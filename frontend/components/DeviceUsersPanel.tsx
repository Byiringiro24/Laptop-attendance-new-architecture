"use client";

/**
 * DeviceUsersPanel — full per-device user management.
 *
 * Features:
 *  - Password gate (dev password required before any device operation)
 *  - Device selector (pick which FK623 to manage)
 *  - Pull users from selected device (live)
 *  - Class filter from registered students
 *  - Per-user: edit name, delete, biometric badges
 *  - Bulk select + bulk delete
 *  - Push all/selected students to device
 *  - Search by name or ID
 */

import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  FiUsers, FiX, FiRefreshCw, FiSearch, FiFilter,
  FiCheckCircle, FiXCircle, FiAlertCircle, FiDownloadCloud,
  FiCpu, FiUserCheck, FiActivity, FiLock, FiEye, FiEyeOff,
  FiTrash2, FiEdit2, FiUploadCloud, FiLoader, FiChevronDown,
} from "react-icons/fi";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

/* ─── Types ──────────────────────────────────────────────── */
type DeviceUser = {
  userId: string;
  name: string;
  privilege: number;
  enabled: boolean;
  biometricMethods: string[];
  fingerprintRegistered?: boolean;
  faceRegistered?: boolean;
  cardRegistered?: boolean;
  student?: any | null;
};

type DeviceEntry = {
  id: string;
  name: string;
  ipAddress: string;
  connected: boolean;
  status?: { connected: boolean; error?: string };
};

type Student = {
  studentId: string;
  studentDeviceId: string;
  name: string;
  className: string;
  section?: string;
};

/* ─── Constants ───────────────────────────────────────────── */
const METHOD_BADGE: Record<string, { bg: string; text: string; short: string }> = {
  Fingerprint:        { bg: "bg-blue-500/20",   text: "text-blue-300",   short: "FP" },
  "Face Recognition": { bg: "bg-violet-500/20", text: "text-violet-300", short: "FA" },
  "RFID Card":        { bg: "bg-amber-500/20",  text: "text-amber-300",  short: "CD" },
  "Password/PIN":     { bg: "bg-slate-500/20",  text: "text-slate-300",  short: "PIN" },
};

