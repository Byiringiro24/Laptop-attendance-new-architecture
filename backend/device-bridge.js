/**
 * DeviceBridge — one FKBridge.exe process per FK623 device.
 *
 * Each registered device in devices-list.json gets its own bridge:
 *  - Own FKBridge.exe child process (own stdin/stdout)
 *  - Own command queue (fully parallel across devices)
 *  - Own log poll (every 2s)
 *  - Own status health-check (every 15s)
 *
 * The manager (DeviceBridgeManager) owns a Map<deviceId, DeviceBridge>
 * and starts/stops bridges as devices are added/removed.
 */

'use strict';

const { spawn } = require('child_process');
const readline   = require('readline');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');

const BRIDGE_DIR  = path.join(__dirname, '..', 'FKBridge', 'bin', 'Release', 'net8.0');
const BRIDGE_PATH = path.join(BRIDGE_DIR, 'FKBridge.exe');
const LOG_POLL_INTERVAL    = 2000;   // ms — how often to poll for new logs
const STATUS_CHECK_INTERVAL = 15000; // ms — how often to verify device is still connected

/** ─── Shared poll-state helpers ─────────────────────────────────────────── */
function loadPollCursor(dataDir, deviceId) {
  try {
    const f = path.join(dataDir, `poll-state-${deviceId}.json`);
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Number(raw.lastSeenLogId) || 0;
  } catch { return 0; }
}

function savePollCursor(dataDir, deviceId, cursor) {
  try {
    const f = path.join(dataDir, `poll-state-${deviceId}.json`);
    fs.writeFileSync(f, JSON.stringify({ lastSeenLogId: cursor }));
  } catch { /* non-fatal */ }
}

/** ─── DeviceBridge class ─────────────────────────────────────────────────── */
class DeviceBridge {
  /**
   * @param {object} config  — entry from devices-list.json
   * @param {string} dataDir — path to backend/data/
   * @param {function} onLog    — cb(deviceId, newLogs[]) called when new attendance logs arrive
   * @param {function} onStatus — cb(deviceId, { connected, ipAddress, error?, ... }) called on status change
   */
  constructor(config, dataDir, onLog, onStatus) {
    this.id          = config.id;
    this.config      = { ...config };
    this.dataDir     = dataDir;
    this.onLog       = onLog;
    this.onStatus    = onStatus;

    // Bridge process state
    this._proc       = null;
    this._ready      = false;
    this._pending    = [];   // array of { resolve } waiting for bridge response
    this._queue      = [];   // { command, timeoutMs, resolve }
    this._lock       = false;

    // Connection state
    this.connected   = false;
    this.deviceInfo  = null; // data returned by CONNECT/STATUS
    this.lastError   = null;
    this.lastAttempt = null;
    this.bootId      = crypto.randomUUID();

    // Poll state
    this._logPollTimer    = null;
    this._statusTimer     = null;
    this._pollBusy        = false;
    this._statusBusy      = false;
    this._lastSeenLogId   = loadPollCursor(dataDir, this.id);
    this._autoReconnectTimer = null;
    this._reconnectAttempts  = 0;
    this._destroyed      = false;
  }

  /** Start the FKBridge.exe process for this device */
  async start() {
    if (this._proc || this._destroyed) return;
    if (!fs.existsSync(BRIDGE_PATH)) {
      console.warn(`[bridge:${this._label()}] FKBridge.exe not found — bridge disabled`);
      return;
    }

    this._proc  = spawn(BRIDGE_PATH, [], { cwd: BRIDGE_DIR, windowsHide: true });
    this._ready = false;

    const rl = readline.createInterface({ input: this._proc.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }

      if (msg.type === 'READY') {
        this._ready = true;
        console.log(`[bridge:${this._label()}] process ready`);
        // Auto-connect immediately
        setImmediate(() => this._autoConnect());
        return;
      }

      const next = this._pending.shift();
      if (next) next.resolve(msg);
    });

