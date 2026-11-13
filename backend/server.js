const express = require('express');
const cors = require('cors');
const { spawn, execFile } = require('child_process');
const path = require('path');
const readline = require('readline');
const fs = require('fs');
const fsSync = fs;  // alias used in WireGuard routes for clarity
const {
  buildPhotoCacheManifest,
  shouldRefreshPhotoCache,
  resolveLocalPhotoPath,
  savePhotoToCache,
} = require('./photo-cache');
const {
  registerDeviceSession,
  getConnectedDeviceSessions,
  getSelectedDeviceSession,
  findDeviceSession,
  removeDeviceSession,
} = require('./device-session-registry');

// ΓöÇΓöÇ Environment constants ΓÇö declared here so every function below can use them ΓöÇΓöÇ
// These were previously declared mid-file, causing Temporal Dead Zone ReferenceErrors.
const PORT            = Number(process.env.PORT || 5000);
// SERVER_API_URL is `let` so it can be updated at runtime via Developer modal
// without restarting the backend — critical when the server IP/domain changes.
let   SERVER_API_URL  = process.env.SERVER_API_URL || 'https://backend.ecareafrica.net/api/v1';
const TABLET_UUID     = process.env.TABLET_UUID   || null;
let   DEV_PASSWORD    = process.env.DEV_PASSWORD  || 'admin1234';
const VPN_ALLOWED_IPS    = process.env.VPN_ALLOWED_IPS    || '10.0.0.0/16';
const WG_SERVER_ENDPOINT = process.env.WG_SERVER_ENDPOINT || '169.58.124.150:51820';
const WG_DNS             = process.env.WG_DNS             || '1.1.1.1';
// WireGuard configuration (configurable via ENV or UI)
const WG_EXE             = process.env.WG_EXE || 'C:\\Program Files\\WireGuard\\wg.exe';
const WIREGUARD_TUNNEL_NAME = process.env.WG_TUNNEL_NAME || 'EcareAfrica';
const WG_TUNNEL_DIR      = process.env.WG_TUNNEL_DIR || `${process.env.PROGRAMDATA || 'C:\\ProgramData'}\\WireGuard`;

// ── FK623 device defaults — read from ENV or fall back to config defaults ─────
// These are used to bootstrap device-config.json on first run.
// Override via environment variables or by writing device-config.json directly.
//   DEVICE_IP      — FK623 device IP address on the local network
//   DEVICE_PORT    — FK623 TCP port (default: 5005)
//   DEVICE_LICENSE — FK623 SDK license number (matches the physical device)
// Each tablet should have its own DEVICE_IP pointing to ITS assigned FK623.
const DEFAULT_DEVICE_IP      = process.env.DEVICE_IP      || '192.168.1.76';
const DEFAULT_DEVICE_PORT    = Number(process.env.DEVICE_PORT    || 5005);
const DEFAULT_DEVICE_LICENSE = Number(process.env.DEVICE_LICENSE || 1261);

function pingSuccessFromOutput(output) {
  const text = String(output || '');
  return /TTL=|ttl=|bytes=|Reply from/i.test(text);
}

async function runPingCheck(target, { timeoutMs = 20000, count = 4 } = {}) {
  const normalizedTarget = String(target || '').trim();
  if (!normalizedTarget) {
    return { success: false, output: 'No target provided', target: normalizedTarget };
  }

  const validIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(normalizedTarget) && normalizedTarget.split('.').every((part) => Number(part) <= 255);
  if (!validIp) {
    return { success: false, output: 'Target must be a valid IPv4 address', target: normalizedTarget };
  }

  try {
    const output = await new Promise((resolve) => {
      execFile('ping.exe', ['-n', String(count), '-w', String(timeoutMs / 4), '-l', '32', normalizedTarget], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
        resolve(String(stdout || stderr || (err ? err.message : 'No output')).trim());
      });
    });

    return {
      success: pingSuccessFromOutput(output),
      output,
      target: normalizedTarget,
      timeoutMs,
    };
  } catch (err) {
    return { success: false, output: err.message || 'Ping failed', target: normalizedTarget, timeoutMs };
  }
}

async function getWireGuardRuntimeStatus() {
  const wgExeExists = fsSync.existsSync(WG_EXE);
  const wguiExists = fsSync.existsSync('C:\\Program Files\\WireGuard\\wireguard.exe');
  const configPath = path.join(WG_TUNNEL_DIR, `${WIREGUARD_TUNNEL_NAME}.conf`);
  const configExists = fsSync.existsSync(configPath);

  let commandExists = false;
  let serviceExists = false;
  let serviceRunning = false;
  let adapterExists = false;
  let adapterUp = false;

  try {
    const commandOut = await new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-Command wg -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source'
      ], { timeout: 6000, windowsHide: true }, (err, stdout) => {
        resolve(err ? '' : stdout);
      });
    });
    commandExists = Boolean((commandOut || '').trim());
  } catch { /* ignore */ }

  try {
    const serviceOut = await new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-Service WireGuard -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Status'
      ], { timeout: 6000, windowsHide: true }, (err, stdout) => {
        resolve(err ? '' : stdout);
      });
    });
    const normalized = (serviceOut || '').toString().trim().toLowerCase();
    serviceExists = Boolean(normalized);
    serviceRunning = normalized.includes('running');
  } catch { /* ignore */ }

  try {
    const adapterOut = await new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-NetAdapter | Where-Object { $_.InterfaceDescription -like "*WireGuard*" -or $_.InterfaceAlias -like "*WireGuard*" } | Select-Object -ExpandProperty Status'
      ], { timeout: 6000, windowsHide: true }, (err, stdout) => {
        resolve(err ? '' : stdout);
      });
    });
    const statuses = (adapterOut || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    adapterExists = statuses.length > 0;
    adapterUp = statuses.some((status) => status.toLowerCase().includes('up'));
  } catch { /* ignore */ }

  const installed = wgExeExists || wguiExists || commandExists || configExists;
  const tunnelActive = serviceRunning || adapterUp;
  const reason = !installed
    ? 'WireGuard is not installed or not detected on this machine.'
    : serviceRunning || adapterUp
      ? 'WireGuard is installed and active.'
      : 'WireGuard is installed but the tunnel/service is not active yet.';

  return {
    installed,
    commandExists,
    serviceExists,
    serviceRunning,
    adapterExists,
    adapterUp,
    configExists,
    tunnelActive,
    reason,
    wgExeExists,
    wguiExists,
    configPath,
  };
}

const { DeviceBridgeManager } = require('./device-bridge');
const app = express();

app.use(cors());
app.use(express.json());

const bridgeDir = path.join(__dirname, '..', 'FKBridge', 'bin', 'Release', 'net8.0');
const bridgePath = path.join(bridgeDir, 'FKBridge.exe');
const dataDir = path.join(__dirname, 'data');
const studentsFile = path.join(dataDir, 'students.json');
const attendanceSettingsFile = path.join(dataDir, 'attendance-settings.json');
const pollStateFile = path.join(dataDir, 'poll-state.json');

// ── Stable boot ID — a new UUID generated each time the bridge process starts.
// Included in every SSE event and attendance_log row so the backend can tell
// apart logs from different device-reset cycles. Prevents ghost replays when
// the FK623 internal counter resets (factory reset, CLEAR_LOGS).
const BOOT_ID = require('crypto').randomUUID();

// ── Poll state — persisted to disk so restarts don't re-emit old logs ────────
function loadPollState() {
  try {
    const raw = fs.readFileSync(pollStateFile, 'utf8');
    const parsed = JSON.parse(raw);
    return { lastSeenLogId: Number(parsed.lastSeenLogId) || 0 };
  } catch {
    return { lastSeenLogId: 0 };
  }
}

function savePollState(state) {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(pollStateFile, JSON.stringify(state));
  } catch { /* non-fatal */ }
}

let pollState = loadPollState();

let bridgeProcess = null;
let bridgeReady = false;
let pending = [];
let currentDevice = null;
const deviceSessions = new Map();

function setActiveDeviceSession(deviceState) {
  const normalized = registerDeviceSession(deviceSessions, deviceState);
  if (normalized) {
    currentDevice = normalized;
  }
  return normalized || currentDevice;
}

function selectSessionTarget(target = {}) {
  const selected = findDeviceSession(deviceSessions, target) || currentDevice;
  if (selected) {
    currentDevice = selected;
  }
  return selected || currentDevice;
}

function resolveSessionTarget(target = {}) {
  const resolved = findDeviceSession(deviceSessions, {
    sessionId: target.sessionId || target.session_id || '',
    ipAddress: target.ipAddress || target.address || '',
    deviceId: target.deviceId || target.device_uid || target.id || '',
  }) || currentDevice;

  if (resolved) {
    currentDevice = resolved;
  }

  return resolved || null;
}

let fk623StatusInProgress = false; // prevent concurrent STATUS commands from /api/health
let usersCache = [];
let logsCache = [];
let students = loadStudents();
let attendanceSettings = loadAttendanceSettings();
const PHOTO_CACHE_ROOT = path.join(__dirname, 'cache', 'photos');

// ── Ensure the photo cache directory exists on startup ────────────────────────
// Without this, the very first scan on a fresh install fails with ENOENT because
// the directory doesn't exist yet (it's gitignored and not created by git clone).
// We create it eagerly so photo lookups never fail with a missing-directory error.
const PHOTO_CACHE_DEFAULT_DIR = path.join(PHOTO_CACHE_ROOT, 'all-rooms');
try {
  if (!fs.existsSync(PHOTO_CACHE_DEFAULT_DIR)) {
    fs.mkdirSync(PHOTO_CACHE_DEFAULT_DIR, { recursive: true });
    console.log('[PhotoCache] Created cache directory:', PHOTO_CACHE_DEFAULT_DIR);
  }
} catch (err) {
  console.warn('[PhotoCache] Could not create cache directory:', err.message);
}

function getRoomPhotoRoot(roomKey = 'all-rooms') {
  const safeRoom = String(roomKey || 'all-rooms').trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-');
  return path.join(PHOTO_CACHE_ROOT, safeRoom || 'all-rooms');
}

async function syncRoomPhotoCache({ roomKey = 'all-rooms', deviceId = 'tablet', studentsList = [], token = null } = {}) {
  const plan = buildPhotoCacheSyncPlan({
    studentsList,
    roomKey,
    deviceId,
    rootPath: PHOTO_CACHE_ROOT,
  });

  let syncedCount = 0;
  let refreshedCount = 0;
  let missingCount = 0;

  for (const staleEntry of plan.remove) {
    try {
      if (fs.existsSync(staleEntry.localPath)) fs.rmSync(staleEntry.localPath, { force: true });
      const metaPath = `${staleEntry.localPath}.meta.json`;
      if (fs.existsSync(metaPath)) fs.rmSync(metaPath, { force: true });
    } catch {
      // best effort cleanup
    }
  }

  const tasks = [...plan.add, ...plan.changed];

  for (const entry of tasks) {
    if (!entry.photoUrl) continue;
    const outcome = await savePhotoToCache(entry.photoUrl, entry.localPath, token);
    if (outcome && outcome.ok) {
      syncedCount += 1;
      if (entry.reason === 'changed') refreshedCount += 1;
    } else {
      missingCount += 1;
    }
  }

  return {
    roomKey: plan.roomKey,
    deviceId: plan.deviceId,
    total: plan.total,
    keep: plan.keep.length,
    add: plan.add.length,
    changed: plan.changed.length,
    remove: plan.remove.length,
    syncedCount,
    refreshedCount,
    missingCount,
    manifest: plan.manifest,
    plan,
  };
}

// Auto-connect state
const deviceConfigFile = path.join(dataDir, 'device-config.json');
let autoConnectTimer = null;
let autoConnectEnabled = true;
let autoConnectAttempt = 0;

// activeDeviceConfig is the single source of truth for what IP to connect to.
// Loaded from file at startup, only updated when Developer modal saves new settings.
// Never re-read from disk during auto-connect to avoid stale browser overwrites.
let activeDeviceConfig = loadDeviceConfig();

// ── Bootstrap default device-config.json if it doesn't exist ─────────────────
// Without this, every fresh tablet install keeps looping "no device config in memory"
// forever because the file was never created. We create a minimal config from
// ecaafrica.json defaults so auto-connect can at least attempt a connection.
// The admin can update the IP later via POST /api/device/set-ip or Enroll-Tablet.ps1.
if (!activeDeviceConfig) {
  const defaultCfg = {
    ipAddress:    DEFAULT_DEVICE_IP,
    port:         DEFAULT_DEVICE_PORT,
    license:      DEFAULT_DEVICE_LICENSE,
    deviceId:     '',
    netPassword:  0,
    protocolType: -1,
    timeoutMs:    10000,
    generatedAt:  new Date().toISOString(),
    note:         'Auto-generated default — update ipAddress to match your FK623 device'
  };
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(deviceConfigFile, JSON.stringify(defaultCfg, null, 2));
    activeDeviceConfig = defaultCfg;
    console.log(`[startup] device-config.json created with default IP ${DEFAULT_DEVICE_IP}:${DEFAULT_DEVICE_PORT} (license=${DEFAULT_DEVICE_LICENSE})`);
    console.log(`[startup] If FK623 is on a different IP, run: POST /api/device/set-ip { ipAddress: "192.168.x.x" }`);
  } catch (err) {
    console.warn('[startup] Could not create default device-config.json:', err.message);
  }
} else {
  console.log(`[startup] Loaded device config: ${activeDeviceConfig.ipAddress}:${activeDeviceConfig.port} (license=${activeDeviceConfig.license})`);
}

// Simple fake bridge handler for local testing when FKBridge.exe is not available.
// Enable by setting environment variable FAKE_BRIDGE=1 before starting the server.
const _fakeUsers = [
  { userId: '1', name: 'Test Student', backupNumber: 0, privilege: 0, enabled: 1 },
];
const _fakeLogs = [
  { id: 'log-1', userId: '1', timestamp: new Date().toISOString(), method: 'FP', direction: 'IN' },
];
async function fakeBridgeHandler(command, timeoutMs = 30000) {
  const parts = String(command || '').split('|');
  const verb = parts[0] || '';
  // quick simulated latency
  await new Promise((r) => setTimeout(r, 150));
  if (verb === 'CONNECT') {
    const ip = parts[1] || '127.0.0.1';
    return { success: true, data: { connected: true, ipAddress: ip, deviceId: 'FAKE_DEVICE_1' } };
  }
  if (verb === 'STATUS') return { success: true, data: { connected: false } };
  if (verb === 'GET_LOGS') return { success: true, data: { logs: _fakeLogs } };
  if (verb === 'GET_USERS') return { success: true, data: { users: _fakeUsers } };
  if (verb === 'GET_LOGS|0') return { success: true, data: { logs: _fakeLogs } };
  return { success: true, data: {} };
}

// SSE clients ├óΓé¼ΓÇ¥ set of response objects
const sseClients = new Set();

function sseEmit(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

// Auto-log-poll state
let logPollTimer = null;
const seenLogIds = new Set();
let pollBusy = false;   // prevent overlapping polls if device is slow

function startLogPoll() {
  if (logPollTimer) return;
  pollBusy = false;
  logPollTimer = setInterval(runLogPoll, 2000);
  console.log('[poll] Auto-poll started (every 2s). lastSeenLogId=' + pollState.lastSeenLogId);
  startStatusCheck(); // always start the real STATUS health-check alongside the log poll
}

function stopLogPoll() {
  if (logPollTimer) { clearInterval(logPollTimer); logPollTimer = null; }
  pollBusy = false;
  stopStatusCheck(); // always stop the STATUS check when the log poll stops
}

// ── Live STATUS health-check — runs every 15s when connected ─────────────────
// The log poll (every 2s) detects disconnects via error responses, but it only
// runs when logs are flowing. The STATUS check is independent: it asks FKBridge
// "are you still connected?" and emits SSE immediately when the answer changes.
// This ensures the frontend always shows real connectivity, not stale state.
let statusCheckTimer = null;
let statusCheckBusy = false;

function startStatusCheck() {
  if (statusCheckTimer) return;
  statusCheckTimer = setInterval(runStatusCheck, 15000);
}

function stopStatusCheck() {
  if (statusCheckTimer) { clearInterval(statusCheckTimer); statusCheckTimer = null; }
  statusCheckBusy = false;
}

async function runStatusCheck() {
  // Run whenever the status check timer fires — even if currentDevice looks connected.
  // The whole point is to verify the in-memory state against reality.
  if (statusCheckBusy || !bridgeReady) return;
  statusCheckBusy = true;
  try {
    const result = await sendCommand('STATUS', 4000);
    if (result.success && result.data) {
      const wasConnected = !!(currentDevice && currentDevice.connected);
      const isConnected  = Boolean(result.data.connected);
      setActiveDeviceSession(result.data);

      if (isConnected !== wasConnected) {
        // State changed — emit SSE immediately
        sseEmit('deviceStatus', {
          connected: isConnected,
          ipAddress: result.data.ipAddress || activeDeviceConfig?.ipAddress || null,
          deviceId:  result.data.deviceId  || null,
          source:    'status-check',
        });
      }

      if (!isConnected) {
        // Device reports not connected — treat as silent disconnect
        currentDevice = null;
        stopLogPoll();
        if (autoConnectEnabled) {
          autoConnectAttempt = 0;
          scheduleAutoConnect(3000);
        }
      }
    } else {
      // Bridge returned failure — device is unreachable or disconnected
      const wasConnected = !!(currentDevice && currentDevice.connected);
      console.log('[status-check] Device offline detected:', result.error || 'no response');
      currentDevice = null;

      if (wasConnected) {
        // Only emit and trigger reconnect if we thought it was connected before
        sseEmit('deviceStatus', {
          connected: false,
          ipAddress: activeDeviceConfig?.ipAddress || null,
          error: result.error || 'Device not reachable',
          source: 'status-check',
        });
        stopLogPoll();
        if (autoConnectEnabled) {
          autoConnectAttempt = 0;
          scheduleAutoConnect(3000);
        }
      }
    }
  } catch (err) {
    const wasConnected = !!(currentDevice && currentDevice.connected);
    currentDevice = null;
    if (wasConnected) {
      sseEmit('deviceStatus', {
        connected: false,
        ipAddress: activeDeviceConfig?.ipAddress || null,
        error: err.message,
        source: 'status-check',
      });
      stopLogPoll();
      if (autoConnectEnabled) {
        autoConnectAttempt = 0;
        scheduleAutoConnect(3000);
      }
    }
  } finally {
    statusCheckBusy = false;
  }
}

/**
 * Incremental log poll — only processes logs with id > lastSeenLogId.
 *
 * Why:
 *  - The old design called GET_LOGS|0 (all logs) and deduplicated in-memory
 *    with a Set capped at 10k entries. When the device has >10k logs the Set
 *    evicts old entries and the next poll re-emits them as "new" (ghost replay).
 *  - The new design advances a numeric cursor. After the first poll only NEW
 *    logs are ever emitted, regardless of how many total logs the device holds.
 *  - BOOT_ID is included in every event so the server can namespace the cursor
 *    per device-reset cycle, preventing collisions after CLEAR_LOGS or a
 *    factory reset.
 */
async function runLogPoll() {
  if (!currentDevice || !currentDevice.connected) return;
  if (pollBusy) return;
  pollBusy = true;

  try {
    // 15s timeout — longer than the old 8s to prevent stall-on-large-log-table.
    // With incremental reads, subsequent polls only fetch new logs and are fast.
    const result = await sendCommand('GET_LOGS|0', 15000);

    if (!result.success) {
      const err = (result.error || '').toLowerCase();
      if (
        err.includes('not reachable') || err.includes('disconnect') ||
        err.includes('timeout')       || err.includes('bridge stopped')
      ) {
        console.log('[poll] Device offline detected — triggering reconnect');
        currentDevice = null;
        stopLogPoll();
        sseEmit('deviceStatus', { connected: false });
        if (autoConnectEnabled) scheduleAutoConnect(3000);
      }
      return;
    }

    const rawLogs = Array.isArray(result.data?.logs) ? result.data.logs : [];
    logsCache = rawLogs;

    if (rawLogs.length === 0) return;

    // ── Device-reset detection ──────────────────────────────────────────────
    // If the device's highest log ID is far below our cursor, the FK623 was
    // factory-reset or CLEAR_LOGS was called. Reset the cursor and skip emitting
    // logs older than 5 minutes (they're historical, not new scans).
    const maxDeviceId = Math.max(...rawLogs.map((r) => Number(r.id) || 0));
    if (pollState.lastSeenLogId > 0 && maxDeviceId < pollState.lastSeenLogId - 100) {
      console.warn('[poll] Device counter reset detected (maxId=' + maxDeviceId +
        ' < cursor=' + pollState.lastSeenLogId + ') — resetting cursor');
      pollState.lastSeenLogId = 0;
      savePollState(pollState);
    }

    // ── Incremental filter — only logs with id > cursor ─────────────────────
    const newLogs = rawLogs
      .filter((r) => Number(r.id) > pollState.lastSeenLogId)
      .sort((a, b) => Number(a.id) - Number(b.id));

    if (newLogs.length === 0) return;

    // Ensure user names resolve before emitting
    if (usersCache.length === 0) {
      await refreshUsersCache().catch(() => null);
    }

    // Attach BOOT_ID so the server can namespace (device_id, boot_id, log_id)
    const mapped = newLogs.map((raw) => ({ ...attendanceFromLog(raw), bootId: BOOT_ID }));
    sseEmit('attendance', mapped);
    console.log('[poll] ' + newLogs.length + ' new log(s) emitted. cursor: ' +
      pollState.lastSeenLogId + ' → ' + Number(newLogs[newLogs.length - 1].id));

    // Advance cursor AFTER successful emit
    pollState.lastSeenLogId = Number(newLogs[newLogs.length - 1].id);
    savePollState(pollState);

  } catch (err) {
    // silent — device may be briefly busy; next tick will retry
  } finally {
    pollBusy = false;
  }
}

function loadStudents() {  
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(studentsFile)) fs.writeFileSync(studentsFile, '[]');
    return JSON.parse(fs.readFileSync(studentsFile, 'utf8'));
  } catch {
    return [];
  }
}

