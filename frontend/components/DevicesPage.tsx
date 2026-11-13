"use client";

/**
 * DevicesPage — full multi-device management UI
 *
 * Each registered device has its own FKBridge.exe process (server-side).
 * All devices connect and poll in parallel — this page shows real live
 * status for every device independently.
 *
 * Features:
 *  - Live per-device status (online/offline/connecting) via SSE
 *  - Device details from live STATUS: users, logs, model, serial
 *  - Add / Edit / Delete devices
 *  - Per-device connect / disconnect
 *  - Bulk CSV import
 *  - Search + filter by status / location
 */

import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  FiPlus, FiTrash2, FiEdit2, FiZap, FiZapOff,
  FiLock,
  FiSearch, FiUploadCloud, FiRefreshCw, FiX,
  FiWifi, FiWifiOff, FiMapPin, FiCpu, FiAlertTriangle,
  FiCheckCircle, FiLoader, FiDownload, FiUsers, FiDatabase,
  FiActivity, FiInfo,
} from "react-icons/fi";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

/* ─── Types ──────────────────────────────────────────────── */
export type DeviceInfo = {
  connected?: boolean;
  users?: number;
  logs?: number;
  fingerprints?: number;
  faces?: number;
  cards?: number;
  serialNumber?: string;
  productCode?: string;
  productName?: string;
  ipAddress?: string;
  port?: number;
  protocolType?: number;
};

export type BiometricDevice = {
  id: string;
  name: string;
  ipAddress: string;
  port: number;
  license: number;
  deviceId: string;
  location: string;
  notes: string;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
  status: {
    connected: boolean;
    error?: string;
    lastAttempt?: string;
    deviceInfo?: DeviceInfo;
  };
};

type FormState = {
  name: string; ipAddress: string; port: number; license: number;
  deviceId: string; location: string; notes: string; timeoutMs: number;
};

const emptyForm: FormState = {
  name: "", ipAddress: "", port: 5005, license: 1261,
  deviceId: "", location: "", notes: "", timeoutMs: 15000,
};

/* ─── Status badge ───────────────────────────────────────── */
function StatusBadge({ status, busy }: {
  status: BiometricDevice["status"];
  busy?: boolean;
}) {
  if (busy) return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
      <FiLoader className="animate-spin text-[9px]" /> Connecting
    </span>
  );
  if (status.connected) return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> Online
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-700/60 px-2 py-0.5 text-[10px] font-semibold text-slate-400">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-600" /> Offline
    </span>
  );
}