    this._proc.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) console.error(`[bridge:${this._label()}] stderr: ${s}`);
    });

    this._proc.on('close', (code) => {
      console.log(`[bridge:${this._label()}] process exited (${code})`);
      for (const p of this._pending.splice(0)) p.resolve({ success: false, type: 'ERROR', error: 'Bridge stopped' });
      this._queue.forEach(q => q.resolve({ success: false, type: 'ERROR', error: 'Bridge stopped' }));
      this._queue = [];
      this._proc  = null;
      this._ready = false;
      this._lock  = false;

      if (this.connected) {
        this.connected = false;
        this.deviceInfo = null;
        this._emitStatus(false, 'Bridge process stopped');
      }
      this._stopTimers();

      // Restart bridge process after delay if not destroyed
      if (!this._destroyed) {
        setTimeout(() => this.start(), 5000);
      }
    });

    // Wait up to 10s for READY
    const deadline = Date.now() + 10000;
    while (!this._ready && Date.now() < deadline) await this._wait(100);
    if (!this._ready) console.warn(`[bridge:${this._label()}] process not ready after 10s`);
  }

  /** Stop the bridge process and all timers */
  stop() {
    this._destroyed = true;
    this._stopTimers();
    if (this._autoReconnectTimer) { clearTimeout(this._autoReconnectTimer); this._autoReconnectTimer = null; }
    if (this._proc) {
      try { this._proc.stdin.write('EXIT\n'); } catch {}
      setTimeout(() => { if (this._proc) this._proc.kill(); }, 1000);
    }
  }

  /** Update config (IP, port, license etc.) and trigger reconnect */
  updateConfig(config) {
    const ipChanged = config.ipAddress !== this.config.ipAddress ||
                      config.port      !== this.config.port ||
                      config.license   !== this.config.license;
    this.config = { ...config };
    if (ipChanged && this._ready) {
      this._cancelAutoReconnect();
      this._reconnectAttempts = 0;
      setImmediate(() => this._autoConnect());
    }
  }

  /** Send a command to this device's bridge process and return the result */
  async send(command, timeoutMs = 30000) {
    if (this._destroyed) return { success: false, error: 'Bridge destroyed' };
    if (!this._ready || !this._proc) {
      return { success: false, error: 'Bridge process not running' };
    }

    return new Promise((resolve) => {
      this._queue.push({ command, timeoutMs, resolve });
      this._drain();
    });
  }

  /** ── Private ─────────────────────────────────────────────────────────── */

  _label() { return this.config.name || this.config.ipAddress || this.id.slice(0, 8); }

  _wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  async _drain() {
    if (this._lock || this._queue.length === 0) return;
    this._lock = true;

    // Prioritise CONNECT — drop any GET_LOGS ahead of it
    const ci = this._queue.findIndex(q => q.command.startsWith('CONNECT'));
    if (ci > 0) this._queue.splice(0, ci);

    const { command, timeoutMs, resolve } = this._queue.shift();
    try {
      const result = await this._sendRaw(command, timeoutMs);
      // FK -3 recovery: device disconnected mid-command
      const isDisconnect = !result.success && (
        String(result.error || '').includes('-3') ||
        String(result.error || '').toLowerCase().includes('not connected') ||
        String(result.error || '').toLowerCase().includes('loadgenerallog')
      );
      if (isDisconnect && !command.startsWith('CONNECT')) {
        console.log(`[bridge:${this._label()}] FK -3 — inline reconnect`);
        this.connected = false;
        const rc = await this._connectRaw();
        if (rc.success) {
          this._onConnected(rc.data);
          const retry = await this._sendRaw(command, timeoutMs);
          resolve(retry);
        } else {
          this._onDisconnected(rc.error);
          resolve({ ...result, error: `Device disconnected. Reconnect failed. ${result.error || ''}`.trim() });
        }
      } else {
        resolve(result);
      }
    } catch (err) {
      resolve({ success: false, type: 'ERROR', error: err.message });
    }
    this._lock = false;
    if (this._queue.length > 0) setImmediate(() => this._drain());
  }

  _sendRaw(command, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const wrapped = (msg) => {
        if (done) return; done = true;
        clearTimeout(timer);
        resolve(msg);
      };
      const timer = setTimeout(() => {
        const i = this._pending.findIndex(p => p.resolve === wrapped);
        if (i >= 0) this._pending.splice(i, 1);
        wrapped({ success: false, type: 'TIMEOUT', error: 'Bridge command timed out' });
      }, timeoutMs);

      this._pending.push({ resolve: wrapped });
      this._proc.stdin.write(command + '\n');
    });
  }

  /** Auto-connect on startup and after disconnection */
  async _autoConnect() {
    if (this._destroyed || !this._ready) return;
    if (this.connected) return;

    this._reconnectAttempts++;
    const attempt = this._reconnectAttempts;
    const shouldLog = attempt <= 3 || attempt % 10 === 0;
    if (shouldLog) console.log(`[bridge:${this._label()}] auto-connect #${attempt}: ${this.config.ipAddress}:${this.config.port}`);

    const result = await this._connectRaw();
    if (result.success) {
      this._reconnectAttempts = 0;
      this._onConnected(result.data);
    } else {
      this._onDisconnected(result.error);
      if (!this._destroyed) {
        const delay = Math.min(3000 * Math.pow(1.5, Math.min(attempt - 1, 6)), 30000);
        this._autoReconnectTimer = setTimeout(() => this._autoConnect(), delay);
      }
    }
  }

  /** Raw CONNECT — tries both common ports */
  async _connectRaw() {
    const { ipAddress, license = 1261, deviceId = '', timeoutMs = 15000 } = this.config;
    const primaryPort = Number(this.config.port) || 5005;
    const ports = [primaryPort];
    if (primaryPort !== 4370) ports.push(4370);
    if (primaryPort !== 5005) ports.push(5005);

    let lastResult = null;
    for (const port of ports) {
      const r = await this._sendRaw(
        `CONNECT|${ipAddress}|${port}|${Number(license)}|${deviceId}|0|-1|${Math.min(timeoutMs, 10000)}`,
        Math.min(timeoutMs, 10000) + 5000
      );
      lastResult = r;
      if (r.success) {
        // Persist working port
        if (port !== this.config.port) {
          this.config.port = port;
          // Signal manager to persist
          this._portChanged = port;
        }
        return r;
      }
      const reachable = r.error && (r.error.includes('-2') || r.error.includes('not reachable'));
      if (!reachable) break;
    }
    return lastResult || { success: false, error: 'No response' };
  }

  _cancelAutoReconnect() {
    if (this._autoReconnectTimer) { clearTimeout(this._autoReconnectTimer); this._autoReconnectTimer = null; }
  }

  _onConnected(data) {
    this.connected   = true;
    this.deviceInfo  = data;
    this.lastError   = null;
    this.lastAttempt = new Date().toISOString();
    console.log(`[bridge:${this._label()}] connected ✓ (${this.config.ipAddress})`);
    this._syncDeviceTime();
    this._startTimers();
    this._emitStatus(true);
  }

  _onDisconnected(error) {
    const wasConnected = this.connected;
    this.connected   = false;
    this.deviceInfo  = null;
    this.lastError   = error;
    this.lastAttempt = new Date().toISOString();
    this._stopTimers();
    if (wasConnected) this._emitStatus(false, error);
  }

  _emitStatus(connected, error) {
    if (this.onStatus) {
      this.onStatus(this.id, {
        connected,
        ipAddress:  this.config.ipAddress,
        name:       this.config.name,
        deviceInfo: this.deviceInfo,
        error:      error || null,
        lastAttempt: this.lastAttempt,
      });
    }
  }

  _syncDeviceTime() {
    this.send('SYNC_TIME', 10000).catch(() => null);
  }

  /** ── Timers ─────────────────────────────────────────────────────────── */
  _startTimers() {
    if (!this._logPollTimer) {
      this._logPollTimer = setInterval(() => this._runLogPoll(), LOG_POLL_INTERVAL);
    }
    if (!this._statusTimer) {
      this._statusTimer = setInterval(() => this._runStatusCheck(), STATUS_CHECK_INTERVAL);
    }
  }

  _stopTimers() {
    if (this._logPollTimer) { clearInterval(this._logPollTimer); this._logPollTimer = null; }
    if (this._statusTimer)  { clearInterval(this._statusTimer);  this._statusTimer  = null; }
    this._pollBusy   = false;
    this._statusBusy = false;
  }

  /** ── Log poll ───────────────────────────────────────────────────────── */
  async _runLogPoll() {
    if (!this.connected || this._pollBusy || !this._ready) return;
    this._pollBusy = true;
    try {
      const result = await this.send('GET_LOGS|0', 15000);
      if (!result.success) {
        const offline = this._isOfflineError(result.error);
        if (offline) {
          console.log(`[bridge:${this._label()}] log poll — device offline`);
          this._onDisconnected(result.error);
          this._scheduleReconnect();
        }
        return;
      }

      const rawLogs = Array.isArray(result.data?.logs) ? result.data.logs : [];
      if (!rawLogs.length) return;

      // Reset cursor if device was factory-reset
      const maxId = Math.max(...rawLogs.map(r => Number(r.id) || 0));
      if (this._lastSeenLogId > 0 && maxId < this._lastSeenLogId - 100) {
        console.warn(`[bridge:${this._label()}] device counter reset — resetting cursor`);
        this._lastSeenLogId = 0;
        savePollCursor(this.dataDir, this.id, 0);
      }

      const newLogs = rawLogs
        .filter(r => Number(r.id) > this._lastSeenLogId)
        .sort((a, b) => Number(a.id) - Number(b.id));

      if (!newLogs.length) return;

      if (this.onLog) this.onLog(this.id, this.config, newLogs);

      this._lastSeenLogId = Number(newLogs[newLogs.length - 1].id);
      savePollCursor(this.dataDir, this.id, this._lastSeenLogId);
    } catch { /* silent */ }
    finally { this._pollBusy = false; }
  }

  /** ── Status check ───────────────────────────────────────────────────── */
  async _runStatusCheck() {
    if (!this._ready || this._statusBusy) return;
    this._statusBusy = true;
    try {
      const result = await this.send('STATUS', 4000);
      if (result.success && result.data) {
        const wasConnected = this.connected;
        const isConnected  = Boolean(result.data.connected);
        this.deviceInfo = result.data;

        if (isConnected !== wasConnected) {
          this.connected = isConnected;
          this._emitStatus(isConnected, isConnected ? null : 'Device reported disconnected');
          if (!isConnected) {
            this._stopTimers();
            this._scheduleReconnect();
          }
        }
      } else if (!result.success) {
        const wasConnected = this.connected;
        this.connected = false;
        if (wasConnected) {
          this._emitStatus(false, result.error || 'Status check failed');
          this._stopTimers();
          this._scheduleReconnect();
        }
      }
    } catch { /* silent */ }
    finally { this._statusBusy = false; }
  }

  _scheduleReconnect() {
    this._cancelAutoReconnect();
    if (!this._destroyed) {
      this._autoReconnectTimer = setTimeout(() => this._autoConnect(), 3000);
    }
  }

  _isOfflineError(err = '') {
    const s = String(err).toLowerCase();
    return s.includes('not reachable') || s.includes('not connected') ||
           s.includes('-3') || s.includes('timeout') || s.includes('bridge stopped');
  }
}

