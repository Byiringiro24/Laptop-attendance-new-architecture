"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  FiActivity, FiCheckCircle, FiDatabase, FiDownloadCloud,
  FiEye, FiEyeOff, FiLock, FiRefreshCw, FiServer,
  FiSettings, FiShield, FiUploadCloud, FiUsers,
  FiX, FiUserCheck, FiCpu, FiMapPin, FiZap,
  FiAlertTriangle, FiLogOut, FiPlus, FiEdit2, FiTrash2,
  FiWifi, FiWifiOff, FiLoader,
} from "react-icons/fi";
import {
  dashboardApi, deviceApi, studentApi,
  wireguardApi, schoolApi,
} from "@/lib/api";
import type {
  NavView, Stats, DeviceStatus,
  AttendanceLog, Student, DeviceUser,
} from "@/components/types";
import {
  NavItem, SideField, SideSelect,
  StatusPill, SummaryTile, InfoRow, AutoConnectBadge,
} from "@/components/ui";
import GateKeeperPanel      from "@/components/GateKeeperPanel";
import ManualAttendancePanel from "@/components/ManualAttendancePanel";
import UsersPanel            from "@/components/UsersPanel";
import LiveAttendanceScreen  from "@/components/LiveAttendanceScreen";
import WireguardWizard       from "@/components/WireguardWizard";
import DeviceUsersPanel      from "@/components/DeviceUsersPanel";
import DevicesPage           from "@/components/DevicesPage";

/* ─── Types ──────────────────────────────────────────── */
type RegisteredDevice = {
  id: string; name: string; ipAddress: string; port: number;
  license: number; deviceId: string; location: string; notes: string;
  status: { connected: boolean; error?: string; lastAttempt?: string };
};

/* ─── Constants ──────────────────────────────────────── */
const WG_SERVER_ENDPOINT_DEFAULT = "169.58.124.150:51820";
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";
const emptyStats: Stats = {
  totalStudents: 0, totalDevices: 0, onlineDevices: 0,
  attendanceToday: 0, lateStudents: 0, totalLogs: 0,
};
const CLASS_LIST = [
  "S1","S2","S3","S4",
  "S5 MPC","S5 MEG","S5 PCB",
  "S6 MPC","S6 MEG","S6 PCB",
];
type WgStatus = {
  installed: boolean; isAdmin: boolean; tunnelActive: boolean;
  vpnIp: string | null; publicKey: string | null; lastHandshake: string | null;
};
type ExtNavView = NavView | "device-users" | "devices";

