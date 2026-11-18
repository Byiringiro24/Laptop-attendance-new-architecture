const fs = require('fs');
const path = require('path');

function stableLogKey(deviceId, log) {
  const userId = String(log?.userId ?? log?.user_id ?? log?.studentDeviceId ?? '').trim();
  const logId = String(log?.id ?? log?.logId ?? log?.log_id ?? '').trim();
  const timestamp = String(log?.timestamp ?? log?.scanTime ?? log?.scan_time ?? '').trim();
  if (!logId && (!userId || !timestamp)) return null;
  return [String(deviceId), logId || userId, timestamp, userId].join('|');
}

class AttendanceLogStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = this._load();
    this.keys = new Set(this.entries.map((entry) => entry.key));
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter((entry) => entry?.key && entry?.log) : [];
    } catch {
      return [];
    }
  }

  _persist(entries) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(entries));
    fs.renameSync(tempPath, this.filePath);
  }

  append(deviceId, logs = []) {
    const added = [];
    const nextKeys = new Set(this.keys);

    for (const raw of Array.isArray(logs) ? logs : []) {
      const key = stableLogKey(deviceId, raw);
      if (!key || nextKeys.has(key)) continue;

      const entry = {
        key,
        deviceId: String(deviceId),
        storedAt: new Date().toISOString(),
        log: { ...raw, deviceConfigId: String(deviceId) },
      };
      added.push(entry);
      nextKeys.add(key);
    }

    if (added.length) {
      const nextEntries = [...this.entries, ...added];
      this._persist(nextEntries);
      this.entries = nextEntries;
      this.keys = nextKeys;
    }

    return added.map((entry) => ({ ...entry.log }));
  }

  getAll(limit = Infinity) {
    const entries = Number.isFinite(limit) ? this.entries.slice(-limit) : this.entries;
    return entries.map((entry) => ({ ...entry.log }));
  }

  getForDevice(deviceId) {
    const id = String(deviceId);
    return this.entries
      .filter((entry) => entry.deviceId === id)
      .map((entry) => ({ ...entry.log }));
  }
}

module.exports = { AttendanceLogStore, stableLogKey };