/** ─── DeviceBridgeManager ───────────────────────────────────────────────── */
class DeviceBridgeManager {
  constructor(dataDir, onLog, onStatus) {
    this.dataDir  = dataDir;
    this.onLog    = onLog;
    this.onStatus = onStatus;
    this._bridges = new Map(); // deviceConfigId → DeviceBridge
  }

  /** Add or update a device — starts its bridge if not running */
  async upsert(config) {
    const existing = this._bridges.get(config.id);
    if (existing) {
      existing.updateConfig(config);
      return existing;
    }

    const bridge = new DeviceBridge(config, this.dataDir, this.onLog, this.onStatus);
    this._bridges.set(config.id, bridge);
    await bridge.start();
    return bridge;
  }

  /** Remove a device — stops and destroys its bridge */
  remove(deviceId) {
    const bridge = this._bridges.get(deviceId);
    if (bridge) { bridge.stop(); this._bridges.delete(deviceId); }
  }

  /** Get the bridge for a device */
  get(deviceId) { return this._bridges.get(deviceId) || null; }

  /** Send a command to a specific device */
  async send(deviceId, command, timeoutMs = 30000) {
    const bridge = this._bridges.get(deviceId);
    if (!bridge) return { success: false, error: `No bridge for device ${deviceId}` };
    return bridge.send(command, timeoutMs);
  }

