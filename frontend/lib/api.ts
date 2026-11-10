import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

const api = axios.create({
  baseURL: `${API_URL}/api`,
  headers: { 'Content-Type': 'application/json' },
});

/** Build config with the dev-password header when provided. */
function devCfg(devPw?: string) {
  return devPw ? { headers: { 'X-Dev-Password': devPw } } : {};
}

export const deviceApi = {
  connect: (data: { deviceId?: string; ipAddress: string; port: number; license?: number; [key: string]: any }) => api.post('/device/connect', data),
  connectSaved: () => api.post('/device/connect-saved'),
  disconnect: () => api.post('/device/disconnect'),
  reconnect: () => api.post('/device/reconnect'),
  getStatus: () => api.get('/device/status'),
  getSessions: () => api.get('/device/sessions'),
  selectSession: (data: { sessionId?: string; deviceId?: string; ipAddress?: string; address?: string }) => api.post('/device/select-session', data),
  routeCommand: (data: { command: string; sessionId?: string; deviceId?: string; ipAddress?: string; address?: string; timeoutMs?: number }) => api.post('/device/route-command', data),
  /** Requires dev password */
  syncTime: (devPw?: string) => api.post('/device/sync-time', {}, devCfg(devPw)),
  setTime: (timestamp: string, devPw?: string) => api.post('/device/set-time', { timestamp }, devCfg(devPw)),
  /** Requires dev password */
  pullLogs: (readMark = 0, devPw?: string) => api.post('/device/pull-logs', { readMark }, devCfg(devPw)),
  /** Requires dev password */
  getUsers: (devPw?: string) => api.get('/device/users', devCfg(devPw)),
  pullUsers: (devPw?: string) => api.get('/device/users', devCfg(devPw)),
  /** Requires dev password */
  pushStudents: (studentIds?: string[], devPw?: string) => api.post('/device/push-students', { studentIds }, devCfg(devPw)),
  /** Requires dev password */
  clearLogs: (devPw?: string) => api.post('/device/clear-logs', {}, devCfg(devPw)),
  /** Requires dev password */
  powerOff: (devPw?: string) => api.post('/device/poweroff', {}, devCfg(devPw)),
  /** Requires dev password */
  clearAll: (devPw?: string) => api.post('/device/clear-all', {}, devCfg(devPw)),
  saveConfig: (data: { deviceId?: string; ipAddress: string; port: number; license?: number; [key: string]: any }) => api.post('/device/connect', { ...data, saveConfig: true }),
};

export const studentApi = {
  getAll: (params?: { deviceId?: string; date?: string; search?: string; class?: string }) => {
    const qs = params ? '?' + new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v && String(v).trim()))
    ).toString() : '';
    return api.get(`/students${qs}`);
  },
  /** Requires dev password — sends to device */
  create: (data: any, devPw?: string) => api.post('/students', data, devCfg(devPw)),
  /** Requires dev password — deletes from device */
  delete: (id: string, devPw?: string) => api.delete(`/students/${id}`, devCfg(devPw)),
};

export const attendanceApi = {
  getAll: () => api.get('/attendance'),
  getToday: () => api.get('/attendance/today'),
  getSettings: () => api.get('/attendance/settings'),
  updateSettings: (settings: any) => api.put('/attendance/settings', settings),
  /** Push FK623 biometric logs to the school server. Requires school login. */
  pushToServer: (since?: string) => api.post('/attendance/push-to-server', since ? { since } : {}),
};

export const dashboardApi = {
  getStats: () => api.get('/dashboard/stats'),
  getRecent: () => api.get('/dashboard/recent'),
};

export const devicesApi = {
  getAll: () => api.get('/devices'),
  create: (data: any) => api.post('/devices', data),
};

export const configApi = {
  /** Update SERVER_API_URL at runtime — takes effect immediately, saved to .env */
  updateServerUrl: (url: string) => api.post('/config/server-url', { url }),
};

