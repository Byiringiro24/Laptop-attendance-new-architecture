"use client";

/**
 * DevicesPage — full multi-device management UI
 *
 * Features:
 *  - List all configured biometric devices with live connection status
 *  - Add / Edit / Delete devices
 *  - Connect / Disconnect individual devices
 *  - Bulk CSV import (name,ipAddress,port,license,location)
 *  - Live SSE updates via devicesInit + devicesStatus events
 *  - Search + filter by status / location
 */

import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  FiPlus, FiTrash2, FiEdit2, FiZap, FiZapOff,
  FiSearch, FiUploadCloud, FiRefreshCw, FiX,
  FiWifi, FiWifiOff, FiMapPin, FiCpu, FiAlertTriangle,
  FiCheckCircle, FiLoader, FiDownload,
} from "react-icons/fi";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

/* ─── Types ──────────────────────────────────────────────── */
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
  status: { connected: boolean; error?: string; lastAttempt?: string };
};

type FormState = Omit<BiometricDevice, "id" | "createdAt" | "updatedAt" | "status">;

const emptyForm: FormState = {
  name: "", ipAddress: "", port: 5005, license: 1261,
  deviceId: "", location: "", notes: "", timeoutMs: 15000,
};

/* ─── Helpers ────────────────────────────────────────────── */
function StatusBadge({ status, busy }: { status: BiometricDevice["status"]; busy?: boolean }) {
  if (busy) return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold text-amber-300">
      <FiLoader className="animate-spin text-[10px]" /> Connecting…
    </span>
  );
  if (status.connected) return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-300">
      <FiWifi className="text-[10px]" /> Online
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-700/60 px-2.5 py-1 text-[11px] font-semibold text-slate-400">
      <FiWifiOff className="text-[10px]" /> Offline
    </span>
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

  const sseRef = useRef<EventSource | null>(null);
  const mountedRef = useRef(true);

  /* ── Load devices ─────────────────────────────────────── */
  const loadDevices = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/devices-config`);
      const d = await r.json();
      if (d.success) setDevices(d.devices || []);
    } catch { toast.error("Failed to load devices"); }
    finally { setLoading(false); }
  }, []);

  /* ── SSE for live status ──────────────────────────────── */
  useEffect(() => {
    mountedRef.current = true;
    loadDevices();

    const es = new EventSource(`${API_BASE}/api/events`);

    es.addEventListener("devicesInit", (e: MessageEvent) => {
      try {
        const list: BiometricDevice[] = JSON.parse(e.data);
        if (mountedRef.current) setDevices(list);
      } catch {}
    });

    es.addEventListener("devicesStatus", (e: MessageEvent) => {
      try {
        const { id, connected, error } = JSON.parse(e.data);
        if (!mountedRef.current) return;
        setDevices(prev => prev.map(d =>
          d.id === id
            ? { ...d, status: { connected, error: error || undefined, lastAttempt: new Date().toISOString() } }
            : d
        ));
        setBusyIds(prev => { const s = new Set(prev); s.delete(id); return s; });
      } catch {}
    });

    es.onerror = () => { /* SSE auto-reconnects */ };
    sseRef.current = es;

    return () => {
      mountedRef.current = false;
      es.close();
    };
  }, [loadDevices]);

  /* ── Connect / Disconnect ─────────────────────────────── */
  async function toggleConnect(device: BiometricDevice) {
    const { id, ipAddress, status } = device;
    setBusyIds(prev => new Set(prev).add(id));

    if (status.connected) {
      try {
        await fetch(`${API_BASE}/api/devices-config/${id}/disconnect`, { method: "POST" });
        toast.success(`Disconnected ${device.name}`);
      } catch { toast.error("Disconnect failed"); setBusyIds(prev => { const s = new Set(prev); s.delete(id); return s; }); }
    } else {
      try {
        const r = await fetch(`${API_BASE}/api/devices-config/${id}/connect`, { method: "POST" });
        const d = await r.json();
        if (d.connected) toast.success(`Connected to ${ipAddress}`);
        else toast.error(`Cannot reach ${ipAddress}: ${d.error || "unreachable"}`);
      } catch { toast.error("Connect failed"); setBusyIds(prev => { const s = new Set(prev); s.delete(id); return s; }); }
    }
    // SSE will update status — no need to reload
  }

  /* ── Add / Edit modal ─────────────────────────────────── */
  function openAdd() {
    setEditId(null); setForm(emptyForm); setFormErr(""); setModalOpen(true);
  }
  function openEdit(d: BiometricDevice) {
    setEditId(d.id);
    setForm({ name: d.name, ipAddress: d.ipAddress, port: d.port, license: d.license, deviceId: d.deviceId, location: d.location, notes: d.notes, timeoutMs: d.timeoutMs });
    setFormErr(""); setModalOpen(true);
  }
  function closeModal() { setModalOpen(false); setEditId(null); setFormErr(""); }

  async function saveDevice(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { setFormErr("Name is required"); return; }
    if (!form.ipAddress.trim()) { setFormErr("IP address is required"); return; }
    setSaving(true); setFormErr("");
    try {
      const url   = editId ? `${API_BASE}/api/devices-config/${editId}` : `${API_BASE}/api/devices-config`;
      const method = editId ? "PUT" : "POST";
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const d = await r.json();
      if (!d.success) { setFormErr(d.error || "Save failed"); setSaving(false); return; }
      toast.success(editId ? `Updated ${form.name}` : `Added ${form.name}`);
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
      if (d.success) { toast.success("Device removed"); setDevices(prev => prev.filter(x => x.id !== deleteId)); }
      else toast.error(d.error || "Delete failed");
    } catch { toast.error("Network error"); }
    finally { setDeleting(false); setDeleteId(null); }
  }

  /* ── Bulk import ──────────────────────────────────────── */
  async function runBulkImport() {
    if (!importText.trim()) return;
    setImporting(true);
    try {
      // Parse CSV: name,ipAddress,port,license,location
      const lines = importText.trim().split("\n").filter(l => l.trim() && !l.startsWith("#"));
      const parsed = lines.map(line => {
        const cols = line.split(",").map(c => c.trim());
        return { name: cols[0], ipAddress: cols[1], port: Number(cols[2]) || 5005, license: Number(cols[3]) || 1261, location: cols[4] || "" };
      }).filter(d => d.name && d.ipAddress);

      if (!parsed.length) { toast.error("No valid rows found"); setImporting(false); return; }

      const r = await fetch(`${API_BASE}/api/devices-config/bulk-import`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devices: parsed }),
      });
      const d = await r.json();
      toast.success(`Imported ${d.added} device${d.added !== 1 ? "s" : ""}${d.skipped ? ` (${d.skipped} skipped)` : ""}`);
      setImportOpen(false); setImportText(""); loadDevices();
    } catch (err: any) { toast.error(err.message || "Import failed"); }
    finally { setImporting(false); }
  }

  /* ── Filter ───────────────────────────────────────────── */
  const filtered = devices.filter(d => {
    const q = query.toLowerCase();
    const matchesQuery = !q || [d.name, d.ipAddress, d.location, d.deviceId].some(v => v?.toLowerCase().includes(q));
    const matchesStatus =
      filterStatus === "all"    ? true :
      filterStatus === "online" ? d.status?.connected :
      !d.status?.connected;
    return matchesQuery && matchesStatus;
  });

  const onlineCount  = devices.filter(d => d.status?.connected).length;
  const offlineCount = devices.length - onlineCount;

  /* ═══════════════════════════════════════════════════════
     RENDER
  ═══════════════════════════════════════════════════════ */
  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-4 md:p-6">

      {/* ── Header ─────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <FiCpu className="text-cyan-400" /> Biometric Devices
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {devices.length} device{devices.length !== 1 ? "s" : ""} · {" "}
            <span className="text-emerald-400">{onlineCount} online</span> · {" "}
            <span className="text-slate-500">{offlineCount} offline</span>
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={loadDevices} className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:text-white transition">
            <FiRefreshCw className="text-[12px]" /> Refresh
          </button>
          <button onClick={() => setImportOpen(true)} className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:text-white transition">
            <FiUploadCloud className="text-[12px]" /> Bulk Import
          </button>
          <button onClick={openAdd} className="flex items-center gap-1.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 px-3 py-2 text-xs font-semibold text-white transition shadow-sm shadow-cyan-900/40">
            <FiPlus /> Add Device
          </button>
        </div>
      </div>

      {/* ── Filters ────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 shrink-0">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-[13px]" />
          <input
            value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search name, IP, location…"
            className="w-full rounded-xl border border-slate-700 bg-slate-800/80 pl-8 pr-3 py-2 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-500/60"
          />
        </div>
        {(["all", "online", "offline"] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`rounded-xl px-3 py-2 text-xs font-medium transition capitalize ${filterStatus === f ? "bg-cyan-600 text-white" : "border border-slate-700 bg-slate-800 text-slate-400 hover:text-white"}`}>
            {f}
          </button>
        ))}
      </div>

      {/* ── Table ──────────────────────────────────────── */}
      <div className="flex-1 overflow-auto rounded-2xl border border-slate-800 bg-slate-900/60">
        {loading ? (
          <div className="flex h-40 items-center justify-center text-slate-500 gap-2">
            <FiLoader className="animate-spin" /> Loading devices…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col h-40 items-center justify-center text-slate-500 gap-2">
            <FiCpu className="text-2xl text-slate-700" />
            <p className="text-sm">{devices.length === 0 ? "No devices configured yet." : "No devices match your search."}</p>
            {devices.length === 0 && (
              <button onClick={openAdd} className="mt-1 flex items-center gap-1 rounded-xl bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 transition">
                <FiPlus /> Add first device
              </button>
            )}
          </div>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500 sticky top-0 bg-slate-900/95 backdrop-blur-sm">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">IP Address</th>
                <th className="px-4 py-3 hidden sm:table-cell">Port / License</th>
                <th className="px-4 py-3 hidden md:table-cell">Location</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filtered.map(d => {
                const isBusy = busyIds.has(d.id);
                return (
                  <tr key={d.id} className="group hover:bg-slate-800/40 transition">
                    <td className="px-4 py-3 font-medium text-white">
                      <div className="flex flex-col">
                        <span>{d.name}</span>
                        {d.deviceId && <span className="text-[10px] text-slate-500 font-mono">{d.deviceId}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-cyan-300">{d.ipAddress}</td>
                    <td className="px-4 py-3 hidden sm:table-cell text-slate-400">
                      {d.port} / {d.license}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-slate-400">
                      {d.location ? (
                        <span className="flex items-center gap-1"><FiMapPin className="text-[10px] text-slate-600" />{d.location}</span>
                      ) : <span className="text-slate-700">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <StatusBadge status={d.status} busy={isBusy} />
                        {!isBusy && d.status?.error && (
                          <span className="text-[10px] text-red-400 flex items-center gap-1 max-w-[160px] truncate" title={d.status.error}>
                            <FiAlertTriangle className="shrink-0" />{d.status.error}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {/* Connect / Disconnect */}
                        <button
                          onClick={() => toggleConnect(d)}
                          disabled={isBusy}
                          title={d.status.connected ? "Disconnect" : "Connect"}
                          className={`rounded-lg p-1.5 transition disabled:opacity-40 ${d.status.connected ? "text-emerald-400 hover:bg-red-500/15 hover:text-red-400" : "text-slate-500 hover:bg-cyan-500/15 hover:text-cyan-400"}`}>
                          {d.status.connected ? <FiZapOff /> : <FiZap />}
                        </button>
                        {/* Edit */}
                        <button onClick={() => openEdit(d)} title="Edit" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-700 hover:text-white transition">
                          <FiEdit2 />
                        </button>
                        {/* Delete */}
                        <button onClick={() => setDeleteId(d.id)} title="Delete" className="rounded-lg p-1.5 text-slate-500 hover:bg-red-500/15 hover:text-red-400 transition">
                          <FiTrash2 />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
              {/* Row 1 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Device Name <span className="text-red-400">*</span></label>
                  <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Main Gate FK623"
                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/60" />
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">IP Address <span className="text-red-400">*</span></label>
                  <input value={form.ipAddress} onChange={e => setForm(p => ({ ...p, ipAddress: e.target.value }))} placeholder="192.168.1.76"
                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white font-mono outline-none focus:border-cyan-500/60" />
                </div>
                <div className="sm:col-span-1">
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Port</label>
                  <input type="number" value={form.port} onChange={e => setForm(p => ({ ...p, port: Number(e.target.value) }))}
                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/60" />
                </div>
              </div>
              {/* Row 2 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">License No.</label>
                  <input type="number" value={form.license} onChange={e => setForm(p => ({ ...p, license: Number(e.target.value) }))}
                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/60" />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Device ID</label>
                  <input value={form.deviceId} onChange={e => setForm(p => ({ ...p, deviceId: e.target.value }))} placeholder="auto-detected"
                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/60" />
                </div>
              </div>
              {/* Row 3 */}
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Location</label>
                <input value={form.location} onChange={e => setForm(p => ({ ...p, location: e.target.value }))} placeholder="e.g. Boys Hostel, Floor 2"
                  className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/60" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Notes</label>
                <input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} placeholder="Optional notes"
                  className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/60" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Timeout (ms)</label>
                <input type="number" value={form.timeoutMs} onChange={e => setForm(p => ({ ...p, timeoutMs: Number(e.target.value) }))}
                  className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/60" />
              </div>

              {formErr && (
                <p className="flex items-center gap-1.5 rounded-xl bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-400">
                  <FiAlertTriangle /> {formErr}
                </p>
              )}

              <div className="flex gap-2 pt-1">
                <button type="button" onClick={closeModal} className="flex-1 rounded-xl border border-slate-700 py-2 text-sm text-slate-400 hover:text-white transition">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 py-2 text-sm font-semibold text-white transition disabled:opacity-50">
                  {saving ? <FiLoader className="animate-spin" /> : <FiCheckCircle />}
                  {saving ? "Saving…" : editId ? "Save Changes" : "Add Device"}
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
              <p className="text-xs text-slate-400">
                Paste CSV rows — one device per line:
              </p>
              <div className="rounded-xl bg-slate-800/60 border border-slate-700 px-3 py-2 font-mono text-[11px] text-slate-400">
                <span className="text-slate-600"># name, ipAddress, port, license, location</span><br />
                Main Gate,192.168.1.76,5005,1261,Gate<br />
                Boys Hostel,192.168.1.77,5005,1262,Hostel A<br />
                Girls Hostel,192.168.1.78,5005,1263,Hostel B
              </div>
              <textarea
                value={importText} onChange={e => setImportText(e.target.value)}
                rows={8} placeholder={"MainGate,192.168.1.76,5005,1261,Gate\nBoysHostel,192.168.1.77,5005,1262,Hostel A"}
                className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-xs text-white outline-none focus:border-cyan-500/60 resize-none"
              />
              <div className="flex gap-2">
                <button onClick={() => setImportOpen(false)} className="flex-1 rounded-xl border border-slate-700 py-2 text-sm text-slate-400 hover:text-white transition">Cancel</button>
                <button onClick={runBulkImport} disabled={importing || !importText.trim()} className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 py-2 text-sm font-semibold text-white transition disabled:opacity-50">
                  {importing ? <FiLoader className="animate-spin" /> : <FiDownload />}
                  {importing ? "Importing…" : "Import"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══ DELETE CONFIRM ════════════════════════════════ */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl p-5 space-y-4">
            <h2 className="text-sm font-bold text-white">Remove Device?</h2>
            <p className="text-xs text-slate-400">
              This removes <strong className="text-white">{devices.find(d => d.id === deleteId)?.name}</strong> from the list.
              The physical device is not affected.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteId(null)} className="flex-1 rounded-xl border border-slate-700 py-2 text-sm text-slate-400 hover:text-white transition">Cancel</button>
              <button onClick={confirmDelete} disabled={deleting} className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-red-600 hover:bg-red-500 py-2 text-sm font-semibold text-white transition disabled:opacity-50">
                {deleting ? <FiLoader className="animate-spin" /> : <FiTrash2 />}
                {deleting ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
