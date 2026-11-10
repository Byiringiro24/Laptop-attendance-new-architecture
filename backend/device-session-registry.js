function normalizeSessionKey(device = {}) {
  const tabletId = String(device.tabletId || device.tablet_id || device.tabletUID || '').trim();
  const sessionId = String(device.sessionId || device.session_id || device.deviceSessionId || '').trim();
  const ipAddress = String(device.ipAddress || device.address || '').trim();
  const deviceId = String(device.deviceId || device.device_uid || '').trim();

  if (tabletId && sessionId) return `tablet:${tabletId}:session:${sessionId}`;
  if (tabletId && ipAddress) return `tablet:${tabletId}:ip:${ipAddress}`;
  if (tabletId && deviceId) return `tablet:${tabletId}:device:${deviceId}`;
  if (sessionId) return `session:${sessionId}`;
  if (ipAddress) return `ip:${ipAddress}`;
  if (deviceId) return `device:${deviceId}`;
  return null;
}

function normalizeDeviceSession(device = {}) {
  if (!device || typeof device !== 'object') return null;

  const tabletId = String(device.tabletId || device.tablet_id || device.tabletUID || '').trim();
  const tabletName = String(device.tabletName || device.tablet_name || device.tablet || '').trim();
  const ipAddress = String(device.ipAddress || device.address || '').trim();
  const deviceId = String(device.deviceId || device.device_uid || '').trim();
  const sessionId = String(device.sessionId || device.session_id || device.deviceSessionId || '').trim() || null;

  return {
    ...device,
    connected: Boolean(device.connected),
    tabletId,
    tabletName,
    sessionId,
    ipAddress,
    deviceId,
    name: String(device.name || device.deviceName || device.device_name || device.label || '').trim() || null,
    port: Number(device.port) || 5005,
    license: Number(device.license) || 1261,
    netPassword: Number(device.netPassword) || 0,
    protocolType: device.protocolType === undefined || device.protocolType === null ? -1 : Number(device.protocolType),
    timeoutMs: Number(device.timeoutMs) || 15000,
    updatedAt: device.updatedAt || new Date().toISOString(),
  };
}

function registerDeviceSession(deviceSessions, device) {
  const normalized = normalizeDeviceSession(device);
  if (!normalized) return null;

  const sessionKey = normalizeSessionKey(normalized);
  if (!sessionKey) return null;

  deviceSessions.set(sessionKey, normalized);
  return normalized;
}

function getConnectedDeviceSessions(deviceSessions) {
  return Array.from(deviceSessions.values())
    .filter((entry) => entry && entry.connected)
    .sort((a, b) => {
      const left = String(a.tabletName || a.ipAddress || a.deviceId || '').toLowerCase();
      const right = String(b.tabletName || b.ipAddress || b.deviceId || '').toLowerCase();
      return left.localeCompare(right);
    });
}

function getTabletDeviceSessions(deviceSessions, tabletId) {
  const target = String(tabletId || '').trim();
  if (!target) return [];

  return getConnectedDeviceSessions(deviceSessions).filter((entry) => {
    const current = String(entry.tabletId || '').trim();
    return current === target;
  });
}

function getSelectedDeviceSession(deviceSessions, fallback = null) {
  if (!deviceSessions || typeof deviceSessions.values !== 'function') return fallback || null;

  const connected = getConnectedDeviceSessions(deviceSessions);
  if (connected.length === 0) return fallback || null;

  if (fallback) {
    const fallbackTablet = String(fallback.tabletId || '').trim();
    const fallbackIp = String(fallback.ipAddress || '').trim();
    const fallbackId = String(fallback.deviceId || '').trim();

    const preferred = connected.find((entry) => {
      const entryTablet = String(entry.tabletId || '').trim();
      const entryIp = String(entry.ipAddress || '').trim();
      const entryId = String(entry.deviceId || '').trim();

      if (fallbackTablet && entryTablet && fallbackTablet === entryTablet) {
        if (fallbackId && entryId && fallbackId === entryId) return true;
        if (fallbackIp && entryIp && fallbackIp === entryIp) return true;
        return true;
      }

      return (fallbackIp && fallbackIp === entryIp) || (fallbackId && fallbackId === entryId);
    });

    if (preferred) return preferred;
  }

  return connected[0] || fallback || null;
}

function findDeviceSession(deviceSessions, device = {}) {
  if (!deviceSessions || typeof deviceSessions.values !== 'function') return null;

  const candidate = normalizeDeviceSession(device);
  if (!candidate) return null;

  const directKey = normalizeSessionKey(candidate);
  if (directKey && deviceSessions.has(directKey)) {
    return deviceSessions.get(directKey) || null;
  }

  const targetTablet = String(candidate.tabletId || '').trim();
  const targetSessionId = String(candidate.sessionId || '').trim();
  const targetIp = String(candidate.ipAddress || '').trim();
  const targetId = String(candidate.deviceId || '').trim();

  if (targetSessionId) {
    const bySession = Array.from(deviceSessions.values()).find((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      return String(entry.sessionId || '').trim() === targetSessionId;
    });

    if (bySession) return bySession;
  }

  const tabletMatches = Array.from(deviceSessions.values()).filter((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const entryTablet = String(entry.tabletId || '').trim();
    if (targetTablet && entryTablet && targetTablet === entryTablet) return true;
    return false;
  });

  if (tabletMatches.length > 0) {
    const matched = tabletMatches.find((entry) => {
      const entryIp = String(entry.ipAddress || '').trim();
      const entryId = String(entry.deviceId || '').trim();
      if (targetIp && entryIp && targetIp === entryIp) return true;
      if (targetId && entryId && targetId === entryId) return true;
      return false;
    });

    if (matched) return matched;
  }

  return Array.from(deviceSessions.values()).find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const entryIp = String(entry.ipAddress || '').trim();
    const entryId = String(entry.deviceId || '').trim();
    if (targetIp && entryIp && targetIp === entryIp) return true;
    if (targetId && entryId && targetId === entryId) return true;
    return false;
  }) || null;
}

function selectDeviceSession(deviceSessions, device = {}) {
  return findDeviceSession(deviceSessions, device);
}

function removeDeviceSession(deviceSessions, device = {}) {
  if (!deviceSessions || typeof deviceSessions.values !== 'function') return false;

  const candidate = normalizeDeviceSession(device);
  if (!candidate) return false;

  const directKey = normalizeSessionKey(candidate);
  if (directKey && deviceSessions.has(directKey)) {
    deviceSessions.delete(directKey);
    return true;
  }

  const targetIp = String(candidate.ipAddress || '').trim();
  const targetId = String(candidate.deviceId || '').trim();
  const removed = Array.from(deviceSessions.entries()).find(([key, entry]) => {
    if (!entry || typeof entry !== 'object') return false;
    const entryIp = String(entry.ipAddress || '').trim();
    const entryId = String(entry.deviceId || '').trim();
    if (targetIp && entryIp && targetIp === entryIp) return true;
    if (targetId && entryId && targetId === entryId) return true;
    return false;
  });

  if (removed) {
    deviceSessions.delete(removed[0]);
    return true;
  }

  return false;
}

module.exports = {
  normalizeSessionKey,
  normalizeDeviceSession,
  registerDeviceSession,
  getConnectedDeviceSessions,
  getTabletDeviceSessions,
  getSelectedDeviceSession,
  findDeviceSession,
  selectDeviceSession,
  removeDeviceSession,
};