/* ─── QuickInfo strip helper ─────────────────────────── */
function QuickInfo({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="text-[10px] text-slate-500 uppercase tracking-wide whitespace-nowrap">{label}</span>
      <span className={`text-[11px] font-bold font-mono ${accent ? "text-cyan-300" : "text-slate-300"}`}>{value}</span>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════════════════════ */
export default function SmartAttendanceDashboard() {

  const [stats,       setStats]       = useState<Stats>(emptyStats);
  const [device,      setDevice]      = useState<DeviceStatus | null>(null);
  const [logs,        setLogs]        = useState<AttendanceLog[]>([]);
  const [students,    setStudents]    = useState<Student[]>([]);
  const [deviceUsers, setDeviceUsers] = useState<DeviceUser[]>([]);
  const [busy,        setBusy]        = useState(false);
  const [query,       setQuery]       = useState("");
  const [readMode,    setReadMode]    = useState(0);
  const [activeView,  setActiveView]  = useState<ExtNavView>("dashboard");
  const [connected,   setConnected]   = useState(false);

  const [liveLog, setLiveLog] = useState<AttendanceLog | null>(null);
  const flashQueueRef = useRef<AttendanceLog[]>([]);
  const liveTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const knownLogIds   = useRef<Set<string>>(new Set());
  const showNextFromQueue = useRef(() => {
    const next = flashQueueRef.current.shift();
    if (!next) { setLiveLog(null); return; }
    setLiveLog(next);
    liveTimerRef.current = setTimeout(() => showNextFromQueue.current(), 4000);
  });

  const [schoolUser,      setSchoolUser]      = useState<any>(null);
  const [schoolLoggedIn,  setSchoolLoggedIn]  = useState(false);
  const [showSchoolLogin, setShowSchoolLogin] = useState(false);
  const [loginPending,    setLoginPending]    = useState<ExtNavView | null>(null);
  const [loginEmail,      setLoginEmail]      = useState("");
  const [loginPassword,   setLoginPassword]   = useState("");
  const [loginError,      setLoginError]      = useState("");
  const [loginBusy,       setLoginBusy]       = useState(false);

  const [deviceForm, setDeviceForm] = useState({ deviceId: "", ipAddress: "", port: 5005, license: 1261, location: "" });
  const deviceFormRef = useRef(deviceForm);
  useEffect(() => { deviceFormRef.current = deviceForm; }, [deviceForm]);

  const sseRef          = useRef<EventSource | null>(null);
  const sseReconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoConnectRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef      = useRef(true);
  const [connectStatus,  setConnectStatus]  = useState<"connecting"|"connected"|"retrying">("connecting");
  const [connectAttempt, setConnectAttempt] = useState(0);

  const [tabletName,        setTabletName]        = useState<string | null>(null);
  const [selectedDeviceName, setSelectedDeviceName] = useState<string | null>(null);
  const [deviceChoices, setDeviceChoices] = useState<string[]>([]);
  const [liveSessions, setLiveSessions] = useState<any[]>([]);
  const [tabletLocation,    setTabletLocation]    = useState<string | null>(null);
  const [schoolName,        setSchoolName]        = useState<string | null>(null);
  const [devPasswordActual, setDevPasswordActual] = useState("admin1234");

  // ── Registered biometric devices (persisted in backend data/devices-list.json) ──
  const [registeredDevices, setRegisteredDevices] = useState<RegisteredDevice[]>([]);
  const [deviceBusy, setDeviceBusy] = useState<Set<string>>(new Set());

  const loadRegisteredDevices = async () => {
    try {
      const r = await fetch(`${API_BASE}/api/devices-config`);
      const d = await r.json();
      if (d.success) setRegisteredDevices(d.devices || []);
    } catch {}
  };

  // Dev modal inline device management state
  const [devDeviceForm, setDevDeviceForm] = useState({ name: "", ipAddress: "", port: 5005, license: 1261, location: "", notes: "" });
  const [devDeviceEditId, setDevDeviceEditId] = useState<string | null>(null);
  const [devDeviceFormOpen, setDevDeviceFormOpen] = useState(false);

  const handleDeviceChoiceChange = async (nextName: string) => {
    setSelectedDeviceName(nextName);

    const match = liveSessions.find((session: any) => {
      const sessionName = String(session?.name || session?.deviceName || session?.deviceId || session?.ipAddress || '').trim();
      return sessionName === nextName;
    });

    if (!match) return;

    try {
      await deviceApi.selectSession({
        sessionId: match.sessionId || match.session_id || undefined,
        deviceId: match.deviceId || match.device_id || undefined,
        ipAddress: match.ipAddress || match.address || undefined,
      });
    } catch {
      // ignore selection errors here; the server still returns the real session list on refresh
    }
  };

  const [studentForm, setStudentForm] = useState({
    name: "", studentId: "", studentDeviceId: "",
    className: CLASS_LIST[0], section: "", assignedDeviceId: "", parentPhone: "",
  });

  const [devStep,          setDevStep]          = useState<"closed"|"password"|"settings"|"wireguard">("closed");
  const [devPendingAction, setDevPendingAction] = useState<"settings"|"wireguard">("settings");
  const [devPassword,      setDevPassword]      = useState("");
  const [devPasswordError, setDevPasswordError] = useState("");
  const [showDevPassword,  setShowDevPassword]  = useState(false);
  const [devForm, setDevForm] = useState({ ...deviceForm, serverApiUrl: "https://backend.ecareafrica.net/api/v1" });

  const [wgStatus,     setWgStatus]     = useState<WgStatus | null>(null);
  const [wgStep,       setWgStep]       = useState<1|2|3|4|5>(1);
  const [wgBusy,       setWgBusy]       = useState(false);
  const [wgError,      setWgError]      = useState("");
  const [wgKeys,       setWgKeys]       = useState<{privateKey:string;publicKey:string}|null>(null);
  const [wgAllowedIPs, setWgAllowedIPs] = useState("10.0.0.0/16");
  const [wgForm, setWgForm] = useState({ serverPublicKey: "", serverEndpoint: WG_SERVER_ENDPOINT_DEFAULT, vpnIp: "10.0.0.2", dns: "1.1.1.1" });
  const [wgPingTarget,  setWgPingTarget]  = useState("10.0.0.1");
  const [wgPingResult,  setWgPingResult]  = useState<{success:boolean;output:string}|null>(null);
  const [wgInstalled,   setWgInstalled]   = useState(false);
  const [wgDiagnosis,   setWgDiagnosis]   = useState<any>(null);
  const [wgDiagBusy,    setWgDiagBusy]    = useState(false);
  const [svcStatus,     setSvcStatus]     = useState<{bridgeService:string;frontendService:string;bothRunning:boolean}|null>(null);
  const [svcInstalling, setSvcInstalling] = useState(false);
  const [copiedKey,     setCopiedKey]     = useState(false);

  type SidebarState = "expanded" | "collapsed" | "hidden";
  const [sidebarState, setSidebarState] = useState<SidebarState>("expanded");
  const [mobileOpen,   setMobileOpen]   = useState(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHovering    = useRef(false);
  const [isSmall, setIsSmall] = useState(false);

  useEffect(() => {
    const check = () => setIsSmall(window.innerWidth < 860);
    check();
    window.addEventListener("resize", check, { passive: true });
    return () => window.removeEventListener("resize", check);
  }, []);

  const clearSidebarTimers = () => {
    if (collapseTimer.current) { clearTimeout(collapseTimer.current); collapseTimer.current = null; }
    if (hideTimer.current)     { clearTimeout(hideTimer.current);     hideTimer.current = null; }
  };
  const startIdleTimers = useCallback(() => {
    if (isHovering.current || isSmall) return;
    clearSidebarTimers();
    collapseTimer.current = setTimeout(() => {
      setSidebarState("collapsed");
      hideTimer.current = setTimeout(() => { if (!isHovering.current) setSidebarState("hidden"); }, 6000);
    }, 8000);
  }, [isSmall]);
  const onActivity = useCallback(() => {
    if (isSmall) return;
    setSidebarState(prev => prev === "hidden" ? "hidden" : "expanded");
    startIdleTimers();
  }, [isSmall, startIdleTimers]);

  useEffect(() => {
    const evts = ["mousemove","mousedown","keydown","touchstart","scroll"];
    evts.forEach(e => window.addEventListener(e, onActivity, { passive: true }));
    startIdleTimers();
    return () => { evts.forEach(e => window.removeEventListener(e, onActivity)); clearSidebarTimers(); };
  }, [onActivity, startIdleTimers]);

  const handleSidebarMouseEnter = () => { if (isSmall) return; isHovering.current = true; clearSidebarTimers(); setSidebarState("expanded"); };
  const handleSidebarMouseLeave = () => { if (isSmall) return; isHovering.current = false; startIdleTimers(); };

  const sidebarWidth = sidebarState === "expanded" ? "w-60" : sidebarState === "collapsed" ? "w-14" : "w-0";
  const isCollapsed  = sidebarState === "collapsed";
  const isHidden     = sidebarState === "hidden";

  /* SSE */
  const onFreshRef = useRef<(l: AttendanceLog[]) => void>(() => {});
  onFreshRef.current = (fresh) => {
    const deduped = fresh.filter(l => !knownLogIds.current.has(l.id));
    if (!deduped.length) return;
    deduped.forEach(l => knownLogIds.current.add(l.id));
    setLogs(prev => [...deduped, ...prev].slice(0, 200));
    setStats(prev => ({ ...prev, attendanceToday: prev.attendanceToday + deduped.length, totalLogs: prev.totalLogs + deduped.length }));
    flashQueueRef.current.push(...deduped);
    if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
    showNextFromQueue.current();
  };
  const seedRef = useRef<(l: AttendanceLog[]) => void>(() => {});
  seedRef.current = (ls) => { ls.forEach(l => knownLogIds.current.add(l.id)); setLogs(ls); };

  function dismissLive() {
    if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
    if (flashQueueRef.current.length > 0) showNextFromQueue.current(); else setLiveLog(null);
  }
  function connectSSE() {
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
    if (sseReconnectRef.current) { clearTimeout(sseReconnectRef.current); sseReconnectRef.current = null; }
    const es = new EventSource(`${API_BASE}/api/events`);
    es.addEventListener("init", e => { try { seedRef.current(JSON.parse((e as MessageEvent).data)); } catch {} });
    es.addEventListener("attendance", e => { try { onFreshRef.current(JSON.parse((e as MessageEvent).data)); } catch {} });
    es.addEventListener("deviceStatus", e => {
      try {
        const s = JSON.parse((e as MessageEvent).data);
        if (s?.connected === false) {
          setDevice(null); setConnected(false); setConnectStatus("retrying");
          toast.error("Device went offline — reconnecting...", { id: "ac" });
          if (autoConnectRef.current) clearTimeout(autoConnectRef.current);
          attemptConnect(0);
        }
      } catch {}
    });
    // Live device list + per-device status updates
    es.addEventListener("devicesInit", (e: MessageEvent) => {
      try { const list = JSON.parse(e.data); if (Array.isArray(list)) setRegisteredDevices(list); } catch {}
    });
    es.addEventListener("devicesStatus", (e: MessageEvent) => {
      try {
        const { id, connected: conn, error } = JSON.parse(e.data);
        setRegisteredDevices(prev => prev.map(d =>
          d.id === id ? { ...d, status: { connected: conn, error, lastAttempt: new Date().toISOString() } } : d
        ));
        setDeviceBusy(prev => { const s = new Set(prev); s.delete(id); return s; });
      } catch {}
    });
    es.onerror = () => { es.close(); sseRef.current = null; sseReconnectRef.current = setTimeout(connectSSE, 3000); };
    sseRef.current = es;
  }

  /* Health */
  const applyServerHealth = useCallback((data: any) => {
    const saved = data?.savedConfig;
    const loc   = data?.tabletLocation || saved?.location || "";
    const name  = data?.tabletName || null;
    const deviceName = data?.selectedDeviceName || data?.deviceName || null;
    const sessionList = Array.isArray(data?.sessions) ? data.sessions : [];
    setLiveSessions(sessionList);

    const availableNames = Array.isArray(data?.tabletDevices)
      ? data.tabletDevices
          .map((item: any) => item?.name)
          .filter((item: any) => typeof item === "string" && item.trim())
          .sort((a: string, b: string) => a.localeCompare(b))
      : sessionList
          .map((item: any) => String(item?.name || item?.deviceName || item?.deviceId || item?.ipAddress || '').trim())
          .filter(Boolean)
          .sort((a: string, b: string) => a.localeCompare(b));

    if (saved) {
      const cfg = {
        deviceId:  saved.deviceId  || deviceFormRef.current.deviceId,
        ipAddress: saved.ipAddress || deviceFormRef.current.ipAddress,
        port:      saved.port      || deviceFormRef.current.port,
        license:   saved.license   || deviceFormRef.current.license,
        location:  loc,
      };
      setDeviceForm(cfg); deviceFormRef.current = cfg;
    }
    if (name) setTabletName(name);
    if (deviceName) setSelectedDeviceName(deviceName);
    if (availableNames.length > 0) setDeviceChoices(availableNames);
    else setDeviceChoices([]);
    if (loc)  { setTabletLocation(loc); setDeviceForm(p => ({ ...p, location: loc })); setDevForm(p => ({ ...p, location: loc })); }
    if (data?.devPassword) setDevPasswordActual(data.devPassword);
    if (data?.schoolName)  setSchoolName(data.schoolName);
    if (data?.fk623?.users != null) setDevice(p => p ? { ...p, users: data.fk623.users } : null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    mountedRef.current = true;
    connectSSE();
    attemptConnect(0);
    fetch(`${API_BASE}/api/health`).then(r => r.json()).then(applyServerHealth).catch(() => {});
    loadRegisteredDevices();
    const hiv = setInterval(() => {
      fetch(`${API_BASE}/api/health`).then(r => r.json()).then(applyServerHealth).catch(() => {});
    }, 30000);
    return () => {
      mountedRef.current = false; clearInterval(hiv);
      if (autoConnectRef.current) clearTimeout(autoConnectRef.current);
      if (liveTimerRef.current)   clearTimeout(liveTimerRef.current);
      if (sseReconnectRef.current) clearTimeout(sseReconnectRef.current);
      if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (connectStatus !== "connected") return;
    const iv = setInterval(refreshDashboard, 30000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectStatus]);

  /* Connect */
  async function attemptConnect(attempt: number) {
    if (!mountedRef.current) return;
    const ipAddress = String(deviceFormRef.current.ipAddress || "").trim();
    if (!ipAddress) {
      setDevice(null); setConnected(false); setConnectStatus("retrying");
      toast.error("Enter the device IP address and connection details before connecting on the same network.", { id: "ac" });
      return;
    }
    setConnectAttempt(attempt); setConnectStatus("connecting");
    try {
      const res = attempt === 0
        ? await deviceApi.connect({ deviceId: deviceFormRef.current.deviceId, ipAddress, port: deviceFormRef.current.port, license: deviceFormRef.current.license, timeoutMs: 6000, saveConfig: true })
        : await deviceApi.connectSaved();
      if (!mountedRef.current) return;
      setDevice(res.data.data); setConnected(true); setConnectStatus("connected");
      if (attempt > 0) toast.success("Device reconnected", { id: "ac" });
      await refreshDashboard(); scheduleReconnectCheck();
    } catch {
      if (!mountedRef.current) return;
      setDevice(null); setConnected(false); setConnectStatus("retrying");
      if (attempt === 0 || attempt % 5 === 0) toast.error("Device unreachable — retrying...", { id: "ac" });
      autoConnectRef.current = setTimeout(() => attemptConnect(attempt + 1), Math.min(1500 + attempt * 1500, 10000));
    }
  }
  function scheduleReconnectCheck() {
    if (autoConnectRef.current) clearTimeout(autoConnectRef.current);
    autoConnectRef.current = setTimeout(async () => {
      if (!mountedRef.current) return;
      try { await deviceApi.getStatus(); scheduleReconnectCheck(); }
      catch { setDevice(null); setConnected(false); setConnectStatus("retrying"); attemptConnect(0); }
    }, 15000);
  }
  async function refreshDashboard() {
    try {
      const [sr, lr] = await Promise.all([dashboardApi.getStats(), dashboardApi.getRecent()]);
      if (sr.data) setStats(sr.data as Stats);
      if (lr.data) {
        const fresh = (lr.data as AttendanceLog[]).filter(l => !knownLogIds.current.has(l.id));
        if (fresh.length) { fresh.forEach(l => knownLogIds.current.add(l.id)); setLogs(p => [...fresh, ...p].slice(0, 200)); }
      }
      studentApi.getAll().then(r => { if (r.data) setStudents(r.data as Student[]); }).catch(() => null);
    } catch {}
  }

  /* ── Dev-auth gate ─────────────────────────────────────────────────────────
   * Any function that sends data to / reads data from the physical device
   * must call withDevAuth(fn). It shows a minimal inline password modal,
   * verifies the developer password, then calls fn() with the password so
   * the backend requireDevPassword middleware accepts the request.
   *
   * The password is passed as a custom header (X-Dev-Password) on all
   * device-data API calls so the backend can validate it.
   * ─────────────────────────────────────────────────────────────────────── */
  const [devAuthOpen,       setDevAuthOpen]       = useState(false);
  const [devAuthPassword,   setDevAuthPassword]   = useState("");
  const [devAuthError,      setDevAuthError]      = useState("");
  const [devAuthBusy,       setDevAuthBusy]       = useState(false);
  const [devAuthShowPw,     setDevAuthShowPw]     = useState(false);
  const devAuthPendingRef   = useRef<((pw: string) => Promise<void>) | null>(null);
  const devAuthResolvedPwRef = useRef<string>("");  // cache verified pw for the session

  /** Wrap a device-data operation behind the dev password gate. */
  function withDevAuth(fn: (pw: string) => Promise<void>) {
    // If we already verified the password this session, skip the modal
    if (devAuthResolvedPwRef.current) { void fn(devAuthResolvedPwRef.current); return; }
    devAuthPendingRef.current = fn;
    setDevAuthPassword(""); setDevAuthError(""); setDevAuthShowPw(false);
    setDevAuthOpen(true);
  }

  async function submitDevAuth(e: React.FormEvent) {
    e.preventDefault();
    if (devAuthPassword !== devPasswordActual) {
      setDevAuthError("Incorrect password"); setDevAuthPassword(""); return;
    }
    setDevAuthBusy(true); setDevAuthError("");
    devAuthResolvedPwRef.current = devAuthPassword;
    const fn = devAuthPendingRef.current;
    setDevAuthOpen(false); setDevAuthPassword("");
    devAuthPendingRef.current = null;
    if (fn) await fn(devAuthResolvedPwRef.current).catch(() => null);
    setDevAuthBusy(false);
  }

  /** Helper: extract a user-friendly message from an axios/fetch error,
   *  handling the device_not_connected and dev_password_required codes. */
  function handleDeviceError(e: any, fallback = "Operation failed"): void {
    const data = e?.response?.data ?? e?.data ?? {};
    const code = data?.code ?? "";
    const msg  = data?.error ?? e?.message ?? fallback;

    if (code === "device_not_connected") {
      setDevice(null); setConnected(false); setConnectStatus("retrying");
      toast.error("Device went offline. Reconnecting…", { id: "ac" });
      if (autoConnectRef.current) clearTimeout(autoConnectRef.current);
      attemptConnect(0);
      return;
    }
    if (code === "dev_password_required" || code === "dev_password_incorrect") {
      // Password was cached but server rejected — invalidate cache and re-prompt
      devAuthResolvedPwRef.current = "";
      toast.error("Developer password required");
      return;
    }
    toast.error(msg);
  }

  async function pullLogs() {
    withDevAuth(async (pw) => {
      setBusy(true);
      try {
        const res = await deviceApi.pullLogs(readMode, pw);
        if (res.data) {
          const pulled = (res.data as AttendanceLog[]).filter(l => !knownLogIds.current.has(l.id));
          pulled.forEach(l => knownLogIds.current.add(l.id));
          setLogs(p => [...pulled, ...p].slice(0, 500));
          toast.success(`Pulled ${pulled.length} new log${pulled.length !== 1 ? "s" : ""}`);
        }
      } catch (e: any) { handleDeviceError(e, "Pull logs failed"); }
      finally { setBusy(false); }
    });
  }

  async function pullUsers() {
    withDevAuth(async (pw) => {
      setBusy(true);
      try {
        const res = await deviceApi.getUsers(pw);
        const raw = res.data as any;
        const list: DeviceUser[] = Array.isArray(raw) ? raw : raw?.data ?? raw?.users ?? [];
        setDeviceUsers(list);
        toast.success(`Loaded ${list.length} device user${list.length !== 1 ? "s" : ""}`);
      } catch (e: any) { handleDeviceError(e, "Get users failed"); }
      finally { setBusy(false); }
    });
  }

  async function syncTime() {
    withDevAuth(async (pw) => {
      setBusy(true);
      try { await deviceApi.syncTime(pw); toast.success("Device time synced"); }
      catch (e: any) { handleDeviceError(e, "Sync time failed"); }
      finally { setBusy(false); }
    });
  }

  async function pushStudents() {
    withDevAuth(async (pw) => {
      setBusy(true);
      try {
        const res = await deviceApi.pushStudents(undefined, pw);
        const d = res.data as any;
        const pushed = d?.data?.pushed ?? d?.pushed ?? "?";
        const failed = d?.data?.failed ?? 0;
        if (failed > 0) toast.error(`${pushed} pushed, ${failed} failed — check device connection`);
        else toast.success(`Pushed ${pushed} student${pushed !== 1 ? "s" : ""} to device`);
      } catch (e: any) { handleDeviceError(e, "Push students failed"); }
      finally { setBusy(false); }
    });
  }

  async function loadStudentsLocal() {
    setBusy(true);
    try { const res = await studentApi.getAll(); setStudents((res.data as any)?.students ?? res.data ?? []); }
    catch (e: any) { toast.error(e?.message || "Failed"); }
    finally { setBusy(false); }
  }

  const filteredLogs = logs.filter(l => {
    if (!query) return true;
    const q = query.toLowerCase();
    return `${l.studentName} ${l.studentId ?? ""} ${l.className ?? ""}`.toLowerCase().includes(q);
  });

  /* School auth */
  const switchToProtectedView = (view: ExtNavView) => {
    if (schoolLoggedIn) { setActiveView(view); return; }
    setLoginPending(view); setLoginEmail(""); setLoginPassword(""); setLoginError("");
    setShowSchoolLogin(true);
  };
  const handleSchoolLogin = async (e: FormEvent) => {
    e.preventDefault(); setLoginBusy(true); setLoginError("");
    try {
      const r = await schoolApi.login(loginEmail.trim(), loginPassword);
      const d = r.data as any;
      if (d.success && d.user) {
        setSchoolUser(d.user); setSchoolLoggedIn(true); setShowSchoolLogin(false);
        if (loginPending) { setActiveView(loginPending); setLoginPending(null); }
        toast.success(`Welcome, ${d.user.name ?? d.user.role}`);
      } else { setLoginError(d.error ?? "Login failed"); }
    } catch (e: any) { setLoginError(e?.response?.data?.error ?? "Cannot reach school server"); }
    finally { setLoginBusy(false); }
  };
  const handleSchoolLogout = async () => {
    await schoolApi.logout().catch(() => {});
    setSchoolUser(null); setSchoolLoggedIn(false); setActiveView("dashboard");
    toast.success("Logged out");
  };

  /* Dev modal */
  const openDevModal = () => {
    setDevPassword(""); setDevPasswordError(""); setShowDevPassword(false);
    setDevPendingAction("settings");
    fetch(`${API_BASE}/api/health`).then(r => r.json()).then(data => {
      const saved = data?.savedConfig;
      const loc   = data?.tabletLocation || saved?.location || "";
      setDevForm({ deviceId: saved?.deviceId || deviceForm.deviceId, ipAddress: saved?.ipAddress || deviceForm.ipAddress, port: saved?.port || deviceForm.port, license: saved?.license || deviceForm.license, location: loc, serverApiUrl: data?.serverApiUrl || "https://backend.ecareafrica.net/api/v1" });
    }).catch(() => setDevForm({ ...deviceForm, location: tabletLocation || "", serverApiUrl: "https://backend.ecareafrica.net/api/v1" }));
    setDevStep("password");
  };
  const closeDevModal = () => { setDevStep("closed"); setDevPassword(""); setDevPasswordError(""); };

  function submitDevPassword(e: FormEvent) {
    e.preventDefault();
    if (devPassword === devPasswordActual) {
      setDevPasswordError(""); setDevPassword("");
      if (devPendingAction === "wireguard") loadAndOpenWgWizard(); else setDevStep("settings");
    } else { setDevPasswordError("Incorrect password. Try again."); setDevPassword(""); }
  }

  /**
   * saveDevSettings — three steps to guarantee the new IP takes effect immediately:
   * 1. POST /api/device/set-ip  → updates activeDeviceConfig in memory right now
   * 2. POST /api/config/server-url → updates SERVER_API_URL in memory + .env
   * 3. POST /api/device/connect with saveConfig:true → full persist + actual connect attempt
   *
   * Even if Step 3 fails (device temporarily off network), Step 1 has already stored the IP
   * so every subsequent auto-connect retry will use the correct address.
   */
  function saveDevSettings(e: FormEvent) {
    e.preventDefault();
    const cfg = { ...devForm, location: tabletLocation || devForm.location || "" };
    const ipAddress = String(cfg.ipAddress || "").trim();
    if (!ipAddress) {
      setDevPasswordError("IP address is required to connect the tablet and device on the same local network.");
      return;
    }
    setDeviceForm(cfg); deviceFormRef.current = cfg;
    closeDevModal();
    toast.loading("Saving settings...", { id: "ac" });

    // Step 1 — instant in-memory update
    fetch(`${API_BASE}/api/device/set-ip`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ipAddress: cfg.ipAddress, port: cfg.port, license: cfg.license, deviceId: cfg.deviceId || "", timeoutMs: 15000 }),
    }).catch(() => null);

    // Step 2 — server URL
    if (cfg.serverApiUrl?.startsWith("http")) {
      fetch(`${API_BASE}/api/config/server-url`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: cfg.serverApiUrl }),
      }).catch(() => null);
    }

    // Step 3 — authoritative connect + persist
    if (autoConnectRef.current) clearTimeout(autoConnectRef.current);
    deviceApi.connect({ ...cfg, timeoutMs: 12000, saveConfig: true })
      .then(res => {
        if (!mountedRef.current) return;
        toast.dismiss("ac");
        setDevice(res.data.data); setConnected(true); setConnectStatus("connected");
        toast.success(`Connected to ${cfg.ipAddress}`, { id: "ac" });
        refreshDashboard(); scheduleReconnectCheck();
      })
      .catch(() => {
        if (!mountedRef.current) return;
        toast.dismiss("ac");
        setDevice(null); setConnected(false); setConnectStatus("retrying");
        toast.error(`IP saved. Cannot reach ${cfg.ipAddress} — retrying...`, { id: "ac" });
        setTimeout(() => attemptConnect(0), 500);
      });
  }

  /* WireGuard */
  function openWgWizard() { setDevPassword(""); setDevPasswordError(""); setShowDevPassword(false); setDevPendingAction("wireguard"); setDevStep("password"); }
  async function loadAndOpenWgWizard() {
    setWgError(""); setWgPingResult(null); setWgBusy(true);
    try {
      const health = await fetch(`${API_BASE}/api/health`).then(r => r.json()).catch(() => null);
      const vpnCfg = health?.vpn;
      if (vpnCfg?.serverEndpoint) {
        const base = (vpnCfg.allowedIPs || "10.0.0.0/16").split("/")[0]; const oct = base.split(".");
        setWgAllowedIPs(vpnCfg.allowedIPs || "10.0.0.0/16");
        setWgForm(p => ({ ...p, serverEndpoint: vpnCfg.serverEndpoint, dns: vpnCfg.dns || "1.1.1.1" }));
        setWgPingTarget(`${oct[0]}.${oct[1]}.0.1`);
      }
      const r = await wireguardApi.getStatus(); const s = r.data as WgStatus & { installed: boolean };
      setWgStatus(s); setWgInstalled(s.installed);
      if (s.publicKey) { setWgKeys({ privateKey: "----hidden----", publicKey: s.publicKey }); setWgStep(s.tunnelActive ? 4 : 3); }
      else if (s.installed) setWgStep(2); else setWgStep(1);
    } catch { setWgStep(1); setWgInstalled(false); }
    setWgBusy(false); setDevStep("wireguard"); void checkServices();
  }
  async function wgRefreshStatus() { try { const r = await wireguardApi.getStatus(); const s = r.data as WgStatus & { installed: boolean }; setWgStatus(s); setWgInstalled(s.installed); } catch {} }
  async function wgGenerateKeys() {
    setWgBusy(true); setWgError("");
    try { const r = await wireguardApi.generateKeys(); setWgKeys(r.data as any); setWgStep(3); }
    catch (e: any) { setWgError(e?.response?.data?.error || e.message || "Failed"); }
    setWgBusy(false);
  }
  async function wgInstall() {
    if (!wgForm.serverPublicKey.trim()) { setWgError("Paste the server public key first."); return; }
    if (!wgForm.serverEndpoint.trim())  { setWgError("Server endpoint is required."); return; }
    if (!wgForm.vpnIp.trim())           { setWgError("VPN IP is required."); return; }
    setWgBusy(true); setWgError("");
    try {
      const r = await wireguardApi.install(wgForm); const data = r.data as any;
      await wgRefreshStatus();
      if (data.requiresGuiImport) { setWgError(`Auto-install failed. Open WireGuard app → Import tunnel → select:\n${data.confPath || "C:\\Temp\\EcareAfrica.conf"}\nthen Activate.`); setWgStep(4); }
      else { setWgStep(4); toast.success(data.message || "Tunnel activated"); }
    } catch (e: any) { setWgError(e?.response?.data?.error || e.message || "Installation failed"); }
    setWgBusy(false);
  }
  async function wgDeactivate() {
    setWgBusy(true); setWgError("");
    try { await wireguardApi.deactivate(); await wgRefreshStatus(); toast.success("Tunnel stopped"); }
    catch (e: any) { setWgError(e?.response?.data?.error || e.message || "Failed"); }
    setWgBusy(false);
  }
  async function wgPing() {
    setWgBusy(true); setWgPingResult(null); setWgError("");
    try {
      const r = await wireguardApi.ping(wgPingTarget); const data = r.data as { success: boolean; output: string };
      setWgPingResult(data);
      if (data.success) toast.success("VPN tunnel is live", { duration: 5000 }); else toast.error(`Ping ${wgPingTarget} failed`);
    } catch (e: any) { setWgPingResult({ success: false, output: e?.response?.data?.output || e.message || "Failed" }); }
    setWgBusy(false);
  }
  async function wgDiagnose() {
    setWgDiagBusy(true); setWgDiagnosis(null);
    try { const r = await wireguardApi.diagnose(); setWgDiagnosis(r.data as any); }
    catch (e: any) { setWgDiagnosis({ healthy: false, problems: [e?.message || "Diagnosis failed"], fixes: [] }); }
    setWgDiagBusy(false);
  }
  async function wgSyncKey() {
    setWgDiagBusy(true);
    try { const r = await wireguardApi.syncKey(); const d = r.data as any; toast.success("Keys synced — " + (d.activeKey?.slice(0,16) + "...")); await wgRefreshStatus(); await wgDiagnose(); }
    catch (e: any) { toast.error(e?.response?.data?.error || e.message || "Sync failed"); }
    setWgDiagBusy(false);
  }
  async function checkServices() { try { const r = await wireguardApi.getServicesStatus(); setSvcStatus(r.data as any); } catch { setSvcStatus(null); } }
  async function installServices() {
    setSvcInstalling(true);
    try {
      toast.loading("Installing services (up to 2 min)...", { id: "svc" });
      const r = await wireguardApi.installServices(); const d = r.data as any;
      toast.dismiss("svc");
      if (d.success) { toast.success("Services installed — auto-start active"); await checkServices(); }
      else toast.error("Install had issues — check output");
    } catch (e: any) { toast.dismiss("svc"); toast.error(e?.response?.data?.error || e.message || "Failed"); }
    setSvcInstalling(false);
  }
  function copyToClipboard(text: string) { navigator.clipboard.writeText(text).catch(() => {}); setCopiedKey(true); setTimeout(() => setCopiedKey(false), 2000); }

  /* ═════════════════════════════════════════════════════
     RENDER
  ═════════════════════════════════════════════════════ */
  return (
    <div className="fixed inset-0 flex overflow-hidden bg-[#070b14]">

      {isSmall && mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
      )}

      {/* ══ SIDEBAR ══════════════════════════════════════════ */}
      <aside
        onMouseEnter={handleSidebarMouseEnter}
        onMouseLeave={handleSidebarMouseLeave}
        className={`flex flex-col border-r border-slate-800/60 bg-slate-900/98 transition-all duration-300 ease-in-out overflow-hidden z-40
          ${isSmall
            ? `fixed inset-y-0 left-0 w-72 shadow-2xl shadow-black/60 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`
            : `relative shrink-0 ${sidebarWidth} ${isHidden ? "border-transparent" : ""}`}`}
      >
        {/* Logo */}
        <div className={`flex items-center border-b border-slate-800 px-3 py-4 shrink-0 ${isCollapsed && !isSmall ? "justify-center" : "justify-between"}`}>
          {(!isCollapsed || isSmall) && (
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-cyan-500/20 text-cyan-400 text-sm font-black">E</div>
              <div className="min-w-0">
                <span className="block text-sm font-bold text-white truncate">EcaAfrica</span>
                {schoolName && <span className="block text-[10px] text-slate-400 truncate">{schoolName}</span>}
              </div>
            </div>
          )}
          {isCollapsed && !isSmall && <div className="grid h-8 w-8 place-items-center rounded-lg bg-cyan-500/20 text-cyan-400 text-sm font-black">E</div>}
          {(!isCollapsed || isSmall) && (
            <button onClick={() => isSmall ? setMobileOpen(false) : setSidebarState("collapsed")}
              className="shrink-0 rounded-lg p-1.5 text-slate-500 hover:bg-slate-800 hover:text-white transition">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
              </svg>
            </button>
          )}
        </div>

        {/* Nav */}
        <nav className={`flex-1 overflow-y-auto py-3 space-y-0.5 ${isCollapsed && !isSmall ? "px-1" : "px-2"}`}>
          {[
            { view: "dashboard",    icon: <FiActivity />,    label: "Dashboard",    prot: false },
            { view: "students",     icon: <FiUsers />,       label: "Students",     prot: false },
            { view: "device-users", icon: <FiCpu />,         label: "Device Users", prot: false },
            { view: "devices",      icon: <FiServer />,      label: "Devices",      prot: false },
            { view: "gate",         icon: <FiShield />,      label: "Gate Keeper",  prot: false },
            { view: "attendance",   icon: <FiCheckCircle />, label: "Attendance",   prot: true  },
            { view: "users",        icon: <FiUserCheck />,   label: "School Users", prot: true  },
          ].map(({ view, icon, label, prot }) => (
            <NavItem key={view} icon={icon} label={label} collapsed={isCollapsed && !isSmall} active={activeView === view}
              onClick={() => {
                if (isSmall) setMobileOpen(false);
                if (view === "gate") setActiveView("gate");
                else if (prot) switchToProtectedView(view as ExtNavView);
                else setActiveView(view as ExtNavView);
              }} />
          ))}
          {schoolLoggedIn && !isCollapsed && (
            <div className="mx-1 mt-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-3 py-2.5">
              <p className="text-xs font-semibold text-emerald-300 truncate">{schoolUser?.name ?? schoolUser?.role}</p>
              <button onClick={handleSchoolLogout} className="flex items-center gap-1 text-[10px] text-emerald-400 hover:text-white mt-0.5">
                <FiLogOut className="text-[10px]" /> Logout
              </button>
            </div>
          )}
        </nav>

        {/* Sidebar logs (dashboard) */}
        {activeView === "dashboard" && !isCollapsed && (
          <div className="flex flex-col min-h-0 px-2 pb-3 border-t border-slate-800 pt-3" style={{ maxHeight: "38vh" }}>
            <div className="mb-2 flex items-center justify-between shrink-0">
              <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                <FiDatabase className="text-cyan-400" /> Recent Logs
              </span>
              <div className="flex gap-1">
                <select value={readMode} onChange={e => setReadMode(Number(e.target.value))} className="rounded-lg border border-slate-700 bg-slate-800 px-1.5 py-1 text-[10px] text-slate-300 outline-none">
                  <option value={0}>All</option><option value={1}>New</option>
                </select>
                <button onClick={pullLogs} disabled={busy || !connected} className="rounded-lg border border-slate-700 bg-slate-800 p-1.5 text-slate-400 hover:text-cyan-400 disabled:opacity-40 touch-manipulation">
                  <FiDownloadCloud className="text-xs" />
                </button>
              </div>
            </div>
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search logs..." autoComplete="off"
              className="mb-2 w-full rounded-xl border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-400 shrink-0" />
            <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
              {filteredLogs.slice(0, 50).map(l => (
                <div key={l.id} className="rounded-lg border border-slate-800 bg-slate-800/50 p-2 text-xs">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-semibold truncate">{l.studentName}</span>
                    <StatusPill status={l.status} small />
                  </div>
                  <p className="text-slate-500 text-[10px]">{new Date(l.timestamp).toLocaleTimeString()}</p>
                </div>
              ))}
              {filteredLogs.length === 0 && <p className="py-4 text-center text-xs text-slate-600">No logs yet</p>}
            </div>
          </div>
        )}

        {/* Sidebar students (students view) */}
        {activeView === "students" && !isCollapsed && (
          <div className="flex flex-col min-h-0 px-2 pb-3 border-t border-slate-800 pt-3 overflow-y-auto space-y-3" style={{ maxHeight: "55vh" }}>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 shrink-0">Register Student</p>
            <SideField label="Full Name *" value={studentForm.name} onChange={v => setStudentForm(f => ({...f, name: v}))} placeholder="Student name" required />
            <SideField label="Student ID" value={studentForm.studentId} onChange={v => setStudentForm(f => ({...f, studentId: v}))} placeholder="STU-001" />
            <SideField label="Device User ID *" value={studentForm.studentDeviceId} onChange={v => setStudentForm(f => ({...f, studentDeviceId: v}))} placeholder="Device user ID" required />
            <SideSelect label="Class" value={studentForm.className} onChange={v => setStudentForm(f => ({...f, className: v}))} options={CLASS_LIST} />
            <SideField label="Section" value={studentForm.section} onChange={v => setStudentForm(f => ({...f, section: v}))} placeholder="A / B / C" />
            <SideField label="Parent Phone" value={studentForm.parentPhone} onChange={v => setStudentForm(f => ({...f, parentPhone: v}))} placeholder="+250..." />
            <button onClick={() => {
              if (!studentForm.name || !studentForm.studentDeviceId) { toast.error("Name and device ID required"); return; }
              withDevAuth(async (pw) => {
                setBusy(true);
                try {
                  const res = await studentApi.create({
                    name: studentForm.name, studentId: studentForm.studentId,
                    studentDeviceId: studentForm.studentDeviceId, className: studentForm.className,
                    section: studentForm.section, parentPhone: studentForm.parentPhone,
                  }, pw);
                  const d = res.data as any;
                  if (d?.savedLocally && d?.code === "device_not_connected") {
                    toast.success(`${studentForm.name} saved locally`, { icon: "💾" });
                    toast.error("Device offline — student will be pushed when device reconnects");
                    setDevice(null); setConnected(false); setConnectStatus("retrying");
                    if (autoConnectRef.current) clearTimeout(autoConnectRef.current);
                    attemptConnect(0);
                  } else if (d?.success !== false) {
                    toast.success(`${studentForm.name} registered & pushed to device`);
                  } else {
                    toast.error(d?.error || "Registration failed");
                  }
                  setStudentForm({ name:"", studentId:"", studentDeviceId:"", className: CLASS_LIST[0], section:"", assignedDeviceId:"", parentPhone:"" });
                  await loadStudentsLocal();
                } catch (e: any) { handleDeviceError(e, "Registration failed"); }
                setBusy(false);
              });
            }} disabled={busy} className="w-full rounded-xl bg-cyan-600 py-3 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-50 touch-manipulation shrink-0">
              Register Student
            </button>
            <div className="border-t border-slate-800 pt-2 shrink-0">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Registered ({students.length})</p>
                <button onClick={loadStudentsLocal} disabled={busy} className="rounded-lg border border-slate-700 p-1.5 text-xs text-slate-400 hover:text-white disabled:opacity-40 touch-manipulation">
                  <FiRefreshCw className={busy ? "animate-spin" : ""} />
                </button>
              </div>
              {students.map(s => (
                <div key={s.studentDeviceId} className="mb-1 rounded-xl border border-slate-800 bg-slate-800/40 p-2.5 text-xs">
                  <p className="font-semibold">{s.name}</p>
                  <p className="text-slate-500">{s.className}{s.section ? ` · ${s.section}` : ""}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Dev buttons */}
        <div className="shrink-0 space-y-2 border-t border-slate-800 p-2">
          <button onClick={openDevModal}
            className={`group flex w-full items-center gap-2.5 rounded-xl border border-slate-700/40 bg-slate-800/30 text-slate-500 hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-300 transition-all duration-200 touch-manipulation ${isCollapsed && !isSmall ? "justify-center px-0 py-3" : "px-3 py-2.5"}`}
            title={isCollapsed && !isSmall ? "Developer" : undefined}>
            <FiSettings className="shrink-0 text-base" />
            {(!isCollapsed || isSmall) && <span className="text-xs font-medium">Developer</span>}
          </button>
          <button onClick={openWgWizard}
            className={`group flex w-full items-center gap-2.5 rounded-xl border border-slate-700/40 bg-slate-800/30 text-slate-500 hover:border-cyan-500/40 hover:bg-cyan-500/10 hover:text-cyan-300 transition-all duration-200 touch-manipulation ${isCollapsed && !isSmall ? "justify-center px-0 py-3" : "px-3 py-2.5"}`}
            title={isCollapsed && !isSmall ? "WireGuard VPN" : undefined}>
            <FiShield className="shrink-0 text-base" />
            {(!isCollapsed || isSmall) && <span className="text-xs font-medium">WireGuard VPN</span>}
          </button>
        </div>
      </aside>

      {/* ══ MAIN AREA ════════════════════════════════════════ */}
      <main className="relative flex flex-1 flex-col overflow-hidden min-w-0">
        {liveLog && <LiveAttendanceScreen log={liveLog} onDismiss={dismissLive} />}

        {!liveLog && (
          <div className="flex h-full flex-col overflow-hidden">

            {/* ── HEADER ───────────────────────────────── */}
            <header className="shrink-0 border-b border-slate-800/80 bg-slate-900/90 backdrop-blur-md">
              <div className="flex items-center gap-4 px-5 pt-4 pb-3">
                {/* Hamburger */}
                <div className="shrink-0 w-9">
                  {(isSmall || isHidden) ? (
                    <button onClick={() => isSmall ? setMobileOpen(true) : setSidebarState("expanded")}
                      className="rounded-xl border border-slate-700 bg-slate-800 p-2 text-slate-300 hover:text-white transition touch-manipulation">
                      <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                      </svg>
                    </button>
                  ) : <div />}
                </div>

                {/* Big tablet name */}
                <div className="flex-1 text-center min-w-0 px-2">
                  {tabletName || selectedDeviceName ? (
                    <>
                      <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tight text-white leading-none truncate">
                        {selectedDeviceName || tabletName || "FK623 Attendance"}
                      </h1>
                      <div className="mt-1.5 flex items-center justify-center gap-3 flex-wrap">
                        {tabletLocation && (
                          <span className="flex items-center gap-1 text-xs text-slate-400">
                            <FiMapPin className="text-cyan-400 shrink-0" /> {tabletLocation}
                          </span>
                        )}
                        {tabletName && selectedDeviceName && (
                          <span className="text-[10px] uppercase tracking-[0.14em] text-slate-500">Tablet: {tabletName}</span>
                        )}
                        {schoolName && <span className="text-xs text-slate-500 font-medium">{schoolName}</span>}
                      </div>
                    </>
                  ) : (
                    <>
                      <h1 className="text-2xl sm:text-3xl font-black text-white">FK623 Attendance</h1>
                      <p className="text-xs text-slate-500 mt-0.5">Biometric · Real-time</p>
                    </>
                  )}
                </div>

                {/* Status + reconnect */}
                <div className="flex items-center gap-2 shrink-0">
                  <AutoConnectBadge status={connectStatus} attempt={connectAttempt} />
                  <button onClick={() => { if (autoConnectRef.current) clearTimeout(autoConnectRef.current); attemptConnect(0); }}
                    disabled={connectStatus === "connecting"}
                    className="hidden sm:flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700 disabled:opacity-50 transition touch-manipulation">
                    <FiRefreshCw className={connectStatus === "connecting" ? "animate-spin" : ""} />
                    <span className="hidden lg:inline">Reconnect</span>
                  </button>
                </div>
              </div>

              {/* Device strip */}
              {connected && device && (
                <div className="flex items-center gap-5 border-t border-slate-800/60 bg-slate-950/40 px-5 py-2 overflow-x-auto">
                  {deviceForm.ipAddress && <QuickInfo label="IP" value={deviceForm.ipAddress} />}
                  {selectedDeviceName && <QuickInfo label="Device" value={selectedDeviceName} accent />}
                  {deviceChoices.length > 0 && (
                    <label className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-2 py-1.5 text-[10px] text-slate-300">
                      <span className="uppercase tracking-[0.12em] text-slate-500">Names</span>
                      <select
                        value={selectedDeviceName || deviceChoices[0] || ""}
                        onChange={(e) => handleDeviceChoiceChange(e.target.value)}
                        className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] font-medium text-slate-100 outline-none focus:border-cyan-400"
                      >
                        {deviceChoices.map((name) => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {device.serialNumber  && <QuickInfo label="Serial" value={device.serialNumber} />}
                  {(device.users ?? 0) > 0 && <QuickInfo label="Users" value={String(device.users)} accent />}
                  {(device.logs  ?? 0) > 0 && <QuickInfo label="Logs"  value={String(device.logs)} />}
                  {device.productName   && <QuickInfo label="Model" value={device.productName} />}
                  <div className="ml-auto shrink-0 flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="text-[11px] text-emerald-300 font-semibold">Live</span>
                  </div>
                </div>
              )}
              {!connected && (
                <div className="flex items-center gap-2 border-t border-slate-800/60 bg-slate-950/40 px-5 py-2">
                  <span className="h-2 w-2 rounded-full bg-red-400 animate-pulse" />
                  <span className="text-[11px] text-red-300 font-medium">
                    {connectStatus === "connecting" ? "Connecting to FK623 device..."
                      : deviceForm.ipAddress ? `Retrying ${deviceForm.ipAddress}:${deviceForm.port}...`
                      : "No device IP set"}
                  </span>
                  {!deviceForm.ipAddress && (
                    <button onClick={openDevModal} className="ml-2 text-[11px] text-amber-400 underline hover:text-amber-300 touch-manipulation">
                      Open Developer settings →
                    </button>
                  )}
                </div>
              )}
            </header>

            {/* ── BODY ─────────────────────────────────── */}
            <div className="flex flex-1 flex-col overflow-y-auto p-4 gap-4">

              {/* Stats */}
              <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4">
                <SummaryTile label="Students"    value={stats.totalStudents}   color="cyan" />
                <SummaryTile label="Scans Today" value={stats.attendanceToday} color="emerald" />
                <SummaryTile
                  label="Devices Online"
                  value={registeredDevices.length > 0
                    ? `${registeredDevices.filter(d => d.status?.connected).length}/${registeredDevices.length}`
                    : connected ? "1/1" : "0"}
                  color={registeredDevices.some(d => d.status?.connected) || connected ? "green" : "red"}
                />
                <SummaryTile label="Total Logs"  value={stats.totalLogs}       color="slate" />
              </div>

              {/* Cards */}
              <div className="grid gap-4 lg:grid-cols-2 shrink-0">

                {/* ── Devices Status ─────────────────────────── */}
                <div className="dashboard-panel p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-base font-bold flex items-center gap-2">
                      <FiServer className="text-cyan-400" /> Devices
                      <span className="text-[11px] font-normal text-slate-500">
                        {registeredDevices.filter(d => d.status?.connected).length}/{registeredDevices.length} online
                      </span>
                    </h3>
                    <button onClick={openDevModal}
                      className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] text-slate-400 hover:text-white transition touch-manipulation">
                      <FiSettings className="text-[10px]" /> Manage
                    </button>
                  </div>

                  {/* No devices registered yet */}
                  {registeredDevices.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-700 py-6 text-center mb-4">
                      <FiCpu className="mx-auto text-2xl text-slate-700 mb-1.5" />
                      <p className="text-xs text-slate-500 mb-2">No devices registered</p>
                      <button onClick={openDevModal}
                        className="inline-flex items-center gap-1 rounded-xl bg-cyan-600 hover:bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-white transition">
                        <FiPlus className="text-[11px]" /> Add Device
                      </button>
                    </div>
                  ) : (
                    /* Device grid — one tile per registered device */
                    <div className={`grid gap-2 mb-4 ${registeredDevices.length === 1 ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"}`}>
                      {registeredDevices.map(d => {
                        const isConn = d.status?.connected;
                        const isBusy = deviceBusy.has(d.id);
                        return (
                          <div key={d.id}
                            className={`rounded-xl border px-3 py-2.5 flex items-center gap-3 transition
                              ${isConn ? "border-emerald-500/30 bg-emerald-500/5" : "border-slate-800 bg-slate-800/30"}`}>
                            {/* Status dot */}
                            <div className={`h-2.5 w-2.5 shrink-0 rounded-full
                              ${isBusy ? "bg-amber-400 animate-pulse"
                                : isConn ? "bg-emerald-400 animate-pulse"
                                : "bg-slate-600"}`} />
                            {/* Info */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-semibold text-white truncate">{d.name}</span>
                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0
                                  ${isConn ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-700/80 text-slate-500"}`}>
                                  {isBusy ? "…" : isConn ? "Online" : "Offline"}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <span className="text-[10px] font-mono text-cyan-400/80">{d.ipAddress}</span>
                                {d.location && <span className="text-[10px] text-slate-600 truncate">· {d.location}</span>}
                              </div>
                              {!isConn && d.status?.error && (
                                <p className="text-[9px] text-red-400 truncate mt-0.5" title={d.status.error}>
                                  {d.status.error.includes('license_mismatch') || d.status.error.includes('sticker')
                                    ? '⚠ Check license number on device sticker'
                                    : d.status.error.split(':')[0]}
                                </p>
                              )}
                            </div>
                            {/* Connect / Disconnect button */}
                            <button disabled={isBusy}
                              onClick={async () => {
                                setDeviceBusy(prev => new Set(prev).add(d.id));
                                try {
                                  const ep = isConn ? "disconnect" : "connect";
                                  const r = await fetch(`${API_BASE}/api/devices-config/${d.id}/${ep}`, { method: "POST" });
                                  const res = await r.json();
                                  if (!isConn && res.connected) toast.success(`Connected to ${d.ipAddress}`);
                                  else if (!isConn) toast.error(`Cannot reach ${d.ipAddress}`);
                                  else toast.success(`Disconnected ${d.name}`);
                                  await loadRegisteredDevices();
                                } catch { toast.error("Request failed"); }
                                setDeviceBusy(prev => { const s = new Set(prev); s.delete(d.id); return s; });
                              }}
                              title={isConn ? "Disconnect" : "Connect"}
                              className={`rounded-lg p-1.5 transition disabled:opacity-40 shrink-0
                                ${isConn
                                  ? "text-emerald-400 hover:bg-red-500/15 hover:text-red-400"
                                  : "text-slate-500 hover:bg-cyan-500/15 hover:text-cyan-400"}`}>
                              {isBusy
                                ? <FiLoader className="text-sm animate-spin" />
                                : isConn ? <FiWifiOff className="text-sm" /> : <FiWifi className="text-sm" />}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Action buttons for active connection */}
                  <div className="grid grid-cols-3 gap-2">
                    <button onClick={pullUsers} disabled={busy || !connected} className="secondary-action py-2.5 text-xs text-center touch-manipulation flex flex-col items-center gap-0.5">
                      <FiUsers className="text-sm" /><span>Get Users</span>
                    </button>
                    <button onClick={syncTime} disabled={busy || !connected} className="secondary-action py-2.5 text-xs text-center touch-manipulation flex flex-col items-center gap-0.5">
                      <FiZap className="text-sm" /><span>Sync Time</span>
                    </button>
                    <button onClick={pullLogs} disabled={busy || !connected} className="secondary-action py-2.5 text-xs text-center touch-manipulation flex flex-col items-center gap-0.5">
                      <FiDownloadCloud className="text-sm" /><span>Pull Logs</span>
                    </button>
                  </div>

                  {/* Device users quick list */}
                  {deviceUsers.length > 0 && (
                    <div className="mt-4 border-t border-slate-800 pt-3">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Device Users ({deviceUsers.length})</p>
                        <button onClick={() => setActiveView("device-users")} className="text-[11px] text-cyan-400 hover:text-cyan-300 hover:underline touch-manipulation">View all →</button>
                      </div>
                      <div className="space-y-1 max-h-32 overflow-y-auto">
                        {deviceUsers.slice(0, 6).map(u => (
                          <div key={u.userId} className="flex items-center gap-2 rounded-lg bg-slate-800/50 px-2.5 py-1.5 text-xs">
                            <span className="h-6 w-6 shrink-0 rounded-full bg-cyan-500/15 text-cyan-300 flex items-center justify-center text-[10px] font-bold">
                              {(u.name || u.userId).slice(0, 2).toUpperCase()}
                            </span>
                            <span className="flex-1 truncate font-medium">{u.name || `User ${u.userId}`}</span>
                            <span className="text-slate-500 font-mono text-[10px] shrink-0">#{u.userId}</span>
                          </div>
                        ))}
                        {deviceUsers.length > 6 && <p className="text-center text-[10px] text-slate-600 pt-1">+{deviceUsers.length - 6} more</p>}
                      </div>
                    </div>
                  )}
                </div>

                {/* Push Students */}
                <div className="dashboard-panel p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-base font-bold flex items-center gap-2"><FiUploadCloud className="text-blue-400" /> Push Students</h3>
                    <button onClick={pushStudents} disabled={busy || !connected}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-blue-500/40 bg-blue-500/10 px-4 py-2.5 text-xs font-semibold text-blue-300 hover:bg-blue-500/20 disabled:opacity-50 touch-manipulation transition">
                      <FiUploadCloud /> Push All
                    </button>
                  </div>
                  <p className="text-xs text-slate-500 leading-relaxed mb-4">
                    Enroll students on the FK623 device. They must be pushed before their scans are recognised.
                  </p>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Registered ({students.length})</span>
                    <button onClick={loadStudentsLocal} disabled={busy} className="rounded-lg border border-slate-700 p-1.5 text-slate-400 hover:text-white disabled:opacity-40 transition">
                      <FiRefreshCw className={`text-xs ${busy ? "animate-spin" : ""}`} />
                    </button>
                  </div>
                  {students.length === 0 ? (
                    <div className="py-8 text-center">
                      <FiUsers className="mx-auto text-3xl text-slate-700 mb-2" />
                      <p className="text-xs text-slate-600">No students registered. Add students in the Students panel.</p>
                    </div>
                  ) : (
                    <div className="space-y-1 max-h-56 overflow-y-auto pr-0.5">
                      {students.slice(0, 60).map(s => (
                        <div key={s.studentId} className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-800/40 px-3 py-2 text-xs">
                          <div className="h-7 w-7 shrink-0 rounded-full bg-slate-700/60 flex items-center justify-center text-[10px] font-bold text-slate-400">
                            {(s.name || "?").split(" ").slice(0,2).map((w: string) => w[0]).join("").toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-slate-200 truncate">{s.name}</p>
                            <p className="text-[10px] text-slate-500">{s.className}{s.section ? ` · ${s.section}` : ""}</p>
                          </div>
                          <span className="text-slate-600 font-mono text-[10px] shrink-0">{s.studentDeviceId}</span>
                        </div>
                      ))}
                      {students.length > 60 && <p className="text-center text-xs text-slate-600 pt-1">+{students.length - 60} more</p>}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ══ SCHOOL LOGIN MODAL ═══════════════════════════════ */}
      {showSchoolLogin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-8 shadow-2xl">
            <div className="mb-6 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-cyan-500/15 p-3 text-cyan-400"><FiShield className="text-xl" /></div>
                <div><h2 className="text-xl font-bold">School Login</h2><p className="text-sm text-slate-400">Use your school account</p></div>
              </div>
              <button onClick={() => { setShowSchoolLogin(false); setLoginPending(null); }} className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white"><FiX /></button>
            </div>
            <form onSubmit={handleSchoolLogin} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm text-slate-400">Email</label>
                <input autoFocus type="email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} placeholder="user@school.ac" required className="form-field" />
              </div>
              <div>
                <label className="mb-1.5 block text-sm text-slate-400">Password</label>
                <input type="password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} required className="form-field" />
              </div>
              {loginError && <p className="text-sm text-red-400">{loginError}</p>}
              <button type="submit" disabled={loginBusy} className="primary-action w-full py-3">{loginBusy ? "Logging in..." : "Login"}</button>
            </form>
          </div>
        </div>
      )}

      {/* ══ FULL-SCREEN PANELS ═══════════════════════════════ */}
      {activeView === "gate" && (
        <div className="fixed inset-0 z-40 bg-slate-950 flex flex-col">
          <GateKeeperPanel onClose={() => setActiveView("dashboard")} />
        </div>
      )}
      {activeView === "attendance" && schoolLoggedIn && (
        <div className="fixed inset-0 z-40 bg-slate-950 flex flex-col">
          <ManualAttendancePanel onClose={() => setActiveView("dashboard")} />
        </div>
      )}
      {activeView === "users" && schoolLoggedIn && (
        <div className="fixed inset-0 z-40 bg-slate-950 flex flex-col">
          <UsersPanel schoolUser={schoolUser} onClose={() => setActiveView("dashboard")} />
        </div>
      )}
      {activeView === "device-users" && (
        <div className="fixed inset-0 z-40 bg-[#070b14] flex flex-col">
          <DeviceUsersPanel onClose={() => setActiveView("dashboard")} />
        </div>
      )}

      {activeView === "devices" && (
        <div className="fixed inset-0 z-40 bg-[#070b14] flex flex-col">
          {/* Header bar matching device-users pattern */}
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 shrink-0">
            <span className="text-sm font-bold text-white flex items-center gap-2">
              <FiServer className="text-cyan-400" /> Device Management
            </span>
            <button onClick={() => setActiveView("dashboard")}
              className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-400 hover:text-white transition">
              <FiX className="text-[11px]" /> Close
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            <DevicesPage />
          </div>
        </div>
      )}

      {/* ══ DEV AUTH GATE MODAL ══════════════════════════════
           Lightweight inline password prompt for all device-data
           operations (push, pull, register, delete, sync, clear).
           Separate from the full Developer Settings modal.
      ════════════════════════════════════════════════════════ */}
      {devAuthOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-amber-500/30 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-center gap-3 mb-5">
              <div className="rounded-xl bg-amber-500/15 p-2.5 text-amber-400 shrink-0">
                <FiLock className="text-lg" />
              </div>
              <div>
                <h2 className="text-base font-bold text-white">Developer Password</h2>
                <p className="text-xs text-slate-500 mt-0.5">Required for all device data operations</p>
              </div>
            </div>
            <form onSubmit={submitDevAuth} className="space-y-4">
              <div className="relative">
                <input
                  autoFocus
                  type={devAuthShowPw ? "text" : "password"}
                  value={devAuthPassword}
                  onChange={e => { setDevAuthPassword(e.target.value); setDevAuthError(""); }}
                  placeholder="Enter developer password"
                  className="form-field pr-10 w-full"
                />
                <button type="button" onClick={() => setDevAuthShowPw(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition">
                  {devAuthShowPw ? <FiEyeOff /> : <FiEye />}
                </button>
              </div>
              {devAuthError && (
                <p className="text-sm text-red-400 flex items-center gap-1.5">
                  <FiAlertTriangle className="shrink-0" /> {devAuthError}
                </p>
              )}
              <div className="flex gap-2">
                <button type="submit" disabled={devAuthBusy || !devAuthPassword}
                  className="primary-action flex-1 py-2.5 text-sm disabled:opacity-50">
                  {devAuthBusy ? "Verifying…" : "Confirm"}
                </button>
                <button type="button" onClick={() => { setDevAuthOpen(false); devAuthPendingRef.current = null; }}
                  className="secondary-action flex-1 py-2.5 text-sm">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ══ DEV PASSWORD MODAL ═══════════════════════════════ */}
      {devStep === "password" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-8 shadow-2xl">
            <div className="mb-6 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-amber-500/15 p-3 text-amber-400">
                  {devPendingAction === "wireguard" ? <FiShield className="text-xl" /> : <FiLock className="text-xl" />}
                </div>
                <h2 className="text-xl font-bold">{devPendingAction === "wireguard" ? "WireGuard Access" : "Developer Access"}</h2>
              </div>
              <button onClick={closeDevModal} className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white"><FiX /></button>
            </div>
            <form onSubmit={submitDevPassword} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm text-slate-400">Password</label>
                <div className="relative">
                  <input autoFocus type={showDevPassword ? "text" : "password"} value={devPassword}
                    onChange={e => { setDevPassword(e.target.value); setDevPasswordError(""); }}
                    placeholder="Enter developer password" className="form-field pr-10" />
                  <button type="button" onClick={() => setShowDevPassword(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white">
                    {showDevPassword ? <FiEyeOff /> : <FiEye />}
                  </button>
                </div>
                {devPasswordError && <p className="mt-1.5 text-sm text-red-400">{devPasswordError}</p>}
              </div>
              <button type="submit" className="primary-action w-full py-3">Unlock</button>
            </form>
          </div>
        </div>
      )}

      {/* ══ DEV SETTINGS MODAL ═══════════════════════════════ */}
      {devStep === "settings" && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 backdrop-blur-sm overflow-y-auto">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl my-4">

            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-amber-500/15 p-2.5 text-amber-400"><FiSettings className="text-lg" /></div>
                <div>
                  <h2 className="text-lg font-bold">Developer Settings</h2>
                  <p className="text-xs text-slate-500">Devices · Server · Connection</p>
                </div>
              </div>
              <button onClick={closeDevModal} className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white transition"><FiX /></button>
            </div>

            <div className="p-6 space-y-6">

              {/* ── SECTION 1: Registered Biometric Devices ────────── */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h3 className="text-sm font-bold text-white flex items-center gap-2"><FiCpu className="text-cyan-400" /> Biometric Devices</h3>
                    <p className="text-[11px] text-slate-500 mt-0.5">Each FK623 device on the local network. Changes take effect immediately.</p>
                  </div>
                  <button
                    onClick={() => { setDevDeviceEditId(null); setDevDeviceForm({ name: "", ipAddress: "", port: 5005, license: 1261, location: "", notes: "" }); setDevDeviceFormOpen(true); }}
                    className="flex items-center gap-1.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-white transition">
                    <FiPlus /> Add Device
                  </button>
                </div>

                {/* Add / Edit inline form */}
                {devDeviceFormOpen && (
                  <div className="mb-3 rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-4 space-y-3">
                    <p className="text-xs font-semibold text-cyan-300">{devDeviceEditId ? "Edit Device" : "Add New Device"}</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="col-span-2">
                        <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Name <span className="text-red-400">*</span></label>
                        <input value={devDeviceForm.name} onChange={e => setDevDeviceForm(f => ({...f, name: e.target.value}))} placeholder="Main Gate FK623" className="form-field text-sm" />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">IP Address <span className="text-red-400">*</span></label>
                        <input value={devDeviceForm.ipAddress} onChange={e => setDevDeviceForm(f => ({...f, ipAddress: e.target.value}))} placeholder="192.168.1.76" className="form-field text-sm font-mono" />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Port</label>
                        <select value={devDeviceForm.port} onChange={e => setDevDeviceForm(f => ({...f, port: Number(e.target.value)}))} className="form-field text-sm">
                          <option value={5005}>5005 (default)</option>
                          <option value={4370}>4370 (ZKTeco)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">
                          License No. <span className="text-amber-400">*</span>
                        </label>
                        <input type="number" value={devDeviceForm.license} onChange={e => setDevDeviceForm(f => ({...f, license: Number(e.target.value)}))} className="form-field text-sm" />
                        <p className="mt-1 text-[10px] text-amber-400/80">Check the sticker on the physical device</p>
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Location</label>
                        <input value={devDeviceForm.location} onChange={e => setDevDeviceForm(f => ({...f, location: e.target.value}))} placeholder="e.g. Main Gate" className="form-field text-sm" />
                      </div>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button type="button" onClick={async () => {
                        if (!devDeviceForm.name.trim() || !devDeviceForm.ipAddress.trim()) { toast.error("Name and IP are required"); return; }
                        try {
                          const url = devDeviceEditId
                            ? `${API_BASE}/api/devices-config/${devDeviceEditId}`
                            : `${API_BASE}/api/devices-config`;
                          const r = await fetch(url, { method: devDeviceEditId ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(devDeviceForm) });
                          const d = await r.json();
                          if (!d.success) { toast.error(d.error || "Save failed"); return; }
                          toast.success(devDeviceEditId ? `Updated ${devDeviceForm.name}` : `Added ${devDeviceForm.name}`);
                          setDevDeviceFormOpen(false); setDevDeviceEditId(null);
                          await loadRegisteredDevices();
                          // If this is the first device, auto-set the IP in devForm too
                          if (!devDeviceEditId && !devForm.ipAddress) {
                            setDevForm(f => ({...f, ipAddress: devDeviceForm.ipAddress, port: devDeviceForm.port, license: devDeviceForm.license }));
                          }
                        } catch { toast.error("Network error"); }
                      }} className="flex-1 rounded-xl bg-cyan-600 hover:bg-cyan-500 py-2 text-xs font-semibold text-white transition">
                        {devDeviceEditId ? "Save Changes" : "Add Device"}
                      </button>
                      <button type="button" onClick={() => { setDevDeviceFormOpen(false); setDevDeviceEditId(null); }} className="flex-1 rounded-xl border border-slate-700 py-2 text-xs text-slate-400 hover:text-white transition">Cancel</button>
                    </div>
                  </div>
                )}

                {/* Device list */}
                {registeredDevices.length === 0 ? (
                  <div className="rounded-xl border border-slate-800 bg-slate-800/30 py-6 text-center">
                    <FiCpu className="mx-auto text-2xl text-slate-700 mb-1.5" />
                    <p className="text-xs text-slate-500">No devices added yet. Click <strong className="text-slate-400">Add Device</strong> to register your FK623.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {registeredDevices.map(d => {
                      const isBusy = deviceBusy.has(d.id);
                      const isConn = d.status?.connected;
                      return (
                        <div key={d.id} className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition ${isConn ? "border-emerald-500/30 bg-emerald-500/5" : "border-slate-800 bg-slate-800/30"}`}>
                          {/* Status dot */}
                          <div className={`h-2 w-2 shrink-0 rounded-full ${isBusy ? "bg-amber-400 animate-pulse" : isConn ? "bg-emerald-400 animate-pulse" : "bg-slate-600"}`} />
                          {/* Info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold text-white truncate">{d.name}</span>
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${isConn ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-700 text-slate-500"}`}>
                                {isBusy ? "..." : isConn ? "Online" : "Offline"}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-[11px] font-mono text-cyan-400">{d.ipAddress}:{d.port}</span>
                              {d.location && <span className="text-[11px] text-slate-500">· {d.location}</span>}
                              {d.status?.error && !isConn && <span className="text-[10px] text-red-400 truncate max-w-[140px]" title={d.status.error}>· {d.status.error.split(':')[0]}</span>}
                            </div>
                          </div>
                          {/* Actions */}
                          <div className="flex items-center gap-1 shrink-0">
                            {/* Connect / Disconnect */}
                            <button disabled={isBusy} title={isConn ? "Disconnect" : "Connect"}
                              onClick={async () => {
                                setDeviceBusy(prev => new Set(prev).add(d.id));
                                try {
                                  const endpoint = isConn ? "disconnect" : "connect";
                                  const r = await fetch(`${API_BASE}/api/devices-config/${d.id}/${endpoint}`, { method: "POST" });
                                  const res = await r.json();
                                  if (!isConn && res.connected) toast.success(`Connected to ${d.ipAddress}`);
                                  else if (!isConn && !res.connected) toast.error(`Cannot reach ${d.ipAddress}: ${res.error || "unreachable"}`);
                                  else toast.success(`Disconnected ${d.name}`);
                                  await loadRegisteredDevices();
                                } catch { toast.error("Request failed"); }
                                setDeviceBusy(prev => { const s = new Set(prev); s.delete(d.id); return s; });
                              }}
                              className={`rounded-lg p-1.5 transition disabled:opacity-40 ${isConn ? "text-emerald-400 hover:bg-red-500/15 hover:text-red-400" : "text-slate-500 hover:bg-cyan-500/15 hover:text-cyan-400"}`}>
                              {isConn ? <FiWifiOff className="text-sm" /> : <FiWifi className="text-sm" />}
                            </button>
                            {/* Edit */}
                            <button title="Edit" onClick={() => {
                              setDevDeviceEditId(d.id);
                              setDevDeviceForm({ name: d.name, ipAddress: d.ipAddress, port: d.port, license: d.license, location: d.location, notes: d.notes || "" });
                              setDevDeviceFormOpen(true);
                            }} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-700 hover:text-white transition">
                              <FiEdit2 className="text-sm" />
                            </button>
                            {/* Delete */}
                            <button title="Delete" onClick={async () => {
                              if (!confirm(`Remove "${d.name}"?`)) return;
                              try {
                                await fetch(`${API_BASE}/api/devices-config/${d.id}`, { method: "DELETE" });
                                toast.success(`Removed ${d.name}`);
                                await loadRegisteredDevices();
                              } catch { toast.error("Delete failed"); }
                            }} className="rounded-lg p-1.5 text-slate-500 hover:bg-red-500/15 hover:text-red-400 transition">
                              <FiTrash2 className="text-sm" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* ── SECTION 2: School Server URL ───────────────────── */}
              <section className="border-t border-slate-800 pt-5">
                <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2"><FiServer className="text-slate-400" /> School Server</h3>
                <form onSubmit={saveDevSettings} className="space-y-3">
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Server API URL</label>
                    <input type="text" value={devForm.serverApiUrl ?? "https://backend.ecareafrica.net/api/v1"} onChange={e => setDevForm({...devForm, serverApiUrl: e.target.value})} placeholder="https://backend.ecareafrica.net/api/v1" className="form-field font-mono text-xs" />
                    <p className="mt-1 text-[11px] text-slate-600">Change only if the school server address changes. Takes effect immediately.</p>
                  </div>
                  {/* Hidden fields to satisfy saveDevSettings — use first registered device IP or existing */}
                  <input type="hidden" value={devForm.ipAddress} readOnly />
                  {tabletLocation && (
                    <div className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/40 px-3 py-2">
                      <FiMapPin className="text-cyan-400 text-xs shrink-0" />
                      <span className="text-xs text-slate-400">Location: <strong className="text-slate-200">{tabletLocation}</strong></span>
                    </div>
                  )}
                  <div className="flex gap-2 pt-1">
                    <button type="submit" className="primary-action flex-1 py-2.5 text-sm">Save Server URL</button>
                    <button type="button" onClick={closeDevModal} className="secondary-action flex-1 py-2.5 text-sm">Close</button>
                  </div>
                </form>
              </section>

            </div>
          </div>
        </div>
      )}

      {/* ══ WIREGUARD WIZARD ═════════════════════════════════ */}
      {devStep === "wireguard" && (
        <WireguardWizard
          wgStep={wgStep} setWgStep={setWgStep}
          wgBusy={wgBusy} wgError={wgError} setWgError={setWgError}
          wgKeys={wgKeys} wgStatus={wgStatus} wgInstalled={wgInstalled}
          wgForm={wgForm} setWgForm={setWgForm}
          wgAllowedIPs={wgAllowedIPs}
          wgPingTarget={wgPingTarget} setWgPingTarget={setWgPingTarget}
          wgPingResult={wgPingResult} setWgPingResult={setWgPingResult}
          wgDiagnosis={wgDiagnosis} wgDiagBusy={wgDiagBusy}
          svcStatus={svcStatus} svcInstalling={svcInstalling}
          copiedKey={copiedKey}
          onClose={closeDevModal}
          onRefreshStatus={wgRefreshStatus}
          onGenerateKeys={wgGenerateKeys}
          onInstall={wgInstall}
          onDeactivate={wgDeactivate}
          onPing={wgPing}
          onDiagnose={wgDiagnose}
          onSyncKey={wgSyncKey}
          onCheckServices={checkServices}
          onInstallServices={installServices}
          onCopy={copyToClipboard}
        />
      )}
    </div>
  );
}