function defaultAttendanceSettings() {
  return {
    morning: {
      name: 'Morning Attendance',
      rules: [
        { label: 'Present', start: '07:00', end: '07:59' },
        { label: 'Late', start: '08:00', end: '16:29' },
        { label: 'Absent', start: '16:30', end: '04:59' },
      ],
    },
    evening: {
      name: 'Evening Attendance',
      rules: [
        { label: 'Leave on time', start: '17:00', end: '17:59' },
        { label: 'Leave late', start: '18:00', end: '18:59' },
        { label: 'Still at school', start: '19:00', end: '04:29' },
      ],
    },
    updatedAt: new Date().toISOString(),
  };
}

function normalizeTime(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

function normalizeRules(rules, fallbackRules) {
  const source = Array.isArray(rules) && rules.length ? rules : fallbackRules;
  return source.map((rule) => {
    const label = String(rule?.label || '').trim();
    const start = normalizeTime(rule?.start);
    const end = normalizeTime(rule?.end);
    if (!label || !start || !end) throw new Error('Invalid attendance rule format');
    return { label, start, end };
  });
}

function normalizeAttendanceSettings(input) {
  const defaults = defaultAttendanceSettings();
  const morningRules = normalizeRules(input?.morning?.rules, defaults.morning.rules);
  const eveningRules = normalizeRules(input?.evening?.rules, defaults.evening.rules);
  const morningName = String(input?.morning?.name || defaults.morning.name).trim() || defaults.morning.name;
  const eveningName = String(input?.evening?.name || defaults.evening.name).trim() || defaults.evening.name;
  return {
    morning: { name: morningName, rules: morningRules },
    evening: { name: eveningName, rules: eveningRules },
    updatedAt: new Date().toISOString(),
  };
}

function normalizeSavedDeviceList(config = {}) {
  const items = Array.isArray(config.savedDevices) ? config.savedDevices : [];
  const map = new Map();

  for (const item of items) {
    const ipAddress = String(item?.ipAddress || '').trim();
    if (!ipAddress) continue;
    map.set(ipAddress, {
      ipAddress,
      port: Number(item?.port) || 5005,
      license: Number(item?.license) || 1261,
      deviceId: String(item?.deviceId || '').trim(),
      netPassword: Number(item?.netPassword) || 0,
      protocolType: Number(item?.protocolType) || -1,
      timeoutMs: Number(item?.timeoutMs) || 15000,
      updatedAt: item?.updatedAt || new Date().toISOString(),
    });
  }

  const currentIp = String(config.ipAddress || '').trim();
  if (currentIp) {
    map.set(currentIp, {
      ipAddress: currentIp,
      port: Number(config.port) || 5005,
      license: Number(config.license) || 1261,
      deviceId: String(config.deviceId || '').trim(),
      netPassword: Number(config.netPassword) || 0,
      protocolType: Number(config.protocolType) || -1,
      timeoutMs: Number(config.timeoutMs) || 15000,
      updatedAt: new Date().toISOString(),
    });
  }

  return [...map.values()].sort((a, b) => a.ipAddress.localeCompare(b.ipAddress));
}

function loadDeviceConfig() {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(deviceConfigFile)) return null;
    const raw = JSON.parse(fs.readFileSync(deviceConfigFile, 'utf8'));
    if (!raw || !raw.ipAddress) return null;
    return {
      ...raw,
      savedDevices: normalizeSavedDeviceList(raw),
      updatedAt: raw.updatedAt || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function saveDeviceConfig(config) {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const normalized = {
      ...config,
      updatedAt: new Date().toISOString(),
      savedDevices: normalizeSavedDeviceList(config),
    };
    fs.writeFileSync(deviceConfigFile, JSON.stringify(normalized, null, 2));
  } catch (err) {
    console.error('Failed to save device config:', err);
  }
}

// Persist a single key=value change to backend/.env without touching other keys.
// Used when admin updates SERVER_API_URL or other env values at runtime via Developer modal.
function saveEnvKey(key, value) {
  const envFile = path.join(__dirname, '.env');
  try {
    let content = '';
    if (fs.existsSync(envFile)) {
      content = fs.readFileSync(envFile, 'utf8');
    }
    const lines = content.split('\n');
    let found = false;
    const updated = lines.map((line) => {
      const match = line.match(/^([^#=\s]+)\s*=(.*)$/);
      if (match && match[1] === key) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });
    if (!found) updated.push(`${key}=${value}`);
    fs.writeFileSync(envFile, updated.join('\n'), 'utf8');
  } catch (err) {
    console.error(`Failed to save .env key ${key}:`, err.message);
  }
}

function rememberLatestDeviceIp(ipAddress, port = 5005, extra = {}) {
  if (!ipAddress || !String(ipAddress).trim()) return null;

  const previous = activeDeviceConfig || loadDeviceConfig() || {};
  const nextConfig = {
    ...previous,
    ...extra,
    ipAddress: String(ipAddress).trim(),
    port: Number(port) || 5005,
    savedDevices: normalizeSavedDeviceList({
      ...previous,
      ...extra,
      ipAddress: String(ipAddress).trim(),
      port: Number(port) || 5005,
    }),
  };

  if (!nextConfig.deviceId && previous.deviceId) nextConfig.deviceId = previous.deviceId;
  activeDeviceConfig = nextConfig;
  saveDeviceConfig(nextConfig);
  return nextConfig;
}

function ensureWireGuardConfigFile({ privateKey, serverPublicKey, vpnIp = '10.0.0.2', dns = WG_DNS, serverEndpoint = WG_SERVER_ENDPOINT, allowedIPs = VPN_ALLOWED_IPS, tunnelName = WIREGUARD_TUNNEL_NAME } = {}) {
  if (!privateKey || !serverPublicKey) {
    throw new Error('Private key and server public key are required to build the WireGuard config.');
  }

  if (!fsSync.existsSync(WG_TUNNEL_DIR)) fsSync.mkdirSync(WG_TUNNEL_DIR, { recursive: true });

  const confContent = [
    '[Interface]',
    `PrivateKey = ${privateKey}`,
    `Address = ${vpnIp}/24`,
    `DNS = ${dns}`,
    '',
    '[Peer]',
    `PublicKey = ${serverPublicKey}`,
    `AllowedIPs = ${allowedIPs}`,
    `Endpoint = ${serverEndpoint}`,
    'PersistentKeepalive = 25',
  ].join('\n');

  const confPath = path.join(WG_TUNNEL_DIR, `${tunnelName}.conf`);
  const tempConfPath = path.join(process.env.TEMP || 'C:\\Temp', `${tunnelName}.conf`);

  // Always write the conf file — this ensures a reinstall with a new server
  // public key, new VPN IP, or new endpoint takes effect immediately.
  // Previously this only wrote if the file was missing or lacked PublicKey,
  // so changing the server public key left the old config unchanged.
  fsSync.writeFileSync(confPath, Buffer.from(confContent, 'utf8'));

  try {
    fsSync.writeFileSync(tempConfPath, Buffer.from(confContent, 'utf8'));
  } catch {
    // Non-fatal fallback when TEMP is unavailable.
  }

  return { confPath, tempConfPath, confContent };
}

function scheduleAutoConnect(delayMs = 2500) {
  if (autoConnectTimer) {
    clearTimeout(autoConnectTimer);
    autoConnectTimer = null;
  }
  if (!autoConnectEnabled) return;
  autoConnectTimer = setTimeout(() => {
    autoConnectTimer = null;
    runAutoConnect();
  }, delayMs);
}

async function runAutoConnect() {
  if (!autoConnectEnabled) return;
  if (currentDevice && currentDevice.connected) return;

  // Use the in-memory cached config ├óΓé¼ΓÇ¥ never re-read from file during auto-connect
  // (file can be overwritten by stale browser requests; memory is authoritative)
  if (!activeDeviceConfig || !activeDeviceConfig.ipAddress) {
    console.log('Auto-connect: no device config in memory, retrying in 10s...');
    scheduleAutoConnect(10000);
    return;
  }

  const config = activeDeviceConfig;

  autoConnectAttempt += 1;
  const attempt = autoConnectAttempt;

  // Only log the first 3 attempts verbosely — after that downgrade to a single
  // periodic reminder every 10 attempts so the console stays readable while the
  // device is powered off or not yet on the network.
  const shouldLog = attempt <= 3 || attempt % 10 === 0;
  if (shouldLog) {
    console.log(`[auto-connect] attempt #${attempt}: ${config.ipAddress}:${config.port || 5005}`);
  }

  try {
    await ensureBridge();
    // Stop log poll before connecting — prevents queue contention
    stopLogPoll();
    const { ipAddress, license = 1261, deviceId = '', netPassword = 0, protocolType = -1 } = config;
    const normalizedProtocol = protocolType === null || protocolType === undefined ? -1 : Number(protocolType);
    const normalizedTimeout = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 15000;

    // Try the configured port first, then fall back to the other common FK623 port
    const primaryPort = Number(config.port) || 5005;
    const portsToTry = [primaryPort];
    if (primaryPort !== 4370) portsToTry.push(4370);
    if (primaryPort !== 5005) portsToTry.push(5005);

    let result = null;
    let workingPort = primaryPort;
    for (const tryPort of portsToTry) {
      result = await sendCommand(
        `CONNECT|${ipAddress}|${tryPort}|${Number(license)}|${deviceId}|${Number(netPassword)}|${normalizedProtocol}|${Math.min(normalizedTimeout, 10000)}`,
        Math.min(normalizedTimeout, 10000) + 5000
      );
      if (result.success) { workingPort = tryPort; break; }
      // Only continue trying ports if device is reachable but SDK rejects (error -2)
      const isReachable = result.error && (result.error.includes('-2') || result.error.includes('not reachable'));
      if (!isReachable) break;
    }

    if (result && result.success) {
      // Persist the working port if it differs from configured
      if (workingPort !== primaryPort && activeDeviceConfig) {
        activeDeviceConfig = { ...activeDeviceConfig, port: workingPort };
        saveDeviceConfig(activeDeviceConfig);
        saveEnvKey('DEVICE_PORT', String(workingPort));
        console.log(`[auto-connect] auto-detected working port ${workingPort} — saved`);
      }
      setActiveDeviceSession(result.data);
      autoConnectAttempt = 0;
      console.log(`[auto-connect] connected to ${ipAddress}:${workingPort}`);
      sseEmit('deviceStatus', { connected: true, ipAddress, attempt });
      syncTimeAfterConnect();
      refreshUsersCache().catch(() => null);
      refreshTabletDeviceAssignments().catch(() => null);
      startLogPoll();
      scheduleAutoConnect(30000);
    } else {
      const errMsg = result?.error || 'unknown error';
      const isLicenseIssue = errMsg.includes('-2') || errMsg.includes('not reachable');
      const hintMsg = isLicenseIssue
        ? `${errMsg} — Verify: 1) License number on device sticker. 2) Network password. 3) Device powered on.`
        : errMsg;
      if (shouldLog) {
        console.log(`[auto-connect] failed (attempt #${attempt}): ${hintMsg}`);
      }
      sseEmit('deviceStatus', { connected: false, ipAddress: config.ipAddress, attempt, error: hintMsg });
      const delay = Math.min(3000 * Math.pow(1.5, Math.min(attempt - 1, 6)), 30000);
      scheduleAutoConnect(delay);
    }
  } catch (err) {
    if (shouldLog) {
      console.log(`[auto-connect] error (attempt #${attempt}): ${err.message}`);
    }
    sseEmit('deviceStatus', { connected: false, ipAddress: config.ipAddress, attempt, error: err.message });
    const delay = Math.min(3000 * Math.pow(1.5, Math.min(attempt - 1, 6)), 30000);
    scheduleAutoConnect(delay);
  }
}

function loadAttendanceSettings() {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(attendanceSettingsFile)) {
      const defaults = defaultAttendanceSettings();
      fs.writeFileSync(attendanceSettingsFile, JSON.stringify(defaults, null, 2));
      return defaults;
    }
    const raw = JSON.parse(fs.readFileSync(attendanceSettingsFile, 'utf8'));
    const normalized = normalizeAttendanceSettings(raw);
    fs.writeFileSync(attendanceSettingsFile, JSON.stringify(normalized, null, 2));
    return normalized;
  } catch {
    const defaults = defaultAttendanceSettings();
    fs.writeFileSync(attendanceSettingsFile, JSON.stringify(defaults, null, 2));
    return defaults;
  }
}

function saveAttendanceSettings() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(attendanceSettingsFile, JSON.stringify(attendanceSettings, null, 2));
}

function saveStudents() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(studentsFile, JSON.stringify(students, null, 2));
}