/* ═══════════════════════════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════════════════════════ */
export default function DeviceUsersPanel({ onClose }: { onClose: () => void }) {
  // ── State ──
  const [devices,       setDevices]     = useState<DeviceEntry[]>([]);
  const [selectedId,    setSelectedId]  = useState<string>("");
  const [deviceUsers,   setDeviceUsers] = useState<DeviceUser[]>([]);
  const [students,      setStudents]    = useState<Student[]>([]);
  const [loading,       setLoading]     = useState(false);
  const [busy,          setBusy]        = useState(false);

  // Password gate
  const [pwOpen,       setPwOpen]       = useState(true);
  const [pwValue,      setPwValue]      = useState("");
  const [pwError,     setPwError]      = useState("");
  const [pwShow,      setPwShow]       = useState(false);
  const devPwRef = useRef<string>("");

  // Filters
  const [search,      setSearch]      = useState("");
  const [classFilter, setClassFilter] = useState<string>("all");
  const [bioFilter,   setBioFilter]   = useState<"all" | "fp" | "face" | "card" | "none">("all");

  // Selection (bulk)
  const [selected,    setSelected]    = useState<Set<string>>(new Set());

  // Edit modal
  const [editUser,    setEditUser]    = useState<DeviceUser | null>(null);
  const [editName,    setEditName]    = useState("");
  const [editBusy,    setEditBusy]    = useState(false);

  // Delete confirm
  const [deleteIds,   setDeleteIds]   = useState<string[] | null>(null);
  const [deleteBusy,  setDeleteBusy]  = useState(false);

  const mountedRef = useRef(true);

  /* ── Load devices + students on mount ──────────────────── */
  const loadDevices = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/devices-config`);
      const d = await r.json();
      if (d.success && mountedRef.current) {
        setDevices(d.devices || []);
        // Auto-select first connected device or first device
        const firstConnected = (d.devices || []).find((dev: any) => dev.status?.connected);
        if (firstConnected && !selectedId) setSelectedId(firstConnected.id);
        else if (d.devices.length === 1 && !selectedId) setSelectedId(d.devices[0].id);
      }
    } catch {}
  }, [selectedId]);

  const loadStudents = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/students`);
      const d = await r.json();
      if (mountedRef.current) setStudents(d.students || d || []);
    } catch {}
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    loadDevices();
    loadStudents();
    return () => { mountedRef.current = false; };
  }, [loadDevices, loadStudents]);

  // Refresh devices list every 15s to catch status changes
  useEffect(() => {
    const iv = setInterval(loadDevices, 15000);
    return () => clearInterval(iv);
  }, [loadDevices]);

  /* ── Password gate ─────────────────────────────────────── */
  function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    // Fetch the current dev password from health to validate
    fetch(`${API_BASE}/api/health`).then(r => r.json()).then(data => {
      if (pwValue === (data.devPassword || "admin1234")) {
        devPwRef.current = pwValue;
        setPwOpen(false); setPwError(""); setPwValue("");
      } else {
        setPwError("Incorrect password"); setPwValue("");
      }
    }).catch(() => {
      // If health fails, try the default
      if (pwValue === "admin1234") {
        devPwRef.current = pwValue;
        setPwOpen(false); setPwError("");
      } else { setPwError("Incorrect password"); setPwValue(""); }
    });
  }

  /* ── Pull users from selected device ────────────────────── */
  async function pullUsers() {
    if (!selectedId || !devPwRef.current) return;
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/devices-config/${selectedId}/users`, {
        headers: { "X-Dev-Password": devPwRef.current },
      });
      const d = await r.json();
      if (d.success) {
        const users = d.data?.users || d.users || [];
        // Merge with local students for class display
        const enriched = users.map((u: DeviceUser) => {
          const student = students.find(s =>
            String(s.studentDeviceId) === String(u.userId)
          );
          return { ...u, student: student || null };
        });
        setDeviceUsers(enriched);
        toast.success(`Loaded ${enriched.length} user${enriched.length !== 1 ? "s" : ""}`);
      } else {
        toast.error(d.error || "Failed to load users");
      }
    } catch (e: any) { toast.error(e?.message || "Network error"); }
    finally { setLoading(false); }
  }

  /* ── Push all students to selected device ───────────────── */
  async function pushAllStudents() {
    if (!selectedId || !devPwRef.current) return;
    if (!students.length) { toast.error("No students registered"); return; }
    setBusy(true);
    try {
      const r = await fetch(`${API_BASE}/api/devices-config/${selectedId}/push-students`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Dev-Password": devPwRef.current },
        body: JSON.stringify({}),
      });
      const d = await r.json();
      if (d.success !== false) {
        const pushed = d.data?.pushed ?? d.pushed ?? 0;
        const failed = d.data?.failed ?? d.failed ?? 0;
        if (failed > 0) toast.error(`Pushed ${pushed}, ${failed} failed`);
        else toast.success(`Pushed ${pushed} student${pushed !== 1 ? "s" : ""} to device`);
        await pullUsers();
      } else { toast.error(d.error || "Push failed"); }
    } catch (e: any) { toast.error(e?.message || "Push failed"); }
    finally { setBusy(false); }
  }

  /* ── Delete one user ────────────────────────────────────── */
  async function deleteUser(userId: string) {
    if (!selectedId || !devPwRef.current) return;
    setDeleteBusy(true);
    try {
      const r = await fetch(`${API_BASE}/api/devices-config/${selectedId}/users/${userId}`, {
        method: "DELETE",
        headers: { "X-Dev-Password": devPwRef.current },
      });
      const d = await r.json();
      if (d.success) {
        setDeviceUsers(prev => prev.filter(u => u.userId !== userId));
        toast.success(`Deleted user ${userId}`);
      } else { toast.error(d.error || "Delete failed"); }
    } catch { toast.error("Network error"); }
    finally { setDeleteBusy(false); setDeleteIds(null); }
  }

  /* ── Bulk delete ────────────────────────────────────────── */
  async function bulkDelete() {
    if (!deleteIds || !deleteIds.length || !selectedId || !devPwRef.current) return;
    setDeleteBusy(true);
    try {
      const r = await fetch(`${API_BASE}/api/devices-config/${selectedId}/users/bulk-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Dev-Password": devPwRef.current },
        body: JSON.stringify({ userIds: deleteIds }),
      });
      const d = await r.json();
      if (d.success !== false) {
        toast.success(`Deleted ${d.deleted || 0} user${(d.deleted || 0) !== 1 ? "s" : ""}${d.failed ? `, ${d.failed} failed` : ""}`);
        setDeviceUsers(prev => prev.filter(u => !deleteIds.includes(u.userId)));
        setSelected(new Set());
      } else { toast.error(d.error || "Bulk delete failed"); }
    } catch { toast.error("Network error"); }
    finally { setDeleteBusy(false); setDeleteIds(null); }
  }

  /* ── Edit user name ─────────────────────────────────────── */
  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editUser || !editName.trim() || !selectedId || !devPwRef.current) return;
    setEditBusy(true);
    try {
      const r = await fetch(`${API_BASE}/api/devices-config/${selectedId}/users/${editUser.userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Dev-Password": devPwRef.current },
        body: JSON.stringify({ name: editName.trim() }),
      });
      const d = await r.json();
      if (d.success) {
        setDeviceUsers(prev => prev.map(u => u.userId === editUser.userId ? { ...u, name: editName.trim() } : u));
        toast.success("Name updated");
        setEditUser(null); setEditName("");
      } else { toast.error(d.error || "Rename failed"); }
    } catch { toast.error("Network error"); }
    finally { setEditBusy(false); }
  }

  /* ── Toggle selection ───────────────────────────────────── */
  function toggleSelect(userId: string) {
    setSelected(prev => { const s = new Set(prev); s.has(userId) ? s.delete(userId) : s.add(userId); return s; });
  }
  function selectAll() { setSelected(new Set(filtered.map(u => u.userId))); }
  function clearSelection() { setSelected(new Set()); }

  /* ── Derived data ───────────────────────────────────────── */
  const selectedDevice = devices.find(d => d.id === selectedId);
  const isConn = selectedDevice?.status?.connected ?? false;

  // Available classes from students
  const classList = Array.from(new Set(students.map(s => s.className).filter(Boolean))).sort();

  // Filter users
  const filtered = deviceUsers.filter(u => {
    // Search
    if (search) {
      const q = search.toLowerCase();
      if (!(`${u.name} ${u.userId}`.toLowerCase().includes(q))) return false;
    }
    // Class filter (from matched student)
    if (classFilter !== "all") {
      const cls = u.student?.className;
      if (cls !== classFilter) return false;
    }
    // Biometric filter
    if (bioFilter === "fp"   && !u.fingerprintRegistered) return false;
    if (bioFilter === "face" && !u.faceRegistered) return false;
    if (bioFilter === "card" && !u.cardRegistered) return false;
    if (bioFilter === "none" && (u.fingerprintRegistered || u.faceRegistered || u.cardRegistered)) return false;
    return true;
  });

  // Stats
  const stats = {
    total:     deviceUsers.length,
    fingerprint: deviceUsers.filter(u => u.fingerprintRegistered).length,
    face:       deviceUsers.filter(u => u.faceRegistered).length,
    card:       deviceUsers.filter(u => u.cardRegistered).length,
    unmatched:  deviceUsers.filter(u => !u.student).length,
  };

  /* ═══════════════════════════════════════════════════════
     RENDER
  ═══════════════════════════════════════════════════════ */
  return (
    <div className="flex h-full flex-col overflow-hidden">

      {/* ── Header ─────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3 shrink-0">
        <div className="flex items-center gap-3">
          <FiCpu className="text-cyan-400 text-lg" />
          <div>
            <h1 className="text-base font-bold text-white">Device Users</h1>
            <p className="text-[11px] text-slate-500">Manage enrolled users per FK623 device</p>
          </div>
        </div>
        <button onClick={onClose}
          className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-400 hover:text-white transition">
          <FiX className="text-[11px]" /> Close
        </button>
      </div>

      {/* ══ PASSWORD GATE ═══════════════════════════════════ */}
      {pwOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-amber-500/30 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-center gap-3 mb-5">
              <div className="rounded-xl bg-amber-500/15 p-2.5 text-amber-400">
                <FiLock className="text-lg" />
              </div>
              <div>
                <h2 className="text-base font-bold text-white">Developer Password</h2>
                <p className="text-xs text-slate-500 mt-0.5">Required to manage device users</p>
              </div>
            </div>
            <form onSubmit={submitPassword} className="space-y-4">
              <div className="relative">
                <input autoFocus type={pwShow ? "text" : "password"} value={pwValue}
                  onChange={e => { setPwValue(e.target.value); setPwError(""); }}
                  placeholder="Enter developer password"
                  className="form-field pr-10 w-full" />
                <button type="button" onClick={() => setPwShow(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition">
                  {pwShow ? <FiEyeOff /> : <FiEye />}
                </button>
              </div>
              {pwError && (
                <p className="text-sm text-red-400 flex items-center gap-1.5">
                  <FiAlertTriangle className="shrink-0" /> {pwError}
                </p>
              )}
              <div className="flex gap-2">
                <button type="submit" className="primary-action flex-1 py-2.5 text-sm">Unlock</button>
                <button type="button" onClick={onClose}
                  className="secondary-action flex-1 py-2.5 text-sm">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Device selector + toolbar ───────────────────── */}
      <div className="border-b border-slate-800 px-5 py-3 space-y-3 shrink-0">

        {/* Row 1: device selector + actions */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Device selector */}
          <select value={selectedId} onChange={e => { setSelectedId(e.target.value); setDeviceUsers([]); setSelected(new Set()); }}
            className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/60 min-w-[200px]">
            <option value="">— Select device —</option>
            {devices.map(d => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.ipAddress}) {d.status?.connected ? "● Online" : "○ Offline"}
              </option>
            ))}
          </select>

          {/* Connection status */}
          {selectedId && (
            <span className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-full
              ${isConn ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-700/60 text-slate-500"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${isConn ? "bg-emerald-400 animate-pulse" : "bg-slate-500"}`} />
              {isConn ? "Connected" : "Offline"}
            </span>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Actions */}
          <button onClick={pullUsers} disabled={loading || !selectedId || !isConn}
            className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:text-white disabled:opacity-40 transition">
            <FiRefreshCw className={`text-[12px] ${loading ? "animate-spin" : ""}`} /> Pull Users
          </button>
          <button onClick={pushAllStudents} disabled={busy || !selectedId || !isConn}
            className="flex items-center gap-1.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40 transition">
            <FiUploadCloud className="text-[12px]" /> Push All Students
          </button>
        </div>

        {/* Row 2: filters */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="relative flex-1 min-w-[150px] max-w-xs">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-[13px]" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search name or ID…"
              className="w-full rounded-xl border border-slate-700 bg-slate-800/80 pl-8 pr-3 py-2 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-500/60" />
          </div>

          {/* Class filter */}
          <select value={classFilter} onChange={e => setClassFilter(e.target.value)}
            className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 outline-none focus:border-cyan-500/60">
            <option value="all">All Classes</option>
            {classList.map(cls => <option key={cls} value={cls}>{cls}</option>)}
          </select>

          {/* Biometric filter */}
          {(["all", "fp", "face", "card", "none"] as const).map(f => (
            <button key={f} onClick={() => setBioFilter(f)}
              className={`rounded-xl px-3 py-2 text-xs font-medium transition capitalize
                ${bioFilter === f ? "bg-cyan-600 text-white" : "border border-slate-700 bg-slate-800 text-slate-400 hover:text-white"}`}>
              {f === "fp" ? "Fingerprint" : f === "none" ? "No Bio" : f}
            </button>
          ))}
        </div>

        {/* Stats + bulk bar */}
        {deviceUsers.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
            <span><strong className="text-white">{stats.total}</strong> total</span>
            <span className="text-blue-300">{stats.fingerprint} FP</span>
            <span className="text-violet-300">{stats.face} Face</span>
            <span className="text-amber-300">{stats.card} Card</span>
            <span className="text-red-400">{stats.unmatched} unmatched</span>

            {/* Bulk selection */}
            {selected.size > 0 ? (
              <div className="flex items-center gap-2 ml-auto">
                <span className="text-cyan-400 font-semibold">{selected.size} selected</span>
                <button onClick={() => setDeleteIds(Array.from(selected))}
                  className="flex items-center gap-1 rounded-lg bg-red-600 hover:bg-red-500 px-2.5 py-1.5 text-xs font-semibold text-white transition">
                  <FiTrash2 className="text-[10px]" /> Delete Selected
                </button>
                <button onClick={clearSelection}
                  className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-400 hover:text-white transition">
                  Clear
                </button>
              </div>
            ) : (
              <button onClick={selectAll}
                className="ml-auto rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-400 hover:text-white transition">
                Select All
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── User list ────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">

        {/* No device selected */}
        {!selectedId && (
          <div className="flex flex-col h-full items-center justify-center text-slate-500 gap-2">
            <FiCpu className="text-3xl text-slate-700" />
            <p className="text-sm">Select a device above to manage its users</p>
          </div>
        )}

        {/* Device selected but not connected */}
        {selectedId && !isConn && (
          <div className="flex flex-col h-full items-center justify-center text-slate-500 gap-2">
            <FiAlertCircle className="text-3xl text-amber-500/50" />
            <p className="text-sm">Device is offline — connect it first</p>
          </div>
        )}

        {/* Connected but no users loaded yet */}
        {selectedId && isConn && deviceUsers.length === 0 && !loading && (
          <div className="flex flex-col h-full items-center justify-center text-slate-500 gap-3">
            <FiUsers className="text-3xl text-slate-700" />
            <p className="text-sm">No users loaded yet</p>
            <button onClick={pullUsers}
              className="flex items-center gap-1.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 px-3 py-2 text-xs font-semibold text-white transition">
              <FiRefreshCw className="text-[12px]" /> Pull Users from Device
            </button>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex h-40 items-center justify-center text-slate-500 gap-2">
            <FiLoader className="animate-spin" /> Loading users…
          </div>
        )}

        {/* User list */}
        {!loading && deviceUsers.length > 0 && (
          <>
            {filtered.map(u => {
              const isSelected = selected.has(u.userId);
              return (
                <div key={u.userId}
                  className={`rounded-xl border px-3 py-2.5 flex items-center gap-3 transition
                    ${isSelected ? "border-cyan-500/40 bg-cyan-500/5" : "border-slate-800 bg-slate-800/30 hover:bg-slate-800/50"}`}>

                  {/* Checkbox */}
                  <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(u.userId)}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-cyan-500 focus:ring-cyan-500/40 shrink-0 cursor-pointer" />

                  {/* Avatar */}
                  <div className="h-8 w-8 shrink-0 rounded-full bg-slate-700/60 flex items-center justify-center text-[11px] font-bold text-slate-400">
                    {(u.name || u.userId).slice(0, 2).toUpperCase()}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-white truncate">{u.name || `User ${u.userId}`}</span>
                      <span className="font-mono text-[10px] text-slate-500">#{u.userId}</span>
                      {!u.student && <span className="text-[10px] text-amber-400">unmatched</span>}
                      {!u.enabled && <span className="text-[10px] text-red-400">disabled</span>}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      {/* Student info */}
                      {u.student && (
                        <span className="text-[10px] text-slate-500">
                          {u.student.className}{u.student.section ? ` · ${u.student.section}` : ""}
                        </span>
                      )}
                      {/* Biometric badges */}
                      {u.biometricMethods.map((m, i) => {
                        const badge = METHOD_BADGE[m] ?? { bg: "bg-slate-700", text: "text-slate-400", short: m.slice(0,3) };
                        return <span key={i} className={`inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-bold ${badge.bg} ${badge.text}`}>{badge.short}</span>;
                      })}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    {/* Edit name */}
                    <button onClick={() => { setEditUser(u); setEditName(u.name || ""); }}
                      title="Edit name"
                      className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-700 hover:text-white transition">
                      <FiEdit2 className="text-sm" />
                    </button>
                    {/* Delete */}
                    <button onClick={() => setDeleteIds([u.userId])}
                      title="Delete"
                      className="rounded-lg p-1.5 text-slate-500 hover:bg-red-500/15 hover:text-red-400 transition">
                      <FiTrash2 className="text-sm" />
                    </button>
                  </div>
                </div>
              );
            })}

            {filtered.length === 0 && deviceUsers.length > 0 && (
              <div className="py-8 text-center text-slate-500">
                <p className="text-sm">No users match your filters</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* ══ EDIT NAME MODAL ════════════════════════════════ */}
      {editUser && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-white">Edit User Name</h2>
              <button onClick={() => setEditUser(null)} className="text-slate-500 hover:text-white transition"><FiX /></button>
            </div>
            <p className="text-xs text-slate-500">User ID: <span className="font-mono text-slate-400">{editUser.userId}</span></p>
            <form onSubmit={saveEdit} className="space-y-3">
              <input autoFocus value={editName} onChange={e => setEditName(e.target.value)}
                placeholder="New name"
                className="form-field w-full" />
              <p className="text-[10px] text-amber-400/80">Note: This deletes and re-adds the user on the device. Biometric data is preserved by the FK623.</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setEditUser(null)}
                  className="flex-1 rounded-xl border border-slate-700 py-2 text-sm text-slate-400 hover:text-white transition">Cancel</button>
                <button type="submit" disabled={editBusy || !editName.trim()}
                  className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 py-2 text-sm font-semibold text-white transition disabled:opacity-50">
                  {editBusy ? <FiLoader className="animate-spin" /> : <FiCheckCircle />}
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ══ DELETE CONFIRM ═════════════════════════════════ */}
      {deleteIds && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl space-y-4">
            <h2 className="text-sm font-bold text-white">Delete {deleteIds.length > 1 ? `${deleteIds.length} Users?` : "User?"}</h2>
            <p className="text-xs text-slate-400">
              {deleteIds.length > 1
                ? "This removes the selected users from the FK623 device. Biometric data (fingerprints, faces) will also be erased."
                : "This removes the user from the FK623 device. Biometric data will also be erased."}
            </p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteIds(null)}
                className="flex-1 rounded-xl border border-slate-700 py-2 text-sm text-slate-400 hover:text-white transition">Cancel</button>
              <button onClick={deleteIds.length > 1 ? bulkDelete : () => deleteUser(deleteIds[0])}
                disabled={deleteBusy}
                className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-red-600 hover:bg-red-500 py-2 text-sm font-semibold text-white transition disabled:opacity-50">
                {deleteBusy ? <FiLoader className="animate-spin" /> : <FiTrash2 />}
                {deleteBusy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