export const wireguardApi = {
  /** Check if WireGuard is installed and whether the tunnel is active */
  getStatus: () => api.get('/wireguard/status'),
  /** Generate a new key pair on the tablet — returns { privateKey, publicKey } */
  generateKeys: () => api.post('/wireguard/generate-keys'),
  /** Write config + activate tunnel — requires server info pasted by admin */
  install: (data: {
    serverPublicKey: string;
    serverEndpoint: string;   // e.g. "169.58.124.150:51820"
    vpnIp: string;            // e.g. "10.0.0.2"
    dns?: string;
  }) => api.post('/wireguard/install', data),
  /** Stop and remove the tunnel service */
  deactivate: () => api.post('/wireguard/deactivate'),
  /** Install bridge + frontend as Windows auto-start services (run as SYSTEM) */
  installServices: () => api.post('/services/install'),
  /** Check if services are installed and running */
  getServicesStatus: () => api.get('/services/status'),
  /** Diagnose VPN connection — detects key mismatch, handshake issues */
  diagnose: () => api.post('/wireguard/diagnose'),
  /** Sync saved key files to match the running tunnel (fixes key mismatch) */
  syncKey: () => api.post('/wireguard/sync-key'),
  /** Ping a VPN IP from the tablet using Windows ping.exe */
  ping: (target: string) => api.post('/wireguard/ping', { target }),
};

export default api;

// ── School Server API (proxied through tablet bridge) ─────────────────────────
// All calls go to localhost:5000/api/school/* which relays to the central server

export const schoolApi = {
  // Auth
  login: (email: string, password: string) =>
    api.post('/school/login', { email, password }),
  logout: () =>
    api.post('/school/logout'),
  me: () =>
    api.get('/school/me'),

  // Gate Keeper — approved exits
  getApprovedExits: (date?: string) =>
    api.get(`/school/approved-exits${date ? `?date=${date}` : ''}`),
  confirmExit: (id: string, notes?: string) =>
    api.patch(`/school/leaves/${id}/confirm-exit`, { notes }),
  confirmReturn: (id: string) =>
    api.patch(`/school/leaves/${id}/confirm-return`, {}),

  // Leave list (patron/DOD view)
  getLeaves: (params?: Record<string, string>) =>
    api.get(`/school/leaves${params ? `?${new URLSearchParams(params)}` : ''}`),
  createLeave: (data: Record<string, unknown>) =>
    api.post('/school/leaves', data),

  // Manual attendance
  getStudents: (params?: Record<string, string>) =>
    api.get(`/school/students${params ? `?${new URLSearchParams(params)}` : ''}`),
  getClasses: () =>
    api.get('/school/classes'),
  getDormitories: () =>
    api.get('/school/dormitories'),
  submitManualAttendance: (sessionId: string, records: Array<{ student_id: string; status: string; reason?: string }>) =>
    api.post('/school/attendance/manual', { session_id: sessionId, records }),
  recordGateAttendance: (data: Record<string, unknown>) =>
    api.post('/school/gate-attendance', data),

  // Boarding sessions
  getBoardingSessions: (params?: Record<string, string>) =>
    api.get(`/school/boarding/sessions${params ? `?${new URLSearchParams(params)}` : ''}`),
  getBoardingSession: (id: string) =>
    api.get(`/school/boarding/sessions/${id}`),

  // Users
  getUsers: (params?: Record<string, string>) =>
    api.get(`/school/users${params ? `?${new URLSearchParams(params)}` : ''}`),
  createUser: (data: Record<string, unknown>) =>
    api.post('/school/users', data),
  updateUser: (id: string, data: Record<string, unknown>) =>
    api.patch(`/school/users/${id}`, data),
  deleteUser: (id: string) =>
    api.delete(`/school/users/${id}`),

  // Photo proxy
  photoUrl: (originalUrl: string, options?: { studentId?: string; roomKey?: string }) => {
    if (!originalUrl) return '';
    const params = new URLSearchParams({ url: originalUrl });
    if (options?.studentId) params.set('studentId', String(options.studentId));
    if (options?.roomKey) params.set('roomKey', String(options.roomKey));
    return `${API_URL}/api/school/photo?${params.toString()}`;
  },
  syncRoomPhotos: (students: Array<{ id?: string; student_id?: string; photo_url?: string | null; photoUrl?: string | null }>, roomKey?: string, deviceId?: string) =>
    api.post('/school/photos/sync-room', {
      roomKey: roomKey || 'all-rooms',
      deviceId: deviceId || 'tablet',
      students,
    }),
};