function startBridge() {
  if (bridgeProcess) return;
  if (!fs.existsSync(bridgePath)) {
    console.warn('FKBridge.exe not found at:', bridgePath);
    console.warn('Bridge features disabled ├óΓé¼ΓÇ¥ WireGuard VPN setup endpoints are still available.');
    return;
  }
  console.log('Starting FK bridge:', bridgePath);
  bridgeReady = false;
  bridgeProcess = spawn(bridgePath, [], { cwd: bridgeDir, windowsHide: true });

  const rl = readline.createInterface({ input: bridgeProcess.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.log('Bridge:', line);
      return;
    }

    if (message.type === 'READY') {
      bridgeReady = true;
      console.log('FK bridge ready');
      return;
    }

    const next = pending.shift();
    if (next) next.resolve(message);
  });

  bridgeProcess.stderr.on('data', (data) => console.error('Bridge stderr:', data.toString()));
  bridgeProcess.on('close', (code) => {
    console.log('FK bridge exited:', code);
    for (const item of pending.splice(0)) item.resolve({ success: false, type: 'ERROR', error: 'Bridge stopped' });
    bridgeProcess = null;
    bridgeReady = false;
    currentDevice = null;
    stopLogPoll();
    // Bridge died ├óΓé¼ΓÇ¥ schedule auto-reconnect after a short delay
    if (autoConnectEnabled) scheduleAutoConnect(5000);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureBridge() {
  startBridge();
  const started = Date.now();
  while (!bridgeReady && Date.now() - started < 10000) await wait(100);
  if (!bridgeReady) throw new Error('FK bridge did not start. Build FKBridge first and confirm FKBridge.exe exists.');
}

// Command lock ├óΓé¼ΓÇ¥ only one bridge command runs at a time
let commandLock = false;
const commandQueue = [];

async function sendCommand(command, timeoutMs = 30000) {
  if (process.env.FAKE_BRIDGE === '1') return fakeBridgeHandler(command, timeoutMs);
  await ensureBridge();
  // Serialize all commands through a queue so they never overlap
  return new Promise((resolve) => {
    commandQueue.push({ command, timeoutMs, resolve });
    drainCommandQueue();
  });
}

async function drainCommandQueue() {
  if (commandLock || commandQueue.length === 0) return;
  commandLock = true;
  // Prioritise CONNECT commands ├óΓé¼ΓÇ¥ if one is waiting, drop all GET_LOGS in front of it
  const connectIdx = commandQueue.findIndex(({ command }) => command.startsWith('CONNECT'));
  if (connectIdx > 0) {
    // Remove all non-CONNECT commands ahead of it to avoid blocking connect
    commandQueue.splice(0, connectIdx);
  }
  const { command, timeoutMs, resolve } = commandQueue.shift();
  try {
    let result = await sendCommandRaw(command, timeoutMs);

    // FK_LoadGeneralLogData failed: -3 means the device disconnected mid-operation.
    // Attempt one auto-reconnect using the saved config and retry the command once.
    const isFkDisconnect = !result.success && (
      String(result.error || '').includes('-3') ||
      String(result.error || '').toLowerCase().includes('not connected') ||
      String(result.error || '').toLowerCase().includes('loadgenerallog')
    );
    if (isFkDisconnect && activeDeviceConfig?.ipAddress && !command.startsWith('CONNECT')) {
      console.log(`[FK Recovery] Device disconnect error (${result.error}) — attempting reconnect before retry`);
      currentDevice = null;
      const { ipAddress, port = 5005, license = 1261, deviceId = '', netPassword = 0, protocolType = -1 } = activeDeviceConfig;
      const reconnect = await sendCommandRaw(
        `CONNECT|${ipAddress}|${Number(port)}|${Number(license)}|${deviceId}|${Number(netPassword)}|${protocolType === null ? -1 : Number(protocolType)}|15000`,
        25000
      ).catch(() => ({ success: false }));
      if (reconnect.success) {
        setActiveDeviceSession(reconnect.data);
        console.log(`[FK Recovery] Reconnected — retrying command: ${command.split('|')[0]}`);
        result = await sendCommandRaw(command, timeoutMs);
      } else {
        console.log('[FK Recovery] Reconnect failed — returning original error');
        result = { ...result, error: `Device disconnected (FK error -3). Reconnect failed. ${result.error || ''}`.trim() };
      }
    }

    resolve(result);
  } catch (err) {
    resolve({ success: false, type: 'ERROR', error: err.message });
  }
  commandLock = false;
  if (commandQueue.length > 0) setImmediate(drainCommandQueue);
}

async function sendCommandRaw(command, timeoutMs = 30000) {
  if (process.env.FAKE_BRIDGE === '1') return fakeBridgeHandler(command, timeoutMs);
  await ensureBridge();
  return new Promise((resolve) => {
    let done = false;
    const wrappedResolve = (message) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(message);
    };
    const timer = setTimeout(() => {
      const index = pending.findIndex((item) => item.resolve === wrappedResolve);
      if (index >= 0) pending.splice(index, 1);
      wrappedResolve({ success: false, type: 'TIMEOUT', error: 'Bridge command timed out' });
    }, timeoutMs);

    pending.push({ resolve: wrappedResolve });
    bridgeProcess.stdin.write(command + '\n');
  });
}

function apiResult(res, result, successStatus = 200) {
  if (!result.success) return res.status(500).json(result);
  return res.status(successStatus).json(result);
}

// ── Middleware: verify developer password on destructive device operations ────
// Pass ?devPassword=<pw> in the request body or header X-Dev-Password.
// Returns 401 if the password is wrong. Skip check in FAKE_BRIDGE mode (testing).
function requireDevPassword(req, res, next) {
  if (process.env.FAKE_BRIDGE === '1') return next(); // bypass in test mode
  const supplied = req.body?.devPassword || req.headers['x-dev-password'] || '';
  if (!supplied) {
    return res.status(401).json({ success: false, error: 'Developer password required', code: 'dev_password_required' });
  }
  if (String(supplied).trim() !== String(DEV_PASSWORD).trim()) {
    return res.status(401).json({ success: false, error: 'Incorrect developer password', code: 'dev_password_incorrect' });
  }
  next();
}

// ── Helper: is the error a device-not-connected error? ────────────────────────
function isNotConnectedError(err = '') {
  const s = String(err).toLowerCase();
  return s.includes('not connected') || s.includes('not reachable') ||
         s.includes('-3') || s.includes('timeout') || s.includes('bridge stopped') ||
         s.includes('no device') || s.includes('device offline');
}

function backupToMethod(backupNumber) {
  if (backupNumber >= 0 && backupNumber <= 9) return 'Fingerprint';
  if (backupNumber === 10) return 'Password/PIN';
  if (backupNumber === 11) return 'RFID Card';
  if (backupNumber === 12) return 'Face Recognition';
  if (backupNumber >= 13 && backupNumber <= 20) return 'Vein/Palm';
  return `Backup ${backupNumber}`;
}

function aggregateDeviceUsers(rawUsers = []) {
  const byId = new Map();
  for (const raw of rawUsers) {
    const userId = String(raw.userId || '').trim();
    if (!userId) continue;
    const existing = byId.get(userId) || {
      userId,
      studentDeviceId: userId,
      name: raw.name || '',
      privilege: raw.privilege || 0,
      enabled: Boolean(raw.enabled),
      biometricMethods: [],
      backupNumbers: [],
      fingerprintRegistered: false,
      faceRegistered: false,
      cardRegistered: false,
      pinRegistered: false,
    };
    const method = backupToMethod(Number(raw.backupNumber));
    if (!existing.biometricMethods.includes(method)) existing.biometricMethods.push(method);
    if (!existing.backupNumbers.includes(raw.backupNumber)) existing.backupNumbers.push(raw.backupNumber);
    existing.fingerprintRegistered ||= method === 'Fingerprint';
    existing.faceRegistered ||= method === 'Face Recognition';
    existing.cardRegistered ||= method === 'RFID Card';
    existing.pinRegistered ||= method === 'Password/PIN';
    if (!existing.name && raw.name) existing.name = raw.name;
    existing.enabled ||= Boolean(raw.enabled);
    byId.set(userId, existing);
  }
  return Array.from(byId.values()).sort((a, b) => a.userId.localeCompare(b.userId, undefined, { numeric: true }));
}

function getStudentForDeviceUser(userId) {
  return students.find((student) => String(student.studentDeviceId) === String(userId) || String(student.deviceUserId) === String(userId));
}

function normalizeStudent(input) {
  const studentDeviceId = String(input.studentDeviceId || input.deviceUserId || input.enrollmentId || input.id || '').trim();
  const generatedSuffix = studentDeviceId || Date.now().toString().slice(-6);
  const studentId = String(input.studentId || `RW-${generatedSuffix}`).trim().toUpperCase();
  // Build full name: support both single 'name' field (local registration)
  // and first_name + last_name (school API response)
  const fullName = String(
    input.name ||
    ((input.first_name || input.last_name)
      ? `${input.first_name || ''} ${input.last_name || ''}`.trim()
      : '')
  ).trim();
  const studentType = String(input.studentType || input.student_type || input.type || '').trim();
  const boardingStatus = String(input.boardingStatus || input.boarding_status || input.boardingStatusCode || '').trim();
  const roomName = String(input.roomName || input.room_name || input.room || '').trim();
  const dormitoryName = String(input.dormitoryName || input.dormitory_name || input.dormitory || '').trim();
  return {
    id: studentId,
    studentId,
    name: fullName,
    firstName: String(input.first_name || input.firstName || '').trim(),
    lastName: String(input.last_name || input.lastName || '').trim(),
    className: String(input.className || input.class_name || '').trim(),
    section: String(input.section || input.section_name || '').trim(),
    studentDeviceId,
    deviceUserId: studentDeviceId,
    studentType,
    boardingStatus,
    roomName,
    dormitoryName,
    assignedDeviceId: input.assignedDeviceId || currentDevice?.deviceId || '',
    // Which FK623 device this student was registered on — used for per-device filtering
    registeredOnDevice: input.registeredOnDevice || activeDeviceConfig?.ipAddress || currentDevice?.ipAddress || '',
    registeredOnDeviceName: input.registeredOnDeviceName || activeDeviceConfig?.name || '',
    parentName: input.parentName || '',
    parentPhone: input.parentPhone || input.parent_phone || '',
    phone: input.phone || '',
    email: input.email || '',
    photoUrl: input.photoUrl || input.photo_url || '',   // stored for display on scan
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeStudentType(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const normalized = text.toLowerCase();
  if (normalized.includes('boarding') || normalized.includes('boarder') || normalized.includes('resident')) return 'Boarding Student';
  if (normalized.includes('day')) return 'Day Student';
  return text;
}

function timeStringToMinutes(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function isMinutesInRange(minutes, start, end) {
  if (start <= end) return minutes >= start && minutes <= end;
  return minutes >= start || minutes <= end;
}

function resolveAttendanceStatus(log) {
  const timestamp = new Date(log.timestamp);
  const minutes = timestamp.getHours() * 60 + timestamp.getMinutes();
  const eveningMatch = attendanceSettings.evening.rules.find((rule) =>
    isMinutesInRange(minutes, timeStringToMinutes(rule.start), timeStringToMinutes(rule.end))
  );
  if (eveningMatch) {
    const fallback = attendanceSettings.evening.rules[attendanceSettings.evening.rules.length - 1]?.label;
    return { status: eveningMatch.label || fallback || 'Unknown', period: attendanceSettings.evening.name };
  }

  const morningMatch = attendanceSettings.morning.rules.find((rule) =>
    isMinutesInRange(minutes, timeStringToMinutes(rule.start), timeStringToMinutes(rule.end))
  );
  const fallback = attendanceSettings.morning.rules[attendanceSettings.morning.rules.length - 1]?.label;
  return { status: morningMatch?.label || fallback || 'Unknown', period: attendanceSettings.morning.name };
}

function attendanceFromLog(log) {
  const student = getStudentForDeviceUser(log.userId);
  const deviceUser = usersCache.find((item) => item.userId === log.userId);
  const resolved = resolveAttendanceStatus(log);
  const stableId = log.id || `${log.userId}-${log.timestamp}`;
  const resolvedDeviceUserId = String(student?.deviceUserId || student?.studentDeviceId || log.userId || '').trim();
  const studentTypeValue =
    student?.studentType || student?.student_type || log.studentType || log.student_type || log.memberType || log.type || '';
  const boardingStatusValue =
    student?.boardingStatus || student?.boarding_status || log.boardingStatus || log.boarding_status || '';
  const roomNameValue =
    student?.roomName || student?.room_name || log.roomName || log.room_name || log.room || log.dormitory || '';
  const dormitoryNameValue =
    student?.dormitoryName || student?.dormitory_name || log.dormitoryName || log.dormitory_name || log.dormitory || '';
  // Prefer the stored full name; fall back to first+last if available, then device name
  const studentName = student?.name
    || (student?.firstName && student?.lastName
        ? `${student.firstName} ${student.lastName}`.trim()
        : null)
    || deviceUser?.name
    || `User ${log.userId}`;
  const finalStudentType = normalizeStudentType(studentTypeValue || boardingStatusValue || '');
  return {
    id: stableId,
    studentId: student?.studentId || `RW-${log.userId}`,
    studentDeviceId: log.userId,
    deviceUserId: resolvedDeviceUserId || log.userId,
    studentName,
    firstName: student?.firstName || '',
    lastName: student?.lastName || '',
    className: student?.className || '',
    section: student?.section || '',
    studentType: finalStudentType || 'Day Student',
    boardingStatus: boardingStatusValue || '',
    roomName: roomNameValue || '',
    dormitoryName: dormitoryNameValue || '',
    deviceId: currentDevice?.deviceId || currentDevice?.ipAddress || 'FK_DEVICE',
    authenticationMethod: readableMethod(log.method),
    direction: log.direction,
    timestamp: log.timestamp,
    status: resolved.status,
    attendancePeriod: resolved.period,
    photoUrl: (() => {
      const u = student?.photoUrl || '';
      if (!u) return '';
      if (u.startsWith('http://localhost') || u.startsWith('data:')) return u;
      const port = Number(process.env.PORT || PORT || 5000);
      // Include studentId and roomKey so the photo proxy caches under the correct path
      const sid = encodeURIComponent(student?.studentId || log.userId || 'unknown');
      const rk  = encodeURIComponent(student?.dormitoryName || student?.roomName || 'all-rooms');
      return `http://localhost:${port}/api/school/photo?url=${encodeURIComponent(u)}&studentId=${sid}&roomKey=${rk}`;
    })(),
    bootId: BOOT_ID,     // allows backend to namespace dedup by device-reset cycle
    verified: true,
    rawData: {
      ...log,
      deviceUserId: resolvedDeviceUserId || log.userId,
      studentType: finalStudentType || 'Day Student',
      boardingStatus: boardingStatusValue || '',
      roomName: roomNameValue || '',
      dormitoryName: dormitoryNameValue || '',
    },
  };
}

function readableMethod(method) {
  const value = String(method || '').toUpperCase();
  if (value.includes('FACE')) return 'Face Recognition';
  if (value.includes('FINGER') || value.includes('FP')) return 'Fingerprint';
  if (value.includes('CARD')) return 'RFID Card';
  if (value.includes('PASS') || value.includes('PIN')) return 'Password/PIN';
  return value.startsWith('MODE_') ? 'Device Verified' : method;
}

// Sync device time to tablet clock immediately after every successful connection.
// Cooldown of 60s prevents repeated syncs during rapid reconnect cycles.
let lastTimeSyncAt = 0;
function syncTimeAfterConnect() {
  const now = Date.now();
  if (now - lastTimeSyncAt < 60000) return; // skip if synced less than 60s ago
  lastTimeSyncAt = now;
  sendCommand('SYNC_TIME', 10000)
    .then((r) => {
      if (r.success) console.log(`[Time Sync] Device clock synced to tablet time: ${new Date().toISOString()}`);
      else           console.warn(`[Time Sync] SYNC_TIME failed: ${r.error || 'unknown error'}`);
    })
    .catch((err) => console.warn(`[Time Sync] SYNC_TIME error: ${err.message}`));
}

async function refreshUsersCache() {
  const result = await sendCommand('GET_USERS', 60000);
  if (result.success) usersCache = aggregateDeviceUsers(result.data.users || []);
  return result.success ? { ...result, data: { users: usersCache, count: usersCache.length } } : result;
}

// Tablet identity ΓÇö cached from school server
let tabletInfo = { name: null, location: null };
let tabletDeviceAssignments = [];
let selectedDeviceName = null;

function resolveDeviceAssignmentByIp(ipAddress) {
  const value = String(ipAddress || '').trim();
  if (!value) return null;
  const exact = tabletDeviceAssignments.find((device) => String(device.tablet_ip || '').trim() === value);
  if (exact) return exact;
  return tabletDeviceAssignments.find((device) => {
    const candidate = String(device.tablet_ip || '').trim();
    return candidate && candidate.startsWith(value.slice(0, -1));
  }) || null;
}

async function fetchTabletInfo() {
  // TABLET_UUID is set in .env after the tablet is registered in the portal.
  // Skip silently if not configured yet ΓÇö no log spam on fresh installs.
  if (!TABLET_UUID || !SERVER_API_URL) return;
  try {
    const res = await fetch(`${SERVER_API_URL}/tablet-bridge/tablet-info/${TABLET_UUID}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      // 404 = UUID not registered yet ΓÇö expected on first boot, not a real error
      if (res.status !== 404) {
        console.warn(`[Tablet] tablet-info fetch failed: HTTP ${res.status}`);
      }
      return;
    }
    const json = await res.json();
    // Public tablet-info endpoint returns { name, location, uuid } directly
    const data = json?.data ?? json ?? null;
    if (data && data.name) {
      tabletInfo = { name: data.name || null, location: data.location || null };
      console.log(`[Tablet] Identity loaded: "${data.name}" @ ${data.location}`);
    }
  } catch (err) {
    // Network errors are normal when WireGuard is not yet connected ΓÇö suppress
    console.warn('[Tablet] Could not fetch tablet info from server:', err.message);
  }
}

async function refreshTabletDeviceAssignments() {
  if (!TABLET_UUID || !SERVER_API_URL) {
    tabletDeviceAssignments = [];
    selectedDeviceName = null;
    return;
  }

  try {
    const res = await fetch(`${SERVER_API_URL}/tablet-bridge/device-assignments/${TABLET_UUID}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      if (res.status === 404) {
        tabletDeviceAssignments = [];
        selectedDeviceName = tabletInfo.name || null;
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();
    const rawDevices = Array.isArray(json?.devices) ? json.devices : Array.isArray(json?.data) ? json.data : [];
    tabletDeviceAssignments = rawDevices
      .filter((device) => device && (device.is_active === undefined || device.is_active !== false))
      .map((device) => ({
        id: device.id ?? device.device_uid ?? null,
        name: String(device.name || device.device_uid || 'Unnamed Device').trim(),
        device_uid: device.device_uid ?? null,
        tablet_ip: String(device.tablet_ip || '').trim() || null,
        location: device.location ?? null,
        is_active: device.is_active ?? true,
        tablet_id: device.tablet_id ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const activeIp = activeDeviceConfig?.ipAddress || currentDevice?.ipAddress || loadDeviceConfig()?.ipAddress || null;
    const resolved = resolveDeviceAssignmentByIp(activeIp);
    selectedDeviceName = resolved?.name || tabletInfo.name || null;

    if (resolved && resolved.name) {
      console.log(`[Tablet] Active device resolved to "${resolved.name}" (${resolved.tablet_ip || activeIp})`);
    }
  } catch (err) {
    console.warn('[Tablet] Could not fetch device assignments from server:', err.message);
  }
}
// Only poll if a UUID is configured ΓÇö avoids pointless fetch loops on fresh installs
if (TABLET_UUID) {
  fetchTabletInfo();
  refreshTabletDeviceAssignments();
  setInterval(fetchTabletInfo, 30 * 1000);
  setInterval(refreshTabletDeviceAssignments, 30 * 1000);
}

// ΓöÇΓöÇ Remote dev-password polling ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Super admin sets a dev password on the school server (PATCH /platform/hardware/tablets/:id/dev-password).
// This bridge polls the school server every 60s and applies the new password immediately.
// The tablet frontend polls /api/health every 60s and updates its local devPasswordActual state.
async function pollDevPassword() {
  if (!TABLET_UUID || !SERVER_API_URL) return;
  try {
    const res = await fetch(`${SERVER_API_URL}/tablet-bridge/dev-password/${TABLET_UUID}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return; // 404 = tablet not registered, 5xx = server down ΓÇö ignore both
    const json = await res.json().catch(() => null);
    if (!json) return;
    if (json.hasPassword && json.password && json.password !== DEV_PASSWORD) {
      DEV_PASSWORD = json.password;
      console.log('[DevPassword] Remote password applied from school server');
    } else if (!json.hasPassword && DEV_PASSWORD !== (process.env.DEV_PASSWORD || 'admin1234')) {
      // Server removed the custom password ΓÇö revert to env default
      DEV_PASSWORD = process.env.DEV_PASSWORD || 'admin1234';
      console.log('[DevPassword] Remote password removed ΓÇö reverted to default');
    }
  } catch {
    // Network error ΓÇö WireGuard may not be up yet. Silent.
  }
}
if (TABLET_UUID) {
  // Initial poll after 5s (give WireGuard time to come up)
  setTimeout(pollDevPassword, 5000);
  setInterval(pollDevPassword, 30 * 1000);
}

async function buildSystemStatusSnapshot() {
  const savedConfig = loadDeviceConfig();
  const sessions = getConnectedDeviceSessions(deviceSessions);
  const selectedSession = getSelectedDeviceSession(deviceSessions, currentDevice) || currentDevice || null;

  try {
    const tunnelStatus = await getWireGuardRuntimeStatus();
    const targetIp = activeDeviceConfig?.ipAddress || selectedSession?.ipAddress || savedConfig?.ipAddress || null;
    const serverTarget = (() => {
      try {
        const parsed = new URL(SERVER_API_URL || 'https://backend.ecareafrica.net');
        return parsed.hostname;
      } catch {
        return null;
      }
    })();

    const devicePing = targetIp ? await runPingCheck(targetIp, { timeoutMs: 8000, count: 2 }) : { success: false, output: 'No device IP configured', target: null };
    const serverPing = serverTarget && /^\d{1,3}(\.\d{1,3}){3}$/.test(serverTarget)
      ? await runPingCheck(serverTarget, { timeoutMs: 8000, count: 2 })
      : { success: false, output: 'Server target is not an IPv4 address', target: serverTarget || null };

    return {
      ok: true,
      status: 'ok',
      bridgeRunning: bridgeProcess !== null,
      bridgeReady,
      wireguard: tunnelStatus,
      connectivity: {
        serverTarget: serverTarget || null,
        serverPing,
        deviceTarget: targetIp || null,
        devicePing,
        overallHealthy: tunnelStatus.serviceRunning || devicePing.success || serverPing.success,
      },
      selectedDevice: selectedSession,
      activeDevice: selectedSession,
      sessionCount: sessions.length,
      sessions,
      connectedDeviceCount: sessions.length,
      deviceConnected: !!(selectedSession && selectedSession.connected),
      savedConfig,
      deviceConfig: activeDeviceConfig || savedConfig || null,
      tabletUuid: TABLET_UUID || null,
      tabletName: tabletInfo.name || null,
    };
  } catch {
    return {
      ok: true,
      status: 'ok',
      bridgeRunning: bridgeProcess !== null,
      bridgeReady,
      wireguard: {
        serviceExists: false,
        serviceRunning: false,
        adapterExists: false,
        adapterUp: false,
        commandExists: false,
      },
      connectivity: {
        serverTarget: null,
        serverPing: { success: false, output: 'Connectivity check failed', target: null },
        deviceTarget: null,
        devicePing: { success: false, output: 'No device configured', target: null },
        overallHealthy: false,
      },
      selectedDevice: selectedSession,
      activeDevice: selectedSession,
      sessionCount: sessions.length,
      sessions,
      connectedDeviceCount: sessions.length,
      deviceConnected: !!(selectedSession && selectedSession.connected),
      savedConfig,
      deviceConfig: activeDeviceConfig || savedConfig || null,
      tabletUuid: TABLET_UUID || null,
      tabletName: tabletInfo.name || null,
    };
  }
}

app.get('/api/system/status', async (req, res) => {
  try {
    const snapshot = await buildSystemStatusSnapshot();
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ ok: false, status: 'error', error: err.message });
  }
});

app.get('/api/health', async (req, res) => {
  const savedConfig = loadDeviceConfig();

  // Fetch real-time FK623 status via STATUS command (non-blocking, 3s timeout)
  // This ensures /api/health always returns actual device connectivity,
  // not stale in-memory state from the last auto-connect cycle.
  // Default connected=false — only set true if the live STATUS command confirms it.
  let fk623Status = {
    connected: false,
    deviceId:  currentDevice?.deviceId  || null,
    ipAddress: activeDeviceConfig?.ipAddress || savedConfig?.ipAddress || null,
    port:      activeDeviceConfig?.port      || savedConfig?.port      || 5005,
    users:     currentDevice?.deviceUserCount || 0,
    logs:      currentDevice?.logCount        || 0,
  };

  // Live STATUS check — always attempt this; skip only if another check is in-flight
  if (bridgeReady && !fk623StatusInProgress) {
    fk623StatusInProgress = true;
    try {
      const result = await Promise.race([
        sendCommand('STATUS', 3000),
        new Promise(resolve => setTimeout(() => resolve({ success: false }), 3500))
      ]);
      if (result.success && result.data) {
        setActiveDeviceSession(result.data);
        fk623Status = {
          connected:  Boolean(result.data.connected),
          deviceId:   result.data.deviceId   || fk623Status.deviceId,
          ipAddress:  result.data.ipAddress  || fk623Status.ipAddress,
          port:       result.data.port       || fk623Status.port,
          users:      result.data.deviceUserCount || result.data.users || 0,
          logs:       result.data.logCount        || result.data.logs  || 0,
        };
        if (!fk623Status.connected) {
          // Device responded but says not connected
          currentDevice = null;
        }
      } else {
        // STATUS failed — FK623 disconnected or unreachable
        currentDevice = null;
        fk623Status.connected = false;
      }
    } catch { fk623Status.connected = false; currentDevice = null; }
    finally { fk623StatusInProgress = false; }
  } else if (fk623StatusInProgress) {
    // Another health check is already running — report unknown rather than stale true
    fk623Status.connected = false;
  }

  const selectedSession = getSelectedDeviceSession(deviceSessions, currentDevice) || currentDevice;
  const selectedDevice = resolveDeviceAssignmentByIp(activeDeviceConfig?.ipAddress || selectedSession?.ipAddress || savedConfig?.ipAddress || null);
  const displayedDeviceName = selectedDevice?.name || selectedDeviceName || tabletInfo.name || null;

  const connectedSessions = getConnectedDeviceSessions(deviceSessions);

  res.json({
    status:       'ok',
    bridgeRunning: bridgeProcess !== null,
    bridgeReady,
    bootId:       BOOT_ID,
    cursor:       pollState.lastSeenLogId,
    fk623:        fk623Status,
    // Keep 'device' field for backwards compatibility with existing callers
    device: selectedSession,
    selectedDevice: selectedSession,
    activeDevice: selectedSession,
    devices: connectedSessions,
    sessions: connectedSessions,
    autoConnect:  { enabled: autoConnectEnabled, attempt: autoConnectAttempt },
    savedConfig,
    savedDevices: savedConfig?.savedDevices || [],
    knownDeviceConfigs: savedConfig?.savedDevices || [],
    tabletUuid:   TABLET_UUID || null,
    tabletName:   tabletInfo.name,
    deviceName:   displayedDeviceName,
    selectedDeviceName: displayedDeviceName,
    tabletDevices: tabletDeviceAssignments,
    devPassword:  DEV_PASSWORD,
    tabletLocation: tabletInfo.location,
    vpn: {
      serverEndpoint: WG_SERVER_ENDPOINT,
      allowedIPs:     VPN_ALLOWED_IPS,
      dns:            WG_DNS,
    },
    serverApiUrl: SERVER_API_URL,
    // Per-device live status from the bridge manager
    registeredDevices: getDevicesWithStatus(),
  });
});

// POST /api/config/server-url
// Updates SERVER_API_URL at runtime AND persists it to .env.
// Called from Developer modal when admin changes the server address.
// No restart needed — takes effect immediately.
app.post('/api/config/server-url', (req, res) => {
  const { url } = req.body || {};
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ success: false, error: 'Valid URL required (must start with http)' });
  }
  const clean = url.trim().replace(/\/$/, ''); // strip trailing slash
  SERVER_API_URL = clean;
  saveEnvKey('SERVER_API_URL', clean);
  console.log(`[Config] SERVER_API_URL updated to: ${clean}`);
  res.json({ success: true, serverApiUrl: SERVER_API_URL });
});

// Server-Sent Events ├óΓé¼ΓÇ¥ frontend subscribes here for real-time attendance updates
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send a heartbeat every 20s so proxies don't close the connection
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { /* client gone */ }
  }, 20000);

  // Send current log cache immediately on connect — seed seenLogIds so they're never treated as fresh
  const current = logsCache.map(attendanceFromLog);
  current.forEach((l) => seenLogIds.add(l.id));
  // Send to frontend as init (sidebar logs only, no flash)
  res.write(`event: init\ndata: ${JSON.stringify(current)}\n\n`);

  // Send all device statuses so the devices page loads with current state immediately
  try {
    const devWithStatus = getDevicesWithStatus();
    res.write(`event: devicesInit\ndata: ${JSON.stringify(devWithStatus)}\n\n`);
  } catch { /* non-fatal */ }

  sseClients.add(res);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.post('/api/device/connect', async (req, res) => {
  const {
    ipAddress,
    address,
    port = 5005,
    license = 1261,
    deviceId = '',
    netPassword = 0,
    protocolType = -1,
    timeoutMs = 3000,
    saveConfig = false,   // only save when explicitly requested (Developer modal)
  } = req.body;
  const targetAddress = ipAddress || address;
  const normalizedProtocol = protocolType === null || protocolType === undefined ? -1 : Number(protocolType);
  const normalizedTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 3000;

  // Preserve the developer-set IP unless the user explicitly saves a new one.
  // Generic connect attempts must not clobber a known saved config while auto-connect is running.
  const existingConfig = activeDeviceConfig || loadDeviceConfig() || {};
  const shouldPersistConfig = saveConfig === true || (!existingConfig.ipAddress && Boolean(targetAddress));

  if (shouldPersistConfig) {
    const cfg = {
      ...existingConfig,
      ipAddress: String(targetAddress || existingConfig.ipAddress || '').trim(),
      port: Number(port) || Number(existingConfig.port) || 5005,
      license: Number(license) || Number(existingConfig.license) || 1261,
      deviceId: String(deviceId || existingConfig.deviceId || '').trim(),
      netPassword: Number(netPassword) || Number(existingConfig.netPassword) || 0,
      protocolType: normalizedProtocol,
      timeoutMs: normalizedTimeout,
    };
    if (cfg.ipAddress) {
      saveDeviceConfig(cfg);
      activeDeviceConfig = cfg;  // keep the latest FK device IP immediately available for reconnects
      // Also persist to .env so the IP survives a full reinstall
      if (saveConfig === true) {
        saveEnvKey('DEVICE_IP', cfg.ipAddress);
        saveEnvKey('DEVICE_PORT', String(cfg.port || 5005));
      }
      refreshTabletDeviceAssignments().catch(() => null);
    }
  }

  const result = await sendCommand(
    `CONNECT|${targetAddress}|${Number(port)}|${Number(license)}|${deviceId}|${Number(netPassword)}|${normalizedProtocol}|${normalizedTimeout}`,
    8000
  );
  if (result.success) {
    setActiveDeviceSession(result.data);
    if (result.data?.ipAddress) {
      rememberLatestDeviceIp(result.data.ipAddress, result.data.port || existingConfig.port || 5005, {
        deviceId: result.data.deviceId || existingConfig.deviceId || '',
        license: result.data.license || existingConfig.license || 1261,
        netPassword: result.data.netPassword || existingConfig.netPassword || 0,
        protocolType: result.data.protocolType ?? existingConfig.protocolType ?? -1,
        timeoutMs: result.data.timeoutMs || existingConfig.timeoutMs || 15000,
      });
    }
    autoConnectAttempt = 0;
    syncTimeAfterConnect();                  // sync device clock to tablet time
    refreshUsersCache().catch(() => null);
    refreshTabletDeviceAssignments().catch(() => null);
    startLogPoll();
    scheduleAutoConnect(30000);
  }
  apiResult(res, result);
});

// Connect using saved config ├óΓé¼ΓÇ¥ frontend calls this so it never overwrites the saved IP
app.post('/api/device/connect-saved', async (req, res) => {
  // If already connected, return current device state immediately ├óΓé¼ΓÇ¥ no need to reconnect
  if (currentDevice && currentDevice.connected) {
    return res.json({ success: true, data: currentDevice });
  }
  const config = activeDeviceConfig || loadDeviceConfig();
  if (!config || !config.ipAddress) {
    return res.status(400).json({ success: false, error: 'No saved device config. Use Developer settings to set the IP first.' });
  }
  const { ipAddress, port = 5005, license = 1261, deviceId = '', netPassword = 0, protocolType = -1, timeoutMs = 10000 } = config;
  const normalizedProtocol = protocolType === null || protocolType === undefined ? -1 : Number(protocolType);
  const normalizedTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 10000;
  const result = await sendCommand(
    `CONNECT|${ipAddress}|${Number(port)}|${Number(license)}|${deviceId}|${Number(netPassword)}|${normalizedProtocol}|${normalizedTimeout}`,
    normalizedTimeout + 5000
  );
  if (result.success) {
    setActiveDeviceSession(result.data);
    autoConnectAttempt = 0;
    syncTimeAfterConnect();                  // sync device clock to tablet time
    refreshUsersCache().catch(() => null);
    refreshTabletDeviceAssignments().catch(() => null);
    startLogPoll();
    scheduleAutoConnect(30000);
  }
  apiResult(res, result);
});

// Persist device configuration without attempting a TCP connect
app.post('/api/device/save-config', (req, res) => {
  try {
    const {
      ipAddress = '', port = 5005, license = 1261, deviceId = '', netPassword = 0, protocolType = -1, timeoutMs = 3000,
    } = req.body || {};
    const cfg = {
      ...(activeDeviceConfig || loadDeviceConfig() || {}),
      ipAddress: String(ipAddress || '').trim(),
      port: Number(port) || 5005,
      license: Number(license) || 1261,
      deviceId: String(deviceId || '').trim(),
      netPassword: Number(netPassword) || 0,
      protocolType: protocolType === null || protocolType === undefined ? -1 : Number(protocolType),
      timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : 3000,
    };
    if (cfg.ipAddress) {
      saveDeviceConfig(cfg);
      activeDeviceConfig = cfg;
    }
    res.json({ success: true, data: cfg });
  } catch (err) {
    console.error('Failed to save device config via API', err);
    res.status(500).json({ success: false, error: 'Failed to save device config' });
  }
});

app.post('/api/device/disconnect', async (req, res) => {
  const result = await sendCommand('DISCONNECT');
  currentDevice = null;
  stopLogPoll();
  autoConnectEnabled = false;
  if (autoConnectTimer) { clearTimeout(autoConnectTimer); autoConnectTimer = null; }
  apiResult(res, result);
});

app.post('/api/device/reconnect', (req, res) => {
  // Re-enable auto-connect and trigger immediately
  autoConnectEnabled = true;
  autoConnectAttempt = 0;
  scheduleAutoConnect(0);
  res.json({ success: true, message: 'Auto-connect re-enabled' });
});

app.get('/api/device/status', async (req, res) => {
  const result = await sendCommand('STATUS', 5000);
  if (result.success) {
    setActiveDeviceSession(result.data);
    // Emit real connected status so any SSE subscriber gets it immediately
    sseEmit('deviceStatus', {
      connected: Boolean(result.data?.connected),
      ipAddress: result.data?.ipAddress || activeDeviceConfig?.ipAddress || null,
      deviceId:  result.data?.deviceId  || null,
    });
  } else {
    // STATUS failed — device is offline, clear it so frontend shows disconnected
    currentDevice = null;
    stopLogPoll();
    sseEmit('deviceStatus', {
      connected: false,
      ipAddress: activeDeviceConfig?.ipAddress || null,
      error: result.error || 'Device not reachable',
    });
    if (autoConnectEnabled) {
      autoConnectAttempt = 0; // reset so retry starts with fast 3s backoff, not 30s
      scheduleAutoConnect(3000);
    }
  }
  apiResult(res, result);
});

app.get('/api/device/sessions', (req, res) => {
  const sessions = getConnectedDeviceSessions(deviceSessions);
  const selectedDevice = getSelectedDeviceSession(deviceSessions, currentDevice) || currentDevice;
  res.json({
    success: true,
    activeDevice: selectedDevice,
    selectedDevice,
    sessions,
    totalSessions: sessions.length,
    connectedSessionCount: sessions.length,
  });
});

app.post('/api/device/select-session', (req, res) => {
  const { sessionId, deviceId, ipAddress, address } = req.body || {};
  const target = { sessionId, deviceId, ipAddress: ipAddress || address };
  const selected = selectSessionTarget(target);

  if (!selected) {
    return res.status(404).json({ success: false, error: 'No matching live device session found.' });
  }

  res.json({
    success: true,
    selectedDevice: selected,
    activeDevice: selected,
    device: selected,
    sessions: getConnectedDeviceSessions(deviceSessions),
  });
});

app.post('/api/device/route-command', async (req, res) => {
  const { command, ipAddress, address, deviceId, sessionId, timeoutMs = 30000 } = req.body || {};

  if (!command || typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ success: false, error: 'A command string is required.' });
  }

  const target = {
    sessionId: sessionId || '',
    ipAddress: ipAddress || address || '',
    deviceId: deviceId || '',
  };

  const session = resolveSessionTarget(target) || currentDevice;
  if (!session) {
    return res.status(404).json({ success: false, error: 'No live device session is active for that target.' });
  }

  try {
    const result = await sendCommand(command, Number(timeoutMs) || 30000);
    if (result.success && result.data) {
      setActiveDeviceSession({ ...session, ...result.data, updatedAt: new Date().toISOString() });
    }

    res.json({
      success: result.success,
      command,
      target: session,
      selectedDevice: session,
      activeDevice: currentDevice,
      data: result.data || null,
      error: result.error || null,
      sessions: getConnectedDeviceSessions(deviceSessions),
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      command,
      target: session,
      selectedDevice: session,
      error: err.message,
    });
  }
});

app.post('/api/device/disconnect-session', (req, res) => {
  const { deviceId, ipAddress, address } = req.body || {};
  const target = { deviceId, ipAddress: ipAddress || address };
  const removed = removeDeviceSession(deviceSessions, target);

  if (removed && currentDevice && (
    (deviceId && currentDevice.deviceId === deviceId) ||
    ((ipAddress || address) && currentDevice.ipAddress === (ipAddress || address))
  )) {
    currentDevice = null;
  }

  res.json({
    success: true,
    removed,
    activeDevice: currentDevice,
    sessions: getConnectedDeviceSessions(deviceSessions),
  });
});

app.post('/api/device/sync-time', requireDevPassword, async (req, res) => {
  if (!currentDevice || !currentDevice.connected) return res.status(503).json({ success: false, error: 'Device is not connected', code: 'device_not_connected' });
  apiResult(res, await sendCommand('SYNC_TIME'));
});

app.post('/api/device/set-time', async (req, res) => {
  const timestamp = req.body?.timestamp;
  if (!timestamp) return res.status(400).json({ success: false, error: 'Timestamp is required' });
  apiResult(res, await sendCommand(`SET_TIME|${timestamp}`));
});

app.get('/api/device/users', requireDevPassword, async (req, res) => {
  if (!currentDevice || !currentDevice.connected) {
    return res.status(503).json({ success: false, error: 'Device is not connected', code: 'device_not_connected' });
  }
  apiResult(res, await refreshUsersCache());
});

app.post('/api/device/users', async (req, res) => {
  const userId = String(req.body?.userId || req.body?.studentDeviceId || req.body?.studentId || '').trim();
  const name = String(req.body?.name || req.body?.studentName || userId).replace(/\|/g, ' ').trim();
  const photoUrl = String(req.body?.photoUrl || req.body?.photo_url || '').trim();
  if (!userId) return res.status(400).json({ success: false, error: 'User ID is required' });

  // Save to local students.json so attendanceFromLog can display name + photo
  const existingIdx = students.findIndex((s) => s.studentDeviceId === userId || s.deviceUserId === userId);
  if (existingIdx >= 0) {
    // Update name and photo if provided
    students[existingIdx].name = name || students[existingIdx].name;
    if (photoUrl) students[existingIdx].photoUrl = photoUrl;
  } else {
    // Add new entry
    students.push(normalizeStudent({
      studentDeviceId: userId,
      name,
      photoUrl,
    }));
  }
  saveStudents();

  // Download and cache the photo immediately if we have one.
  // Use 'all-rooms' as the roomKey so it matches what attendanceFromLog uses.
  if (photoUrl) {
    const token = schoolAuthToken || null;
    syncRoomPhotoCache({
      roomKey: 'all-rooms',
      deviceId: currentDevice?.deviceId || 'tablet',
      studentsList: [{ id: userId, student_id: userId, photo_url: photoUrl, photoUrl }],
      token,
    }).catch(() => null);
  }

  const result = await sendCommand(`ADD_USER|${userId}|${name}`, 30000);
  if (result.success) await refreshUsersCache().catch(() => null);
  apiResult(res, result, 201);
});

app.delete('/api/device/users/:id', async (req, res) => {
  const userId = String(req.params.id || '').trim();
  if (!userId) return res.status(400).json({ success: false, error: 'User ID is required' });
  const result = await sendCommand(`DELETE_USER|${userId}`, 30000);
  if (result.success) usersCache = usersCache.filter((user) => user.userId !== userId);
  apiResult(res, result);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PER-DEVICE USER MANAGEMENT  (/api/devices-config/:id/...)
// Routes to the specific device's bridge process — fully parallel.
// All endpoints require dev password.
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/devices-config/:id/users — pull users from a specific device ────
app.get('/api/devices-config/:id/users', requireDevPassword, async (req, res) => {
  const bridge = bridgeManager.get(req.params.id);
  if (!bridge) return res.status(404).json({ success: false, error: 'Device not found' });
  if (!bridge.connected) return res.status(503).json({ success: false, error: 'Device not connected', code: 'device_not_connected' });

  const result = await bridge.send('GET_USERS', 60000);
  if (!result.success) return apiResult(res, result);

  const rawUsers = result.data?.users || [];
  const enriched = aggregateDeviceUsers(rawUsers).map(u => {
    const student = students.find(s => String(s.studentDeviceId) === String(u.userId) || String(s.deviceUserId) === String(u.userId));
    return { ...u, student: student || null };
  });
  res.json({ success: true, data: { users: enriched, count: enriched.length } });
});

// ── POST /api/devices-config/:id/users — add a user to a specific device ──────
app.post('/api/devices-config/:id/users', requireDevPassword, async (req, res) => {
  const bridge = bridgeManager.get(req.params.id);
  if (!bridge) return res.status(404).json({ success: false, error: 'Device not found' });
  if (!bridge.connected) return res.status(503).json({ success: false, error: 'Device not connected', code: 'device_not_connected' });

  const userId = String(req.body?.userId || req.body?.studentDeviceId || '').trim();
  const name   = String(req.body?.name || req.body?.studentName || userId).replace(/\|/g, ' ').trim();
  if (!userId) return res.status(400).json({ success: false, error: 'User ID is required' });

  const result = await bridge.send(`ADD_USER|${userId}|${name}`, 30000);
  apiResult(res, result, 201);
});

// ── DELETE /api/devices-config/:id/users/:userId — delete one user ────────────
app.delete('/api/devices-config/:id/users/:userId', requireDevPassword, async (req, res) => {
  const bridge = bridgeManager.get(req.params.id);
  if (!bridge) return res.status(404).json({ success: false, error: 'Device not found' });
  if (!bridge.connected) return res.status(503).json({ success: false, error: 'Device not connected', code: 'device_not_connected' });

  const userId = String(req.params.userId || '').trim();
  if (!userId) return res.status(400).json({ success: false, error: 'User ID is required' });

  const result = await bridge.send(`DELETE_USER|${userId}`, 30000);
  apiResult(res, result);
});

// ── POST /api/devices-config/:id/users/bulk-delete — delete multiple users ────
// Body: { userIds: string[] }
app.post('/api/devices-config/:id/users/bulk-delete', requireDevPassword, async (req, res) => {
  const bridge = bridgeManager.get(req.params.id);
  if (!bridge) return res.status(404).json({ success: false, error: 'Device not found' });
  if (!bridge.connected) return res.status(503).json({ success: false, error: 'Device not connected', code: 'device_not_connected' });

  const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds.map(String) : [];
  if (!userIds.length) return res.status(400).json({ success: false, error: 'userIds array is required' });

  const deleted = []; const failed = [];
  for (const userId of userIds) {
    const r = await bridge.send(`DELETE_USER|${userId}`, 15000);
    if (r.success) deleted.push(userId); else failed.push({ userId, error: r.error });
  }
  res.json({ success: failed.length === 0, deleted: deleted.length, failed: failed.length, failures: failed });
});

// ── PATCH /api/devices-config/:id/users/:userId — rename a user ───────────────
// FK623 has no UPDATE command — we delete and re-add with the new name.
// Body: { name: string }
app.patch('/api/devices-config/:id/users/:userId', requireDevPassword, async (req, res) => {
  const bridge = bridgeManager.get(req.params.id);
  if (!bridge) return res.status(404).json({ success: false, error: 'Device not found' });
  if (!bridge.connected) return res.status(503).json({ success: false, error: 'Device not connected', code: 'device_not_connected' });

  const userId  = String(req.params.userId || '').trim();
  const newName = String(req.body?.name || '').replace(/\|/g, ' ').trim();
  if (!userId)  return res.status(400).json({ success: false, error: 'User ID is required' });
  if (!newName) return res.status(400).json({ success: false, error: 'name is required' });

  // Delete biometric data for all backup slots, then re-add with new name
  await bridge.send(`DELETE_USER|${userId}`, 15000).catch(() => null);
  const result = await bridge.send(`ADD_USER|${userId}|${newName}`, 30000);

  // Also update local students.json
  if (result.success) {
    const idx = students.findIndex(s => String(s.studentDeviceId) === userId || String(s.deviceUserId) === userId);
    if (idx >= 0) { students[idx].name = newName; students[idx].updatedAt = new Date().toISOString(); saveStudents(); }
  }
  apiResult(res, result);
});

// ── POST /api/devices-config/:id/push-students — push students to one device ──
// Body: { studentIds?: string[], devPassword: string }
app.post('/api/devices-config/:id/push-students', requireDevPassword, async (req, res) => {
  const bridge = bridgeManager.get(req.params.id);
  if (!bridge) return res.status(404).json({ success: false, error: 'Device not found' });
  if (!bridge.connected) return res.status(503).json({ success: false, error: 'Device not connected', code: 'device_not_connected' });

  const ids = Array.isArray(req.body?.studentIds) ? req.body.studentIds : [];
  const selected = ids.length ? students.filter(s => ids.includes(s.studentId)) : students;

  const pushed = []; const failed = [];
  for (const student of selected) {
    const r = await bridge.send(`ADD_USER|${student.studentDeviceId}|${String(student.name).replace(/\|/g, ' ')}`, 30000);
    if (r.success) pushed.push(student);
    else {
      failed.push({ student, error: r.error });
      if (isNotConnectedError(r.error)) {
        sseEmit('devicesStatus', { id: req.params.id, connected: false, error: r.error });
        break;
      }
    }
  }
  res.json({ success: failed.length === 0, data: { pushed: pushed.length, failed: failed.length, failures: failed } });
});

// ── POST /api/devices-config/:id/pull-logs — pull logs from a specific device ──
// No dev password required — this is called automatically by the server pull-logs job.
app.post('/api/devices-config/:id/pull-logs', async (req, res) => {
  const bridge = bridgeManager.get(req.params.id);
  if (!bridge) return res.status(404).json({ success: false, error: 'Device not found' });
  if (!bridge.connected) return res.status(503).json({ success: false, error: 'Device not connected', code: 'device_not_connected' });

  const readMark = req.body?.readMark === 1 || req.query.readMark === '1' ? 1 : 0;
  let result = await bridge.send(`GET_LOGS|${readMark}`, 90000);

  // Fallback: if readMark=1 returns nothing, re-fetch all logs
  if (result.success && (result.data?.logs || []).length === 0 && readMark === 1) {
    result = await bridge.send('GET_LOGS|0', 90000);
  }

  if (!result.success && bridge._isOfflineError(result.error)) {
    sseEmit('devicesStatus', { id: req.params.id, connected: false, error: result.error, source: 'pull-logs' });
    return res.status(503).json({ ...result, code: 'device_not_connected' });
  }

  res.json(result);
});

// ── POST /api/devices-config/:id/clear-logs — clear logs on a specific device ──
app.post('/api/devices-config/:id/clear-logs', requireDevPassword, async (req, res) => {
  const bridge = bridgeManager.get(req.params.id);
  if (!bridge) return res.status(404).json({ success: false, error: 'Device not found' });
  if (!bridge.connected) return res.status(503).json({ success: false, error: 'Device not connected', code: 'device_not_connected' });
  const result = await bridge.send('CLEAR_LOGS', 30000);
  res.json(result);
});

// ── POST /api/devices-config/:id/clear-all — delete ALL users + logs on a specific device ──
// Each FK623 has its own user database — this only wipes the targeted device.
app.post('/api/devices-config/:id/clear-all', requireDevPassword, async (req, res) => {
  const bridge = bridgeManager.get(req.params.id);
  if (!bridge) return res.status(404).json({ success: false, error: 'Device not found' });
  if (!bridge.connected) return res.status(503).json({ success: false, error: 'Device not connected', code: 'device_not_connected' });
  const result = await bridge.send('CLEAR_ALL', 60000);
  if (!result.success && bridge._isOfflineError(result.error)) {
    sseEmit('devicesStatus', { id: req.params.id, connected: false, error: result.error });
  }
  res.json(result);
});

// ── DELETE /api/devices-config/:id/users/clear — delete ALL users on a specific device ──
// Alias for clear-all when only users need to be removed (not logs).
app.delete('/api/devices-config/:id/users', requireDevPassword, async (req, res) => {
  const bridge = bridgeManager.get(req.params.id);
  if (!bridge) return res.status(404).json({ success: false, error: 'Device not found' });
  if (!bridge.connected) return res.status(503).json({ success: false, error: 'Device not connected', code: 'device_not_connected' });
  // FK623 has no "delete all users" command — CLEAR_ALL wipes users + logs
  const result = await bridge.send('CLEAR_ALL', 60000);
  res.json(result);
});

// ── POST /api/devices-config/:id/sync-time — sync clock on a specific device ──
app.post('/api/devices-config/:id/sync-time', requireDevPassword, async (req, res) => {
  const bridge = bridgeManager.get(req.params.id);
  if (!bridge) return res.status(404).json({ success: false, error: 'Device not found' });
  if (!bridge.connected) return res.status(503).json({ success: false, error: 'Device not connected', code: 'device_not_connected' });
  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const result = await bridge.send(`SET_TIME|${now}`, 10000);
  res.json(result);
});

// ── GET /api/devices-config/:id/ping — ping FK623 device via its bridge ──────
// The bridge sends a STATUS command to the FK623 and returns whether it is
// reachable on the school LAN. This is the per-device equivalent of /api/health.
// No dev password required — this is a read-only connectivity check.
app.get('/api/devices-config/:id/ping', async (req, res) => {
  const bridge = bridgeManager.get(req.params.id);
  if (!bridge) return res.status(404).json({ success: false, error: 'Device not found', connected: false });

  // If the bridge process is not even running/ready, FK623 is unreachable
  if (!bridge._ready) {
    return res.json({
      success: true,
      connected: false,
      fk623Reachable: false,
      bridgeReady: false,
      message: 'Bridge process not ready',
      deviceId: req.params.id,
    });
  }

  try {
    // Send STATUS command — FK623 SDK checks TCP connection to the device
    const result = await bridge.send('STATUS', 5000);
    const fk623Connected = result.success && Boolean(result.data?.connected);
    const deviceInfo = result.data || {};

    // Update the bridge's internal connected state so SSE reflects this
    if (result.success) {
      bridge.connected = fk623Connected;
      bridge.deviceInfo = deviceInfo;
    }

    res.json({
      success: true,
      connected: fk623Connected,
      fk623Reachable: fk623Connected,
      bridgeReady: true,
      bridgeConnected: bridge.connected,
      deviceInfo: fk623Connected ? {
        deviceId:    deviceInfo.deviceId,
        serialNumber: deviceInfo.serialNumber,
        users:       deviceInfo.deviceUserCount ?? deviceInfo.users ?? 0,
        logs:        deviceInfo.logCount        ?? deviceInfo.logs  ?? 0,
        productName: deviceInfo.productName,
        ipAddress:   deviceInfo.ipAddress,
      } : null,
      message: fk623Connected
        ? 'FK623 is connected and responding'
        : (result.error || 'FK623 not reachable on local network'),
      deviceId: req.params.id,
    });
  } catch (err) {
    res.json({
      success: true,
      connected: false,
      fk623Reachable: false,
      bridgeReady: true,
      message: (err instanceof Error ? err.message : String(err)) || 'Ping failed',
      deviceId: req.params.id,
    });
  }
});

app.post('/api/device/pull-logs', async (req, res) => {
  if (!currentDevice || !currentDevice.connected) return res.status(503).json({ success: false, error: 'Device is not connected', code: 'device_not_connected' });
  const readMark = req.body?.readMark === 1 || req.query.readMark === '1' ? 1 : 0;
  let result = await sendCommand(`GET_LOGS|${readMark}`, 90000);
  if (result.success && (result.data?.logs || []).length === 0 && readMark === 1) {
    result = await sendCommand('GET_LOGS|0', 90000);
  }
  if (result.success) {
    const newLogs = Array.isArray(result.data?.logs) ? result.data.logs : [];
    logsCache = newLogs;
    newLogs.map(attendanceFromLog).forEach((l) => seenLogIds.add(l.id));
  } else if (isNotConnectedError(result.error)) {
    currentDevice = null;
    sseEmit('deviceStatus', { connected: false, error: result.error, source: 'pull-logs' });
    return res.status(503).json({ ...result, code: 'device_not_connected' });
  }
  apiResult(res, result);
});

app.post('/api/device/push-students', requireDevPassword, async (req, res) => {
  // Check device is actually connected before attempting
  if (!currentDevice || !currentDevice.connected) {
    return res.status(503).json({ success: false, error: 'Device is not connected. Connect the FK623 device first.', code: 'device_not_connected' });
  }
  const ids = Array.isArray(req.body?.studentIds) ? req.body.studentIds : [];
  const selected = ids.length ? students.filter((student) => ids.includes(student.studentId)) : students;
  const pushed = [];
  const failed = [];
  for (const student of selected) {
    const result = await sendCommand(`ADD_USER|${student.studentDeviceId}|${String(student.name).replace(/\|/g, ' ')}`, 30000);
    if (result.success) pushed.push(student);
    else {
      const code = isNotConnectedError(result.error) ? 'device_not_connected' : 'push_failed';
      failed.push({ student, error: result.error, code });
      // If device disconnected mid-push, stop trying
      if (code === 'device_not_connected') {
        currentDevice = null;
        sseEmit('deviceStatus', { connected: false, error: result.error, source: 'push-students' });
        break;
      }
    }
  }
  if (pushed.length) await refreshUsersCache().catch(() => null);

  // Download and cache photos for successfully pushed students.
  // Photos are stored locally so they display instantly on the attendance flash card
  // even without an active internet connection.
  if (pushed.length > 0) {
    const token = schoolAuthToken || null;
    const photoStudents = pushed
      .filter((s) => s.photoUrl || s.photo_url)
      .map((s) => ({
        id: s.studentId || s.id,
        student_id: s.studentId || s.id,
        photo_url: s.photoUrl || s.photo_url || '',
        photoUrl:  s.photoUrl || s.photo_url || '',
      }));
    if (photoStudents.length > 0) {
      // Fire and forget — don't block the push response.
      // Use 'all-rooms' so photos match what attendanceFromLog resolves.
      syncRoomPhotoCache({
        roomKey:      'all-rooms',
        deviceId:     currentDevice?.deviceId || 'tablet',
        studentsList: photoStudents,
        token,
      }).catch((err) => console.warn('[PhotoCache] Photo sync failed after push:', err?.message));
    }
  }

  res.json({
    success: failed.length === 0,
    data: { pushed: pushed.length, failed: failed.length, failures: failed },
    error: failed[0]?.error || null,
    code: failed.length > 0 && failed.every(f => f.code === 'device_not_connected') ? 'device_not_connected' : null,
  });
});

app.post('/api/device/clear-logs', requireDevPassword, async (req, res) => {
  if (!currentDevice || !currentDevice.connected) return res.status(503).json({ success: false, error: 'Device is not connected', code: 'device_not_connected' });
  apiResult(res, await sendCommand('CLEAR_LOGS'));
});
app.post('/api/device/clear-all', requireDevPassword, async (req, res) => {
  if (!currentDevice || !currentDevice.connected) return res.status(503).json({ success: false, error: 'Device is not connected', code: 'device_not_connected' });
  apiResult(res, await sendCommand('CLEAR_ALL'));
});
app.post('/api/device/poweroff', requireDevPassword, async (req, res) => {
  if (!currentDevice || !currentDevice.connected) return res.status(503).json({ success: false, error: 'Device is not connected', code: 'device_not_connected' });
  apiResult(res, await sendCommand('POWEROFF'));
});

app.get('/api/dashboard/stats', async (req, res) => {
  if (!currentDevice) {
    const status = await sendCommand('STATUS', 10000).catch(() => null);
    if (status?.success) currentDevice = status.data;
  }
  const today = new Date().toDateString();
  const todayLogs = logsCache.filter((log) => new Date(log.timestamp).toDateString() === today);
  const lateCount = todayLogs
    .map(attendanceFromLog)
    .filter((log) => String(log.status).toLowerCase().includes('late')).length;

  // Per-device student counts using the devices list
  const devicesList = loadDevicesList();
  const perDevice = devicesList.map(d => {
    const bridge = bridgeManager.get(d.id);
    const isConnected = bridge ? bridge.connected : !!(deviceStatusMap.get(d.id)?.connected);
    return {
      id:        d.id,
      name:      d.name,
      ipAddress: d.ipAddress,
      location:  d.location,
      connected: isConnected,
      deviceInfo: bridge?.deviceInfo || null,
      studentCount: students.filter(s =>
        s.registeredOnDevice === d.ipAddress ||
        s.assignedDeviceId   === d.ipAddress
      ).length,
    };
  });

  const onlineCount = devicesList.length
    ? devicesList.filter(d => {
        const bridge = bridgeManager.get(d.id);
        return bridge ? bridge.connected : !!(deviceStatusMap.get(d.id)?.connected);
      }).length
    : (currentDevice?.connected ? 1 : 0);

  res.json({
    success: true,
    stats: {
      totalStudents: students.length || usersCache.length,
      totalDevices: devicesList.length || (currentDevice ? 1 : 0),
      onlineDevices: onlineCount,
      attendanceToday: new Set(todayLogs.map((log) => log.userId)).size,
      lateStudents: lateCount,
      totalLogs: logsCache.length,
    },
    perDevice,
  });
});

app.get('/api/dashboard/recent', (req, res) => {
  res.json({ success: true, recent: logsCache.slice(0, 20).map(attendanceFromLog) });
});

app.get('/api/students', async (req, res) => {
  // Filters: ?deviceId=192.168.1.x  ?date=2026-11-09  ?search=name  ?class=S1
  const { deviceId, date, search, class: classFilter } = req.query || {};

  let merged = students.map((student) => {
    const deviceUser = usersCache.find((user) => user.userId === student.studentDeviceId);
    return { ...student, deviceUser, biometricMethods: deviceUser?.biometricMethods || [] };
  });

  // Filter by device (IP address stored in registeredOnDevice)
  if (deviceId && String(deviceId).trim()) {
    const dId = String(deviceId).trim();
    merged = merged.filter(s =>
      s.registeredOnDevice === dId ||
      s.assignedDeviceId === dId ||
      s.studentDeviceId === dId
    );
  }

  // Filter by registration date (createdAt)
  if (date && String(date).trim()) {
    const targetDate = String(date).trim(); // expected: YYYY-MM-DD
    merged = merged.filter(s => {
      if (!s.createdAt) return false;
      return s.createdAt.slice(0, 10) === targetDate;
    });
  }

  // Filter by name / studentId search
  if (search && String(search).trim()) {
    const q = String(search).trim().toLowerCase();
    merged = merged.filter(s =>
      (s.name || '').toLowerCase().includes(q) ||
      (s.studentId || '').toLowerCase().includes(q) ||
      (s.studentDeviceId || '').toLowerCase().includes(q)
    );
  }

  // Filter by class
  if (classFilter && String(classFilter).trim() !== 'all') {
    const cls = String(classFilter).trim();
    merged = merged.filter(s => (s.className || '') === cls);
  }

  res.json({ success: true, students: merged, count: merged.length, total: students.length });
});

app.post('/api/students', requireDevPassword, async (req, res) => {
  const student = normalizeStudent(req.body);
  if (!student.name) return res.status(400).json({ success: false, error: 'Student full name is required' });
  if (!student.studentDeviceId) return res.status(400).json({ success: false, error: 'Student device ID is required' });
  if (!student.studentId.startsWith('RW-')) return res.status(400).json({ success: false, error: 'Student ID must start with Rwanda suffix RW-, for example RW-0001' });

  // Stamp which device this student was registered on (IP + name from config)
  if (!student.registeredOnDevice && activeDeviceConfig?.ipAddress) {
    student.registeredOnDevice = activeDeviceConfig.ipAddress;
  }

  const existingIndex = students.findIndex((item) => item.studentId === student.studentId || item.studentDeviceId === student.studentDeviceId);
  if (existingIndex >= 0) students[existingIndex] = { ...students[existingIndex], ...student, updatedAt: new Date().toISOString() };
  else students.push(student);
  saveStudents();

  let pushResult = null;
  let pushCode = null;
  if (req.body.pushToDevice !== false) {
    if (!currentDevice || !currentDevice.connected) {
      // Save locally but tell frontend device is offline
      return res.json({
        success: true,
        savedLocally: true,
        pushResult: null,
        student,
        warning: 'Student saved locally. Device is not connected — push to device when device is online.',
        code: 'device_not_connected',
      });
    }
    pushResult = await sendCommand(`ADD_USER|${student.studentDeviceId}|${String(student.name).replace(/\|/g, ' ')}`, 30000);
    await refreshUsersCache().catch(() => null);
    if (!pushResult.success) {
      pushCode = isNotConnectedError(pushResult.error) ? 'device_not_connected' : 'push_failed';
      if (pushCode === 'device_not_connected') {
        currentDevice = null;
        sseEmit('deviceStatus', { connected: false, error: pushResult.error, source: 'register-student' });
      }
    }
  }

  res.json({
    success: !pushResult || pushResult.success,
    savedLocally: true,
    student,
    pushResult,
    code: pushCode,
    error: pushResult?.success === false ? pushResult.error : null,
  });
});

app.delete('/api/students/:id', requireDevPassword, async (req, res) => {
  const student = students.find((item) => item.studentId === req.params.id || item.studentDeviceId === req.params.id);
  const deviceId = student?.studentDeviceId || req.params.id;

  // Always remove from local list first
  students = students.filter((item) => item.studentId !== req.params.id && item.studentDeviceId !== req.params.id);
  saveStudents();

  // Try to remove from device — not fatal if device is offline
  if (currentDevice && currentDevice.connected) {
    const result = await sendCommand(`DELETE_USER|${deviceId}`);
    if (result.success) {
      usersCache = usersCache.filter((user) => user.userId !== deviceId);
      return res.json({ success: true, removedFromDevice: true });
    } else {
      const code = isNotConnectedError(result.error) ? 'device_not_connected' : 'delete_failed';
      if (code === 'device_not_connected') {
        currentDevice = null;
        sseEmit('deviceStatus', { connected: false, error: result.error, source: 'delete-student' });
      }
      return res.json({ success: true, removedLocally: true, removedFromDevice: false, deviceError: result.error, code });
    }
  }
  // Device offline — removed locally only
  res.json({ success: true, removedLocally: true, removedFromDevice: false, code: 'device_not_connected' });
});

app.get('/api/devices', (req, res) => {
  res.json({ success: true, devices: currentDevice ? [currentDevice] : [] });
});

app.post('/api/devices', (req, res) => {
  currentDevice = { ...req.body, connected: false };
  res.json({ success: true, data: currentDevice, device: currentDevice });
});

app.get('/api/attendance', (req, res) => {
  res.json({ success: true, attendance: logsCache.map(attendanceFromLog), count: logsCache.length });
});

app.get('/api/attendance/settings', (req, res) => {
  res.json({ success: true, settings: attendanceSettings });
});

app.put('/api/attendance/settings', (req, res) => {
  try {
    attendanceSettings = normalizeAttendanceSettings(req.body || {});
    saveAttendanceSettings();
    res.json({ success: true, settings: attendanceSettings });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || 'Invalid attendance settings' });
  }
});

app.get('/api/attendance/today', (req, res) => {
  const today = new Date().toDateString();
  const todayLogs = logsCache.filter((log) => new Date(log.timestamp).toDateString() === today).map(attendanceFromLog);
  res.json({ success: true, summary: { total: todayLogs.length, checkIns: todayLogs.length, uniqueStudents: new Set(todayLogs.map((log) => log.studentDeviceId)).size } });
});

// POST /api/attendance/push-to-server
// Pushes FK623 biometric attendance logs to the school server via /gate/logs.
// Body: { since?: ISO-date-string } — optional, default = today only.
// Requires staff to be logged in (schoolAuthToken must exist).
// Returns: { success, pushed, failed, skipped, errors[] }
app.post('/api/attendance/push-to-server', async (req, res) => {
  if (!schoolAuthToken) {
    return res.status(401).json({
      success: false,
      error: 'Not logged in to school server. Open the login panel and sign in first.',
    });
  }

  // Decide which logs to push
  const since = req.body?.since ? new Date(req.body.since) : null;
  const logsToSend = since
    ? logsCache.filter((log) => new Date(log.timestamp) >= since)
    : logsCache;

  if (logsToSend.length === 0) {
    return res.json({ success: true, pushed: 0, failed: 0, skipped: 0, total: 0, message: 'No logs to push' });
  }

  let pushed = 0;
  let failed = 0;
  const errors = [];

  for (const raw of logsToSend) {
    const log = attendanceFromLog(raw);
    const payload = {
      student_id:    log.studentDeviceId || raw.userId,
      student_name:  log.studentName,
      device_id:     log.deviceId || currentDevice?.deviceId || TABLET_UUID || 'tablet',
      tablet_uuid:   TABLET_UUID || null,
      method:        log.authenticationMethod,
      direction:     log.direction || raw.direction || 'IN',
      timestamp:     log.timestamp || raw.timestamp,
      status:        log.status,
      boot_id:       BOOT_ID,
      log_id:        raw.id || null,
    };

    try {
      const { status: httpStatus } = await relayToServer('POST', '/gate/logs', payload, schoolAuthToken);
      if (httpStatus >= 200 && httpStatus < 300) {
        pushed++;
      } else {
        failed++;
        errors.push({ logId: raw.id, status: httpStatus });
      }
    } catch (err) {
      failed++;
      errors.push({ logId: raw.id, error: err.message });
    }
  }

  console.log(`[AttendancePush] pushed=${pushed} failed=${failed} total=${logsToSend.length}`);
  res.json({
    success: failed === 0,
    pushed,
    failed,
    skipped: logsCache.length - logsToSend.length,
    total: logsToSend.length,
    errors: errors.slice(0, 10), // cap at 10 so response stays small
    message: failed === 0
      ? `Successfully pushed ${pushed} attendance record(s) to school server`
      : `Pushed ${pushed}, failed ${failed} — check errors array`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SERVER-TRIGGERED ENDPOINTS
// The school server calls these to remotely trigger actions on the tablet.
// Authentication: the server must pass the tablet's TABLET_UUID as a Bearer
// token in the Authorization header — prevents unauthorized callers.
//
//   Authorization: Bearer <TABLET_UUID>
//
// All endpoints return immediately with a job-started response; the actual
// work (FK623 commands) runs asynchronously so the server doesn't time out.
// ─────────────────────────────────────────────────────────────────────────────

function requireTabletToken(req, res, next) {
  if (!TABLET_UUID) return next(); // no UUID configured yet — allow during setup
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (token !== TABLET_UUID) {
    return res.status(403).json({ success: false, error: 'Invalid tablet token' });
  }
  next();
}

// POST /api/tablet/pull-students
// Server → Tablet: pull the latest students list from the school server
// and save them to local students.json. Also pushes them to the FK623 device.
app.post('/api/tablet/pull-students', requireTabletToken, async (req, res) => {
  res.json({ success: true, message: 'Student pull started in background' });

  // Run asynchronously so HTTP response returns immediately
  setImmediate(async () => {
    try {
      if (!schoolAuthToken) {
        console.log('[tablet/pull-students] No school auth token — skipping server fetch, pushing local students to device');
        if (students.length > 0) {
          const result = await sendCommand('GET_USERS', 30000).catch(() => null);
          console.log(`[tablet/pull-students] Pushed ${students.length} local students to FK623`);
        }
        return;
      }
      // Fetch students from school server
      const { status: httpStatus, json: serverStudents } = await relayToServer('GET', '/students?limit=500', null, schoolAuthToken);
      if (httpStatus !== 200 || !serverStudents) {
        console.warn(`[tablet/pull-students] Server returned ${httpStatus}`);
        return;
      }
      const list = Array.isArray(serverStudents) ? serverStudents : (serverStudents.data || serverStudents.students || []);
      if (!list.length) { console.log('[tablet/pull-students] No students from server'); return; }

      // Merge into local students.json (upsert by studentId)
      let changed = 0;
      for (const s of list) {
        const studentDeviceId = String(s.biometric_id || s.student_device_id || s.id || '').trim();
        if (!studentDeviceId) continue;
        const studentId = String(s.student_id || s.studentId || `RW-${studentDeviceId}`).trim().toUpperCase();
        const existing = students.findIndex(x => x.studentId === studentId || x.studentDeviceId === studentDeviceId);
        const record = {
          id: studentId, studentId,
          name: String(s.name || s.full_name || '').trim(),
          className: String(s.class_name || s.className || '').trim(),
          section: String(s.section || '').trim(),
          studentDeviceId,
          deviceUserId: studentDeviceId,
          photoUrl: s.photo_url || s.photoUrl || '',
          assignedDeviceId: currentDevice?.deviceId || '',
          updatedAt: new Date().toISOString(),
          createdAt: existing >= 0 ? students[existing].createdAt : new Date().toISOString(),
        };
        if (existing >= 0) { students[existing] = { ...students[existing], ...record }; }
        else { students.push(record); }
        changed++;
      }
      if (changed > 0) saveStudents();
      console.log(`[tablet/pull-students] Merged ${changed} students from server`);

      // Push all to FK623 device
      const pushed = []; const failed = [];
      for (const s of students) {
        const r = await sendCommand(`ADD_USER|${s.studentDeviceId}|${String(s.name).replace(/\|/g, ' ')}`, 15000);
        if (r.success) pushed.push(s); else failed.push(s);
      }
      if (pushed.length) await refreshUsersCache().catch(() => null);
      console.log(`[tablet/pull-students] FK623 push: ${pushed.length} ok, ${failed.length} failed`);

      // Emit SSE so frontend updates without reload
      sseEmit('studentsUpdated', { count: students.length });
    } catch (err) {
      console.error('[tablet/pull-students] Error:', err.message);
    }
  });
});

// POST /api/tablet/push-attendance
// Server → Tablet: push all cached FK623 attendance logs to the school server.
// Body: { since?: ISO-date-string } — optional filter.
app.post('/api/tablet/push-attendance', requireTabletToken, async (req, res) => {
  if (!schoolAuthToken) {
    return res.status(401).json({
      success: false,
      error: 'Tablet is not logged in to the school server. Login first via /api/school/login',
    });
  }
  const since = req.body?.since ? new Date(req.body.since) : null;
  const logsToSend = since ? logsCache.filter(l => new Date(l.timestamp) >= since) : logsCache;

  res.json({ success: true, message: `Attendance push started for ${logsToSend.length} log(s)`, total: logsToSend.length });

  setImmediate(async () => {
    let pushed = 0; let failed = 0;
    for (const raw of logsToSend) {
      const log = attendanceFromLog(raw);
      const payload = {
        student_id:  log.studentDeviceId || raw.userId,
        device_id:   log.deviceId || currentDevice?.deviceId || TABLET_UUID || 'tablet',
        tablet_uuid: TABLET_UUID || null,
        method:      log.authenticationMethod,
        direction:   log.direction || raw.direction || 'IN',
        timestamp:   log.timestamp || raw.timestamp,
        status:      log.status,
        boot_id:     BOOT_ID,
        log_id:      raw.id || null,
      };
      try {
        const { status: s } = await relayToServer('POST', '/gate/logs', payload, schoolAuthToken);
        if (s >= 200 && s < 300) pushed++; else failed++;
      } catch { failed++; }
    }
    console.log(`[tablet/push-attendance] pushed=${pushed} failed=${failed} total=${logsToSend.length}`);
    sseEmit('attendancePushComplete', { pushed, failed, total: logsToSend.length });
  });
});

// GET /api/tablet/status
// Server → Tablet: get current tablet health snapshot.
// Used by the server to monitor all tablets in one dashboard.
app.get('/api/tablet/status', requireTabletToken, (req, res) => {
  res.json({
    success:        true,
    tabletUuid:     TABLET_UUID,
    deviceConnected: !!(currentDevice && currentDevice.connected),
    deviceIp:       currentDevice?.ipAddress || activeDeviceConfig?.ipAddress || null,
    studentsCount:  students.length,
    logsCount:      logsCache.length,
    bridgeReady,
    bootId:         BOOT_ID,
    vpnIp:          null, // filled by WireGuard status separately
    serverApiUrl:   SERVER_API_URL,
    timestamp:      new Date().toISOString(),
  });
});

// ├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼
// WireGuard VPN Setup Endpoints
// These run PowerShell on the Windows tablet so the super admin can set up
// the VPN tunnel from a web browser without touching a terminal.
//
// Flow:
//   1. GET  /api/wireguard/status       ├óΓÇáΓÇÖ check if WireGuard is installed & tunnel state
//   2. POST /api/wireguard/generate-keys ├óΓÇáΓÇÖ generate a new private+public key pair
//   3. POST /api/wireguard/install       ├óΓÇáΓÇÖ write the tunnel config and activate it
//   4. GET  /api/wireguard/status        ├óΓÇáΓÇÖ verify tunnel is Active
// ├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼├óΓÇ¥Γé¼


// Run a PowerShell command and return stdout, rejecting on non-zero exit.
function runPS(script, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const ps = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.trim() || err.message));
        resolve(stdout.trim());
      }
    );
  });
}

function runWg(...args) {
  return new Promise((resolve, reject) => {
    execFile(WG_EXE, args, { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout.trim());
    });
  });
}

// GET /api/wireguard/status
// Returns: installed, tunnelActive, tunnelName, vpnIp, publicKey (if keys exist)
app.get('/api/wireguard/status', async (req, res) => {
  // Check if running as Administrator ΓÇö WireGuard tunnel service requires it
  let isAdmin = false;
  try {
    await runPS('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]"Administrator")', 5000);
    isAdmin = true;
  } catch {
    // If the PS command fails, try a simpler test
    try {
      await runPS('net session', 3000);
      isAdmin = true;
    } catch { isAdmin = false; }
  }
  const wgExeExists  = fsSync.existsSync(WG_EXE);
  const wguiExists   = fsSync.existsSync('C:\\Program Files\\WireGuard\\wireguard.exe');
  const installed    = wgExeExists && wguiExists;
  let tunnelActive  = false;
  let vpnIp         = null;
  let publicKey     = null;
  let lastHandshake = null;
  let tunnelExists  = false;
  let activeTunnelName = WIREGUARD_TUNNEL_NAME;

  if (installed) {
    // Use netsh to detect WireGuard adapter ΓÇö fast, no admin needed
    try {
      const netshOut = await new Promise((resolve) => {
        execFile('netsh', ['interface', 'ipv4', 'show', 'addresses'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
          resolve(err ? '' : stdout);
        });
      });
      // Also check adapter list via ipconfig
      const ipconfigOut = await new Promise((resolve) => {
        execFile('ipconfig', [], { timeout: 5000, windowsHide: true }, (err, stdout) => {
          resolve(err ? '' : stdout);
        });
      });
      // Look for 10.0.x.x address ΓÇö if present the WireGuard tunnel is up
      const vpnMatch = ipconfigOut.match(/IPv4 Address[.\s]+:\s*(10\.0\.\d+\.\d+)/i);
      if (vpnMatch) {
        tunnelActive = true;
        tunnelExists = true;
        vpnIp = vpnMatch[1];
      } else {
        // Check if adapter exists but not connected
        const adapterOut = await new Promise((resolve) => {
          execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            'Get-NetAdapter | Where-Object { $_.InterfaceDescription -like "*WireGuard*" } | Select-Object -ExpandProperty Status'
          ], { timeout: 6000, windowsHide: true }, (err, stdout) => {
            resolve(err ? '' : stdout);
          });
        });
        if (adapterOut.trim()) tunnelExists = true;
        if (adapterOut.toLowerCase().includes('up')) tunnelActive = true;
      }
    } catch { /* detection failed */ }

    // Read saved public key from disk
    try {
      const keyFile = path.join(__dirname, 'data', 'wireguard-public.key');
      if (fsSync.existsSync(keyFile)) {
        publicKey = fsSync.readFileSync(keyFile, 'utf8').trim();
        if (!/^[A-Za-z0-9+/]{43}=$/.test(publicKey)) publicKey = null;
      }
    } catch { /* no saved key */ }
  }

  // Read VPN IP from saved config if adapter method did not get it
  if (!vpnIp) {
    try {
      const confPath = path.join(WG_TUNNEL_DIR, `${WIREGUARD_TUNNEL_NAME}.conf`);
      if (fsSync.existsSync(confPath)) {
        const conf = fsSync.readFileSync(confPath, 'utf8');
        const m = conf.match(/^Address\s*=\s*([\d.]+)(?:\/\d+)?/im);
        if (m) vpnIp = m[1];
      }
    } catch { /* ignore */ }
  }

  res.json({
    success: true,
    installed,
    isAdmin,           // frontend uses this to warn user if bridge is not elevated
    wgExeExists,
    tunnelExists,
    tunnelActive,
    tunnelName: WIREGUARD_TUNNEL_NAME,
    vpnIp,
    publicKey,
    lastHandshake,
    wgPath: WG_EXE,
  });
});

// POST /api/wireguard/generate-keys
// Generates a new WireGuard key pair on the tablet.
// Returns: { privateKey, publicKey }
// The super admin copies the publicKey and pastes it into the server web UI.
app.post('/api/wireguard/generate-keys', async (req, res) => {
  const wireguardStatus = await getWireGuardRuntimeStatus();
  if (!wireguardStatus.installed && !wireguardStatus.configExists) {
    return res.status(400).json({
      success: false,
      error: 'WireGuard is not installed. Download from https://www.wireguard.com/install/ and install it first.',
      downloadUrl: 'https://www.wireguard.com/install/',
      status: wireguardStatus,
    });
  }

  try {
    // Step 1: generate private key
    const privateKey = await runWg('genkey');
    if (!privateKey || privateKey.length < 40) {
      throw new Error('wg genkey returned an empty or invalid key');
    }

    // Step 2: derive public key ├óΓé¼ΓÇ¥ pipe private key to `wg pubkey` via stdin (safe, no shell injection)
    const publicKey = await new Promise((resolve, reject) => {
      const child = execFile(WG_EXE, ['pubkey'], { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.trim() || err.message));
        const key = stdout.trim();
        if (!key || key.length < 40) return reject(new Error('wg pubkey returned an empty result'));
        resolve(key);
      });
      // Write private key to wg pubkey's stdin and close it
      child.stdin.write(privateKey + '\n');
      child.stdin.end();
    });

    // Validate both keys look like real WireGuard keys (44-char base64 ending in =)
    const keyRegex = /^[A-Za-z0-9+/]{43}=$/;
    if (!keyRegex.test(privateKey)) throw new Error(`Generated private key has invalid format: "${privateKey}"`);
    if (!keyRegex.test(publicKey))  throw new Error(`Derived public key has invalid format: "${publicKey}"`);

    // Save keys to disk
    const keyDir = path.join(__dirname, 'data');
    if (!fsSync.existsSync(keyDir)) fsSync.mkdirSync(keyDir, { recursive: true });
    fsSync.writeFileSync(path.join(keyDir, 'wireguard-private.key'), privateKey, { mode: 0o600 });
    fsSync.writeFileSync(path.join(keyDir, 'wireguard-public.key'),  publicKey);

    console.log(`[WireGuard] Keys generated. Public: ${publicKey}`);
    res.json({ success: true, privateKey, publicKey });
  } catch (err) {
    console.error('[WireGuard] Key generation failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/wireguard/install
// Installs and activates the WireGuard tunnel on the tablet.
// Body: { serverPublicKey, serverEndpoint, vpnIp, dns? }
// The super admin pastes the serverPublicKey (from the server web UI) and the assigned VPN IP.
app.post('/api/wireguard/install', async (req, res) => {
  const { serverPublicKey, serverEndpoint, vpnIp, dns = '1.1.1.1', tunnelName } = req.body || {};
  const effectiveTunnelName = tunnelName || WIREGUARD_TUNNEL_NAME;

  if (!serverPublicKey) return res.status(400).json({ success: false, error: 'serverPublicKey is required' });
  if (!serverEndpoint)  return res.status(400).json({ success: false, error: 'serverEndpoint is required (e.g. 169.58.124.150:51820)' });
  if (!vpnIp)           return res.status(400).json({ success: false, error: 'vpnIp is required (e.g. 10.0.0.2)' });

  const wireguardStatus = await getWireGuardRuntimeStatus();
  if (!wireguardStatus.installed && !wireguardStatus.configExists) {
    return res.status(400).json({
      success: false,
      error: 'WireGuard is not installed.',
      downloadUrl: 'https://www.wireguard.com/install/',
      status: wireguardStatus,
    });
  }

  // Load saved private key
  const privateKeyFile = path.join(__dirname, 'data', 'wireguard-private.key');
  if (!fsSync.existsSync(privateKeyFile)) {
    return res.status(400).json({
      success: false,
      error: 'No private key found. Generate keys first using the Generate Keys step.',
    });
  }
  const privateKey = fsSync.readFileSync(privateKeyFile, 'utf8').trim();

  const { confPath, tempConfPath } = ensureWireGuardConfigFile({
    privateKey,
    serverPublicKey,
    vpnIp,
    dns: dns || WG_DNS,
    serverEndpoint,
    allowedIPs: VPN_ALLOWED_IPS,
    tunnelName: effectiveTunnelName,
  });

  // Install tunnel via WireGuard CLI (requires admin ΓÇö bridge must run as Administrator)
  try {
    // Remove existing tunnel (elevated via RunAs ΓÇö works even if backend is not admin)
    await runPS(`Start-Process -FilePath 'C:\\Program Files\\WireGuard\\wireguard.exe' -ArgumentList '/uninstalltunnelservice','${WIREGUARD_TUNNEL_NAME}' -Verb RunAs -Wait -ErrorAction SilentlyContinue`)
      .catch(() => null);

    // Install tunnel service with elevation ΓÇö this is why it works without running backend as admin
    await runPS(`Start-Process -FilePath 'C:\\Program Files\\WireGuard\\wireguard.exe' -ArgumentList '/installtunnelservice','${confPath.replace(/'/g, "''")}' -Verb RunAs -Wait`);

    // Give it 3s to establish
    await new Promise(r => setTimeout(r, 3000));

    // Verify tunnel is active
    const show = await runWg('show', effectiveTunnelName).catch(() => '');
    const active = show.includes('interface:') || show.includes('listening port');

    res.json({
      success: true,
      tunnelActive: active,
      vpnIp,
      confPath: tempConfPath,
      message: active
        ? `WireGuard tunnel "${effectiveTunnelName}" is active on ${vpnIp}`
        : `Tunnel installed but not yet active. If it stays inactive, open WireGuard app and import: ${tempConfPath}`,
    });
  } catch (err) {
    // Service install failed ΓÇö config file is ready, guide user to import via GUI
    const show = await runWg('show', WIREGUARD_TUNNEL_NAME).catch(() => '');
    const active = show.includes('interface:') || show.includes('listening port');
    if (active) {
      return res.json({ success: true, tunnelActive: true, vpnIp, confPath: tempConfPath, message: `Tunnel already active on ${vpnIp}` });
    }
    // Return config path so wizard can show the GUI import fallback instruction
    res.json({
      success: false,
      tunnelActive: false,
      vpnIp,
      confPath: tempConfPath,
      requiresGuiImport: true,
      error: `Auto-install failed. Open WireGuard app, click Import tunnel, select: ${tempConfPath}, then Activate.`,
    });
  }
});

// POST /api/services/install
// Installs the bridge and frontend as Windows services using NSSM so they
// start automatically on boot as SYSTEM ΓÇö no manual "Run as Administrator" needed.
app.post('/api/services/install', async (req, res) => {
  const scriptPath = path.join(__dirname, '..', 'install-services.ps1');
  if (!fsSync.existsSync(scriptPath)) {
    return res.status(404).json({
      success: false,
      error: 'install-services.ps1 not found. Make sure the script is in the Tablet Setup folder.',
    });
  }
  try {
    // Run the install script elevated ΓÇö the bridge must already be running as admin
    // for this to work (powershell Start-Process -Verb RunAs needs an elevated caller)
    const output = await runPS(
      `& '${scriptPath.replace(/'/g, "''")}' *>&1`,
      120000  // 2 minute timeout ΓÇö includes possible npm build
    );
    const success = output.includes('SETUP COMPLETE') || output.includes('is RUNNING');
    res.json({ success, output, message: success ? 'Services installed and started' : 'Install may have issues ΓÇö see output' });
  } catch (err) {
    res.json({
      success: false,
      output: err.message,
      error: 'Install script failed. Make sure the bridge is running as Administrator.',
    });
  }
});

// GET /api/services/status
// Returns status of both Windows services
app.get('/api/services/status', async (req, res) => {
  try {
    const output = await runPS(
      `@("EcaAfrica-Bridge","EcaAfrica-Frontend") | ForEach-Object { $s = Get-Service $_ -EA SilentlyContinue; "$_=$(if($s){$s.Status}else{'NotInstalled'})" }`,
      10000
    );
    const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
    const status = {};
    for (const line of lines) {
      const [name, state] = line.split('=');
      if (name && state) status[name.trim()] = state.trim();
    }
    res.json({
      success: true,
      bridgeService: status['EcaAfrica-Bridge'] || 'NotInstalled',
      frontendService: status['EcaAfrica-Frontend'] || 'NotInstalled',
      bothRunning: status['EcaAfrica-Bridge'] === 'Running' && status['EcaAfrica-Frontend'] === 'Running',
    });
  } catch (err) {
    res.json({ success: false, error: err.message, bridgeService: 'Unknown', frontendService: 'Unknown', bothRunning: false });
  }
});

// POST /api/wireguard/diagnose
// Diagnoses the VPN connection ΓÇö detects key mismatch between the running tunnel
// and the saved key in data/, and checks if the tunnel is actually connected.
// Returns everything the frontend needs to show a clear fix path.
app.post('/api/wireguard/diagnose', async (req, res) => {
  const problems = [];
  const fixes    = [];

  // 1. Is WireGuard installed?
  if (!fsSync.existsSync(WG_EXE)) {
    return res.json({ success: true, healthy: false, problems: ['WireGuard is not installed'], fixes: [] });
  }

  // 2. Is the tunnel running?
  let tunnelOutput = '';
  try {
    tunnelOutput = await runWg('show', WIREGUARD_TUNNEL_NAME);
  } catch {
    problems.push('Tunnel is not running');
    fixes.push({ action: 'restart_tunnel', label: 'Restart Tunnel' });
    return res.json({ success: true, healthy: false, problems, fixes, tunnelOutput: '' });
  }

  // 3. Parse active tunnel info
  const activeKeyMatch = tunnelOutput.match(/public key:\s*(.+)/i);
  const activeKey      = activeKeyMatch ? activeKeyMatch[1].trim() : null;
  const handshakeMatch = tunnelOutput.match(/latest handshake:\s*(.+)/i);
  const hasHandshake   = handshakeMatch && !handshakeMatch[1].includes('0 seconds');
  const endpointMatch  = tunnelOutput.match(/endpoint:\s*(.+)/i);
  const endpoint       = endpointMatch ? endpointMatch[1].trim() : null;
  const transferMatch  = tunnelOutput.match(/transfer:\s*(.+)/i);

  // 4. Check saved key matches active key
  const keyFile    = path.join(__dirname, 'data', 'wireguard-public.key');
  const savedKey   = fsSync.existsSync(keyFile) ? fsSync.readFileSync(keyFile, 'utf8').trim() : null;
  const keyMismatch = savedKey && activeKey && savedKey !== activeKey;

  if (keyMismatch) {
    problems.push(`Key mismatch: saved key (${savedKey.slice(0,16)}ΓÇª) does not match active tunnel key (${activeKey.slice(0,16)}ΓÇª)`);
    fixes.push({
      action: 'sync_key',
      label: 'Sync key ΓÇö update saved key to match running tunnel',
      activeKey,
    });
  }

  // 5. No handshake ΓÇö server doesn't know this tablet yet
  if (!hasHandshake) {
    problems.push('No handshake with server ΓÇö server may not have this key registered');
    fixes.push({
      action: 'show_register_instructions',
      label: 'Register this key on the server',
      activeKey,
    });
  }

  // 6. Read VPN IP from config
  let vpnIp = null;
  try {
    const confPath = path.join(WG_TUNNEL_DIR, `${WIREGUARD_TUNNEL_NAME}.conf`);
    if (fsSync.existsSync(confPath)) {
      const conf = fsSync.readFileSync(confPath, 'utf8');
      const m = conf.match(/^Address\s*=\s*([\d.]+)/im);
      if (m) vpnIp = m[1];
    }
  } catch { /* ignore */ }

  const healthy = problems.length === 0 && hasHandshake;

  res.json({
    success: true,
    healthy,
    activeKey,
    savedKey,
    keyMismatch: !!keyMismatch,
    hasHandshake,
    handshake: handshakeMatch?.[1]?.trim() ?? null,
    endpoint,
    transfer: transferMatch?.[1]?.trim() ?? null,
    vpnIp,
    problems,
    fixes,
    tunnelOutput,
  });
});

// POST /api/wireguard/sync-key
// Saves the active tunnel's public key to data/wireguard-public.key
// so the wizard shows the correct key ΓÇö fixes the mismatch problem.
app.post('/api/wireguard/sync-key', async (req, res) => {
  try {
    const tunnelOutput = await runWg('show', WIREGUARD_TUNNEL_NAME);
    const activeKeyMatch = tunnelOutput.match(/public key:\s*(.+)/i);
    if (!activeKeyMatch) {
      return res.status(400).json({ success: false, error: 'Tunnel is not running ΓÇö cannot read active key' });
    }
    const activeKey = activeKeyMatch[1].trim();
    const keyDir = path.join(__dirname, 'data');
    if (!fsSync.existsSync(keyDir)) fsSync.mkdirSync(keyDir, { recursive: true });
    fsSync.writeFileSync(path.join(keyDir, 'wireguard-public.key'), activeKey);
    // We cannot recover the private key from wg show ΓÇö it's hidden.
    // The private key is in the conf file though:
    const confPath = path.join(WG_TUNNEL_DIR, `${WIREGUARD_TUNNEL_NAME}.conf`);
    if (fsSync.existsSync(confPath)) {
      const conf = fsSync.readFileSync(confPath, 'utf8');
      const privMatch = conf.match(/^PrivateKey\s*=\s*(.+)/im);
      if (privMatch) {
        fsSync.writeFileSync(path.join(keyDir, 'wireguard-private.key'), privMatch[1].trim(), { mode: 0o600 });
      }
    }
    res.json({ success: true, activeKey, message: 'Key files synced to match running tunnel' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/wireguard/deactivate
// Removes the tunnel service (stops VPN).
app.post('/api/wireguard/deactivate', async (req, res) => {
  try {
    await runPS(`Start-Process -FilePath 'C:\\Program Files\\WireGuard\\wireguard.exe' -ArgumentList '/uninstalltunnelservice','${WIREGUARD_TUNNEL_NAME}' -Verb RunAs -Wait`);
    res.json({ success: true, message: 'WireGuard tunnel stopped' });
  } catch (err) {
    const msg = err.message || '';
    // Treat "not found" / "does not exist" as already-stopped ΓÇö not a real error
    if (/not found|does not exist|0x80070002|cannot find/i.test(msg)) {
      return res.json({ success: true, message: 'Tunnel was already stopped' });
    }
    res.status(500).json({ success: false, error: msg });
  }
});

// POST /api/wireguard/ping
// Runs a Windows ping from the tablet to a VPN IP and returns the output.
// Body: { target: "10.0.0.1" }
app.post('/api/wireguard/ping', async (req, res) => {
  const target = String(req.body?.target || '').trim();
  // Validate: only allow IP address format to prevent command injection
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(target) || target.split('.').some(n => Number(n) > 255)) {
    return res.status(400).json({ success: false, output: 'Invalid target IP address' });
  }
  try {
    // Use ping.exe directly ├óΓé¼ΓÇ¥ avoids PowerShell alias ambiguity.
    // -n 4 = 4 packets, -w 2000 = 2s timeout per packet, -l 32 = 32-byte payload
    const output = await new Promise((resolve, reject) => {
      execFile(
        'ping.exe',
        ['-n', '4', '-w', '2000', '-l', '32', target],
        { timeout: 20000, windowsHide: true },
        (err, stdout, stderr) => {
          // ping.exe exits with non-zero on failure ├óΓé¼ΓÇ¥ we want the output regardless
          // so we resolve even on error (stderr) to show the user what happened
          const out = (stdout || stderr || (err ? err.message : 'No output')).trim();
          resolve(out);
        }
      );
    });

    const out = String(output);
    // Windows ping success indicators ├óΓé¼ΓÇ¥ works on EN, FR, DE, and other locales
    // "TTL=" appears in every locale for successful replies
    const success = out.includes('TTL=') || out.includes('ttl=') || out.includes('bytes=');
    res.json({ success, output: out });
  } catch (err) {
    res.json({ success: false, output: err.message });
  }
});

// ============================================================
// SCHOOL SERVER RELAY
// Proxies requests to the central school server (ecareafrica.net)
// The tablet stores the school auth token in memory after login.
// All relay endpoints require ?token= or Authorization header.
// ============================================================

// In-memory token store (one token per tablet session)
let schoolAuthToken = null;
let schoolAuthRefreshToken = null;   // stored for auto-refresh
let schoolAuthTokenSetAt = 0;        // epoch ms when token was issued
let schoolUser = null;

// ── Auto-refresh the school token every 12 minutes ───────────────────────────
// The school server issues 15-minute access tokens. We refresh 3 minutes early
// so photo downloads, student syncs, and SSE never see a 401 due to expiry.
// Refresh uses the stored refresh_token from the login response.
setInterval(async () => {
  if (!schoolAuthToken || !schoolAuthRefreshToken) return;
  const ageMs = Date.now() - schoolAuthTokenSetAt;
  if (ageMs < 12 * 60 * 1000) return; // not yet due
  try {
    const res = await fetch(`${SERVER_API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${schoolAuthRefreshToken}` },
    });
    const json = await res.json().catch(() => null);
    const newToken = json?.data?.accessToken ?? json?.accessToken ?? null;
    const newRefresh = json?.data?.refreshToken ?? json?.refreshToken ?? null;
    if (newToken) {
      schoolAuthToken = newToken;
      schoolAuthTokenSetAt = Date.now();
      if (newRefresh) schoolAuthRefreshToken = newRefresh;
      console.log('[school-auth] Token refreshed successfully');
    }
  } catch (err) {
    console.warn('[school-auth] Auto-refresh failed:', err.message);
  }
}, 60_000); // check every 60 seconds

// Helper: relay a request to the school server
async function relayToServer(method, path, body, token) {
  const url = `${SERVER_API_URL}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({ success: false, error: 'Invalid response' }));
  return { status: res.status, json };
}

// POST /api/school/login
// Authenticate with the school server, store token in memory
app.post('/api/school/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ success: false, error: 'email and password required' });
  try {
    const { status, json } = await relayToServer('POST', '/auth/login', { email, password }, null);
    if (json.success !== false && (json.data?.accessToken || json.accessToken)) {
      schoolAuthToken = json.data?.accessToken ?? json.accessToken;
      schoolAuthRefreshToken = json.data?.refreshToken ?? json.refreshToken ?? null;
      schoolAuthTokenSetAt = Date.now();
      schoolUser = json.data?.user ?? json.user ?? null;
      return res.json({ success: true, user: schoolUser, token: schoolAuthToken });
    }
    res.status(status).json({ success: false, error: json.error?.message ?? json.message ?? 'Login failed' });
  } catch (err) {
    res.status(502).json({ success: false, error: `Cannot reach school server: ${err.message}` });
  }
});

// POST /api/school/logout
app.post('/api/school/logout', (req, res) => {
  schoolAuthToken = null;
  schoolAuthRefreshToken = null;
  schoolAuthTokenSetAt = 0;
  schoolUser = null;
  res.json({ success: true });
});

// GET /api/school/me
app.get('/api/school/me', (req, res) => {
  res.json({ success: true, user: schoolUser, loggedIn: !!schoolAuthToken });
});

// ΓöÇΓöÇ Middleware: require school token ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
function requireSchoolToken(req, res, next) {
  const token = req.headers['x-school-token'] || req.query.token || schoolAuthToken;
  if (!token) return res.status(401).json({ success: false, error: 'Not logged in to school server' });
  req.schoolToken = token;
  next();
}

// ΓöÇΓöÇ Approved Exits (Gate Keeper) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// GET /api/school/approved-exits
app.get('/api/school/approved-exits', requireSchoolToken, async (req, res) => {
  const date = req.query.date || '';
  const { status, json } = await relayToServer('GET', `/boarding/leaves/approved-exits${date ? `?date=${date}` : ''}`, null, req.schoolToken);
  res.status(status).json(json);
});

// PATCH /api/school/leaves/:id/confirm-exit
app.patch('/api/school/leaves/:id/confirm-exit', requireSchoolToken, async (req, res) => {
  const { status, json } = await relayToServer('PATCH', `/boarding/leaves/${req.params.id}/confirm-exit`, req.body, req.schoolToken);
  res.status(status).json(json);
});

// PATCH /api/school/leaves/:id/confirm-return
app.patch('/api/school/leaves/:id/confirm-return', requireSchoolToken, async (req, res) => {
  const { status, json } = await relayToServer('PATCH', `/boarding/leaves/${req.params.id}/confirm-return`, req.body, req.schoolToken);
  res.status(status).json(json);
});

// ΓöÇΓöÇ Leave Management (Patron/DOD view) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// GET /api/school/leaves
app.get('/api/school/leaves', requireSchoolToken, async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const { status, json } = await relayToServer('GET', `/boarding/leaves${qs ? `?${qs}` : ''}`, null, req.schoolToken);
  res.status(status).json(json);
});

// POST /api/school/leaves
app.post('/api/school/leaves', requireSchoolToken, async (req, res) => {
  const { status, json } = await relayToServer('POST', '/boarding/leaves', req.body, req.schoolToken);
  res.status(status).json(json);
});

// ΓöÇΓöÇ Manual Attendance ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// GET /api/school/students  -- fetch students by class or dormitory
app.get('/api/school/students', requireSchoolToken, async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const { status, json } = await relayToServer('GET', `/students${qs ? `?${qs}` : ''}`, null, req.schoolToken);
  res.status(status).json(json);
});

// GET /api/school/classes
app.get('/api/school/classes', requireSchoolToken, async (req, res) => {
  const { status, json } = await relayToServer('GET', '/classes?limit=200', null, req.schoolToken);
  res.status(status).json(json);
});

// GET /api/school/dormitories
app.get('/api/school/dormitories', requireSchoolToken, async (req, res) => {
  const { status, json } = await relayToServer('GET', '/boarding/dormitories?limit=200', null, req.schoolToken);
  res.status(status).json(json);
});

// POST /api/school/attendance/manual
// Body: { session_id, records: [{ student_id, status, reason? }] }
app.post('/api/school/attendance/manual', requireSchoolToken, async (req, res) => {
  const { session_id, records } = req.body || {};
  if (!session_id || !Array.isArray(records)) {
    return res.status(400).json({ success: false, error: 'session_id and records[] required' });
  }
  // Submit each correction ΓÇö relay individually (server has no bulk endpoint)
  const results = [];
  for (const rec of records) {
    if (!rec.student_id || !rec.status) continue;
    const { status, json } = await relayToServer(
      'PATCH', `/boarding/attendance/sessions/${session_id}/correct`,
      { student_id: rec.student_id, status: rec.status, reason: rec.reason || 'Manual attendance via tablet' },
      req.schoolToken
    );
    results.push({ student_id: rec.student_id, ok: status < 300, error: json?.error });
  }
  res.json({ success: true, results });
});

// POST /api/school/gate-attendance  -- manual gate attendance (entry/exit without biometric)
app.post('/api/school/gate-attendance', requireSchoolToken, async (req, res) => {
  const { status, json } = await relayToServer('POST', '/gate/logs', req.body, req.schoolToken);
  res.status(status).json(json);
});

// ΓöÇΓöÇ User Management ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// GET /api/school/users
app.get('/api/school/users', requireSchoolToken, async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const { status, json } = await relayToServer('GET', `/users${qs ? `?${qs}` : ''}`, null, req.schoolToken);
  res.status(status).json(json);
});

// POST /api/school/users
app.post('/api/school/users', requireSchoolToken, async (req, res) => {
  const { status, json } = await relayToServer('POST', '/users', req.body, req.schoolToken);
  res.status(status).json(json);
});

// PATCH /api/school/users/:id
app.patch('/api/school/users/:id', requireSchoolToken, async (req, res) => {
  const { status, json } = await relayToServer('PATCH', `/users/${req.params.id}`, req.body, req.schoolToken);
  res.status(status).json(json);
});

// DELETE /api/school/users/:id
app.delete('/api/school/users/:id', requireSchoolToken, async (req, res) => {
  const { status, json } = await relayToServer('DELETE', `/users/${req.params.id}`, null, req.schoolToken);
  res.status(status).json(json);
});

// ΓöÇΓöÇ Boarding sessions (patron) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
app.get('/api/school/boarding/sessions', requireSchoolToken, async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const { status, json } = await relayToServer('GET', `/boarding/attendance/sessions${qs ? `?${qs}` : ''}`, null, req.schoolToken);
  res.status(status).json(json);
});

app.get('/api/school/boarding/sessions/:id', requireSchoolToken, async (req, res) => {
  const { status, json } = await relayToServer('GET', `/boarding/attendance/sessions/${req.params.id}`, null, req.schoolToken);
  res.status(status).json(json);
});

// ΓöÇΓöÇ Student photo proxy (fetches photo from server, serves to tablet frontend) ΓöÇ
// Note: token passed as query param since this is used via <img src="...">
app.get('/api/school/photo', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url param required' });

  const roomKey = String(req.query.roomKey || req.query.room_id || req.query.dormitory_id || req.query.room || 'all-rooms');
  const studentId = String(req.query.studentId || req.query.student_id || 'unknown-student');
  const token = req.headers['authorization']?.replace('Bearer ', '') || schoolAuthToken;

  const localPath = resolveLocalPhotoPath(studentId, roomKey, PHOTO_CACHE_ROOT);
  const localExists = fs.existsSync(localPath);

  if (localExists) {
    const stat = fs.statSync(localPath);
    const isFresh = !shouldRefreshPhotoCache({ updatedAt: stat.mtimeMs }, Date.now());
    if (isFresh) {
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=300');
      return res.sendFile(localPath);
    }
  }

  try {
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const photoRes = await fetch(url, { headers });
    if (!photoRes.ok) {
      if (localExists) return res.sendFile(localPath);
      return res.status(photoRes.status).send('Not found');
    }
    const buffer = Buffer.from(await photoRes.arrayBuffer());
    try { fs.mkdirSync(path.dirname(localPath), { recursive: true }); fs.writeFileSync(localPath, buffer); } catch {}
    res.set('Content-Type', photoRes.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=300');
    return res.send(buffer);
  } catch (err) {
    if (localExists) return res.sendFile(localPath);
    res.status(502).send('Photo fetch failed');
  }
});

app.post('/api/school/photos/sync-room', async (req, res) => {
  try {
    const { roomKey = 'all-rooms', deviceId = 'tablet', students: studentsList = [], token } = req.body || {};
    const result = await syncRoomPhotoCache({
      roomKey,
      deviceId,
      studentsList,
      token: token || schoolAuthToken,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error?.message || 'Photo sync failed' });
  }
});

/**
 * POST /api/school/photos/sync-all
 * Downloads photos for ALL students in students.json that are missing from cache.
 * Called automatically after student sync and on tablet startup.
 * Returns counts: { synced, missing, total }
 */
app.post('/api/school/photos/sync-all', async (req, res) => {
  try {
    const token = req.body?.token || schoolAuthToken;
    // Only sync students who have a photoUrl and are missing from cache
    const studentsWithPhotos = students.filter(s => s.photoUrl && !s.photoUrl.startsWith('http://localhost'));
    if (!studentsWithPhotos.length) {
      return res.json({ success: true, synced: 0, missing: 0, total: 0, message: 'No photos to sync' });
    }
    const result = await syncRoomPhotoCache({
      roomKey:      'all-rooms',
      deviceId:     currentDevice?.deviceId || 'tablet',
      studentsList: studentsWithPhotos.map(s => ({
        id:        s.studentId || s.studentDeviceId,
        student_id: s.studentId || s.studentDeviceId,
        photo_url: s.photoUrl,
        photoUrl:  s.photoUrl,
      })),
      token,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error?.message || 'Photo sync-all failed' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FK Attendance Backend running on http://localhost:${PORT}`);
  startBridge();
  // Kick off auto-connect shortly after bridge starts (legacy single-device flow)
  scheduleAutoConnect(3000);
  // Start one FKBridge process per registered device (multi-device parallel operation)
  startAllDeviceBridges().catch(err => console.warn('[bridge-mgr] startup error:', err.message));

  // Sync missing photos 30 seconds after startup (give token time to load)
  // Runs silently — downloads any photos in students.json that are missing from cache
  setTimeout(() => {
    const studentsWithPhotos = students.filter(s => s.photoUrl && !s.photoUrl.startsWith('http://localhost'));
    if (studentsWithPhotos.length && schoolAuthToken) {
      console.log(`[PhotoCache] Startup sync: checking ${studentsWithPhotos.length} student photo(s)...`);
      syncRoomPhotoCache({
        roomKey:      'all-rooms',
        deviceId:     'tablet',
        studentsList: studentsWithPhotos.map(s => ({
          id:        s.studentId || s.studentDeviceId,
          student_id: s.studentId || s.studentDeviceId,
          photo_url: s.photoUrl,
          photoUrl:  s.photoUrl,
        })),
        token: schoolAuthToken,
      }).then(r => {
        if (r.syncedCount > 0) console.log(`[PhotoCache] Startup sync: downloaded ${r.syncedCount} photo(s)`);
        if (r.missingCount > 0) console.log(`[PhotoCache] Startup sync: ${r.missingCount} photo(s) unavailable (server unreachable?)`);
      }).catch(() => null);
    }
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL NETWORK FK623 DISCOVERY
// Scans the tablet's local subnet for any host with port 5005 open (FK623 TCP).
// This lets the bridge find the device IP automatically when on the same LAN
// without needing the admin to know the FK623 IP in advance.
// ─────────────────────────────────────────────────────────────────────────────

const net = require('net');

/**
 * Test if a TCP port is open on a host.
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function tcpProbe(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * Derive all .1–.254 addresses in the same /24 as a given IP.
 * e.g. 192.168.1.45 → ['192.168.1.1', …, '192.168.1.254']
 */
function subnetAddresses(localIp) {
  const parts = localIp.split('.');
  if (parts.length !== 4) return [];
  const prefix = parts.slice(0, 3).join('.');
  const addrs = [];
  for (let i = 1; i <= 254; i++) addrs.push(`${prefix}.${i}`);
  return addrs;
}

/**
 * Scan up to `concurrency` hosts in parallel.
 * Returns array of IPs that have port open.
 */
async function scanSubnet(addrs, port, concurrency = 30, timeoutMs = 800) {
  const found = [];
  let idx = 0;
  async function worker() {
    while (idx < addrs.length) {
      const host = addrs[idx++];
      const open = await tcpProbe(host, port, timeoutMs);
      if (open) found.push(host);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, addrs.length) }, worker);
  await Promise.all(workers);
  return found;
}

/**
 * Get all non-loopback, non-APIPA IPv4 addresses on this machine.
 * Prefers addresses matching 192.168.x.x, 10.x.x.x, 172.16–31.x.x.
 */
function getLocalIPs() {
  const os = require('os');
  const ifaces = os.networkInterfaces();
  const all = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of (ifaces[name] || [])) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (iface.address.startsWith('127.') || iface.address.startsWith('169.254.')) continue;
      all.push({ name, address: iface.address });
    }
  }
  // Prefer private ranges for the scan subnet
  const private_ = all.filter(i =>
    i.address.startsWith('192.168.') ||
    i.address.startsWith('10.')      ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(i.address)
  );
  return private_.length ? private_ : all;
}

/**
 * POST /api/device/scan
 * Body: { port?: number, timeoutMs?: number }
 *
 * Scans the local subnet for FK623 biometric devices (default port 5005).
 * Returns found IPs and optionally auto-connects to the first one.
 *
 * Steps:
 *   1. Get local IPs of this tablet
 *   2. For each local IP, scan the /24 subnet for open port 5005
 *   3. Return all found IPs
 *   4. If autoConnect=true (default), connect to the first found device
 */
app.post('/api/device/scan', async (req, res) => {
  const scanPort    = Number(req.body?.port     || 5005);
  const scanTimeout = Number(req.body?.timeoutMs || 800);
  const autoConnect = req.body?.autoConnect !== false; // default true
  const concurrency = Number(req.body?.concurrency || 30);

  const localIPs = getLocalIPs();
  if (localIPs.length === 0) {
    return res.json({
      success: false,
      found: [],
      message: 'No local network interfaces found. Connect to a network first.',
    });
  }

  console.log(`[scan] Scanning for FK623 on port ${scanPort} from interfaces: ${localIPs.map(i => i.address).join(', ')}`);

  // Collect all unique addresses across all local interfaces
  const allAddrs = new Set();
  for (const iface of localIPs) {
    for (const addr of subnetAddresses(iface.address)) allAddrs.add(addr);
  }

  const startMs = Date.now();
  const found = await scanSubnet([...allAddrs], scanPort, concurrency, scanTimeout);
  const elapsedMs = Date.now() - startMs;

  console.log(`[scan] Found ${found.length} device(s) with port ${scanPort} open in ${elapsedMs}ms: ${found.join(', ')}`);

  // Auto-connect to the first found device if requested and not already connected
  let connectResult = null;
  if (autoConnect && found.length > 0 && !(currentDevice && currentDevice.connected)) {
    const targetIp = found[0];
    const savedCfg  = activeDeviceConfig || loadDeviceConfig() || {};
    const license   = savedCfg.license      || 1261;
    const deviceId  = savedCfg.deviceId     || '';
    const netPw     = savedCfg.netPassword  || 0;
    const proto     = savedCfg.protocolType ?? -1;

    console.log(`[scan] Auto-connecting to first found device: ${targetIp}:${scanPort}`);

    try {
      await ensureBridge();
      stopLogPoll();
      const result = await sendCommand(
        `CONNECT|${targetIp}|${scanPort}|${license}|${deviceId}|${netPw}|${proto}|15000`,
        25000
      );
      if (result.success) {
        setActiveDeviceSession(result.data);
        // Persist discovered IP so auto-connect uses it on next restart
        rememberLatestDeviceIp(targetIp, scanPort, { license, deviceId, netPassword: netPw, protocolType: proto });
        syncTimeAfterConnect();
        refreshUsersCache().catch(() => null);
        refreshTabletDeviceAssignments().catch(() => null);
        startLogPoll();
        connectResult = { connected: true, ip: targetIp, port: scanPort, device: result.data };
        console.log(`[scan] Auto-connect success: ${targetIp}:${scanPort}`);
      } else {
        connectResult = { connected: false, ip: targetIp, error: result.error };
        console.log(`[scan] Auto-connect failed: ${result.error}`);
        scheduleAutoConnect(3000);
      }
    } catch (err) {
      connectResult = { connected: false, ip: targetIp, error: err.message };
      scheduleAutoConnect(3000);
    }
  }

  res.json({
    success: true,
    found,
    count: found.length,
    elapsedMs,
    scannedInterfaces: localIPs.map(i => `${i.name}: ${i.address}`),
    port: scanPort,
    connectResult,
    message: found.length === 0
      ? `No FK623 devices found on port ${scanPort}. Check the device is powered on and connected to the same network.`
      : `Found ${found.length} device(s): ${found.join(', ')}${connectResult?.connected ? ` — connected to ${connectResult.ip}` : ''}`,
  });
});

/**
 * GET /api/device/saved-config
 * Returns the currently saved device-config.json plus current connection state.
 * Used by frontend to show what IP the bridge will auto-connect to.
 */
app.get('/api/device/saved-config', (req, res) => {
  const saved = activeDeviceConfig || loadDeviceConfig();
  res.json({
    success: true,
    config: saved,
    currentDevice: currentDevice || null,
    autoConnectEnabled,
    bridgeReady,
    bridgePath,
    bridgeExists: fs.existsSync(bridgePath),
  });
});

/**
 * POST /api/device/set-ip
 * Body: { ipAddress, port?, license?, deviceId? }
 *
 * Saves the FK623 IP to device-config.json and triggers an immediate
 * reconnect attempt. This is the lightweight alternative to running
 * Enroll-Tablet.ps1 — the admin can set the IP directly from the
 * browser without opening a terminal.
 */
app.post('/api/device/set-ip', async (req, res) => {
  const { ipAddress, port = 5005, license = 1261, deviceId = '', timeoutMs = 15000 } = req.body || {};
  if (!ipAddress || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipAddress)) {
    return res.status(400).json({ success: false, error: 'Valid IPv4 address required (e.g. 192.168.1.76)' });
  }

  const cfg = {
    ...(activeDeviceConfig || loadDeviceConfig() || {}),
    ipAddress: ipAddress.trim(),
    port: Number(port) || 5005,
    license: Number(license) || 1261,
    deviceId: String(deviceId || '').trim(),
    netPassword: 0,
    protocolType: -1,
    timeoutMs: Number(timeoutMs) || 15000,
    savedDevices: normalizeSavedDeviceList({
      ...(activeDeviceConfig || loadDeviceConfig() || {}),
      ipAddress: ipAddress.trim(),
      port: Number(port) || 5005,
      license: Number(license) || 1261,
      deviceId: String(deviceId || '').trim(),
      netPassword: 0,
      protocolType: -1,
      timeoutMs: Number(timeoutMs) || 15000,
    }),
  };
  saveDeviceConfig(cfg);
  activeDeviceConfig = cfg;
  console.log(`[set-ip] Device IP updated to ${ipAddress}:${port}`);

  // Also persist to .env so the IP survives a full reinstall of the tablet software.
  // On reinstall, device-config.json is regenerated from .env DEVICE_IP.
  saveEnvKey('DEVICE_IP', ipAddress.trim());
  saveEnvKey('DEVICE_PORT', String(Number(port) || 5005));
  if (license !== 1261) saveEnvKey('DEVICE_LICENSE', String(Number(license) || 1261));

  // Cancel any pending auto-connect retry — config changed, start fresh
  if (autoConnectTimer) { clearTimeout(autoConnectTimer); autoConnectTimer = null; }
  autoConnectAttempt = 0;
  currentDevice = null;
  stopLogPoll();

  // Notify frontend immediately: config saved, connecting now
  sseEmit('deviceStatus', { connected: false, ipAddress, configChanged: true, message: 'Config saved — connecting...' });

  // Immediately attempt connection with the new IP
  let connectResult = null;
  try {
    await ensureBridge();
    const result = await sendCommand(
      `CONNECT|${cfg.ipAddress}|${cfg.port}|${cfg.license}|${cfg.deviceId}|${cfg.netPassword}|${cfg.protocolType}|${cfg.timeoutMs}`,
      cfg.timeoutMs + 10000
    );
    if (result.success) {
      setActiveDeviceSession(result.data);
      autoConnectAttempt = 0;
      syncTimeAfterConnect();
      refreshUsersCache().catch(() => null);
      refreshTabletDeviceAssignments().catch(() => null);
      startLogPoll();
      connectResult = { connected: true, device: result.data };
      // Emit real connected status immediately over SSE
      sseEmit('deviceStatus', { connected: true, ipAddress, deviceId: result.data?.deviceId || '' });
      scheduleAutoConnect(30000); // health-check in 30s
    } else {
      connectResult = { connected: false, error: result.error };
      sseEmit('deviceStatus', { connected: false, ipAddress, error: result.error || 'Device not reachable' });
      autoConnectAttempt = 0; // reset so retry starts from attempt #1 with 3s backoff
      scheduleAutoConnect(3000);
    }
  } catch (err) {
    connectResult = { connected: false, error: err.message };
    sseEmit('deviceStatus', { connected: false, ipAddress, error: err.message });
    autoConnectAttempt = 0;
    scheduleAutoConnect(3000);
  }

  res.json({
    success: true,
    config: cfg,
    savedDevices: cfg.savedDevices || [],
    connectResult,
    message: connectResult?.connected
      ? `Connected to FK623 at ${ipAddress}:${port}`
      : `IP saved. Connection attempt: ${connectResult?.error || 'failed — will retry automatically'}`,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-DEVICE CONFIG MANAGEMENT  (/api/devices-config)
// Stores up to 1000+ biometric devices in data/devices-list.json
// Each entry: { id, name, ipAddress, port, license, deviceId, location, notes, createdAt, updatedAt }
// ═══════════════════════════════════════════════════════════════════════════════

const devicesListFile = path.join(dataDir, 'devices-list.json');

function loadDevicesList() {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(devicesListFile)) return [];
    return JSON.parse(fs.readFileSync(devicesListFile, 'utf8')) || [];
  } catch { return []; }
}

function saveDevicesList(list) {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(devicesListFile, JSON.stringify(list, null, 2));
  } catch (err) { console.error('[devices-list] save error:', err.message); }
}

function sanitizeDevice(raw) {
  return {
    id:         String(raw.id         || require('crypto').randomUUID()),
    name:       String(raw.name       || '').trim(),
    ipAddress:  String(raw.ipAddress  || '').trim(),
    port:       Number(raw.port)       || 5005,
    license:    Number(raw.license)    || 1261,
    deviceId:   String(raw.deviceId   || '').trim(),
    location:   String(raw.location   || '').trim(),
    notes:      String(raw.notes      || '').trim(),
    timeoutMs:  Number(raw.timeoutMs) || 15000,
    createdAt:  raw.createdAt || new Date().toISOString(),
    updatedAt:  new Date().toISOString(),
  };
}

// In-memory status map — updated whenever a connect/disconnect is attempted
// key: device id, value: { connected, deviceId, error, lastAttempt }
const deviceStatusMap = new Map();

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-DEVICE BRIDGE MANAGER
// One FKBridge.exe process per registered device — fully parallel operation.
// Each device has its own command queue, log poll (every 2s), and status check (every 15s).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Called by each DeviceBridge when new attendance logs arrive from its device.
 * Merges them into the global logsCache, emits over SSE, AND auto-pushes to
 * the school server immediately if a school auth token is available.
 */
function onDeviceLog(deviceId, deviceConfig, newLogs) {
  if (!Array.isArray(newLogs) || !newLogs.length) return;

  // Map raw FK623 log objects to the same shape attendanceFromLog produces
  // so the existing SSE / frontend code works without changes.
  const mapped = newLogs.map(raw => ({
    ...attendanceFromLog(raw),
    deviceConfigId: deviceId,
    deviceName:     deviceConfig.name || deviceConfig.ipAddress,
    bootId:         deviceId, // use deviceId as stable boot namespace
  }));

  // Merge into global logsCache
  const existingIds = new Set(logsCache.map(l => l.id));
  const truly_new = mapped.filter(l => !existingIds.has(l.id));
  if (truly_new.length) {
    logsCache = [...logsCache, ...truly_new].slice(-5000); // keep last 5000
    sseEmit('attendance', truly_new);
    console.log(`[bridge-mgr:${deviceConfig.name || deviceId.slice(0,8)}] ${truly_new.length} new log(s) emitted`);

    // ── Auto-push to school server immediately ───────────────────────────
    // Push each new log to the school server as it arrives so the server
    // has real-time data without waiting for a manual push or the server
    // pull-logs job. Fire-and-forget — never block the log poll cycle.
    if (schoolAuthToken) {
      setImmediate(async () => {
        let pushed = 0, failed = 0;
        for (const log of truly_new) {
          const payload = {
            log_id:                String(log.id || ''),
            user_id:               String(log.deviceUserId || log.userId || ''),
            timestamp:             log.timestamp || new Date().toISOString(),
            authentication_method: log.scanMethod || log.method || 'fingerprint',
            direction:             log.direction || 'In',
            device_id:             String(log.deviceId || deviceConfig.deviceId || deviceId),
            raw_data:              log,
          };
          try {
            const { status: s } = await relayToServer('POST', '/gate/logs', payload, schoolAuthToken);
            if (s >= 200 && s < 300) pushed++; else failed++;
          } catch { failed++; }
        }
        if (pushed > 0 || failed > 0) {
          console.log(`[bridge-mgr:${deviceConfig.name || deviceId.slice(0,8)}] auto-pushed ${pushed} log(s) to server${failed ? `, ${failed} failed` : ''}`);
        }
      });
    } else {
      console.log(`[bridge-mgr:${deviceConfig.name || deviceId.slice(0,8)}] ${truly_new.length} log(s) cached locally — not logged in to school server`);
    }
  }
}

/**
 * Called by each DeviceBridge when connection state changes.
 * Updates deviceStatusMap and broadcasts SSE events.
 */
function onDeviceStatus(deviceId, status) {
  const prev = deviceStatusMap.get(deviceId);
  deviceStatusMap.set(deviceId, {
    connected:   status.connected,
    deviceId:    status.deviceInfo?.deviceId || '',
    ipAddress:   status.ipAddress,
    error:       status.error || null,
    lastAttempt: status.lastAttempt || new Date().toISOString(),
    deviceInfo:  status.deviceInfo || null,
  });

  // Broadcast per-device status update
  sseEmit('devicesStatus', {
    id:        deviceId,
    connected: status.connected,
    ipAddress: status.ipAddress,
    name:      status.name,
    error:     status.error || null,
    deviceInfo: status.deviceInfo || null,
  });

  // Also update the main deviceStatus channel — this keeps the existing
  // single-device frontend connection indicators working
  if (status.connected !== (prev?.connected)) {
    sseEmit('deviceStatus', {
      connected: status.connected,
      ipAddress: status.ipAddress,
      deviceId:  status.deviceInfo?.deviceId || '',
      error:     status.error || null,
      source:    'bridge-manager',
    });
  }

  // Also check if the working port changed and persist it
  const bridge = bridgeManager.get(deviceId);
  if (bridge && bridge._portChanged) {
    const list = loadDevicesList();
    const i = list.findIndex(d => d.id === deviceId);
    if (i !== -1) {
      list[i].port = bridge._portChanged;
      list[i].updatedAt = new Date().toISOString();
      saveDevicesList(list);
    }
    bridge._portChanged = null;
  }
}

// Create the manager — it will be populated when devices are loaded at startup
const bridgeManager = new DeviceBridgeManager(dataDir, onDeviceLog, onDeviceStatus);

/** Load all registered devices and start a bridge for each one.
 * Staggered startup for 100+ devices — avoids overwhelming the OS
 * by starting bridges in batches of 20 with a 200ms delay between batches.
 */
async function startAllDeviceBridges() {
  const list = loadDevicesList();
  if (!list.length) return;
  console.log(`[bridge-mgr] Starting bridges for ${list.length} device(s)...`);

  // Start in batches of 20 — prevents port exhaustion and CPU spikes on large fleets
  const BATCH_SIZE = 20;
  const BATCH_DELAY_MS = 200;
  for (let i = 0; i < list.length; i += BATCH_SIZE) {
    const batch = list.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(d => bridgeManager.upsert(d).catch(err =>
      console.warn(`[bridge-mgr] start failed for ${d.name}:`, err.message)
    )));
    if (i + BATCH_SIZE < list.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }
  console.log(`[bridge-mgr] All ${list.length} bridge(s) started`);
}

function getDevicesWithStatus() {
  const list = loadDevicesList();
  return list.map(d => {
    // Prefer the bridge manager's live state over deviceStatusMap
    const bridge = bridgeManager.get(d.id);
    const liveStatus = bridge
      ? { connected: bridge.connected, deviceId: bridge.deviceInfo?.deviceId || d.deviceId, error: bridge.lastError, lastAttempt: bridge.lastAttempt, deviceInfo: bridge.deviceInfo }
      : (deviceStatusMap.get(d.id) || { connected: false });
    return { ...d, status: liveStatus };
  });
}

// ── GET /api/devices-config — list all devices ───────────────────────────────
app.get('/api/devices-config', (req, res) => {
  res.json({ success: true, devices: getDevicesWithStatus() });
});

// ── GET /api/devices-config/status — per-device live status from bridge manager ──
app.get('/api/devices-config/status', (req, res) => {
  res.json({ success: true, devices: bridgeManager.getAllStatus() });
});

// ── POST /api/devices-config — add a new device ──────────────────────────────
app.post('/api/devices-config', async (req, res) => {
  const { name, ipAddress, port, license, deviceId, location, notes, timeoutMs } = req.body || {};
  if (!ipAddress || !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ipAddress).trim())) {
    return res.status(400).json({ success: false, error: 'Valid IPv4 address is required' });
  }
  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, error: 'Device name is required' });
  }
  const list = loadDevicesList();
  const dup = list.find(d => d.ipAddress === String(ipAddress).trim());
  if (dup) return res.status(409).json({ success: false, error: `Device with IP ${ipAddress} already exists (${dup.name})` });
  const device = sanitizeDevice({ id: require('crypto').randomUUID(), name, ipAddress, port, license, deviceId, location, notes, timeoutMs });
  list.push(device);
  saveDevicesList(list);
  console.log(`[devices-config] added: ${device.name} (${device.ipAddress})`);
  // Start a bridge immediately for the new device
  bridgeManager.upsert(device).catch(err => console.warn(`[bridge-mgr] start failed for ${device.name}:`, err.message));
  res.status(201).json({ success: true, device: { ...device, status: { connected: false } } });
});

// ── PUT /api/devices-config/:id — update a device ────────────────────────────
app.put('/api/devices-config/:id', (req, res) => {
  const { id } = req.params;
  const list = loadDevicesList();
  const idx = list.findIndex(d => d.id === id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Device not found' });
  const { name, ipAddress, port, license, deviceId, location, notes, timeoutMs } = req.body || {};
  if (ipAddress && !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ipAddress).trim())) {
    return res.status(400).json({ success: false, error: 'Invalid IP address' });
  }
  const updated = sanitizeDevice({ ...list[idx], ...(name && { name }), ...(ipAddress && { ipAddress }), ...(port && { port }), ...(license && { license }), ...(deviceId !== undefined && { deviceId }), ...(location !== undefined && { location }), ...(notes !== undefined && { notes }), ...(timeoutMs && { timeoutMs }), id: list[idx].id, createdAt: list[idx].createdAt });
  list[idx] = updated;
  saveDevicesList(list);
  console.log(`[devices-config] updated: ${updated.name} (${updated.ipAddress})`);
  // Update the bridge config — will reconnect if IP/port/license changed
  bridgeManager.upsert(updated).catch(() => null);
  const bridge = bridgeManager.get(id);
  const status = bridge ? { connected: bridge.connected, error: bridge.lastError } : (deviceStatusMap.get(id) || { connected: false });
  res.json({ success: true, device: { ...updated, status } });
});

// ── DELETE /api/devices-config/:id — remove a device ─────────────────────────
app.delete('/api/devices-config/:id', (req, res) => {
  const { id } = req.params;
  const list = loadDevicesList();
  const idx = list.findIndex(d => d.id === id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Device not found' });
  const removed = list.splice(idx, 1)[0];
  saveDevicesList(list);
  deviceStatusMap.delete(id);
  // Stop and destroy the bridge for this device
  bridgeManager.remove(id);
  sseEmit('devicesStatus', { id, connected: false, removed: true });
  console.log(`[devices-config] removed: ${removed.name} (${removed.ipAddress})`);
  res.json({ success: true, removed });
});

// ── POST /api/devices-config/:id/connect — connect a specific device ─────────
app.post('/api/devices-config/:id/connect', async (req, res) => {
  const { id } = req.params;
  const list = loadDevicesList();
  const device = list.find(d => d.id === id);
  if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

  // Ensure bridge exists for this device
  await bridgeManager.upsert(device);

  // Trigger an immediate reconnect via the bridge manager
  const result = await bridgeManager.connect(id);

  if (result.success) {
    res.json({ success: true, connected: true, device: result.data || null });
  } else {
    const isLicenseError = String(result.error || '').includes('-2');
    const friendlyError = isLicenseError
      ? `Device is reachable but the FK SDK rejected the connection. ` +
        `Check: 1) License number on the device sticker (currently ${device.license}). ` +
        `2) Network password (default 0). 3) Port (try 4370 or 5005).`
      : result.error || 'Connection failed';
    res.json({ success: false, connected: false, error: friendlyError, hint: isLicenseError ? 'license_mismatch' : null });
  }
});

// ── POST /api/devices-config/:id/disconnect — disconnect a specific device ───
app.post('/api/devices-config/:id/disconnect', async (req, res) => {
  const { id } = req.params;
  const list = loadDevicesList();
  const device = list.find(d => d.id === id);
  if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
  const result = await bridgeManager.disconnect(id);
  res.json(result);
});

// ── POST /api/devices-config/:id/command — send a raw command to one device ──
// Body: { command: "STATUS" | "GET_USERS" | etc., timeoutMs? }
// Protected by dev password — allows per-device operations from the UI
app.post('/api/devices-config/:id/command', requireDevPassword, async (req, res) => {
  const { id } = req.params;
  const { command, timeoutMs = 30000 } = req.body || {};
  if (!command) return res.status(400).json({ success: false, error: 'command is required' });
  const bridge = bridgeManager.get(id);
  if (!bridge) return res.status(404).json({ success: false, error: 'No bridge running for this device' });
  if (!bridge.connected) return res.status(503).json({ success: false, error: 'Device not connected', code: 'device_not_connected' });
  const result = await bridge.send(command, Number(timeoutMs) || 30000);
  res.json(result);
});

// ── POST /api/devices-config/bulk-import — import many devices at once ────────
app.post('/api/devices-config/bulk-import', async (req, res) => {
  const incoming = Array.isArray(req.body?.devices) ? req.body.devices : [];
  if (!incoming.length) return res.status(400).json({ success: false, error: 'No devices provided' });
  const list = loadDevicesList();
  const existingIPs = new Set(list.map(d => d.ipAddress));
  const added = []; const skipped = [];
  for (const raw of incoming) {
    const ip = String(raw.ipAddress || '').trim();
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { skipped.push({ ...raw, reason: 'invalid IP' }); continue; }
    if (existingIPs.has(ip)) { skipped.push({ ...raw, reason: 'duplicate IP' }); continue; }
    const device = sanitizeDevice({ id: require('crypto').randomUUID(), ...raw, ipAddress: ip });
    list.push(device);
    existingIPs.add(ip);
    added.push(device);
  }
  saveDevicesList(list);
  // Start bridges for all newly added devices
  await Promise.all(added.map(d => bridgeManager.upsert(d).catch(() => null)));
  console.log(`[devices-config] bulk-import: ${added.length} added, ${skipped.length} skipped`);
  res.json({ success: true, added: added.length, skipped: skipped.length, skippedDetails: skipped });
});

// ── GET /api/device/config — expose current active device config ──────────────
app.get('/api/device/config', (req, res) => {
  res.json({
    success: true,
    config: activeDeviceConfig || null,
    connected: !!(currentDevice && currentDevice.connected),
  });
});

process.on('SIGINT', () => {
  bridgeManager.stopAll();
  if (bridgeProcess) bridgeProcess.kill();
  process.exit(0);
});