  /** Connect a specific device (reconnect) */
  async connect(deviceId) {
    const bridge = this._bridges.get(deviceId);
    if (!bridge) return { success: false, error: 'Device not found in bridge manager' };
    bridge._cancelAutoReconnect();
    bridge._reconnectAttempts = 0;
    const result = await bridge._connectRaw();
    if (result.success) bridge._onConnected(result.data);
    else bridge._onDisconnected(result.error);
    return result;
  }

  /** Disconnect a specific device */
  async disconnect(deviceId) {
    const bridge = this._bridges.get(deviceId);
    if (!bridge) return { success: false, error: 'Device not found' };
    bridge._cancelAutoReconnect();
    bridge._stopTimers();
    if (bridge.connected) {
      await bridge.send('DISCONNECT', 5000).catch(() => null);
      bridge._onDisconnected('Manually disconnected');
    }
    return { success: true };
  }

  /** Get status of all bridges */
  getAllStatus() {
    return Array.from(this._bridges.entries()).map(([id, b]) => ({
      id,
      name:        b.config.name,
      ipAddress:   b.config.ipAddress,
      port:        b.config.port,
      location:    b.config.location,
      connected:   b.connected,
      deviceInfo:  b.deviceInfo,
      lastError:   b.lastError,
      lastAttempt: b.lastAttempt,
      bridgeReady: b._ready,
    }));
  }

  /** Stop all bridges (graceful shutdown) */
  stopAll() {
    for (const bridge of this._bridges.values()) bridge.stop();
    this._bridges.clear();
  }
}

module.exports = { DeviceBridge, DeviceBridgeManager };