/* ─── Device info strip ──────────────────────────────────── */
function DeviceInfoStrip({ info }: { info?: DeviceInfo }) {
  if (!info || !info.connected) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 mt-1">
      {info.users != null && (
        <span className="flex items-center gap-1 text-[10px] text-slate-500">
          <FiUsers className="text-cyan-500/70" /> {info.users} users
        </span>
      )}
      {info.logs != null && (
        <span className="flex items-center gap-1 text-[10px] text-slate-500">
          <FiDatabase className="text-slate-600" /> {info.logs} logs
        </span>
      )}
      {info.productName && (
        <span className="text-[10px] text-slate-600">{info.productName}</span>
      )}
      {info.serialNumber && (
        <span className="text-[10px] text-slate-600 font-mono">{info.serialNumber}</span>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════════════════════════ */
export default function DevicesPage() {
  const [devices, setDevices]       = useState<BiometricDevice[]>([]);
  const [loading, setLoading]       = useState(true);
  const [busyIds, setBusyIds]       = useState<Set<string>>(new Set());
  const [query, setQuery]           = useState("");
  const [filterStatus, setFilter]   = useState<"all" | "online" | "offline">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Modal state
  const [modalOpen, setModalOpen]   = useState(false);
  const [editId, setEditId]         = useState<string | null>(null);
  const [form, setForm]             = useState<FormState>(emptyForm);
  const [formErr, setFormErr]       = useState("");
  const [saving, setSaving]         = useState(false);

  // Bulk import
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importing, setImporting]   = useState(false);

  // Delete confirm
  const [deleteId, setDeleteId]     = useState<string | null>(null);
  const [deleting, setDeleting]     = useState(false);

  // Dev password gate — required for edit/delete operations
  const [devPw, setDevPw]           = useState("");
  const [devPwInput, setDevPwInput] = useState("");
  const [devPwOpen, setDevPwOpen]   = useState(false);
  const [devPwError, setDevPwError] = useState("");
  const [devPwPending, setDevPwPending] = useState<(() => void) | null>(null);

  // Verify dev password with the bridge then run the pending action
  const unlockAndRun = async (action: () => void) => {
    setDevPwPending(() => action);
    if (devPw) { action(); return; } // already unlocked this session
    setDevPwInput(""); setDevPwError(""); setDevPwOpen(true);
  };
  const submitDevPw = async () => {
    if (!devPwInput.trim()) { setDevPwError("Enter the developer password"); return; }
    try {
      const r = await fetch(`${API_BASE}/api/device/status`, {
        headers: { "X-Dev-Password": devPwInput.trim() },
      });
      if (r.status === 401) { setDevPwError("Incorrect password"); return; }
      setDevPw(devPwInput.trim());
      setDevPwOpen(false);
      devPwPending?.();
    } catch { setDevPwError("Could not verify — check bridge is running"); }
  };

  const sseRef     = useRef<EventSource | null>(null);
  const mountedRef = useRef(true);

  /* ── Load devices ─────────────────────────────────────── */
  const loadDevices = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/devices-config`);
      const d = await r.json();
      if (d.success && mountedRef.current) setDevices(d.devices || []);
    } catch { toast.error("Failed to load devices"); }
    finally { if (mountedRef.current) setLoading(false); }
  }, []);

  /* ── SSE — live per-device status ────────────────────── */
  useEffect(() => {
    mountedRef.current = true;
    loadDevices();

    const es = new EventSource(`${API_BASE}/api/events`);

    // Initial snapshot — all devices with current status from bridge manager
    es.addEventListener("devicesInit", (e: MessageEvent) => {
      try {
        const list: BiometricDevice[] = JSON.parse(e.data);
        if (mountedRef.current) setDevices(list);
      } catch {}
    });

    // Individual device status update — fires every time a bridge changes state
    es.addEventListener("devicesStatus", (e: MessageEvent) => {
      try {
        const { id, connected, error, deviceInfo } = JSON.parse(e.data);
        if (!mountedRef.current) return;
        setDevices(prev => prev.map(d =>
          d.id === id
            ? {
                ...d,
                // Update port if auto-detected
                ...(deviceInfo?.port && { port: deviceInfo.port }),
                status: {
                  connected,
                  error:       error || undefined,
                  lastAttempt: new Date().toISOString(),
                  deviceInfo:  deviceInfo || d.status?.deviceInfo,
                },
              }
            : d
        ));
        setBusyIds(prev => { const s = new Set(prev); s.delete(id); return s; });
      } catch {}
    });

    es.onerror = () => { /* browser auto-reconnects SSE */ };
    sseRef.current = es;

    return () => {
      mountedRef.current = false;
      es.close();
    };
  }, [loadDevices]);

  /* ── Connect / Disconnect ─────────────────────────────── */
  async function toggleConnect(device: BiometricDevice) {
    const { id, status } = device;
    setBusyIds(prev => new Set(prev).add(id));
    const ep = status.connected ? "disconnect" : "connect";
    try {
      const r = await fetch(`${API_BASE}/api/devices-config/${id}/${ep}`, { method: "POST" });
      const d = await r.json();
      if (!status.connected) {
        if (d.connected) toast.success(`Connected to ${device.ipAddress}`);
        else {
          const hint = d.hint === "license_mismatch"
            ? " — check license number on device sticker"
            : "";
          toast.error(`Cannot reach ${device.ipAddress}${hint}`);
        }
      } else {
        toast.success(`Disconnected ${device.name}`);
      }
    } catch { toast.error("Request failed"); }
    // Status will update via SSE
    setBusyIds(prev => { const s = new Set(prev); s.delete(id); return s; });
  }

  /* ── Save device ──────────────────────────────────────── */
  function openAdd() {
    setEditId(null); setForm(emptyForm); setFormErr(""); setModalOpen(true);
  }
  function openEdit(d: BiometricDevice) {
    unlockAndRun(() => {
      setEditId(d.id);
      setForm({ name: d.name, ipAddress: d.ipAddress, port: d.port, license: d.license,
                 deviceId: d.deviceId, location: d.location, notes: d.notes, timeoutMs: d.timeoutMs });
      setFormErr(""); setModalOpen(true);
    });
  }
  function closeModal() { setModalOpen(false); setEditId(null); setFormErr(""); }

  async function saveDevice(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { setFormErr("Name is required"); return; }
    if (!form.ipAddress.trim()) { setFormErr("IP address is required"); return; }
    setSaving(true); setFormErr("");
    try {
      const url    = editId ? `${API_BASE}/api/devices-config/${editId}` : `${API_BASE}/api/devices-config`;
      const method = editId ? "PUT" : "POST";
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const d = await r.json();
      if (!d.success) { setFormErr(d.error || "Save failed"); setSaving(false); return; }
      toast.success(editId ? `Updated ${form.name}` : `Added ${form.name} — bridge starting…`);
      closeModal();
      loadDevices();
    } catch (err: any) { setFormErr(err.message || "Network error"); }
    finally { setSaving(false); }
  }

  /* ── Delete ───────────────────────────────────────────── */
  async function confirmDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const r = await fetch(`${API_BASE}/api/devices-config/${deleteId}`, { method: "DELETE" });
      const d = await r.json();
      if (d.success) {
        toast.success("Device removed and bridge stopped");
        setDevices(prev => prev.filter(x => x.id !== deleteId));
      } else toast.error(d.error || "Delete failed");
    } catch { toast.error("Network error"); }
    finally { setDeleting(false); setDeleteId(null); }
  }

  /* ── Bulk import ──────────────────────────────────────── */
  async function runBulkImport() {
    if (!importText.trim()) return;
    setImporting(true);
    try {
      const lines = importText.trim().split("\n").filter(l => l.trim() && !l.startsWith("#"));
      const parsed = lines.map(line => {
        const cols = line.split(",").map(c => c.trim());
        return { name: cols[0], ipAddress: cols[1], port: Number(cols[2]) || 5005,
                 license: Number(cols[3]) || 1261, location: cols[4] || "" };
      }).filter(d => d.name && d.ipAddress);
      if (!parsed.length) { toast.error("No valid rows found"); setImporting(false); return; }
      const r = await fetch(`${API_BASE}/api/devices-config/bulk-import`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devices: parsed }),
      });
      const d = await r.json();
      toast.success(`Imported ${d.added} device${d.added !== 1 ? "s" : ""}${d.skipped ? ` (${d.skipped} skipped)` : ""} — bridges starting…`);
      setImportOpen(false); setImportText(""); loadDevices();
    } catch (err: any) { toast.error(err.message || "Import failed"); }
    finally { setImporting(false); }
  }

  /* ── Filter ───────────────────────────────────────────── */
  const filtered = devices.filter(d => {
    const q = query.toLowerCase();
    const matchQ = !q || [d.name, d.ipAddress, d.location, d.deviceId].some(v => v?.toLowerCase().includes(q));
    const matchS = filterStatus === "all" ? true : filterStatus === "online" ? d.status?.connected : !d.status?.connected;
    return matchQ && matchS;
  });

  const onlineCount = devices.filter(d => d.status?.connected).length;

  /* ═══════════════════════════════════════════════════════
     RENDER
  ═══════════════════════════════════════════════════════ */
  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-4 md:p-6">

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <FiCpu className="text-cyan-400" /> Biometric Devices
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {devices.length} registered ·{" "}
            <span className="text-emerald-400 font-medium">{onlineCount} online</span> ·{" "}
            <span className="text-slate-500">{devices.length - onlineCount} offline</span>
            {devices.length > 0 && (
              <span className="ml-2 text-slate-600">· each runs its own bridge process in parallel</span>
            )}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={loadDevices}
            className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:text-white transition">
            <FiRefreshCw className="text-[12px]" /> Refresh
          </button>
          <button onClick={() => setImportOpen(true)}
            className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:text-white transition">
            <FiUploadCloud className="text-[12px]" /> Bulk Import
          </button>
          <button onClick={openAdd}
            className="flex items-center gap-1.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 px-3 py-2 text-xs font-semibold text-white transition">
            <FiPlus /> Add Device
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 shrink-0">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-[13px]" />
          <input value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search name, IP, location…"
            className="w-full rounded-xl border border-slate-700 bg-slate-800/80 pl-8 pr-3 py-2 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-500/60" />
        </div>
        {(["all", "online", "offline"] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`rounded-xl px-3 py-2 text-xs font-medium transition capitalize
              ${filterStatus === f ? "bg-cyan-600 text-white" : "border border-slate-700 bg-slate-800 text-slate-400 hover:text-white"}`}>
            {f}
          </button>
        ))}
      </div>

      {/* Device list */}
      <div className="flex-1 overflow-y-auto space-y-2 pr-0.5">
        {loading ? (
          <div className="flex h-40 items-center justify-center text-slate-500 gap-2">
            <FiLoader className="animate-spin" /> Loading devices…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col h-40 items-center justify-center text-slate-500 gap-2">
            <FiCpu className="text-2xl text-slate-700" />
            <p className="text-sm">{devices.length === 0 ? "No devices registered yet." : "No devices match your search."}</p>
            {devices.length === 0 && (
              <button onClick={openAdd}
                className="mt-1 flex items-center gap-1 rounded-xl bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 transition">
                <FiPlus /> Add first device
              </button>
            )}
          </div>
        ) : (
          filtered.map(d => {
            const isBusy    = busyIds.has(d.id);
            const isConn    = d.status?.connected;
            const info      = d.status?.deviceInfo;
            const isExpanded = expandedId === d.id;

            return (
              <div key={d.id}
                className={`rounded-2xl border transition-all
                  ${isConn
                    ? "border-emerald-500/25 bg-emerald-500/5"
                    : "border-slate-800 bg-slate-900/50"}`}>

                {/* Main row */}
                <div className="flex items-center gap-3 px-4 py-3">
                  {/* Status indicator */}
                  <div className={`h-2.5 w-2.5 shrink-0 rounded-full
                    ${isBusy ? "bg-amber-400 animate-pulse"
                      : isConn ? "bg-emerald-400 animate-pulse"
                      : "bg-slate-600"}`} />

                  {/* Identity */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-white text-sm">{d.name}</span>
                      <StatusBadge status={d.status} busy={isBusy} />
                      {d.location && (
                        <span className="flex items-center gap-1 text-[11px] text-slate-500">
                          <FiMapPin className="text-[10px]" /> {d.location}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                      <span className="font-mono text-[11px] text-cyan-400">{d.ipAddress}:{d.port}</span>
                      <span className="text-[11px] text-slate-600">lic {d.license}</span>
                      {d.deviceId && <span className="font-mono text-[10px] text-slate-600">{d.deviceId}</span>}
                    </div>
                    {/* Bridge Device UUID — copy this to paste into the server's device_uid field */}
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="font-mono text-[10px] text-slate-500 select-all" title="Bridge Device UUID — paste this into the server device_uid field">
                        {d.id}
                      </span>
                      <button
                        onClick={() => { navigator.clipboard.writeText(d.id); }}
                        title="Copy UUID to clipboard"
                        className="rounded px-1 py-0.5 text-[9px] border border-slate-700 text-slate-500 hover:text-cyan-400 hover:border-cyan-500/40 transition font-mono"
                      >
                        copy
                      </button>
                    </div>
                    {/* Live device info strip when connected */}
                    <DeviceInfoStrip info={info} />
                    {/* Error */}
                    {!isConn && !isBusy && d.status?.error && (
                      <p className="mt-0.5 text-[10px] text-red-400 truncate max-w-sm flex items-center gap-1" title={d.status.error}>
                        <FiAlertTriangle className="shrink-0" />
                        {d.status.error.includes("sticker") || d.status.error.includes("license")
                          ? "⚠ Check license number on device sticker"
                          : d.status.error.split("|")[0].split(".")[0]}
                      </p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    {/* Expand for more info */}
                    {isConn && (
                      <button onClick={() => setExpandedId(isExpanded ? null : d.id)}
                        title={isExpanded ? "Hide details" : "Show details"}
                        className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-700 hover:text-white transition">
                        <FiInfo className="text-sm" />
                      </button>
                    )}
                    {/* Connect / Disconnect */}
                    <button disabled={isBusy}
                      onClick={() => toggleConnect(d)}
                      title={isConn ? "Disconnect" : "Connect"}
                      className={`rounded-lg p-1.5 transition disabled:opacity-40
                        ${isConn
                          ? "text-emerald-400 hover:bg-red-500/15 hover:text-red-400"
                          : "text-slate-500 hover:bg-cyan-500/15 hover:text-cyan-400"}`}>
                      {isBusy ? <FiLoader className="animate-spin text-sm" />
                        : isConn ? <FiZapOff className="text-sm" />
                        : <FiZap className="text-sm" />}
                    </button>
                    {/* Edit */}
                    <button onClick={() => openEdit(d)} title="Edit"
                      className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-700 hover:text-white transition">
                      <FiEdit2 className="text-sm" />
                    </button>
                    {/* Delete */}
                    <button onClick={() => unlockAndRun(() => setDeleteId(d.id))} title="Delete"
                      className="rounded-lg p-1.5 text-slate-500 hover:bg-red-500/15 hover:text-red-400 transition">
                      <FiTrash2 className="text-sm" />
                    </button>
                  </div>
                </div>

                {/* Expanded detail panel */}
                {isExpanded && info && (
                  <div className="border-t border-slate-800/60 px-4 py-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[
                      { label: "Users",        value: info.users,        icon: <FiUsers /> },
                      { label: "Logs",         value: info.logs,         icon: <FiDatabase /> },
                      { label: "Fingerprints", value: info.fingerprints, icon: <FiActivity /> },
                      { label: "Faces",        value: info.faces,        icon: <FiActivity /> },
                      { label: "Cards",        value: info.cards,        icon: <FiActivity /> },
                      { label: "Protocol",     value: info.protocolType != null ? `P${info.protocolType}` : null, icon: <FiCpu /> },
                      { label: "Model",        value: info.productName,  icon: <FiCpu /> },
                      { label: "Serial",       value: info.serialNumber, icon: <FiCpu /> },
                    ].filter(r => r.value != null && r.value !== "").map(row => (
                      <div key={row.label} className="rounded-xl bg-slate-800/50 px-3 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-slate-600 mb-0.5">{row.label}</p>
                        <p className="text-xs font-semibold text-slate-200">{String(row.value)}</p>
                      </div>
                    ))}
                    {d.status?.lastAttempt && (
                      <div className="col-span-2 rounded-xl bg-slate-800/50 px-3 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-slate-600 mb-0.5">Last checked</p>
                        <p className="text-[10px] text-slate-400">{new Date(d.status.lastAttempt).toLocaleTimeString()}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* ══ ADD / EDIT MODAL ══════════════════════════════ */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
              <h2 className="text-sm font-bold text-white">{editId ? "Edit Device" : "Add Biometric Device"}</h2>
              <button onClick={closeModal} className="text-slate-500 hover:text-white transition"><FiX /></button>
            </div>
            <form onSubmit={saveDevice} className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Device Name <span className="text-red-400">*</span></label>
                  <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                    placeholder="e.g. Main Gate FK623"
                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/60" />
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">IP Address <span className="text-red-400">*</span></label>
                  <input value={form.ipAddress} onChange={e => setForm(p => ({ ...p, ipAddress: e.target.value }))}
                    placeholder="192.168.1.76"
                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white font-mono outline-none focus:border-cyan-500/60" />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Port</label>
                  <select value={form.port} onChange={e => setForm(p => ({ ...p, port: Number(e.target.value) }))}
                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/60">
                    <option value={5005}>5005 (FK623 default)</option>
                    <option value={4370}>4370 (ZKTeco compat)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">
                    License No. <span className="text-amber-400">*</span>
                  </label>
                  <input type="number" value={form.license} onChange={e => setForm(p => ({ ...p, license: Number(e.target.value) }))}
                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/60" />
                  <p className="mt-1 text-[10px] text-amber-400/80">Found on the sticker on the physical device</p>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Device ID</label>
                  <input value={form.deviceId} onChange={e => setForm(p => ({ ...p, deviceId: e.target.value }))}
                    placeholder="auto-detected on connect"
                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/60" />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Location</label>
                  <input value={form.location} onChange={e => setForm(p => ({ ...p, location: e.target.value }))}
                    placeholder="e.g. Boys Hostel"
                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/60" />
                </div>
                <div className="col-span-2">
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Notes</label>
                  <input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                    placeholder="Optional"
                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/60" />
                </div>
              </div>

              {/* Info callout */}
              <div className="rounded-xl border border-slate-700/50 bg-slate-800/40 px-3 py-2 text-[11px] text-slate-500">
                After saving, a dedicated bridge process starts automatically and connects to this device in the background.
                Both ports (5005 and 4370) are tried automatically if the first fails.
              </div>

              {formErr && (
                <p className="flex items-center gap-1.5 rounded-xl bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-400">
                  <FiAlertTriangle /> {formErr}
                </p>
              )}

              <div className="flex gap-2 pt-1">
                <button type="button" onClick={closeModal}
                  className="flex-1 rounded-xl border border-slate-700 py-2 text-sm text-slate-400 hover:text-white transition">
                  Cancel
                </button>
                <button type="submit" disabled={saving}
                  className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 py-2 text-sm font-semibold text-white transition disabled:opacity-50">
                  {saving ? <FiLoader className="animate-spin" /> : <FiCheckCircle />}
                  {saving ? "Saving…" : editId ? "Save Changes" : "Add & Connect"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ══ BULK IMPORT MODAL ═════════════════════════════ */}
      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
              <h2 className="text-sm font-bold text-white">Bulk Import Devices</h2>
              <button onClick={() => setImportOpen(false)} className="text-slate-500 hover:text-white transition"><FiX /></button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-xs text-slate-400">Paste CSV rows — one device per line:</p>
              <div className="rounded-xl bg-slate-800/60 border border-slate-700 px-3 py-2 font-mono text-[11px] text-slate-400">
                <span className="text-slate-600"># name, ipAddress, port, license, location</span><br />
                Main Gate,192.168.1.76,5005,1261,Gate<br />
                Boys Hostel,192.168.1.77,5005,1262,Hostel A
              </div>
              <textarea value={importText} onChange={e => setImportText(e.target.value)}
                rows={7} placeholder="MainGate,192.168.1.76,5005,1261,Gate"
                className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-xs text-white outline-none focus:border-cyan-500/60 resize-none" />
              <div className="flex gap-2">
                <button onClick={() => setImportOpen(false)}
                  className="flex-1 rounded-xl border border-slate-700 py-2 text-sm text-slate-400 hover:text-white transition">Cancel</button>
                <button onClick={runBulkImport} disabled={importing || !importText.trim()}
                  className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 py-2 text-sm font-semibold text-white transition disabled:opacity-50">
                  {importing ? <FiLoader className="animate-spin" /> : <FiDownload />}
                  {importing ? "Importing…" : "Import All"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══ DEV PASSWORD GATE ════════════════════════════ */}
      {devPwOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl p-5 space-y-4">
            <div className="flex items-center gap-2">
              <FiLock className="text-cyan-400 shrink-0" />
              <h2 className="text-sm font-bold text-white">Developer Password Required</h2>
            </div>
            <p className="text-xs text-slate-400">
              This operation requires the developer password set on the bridge to prevent accidental changes.
            </p>
            <div className="space-y-2">
              <input
                type="password"
                value={devPwInput}
                onChange={e => setDevPwInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && submitDevPw()}
                placeholder="Enter developer password"
                autoFocus
                className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/60"
              />
              {devPwError && <p className="text-xs text-red-400">{devPwError}</p>}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setDevPwOpen(false)}
                className="flex-1 rounded-xl border border-slate-700 py-2 text-sm text-slate-400 hover:text-white transition">
                Cancel
              </button>
              <button onClick={submitDevPw}
                className="flex-1 rounded-xl bg-cyan-600 hover:bg-cyan-500 py-2 text-sm font-semibold text-white transition">
                Unlock
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

