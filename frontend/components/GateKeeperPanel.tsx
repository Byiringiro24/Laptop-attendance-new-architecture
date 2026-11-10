"use client";
import { useEffect, useState, type FormEvent } from "react";
import toast from "react-hot-toast";
import { FiShield, FiRefreshCw, FiX, FiSearch, FiUser } from "react-icons/fi";
import { schoolApi } from "@/lib/api";
import type { ApprovedExit, SchoolUser } from "./types";

const STATE_BADGE: Record<string, string> = {
  awaiting_physical_exit: "bg-amber-500/20 text-amber-300 border border-amber-500/30",
  outside_school:         "bg-orange-500/20 text-orange-300 border border-orange-500/30",
  returned:               "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30",
  closed:                 "bg-slate-700 text-slate-400 border border-slate-600",
};

export default function GateKeeperPanel({ onClose }: { onClose: () => void }) {
  const [loggedIn,      setLoggedIn]      = useState(false);
  const [schoolUser,    setSchoolUser]    = useState<SchoolUser | null>(null);
  const [loginEmail,    setLoginEmail]    = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError,    setLoginError]    = useState("");
  const [loginBusy,     setLoginBusy]     = useState(false);

  const [exits,    setExits]    = useState<ApprovedExit[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [view,     setView]     = useState<"pending" | "outside" | "all">("pending");
  const [query,    setQuery]    = useState("");
  const [selected, setSelected] = useState<ApprovedExit | null>(null);
  const [notes,    setNotes]    = useState("");
  const [acting,   setActing]   = useState(false);

  useEffect(() => {
    schoolApi.me().then(r => {
      const d = r.data as any;
      if (d.loggedIn && d.user) { setSchoolUser(d.user); setLoggedIn(true); }
    }).catch(() => {});
  }, []);

  useEffect(() => { if (loggedIn) void loadExits(); }, [loggedIn]);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoginBusy(true); setLoginError("");
    try {
      const r = await schoolApi.login(loginEmail.trim(), loginPassword);
      const d = r.data as any;
      if (d.success && d.user) {
        setSchoolUser(d.user); setLoggedIn(true);
        toast.success(`Welcome, ${d.user.name ?? d.user.role}`);
      } else { setLoginError(d.error ?? "Login failed"); }
    } catch (e: any) { setLoginError(e?.response?.data?.error ?? "Cannot reach school server"); }
    finally { setLoginBusy(false); }
  };

  const normalizeExit = (item: any): ApprovedExit => {
    const student = item?.student ?? null;
    return {
      ...item,
      id: item?.id ?? item?.leave_id ?? item?.leaveId ?? "",
      leave_id: item?.leave_id ?? item?.id ?? item?.leaveId ?? "",
      student_id: item?.student_id ?? student?.id ?? "",
      leave_state: item?.leave_state ?? item?.status ?? "",
      student: student ? {
        ...student,
        id: student.id ?? student.student_id ?? "",
      } : null,
    } as ApprovedExit;
  };

  const loadExits = async () => {
    setLoading(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const r = await schoolApi.getApprovedExits(today);
      const payload = (r.data as any)?.data ?? r.data ?? [];
      const data = Array.isArray(payload) ? payload.map(normalizeExit) : [];
      setExits(data);
    } catch (e: any) {
      const message = e?.response?.data?.error ?? e?.response?.data?.message ?? "Failed to load exits";
      toast.error(message);
    } finally { setLoading(false); }
  };

  const filtered = exits.filter(e => {
    if (view === "pending") return e.leave_state === "awaiting_physical_exit";
    if (view === "outside") return ["outside_school", "returned"].includes(e.leave_state);
    return true;
  }).filter(e => {
    const q = query.toLowerCase();
    if (!q) return true;
    const name = `${e.student?.first_name ?? ""} ${e.student?.last_name ?? ""}`.toLowerCase();
    return name.includes(q) || (e.student?.student_id_number ?? "").toLowerCase().includes(q);
  });

  const confirmExit = async () => {
    if (!selected) return;
    setActing(true);
    try {
      await schoolApi.confirmExit(selected.id, notes);
      toast.success("Gate exit confirmed");
      setSelected(null); setNotes("");
      await loadExits();
    } catch (e: any) { toast.error(e?.response?.data?.error ?? "Failed to confirm exit"); }
    finally { setActing(false); }
  };

  const confirmReturn = async () => {
    if (!selected) return;
    setActing(true);
    try {
      await schoolApi.confirmReturn(selected.id);
      toast.success("Return confirmed");
      setSelected(null);
      await loadExits();
    } catch (e: any) { toast.error(e?.response?.data?.error ?? "Failed to confirm return"); }
    finally { setActing(false); }
  };

  // ── Login screen ──────────────────────────────────────────
  if (!loggedIn) {
    return (
      <div className="flex flex-col h-full text-white bg-slate-950">
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-5 py-4 shrink-0">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-cyan-500/15 p-3 text-cyan-400"><FiShield className="text-xl" /></div>
            <div>
              <h2 className="text-lg font-bold">Gate Keeper</h2>
              <p className="text-xs text-slate-400">Sign in to view approved exits</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-xl p-3 text-slate-400 hover:bg-slate-800 hover:text-white touch-manipulation"><FiX className="text-lg" /></button>
        </div>
        <div className="flex flex-1 items-center justify-center p-6 overflow-y-auto">
          <div className="w-full max-w-sm space-y-6">
            <div className="text-center">
              <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-cyan-500/15 text-cyan-400">
                <FiShield className="text-3xl" />
              </div>
              <h3 className="text-xl font-bold">School Login</h3>
              <p className="mt-1 text-sm text-slate-400">Use your school account credentials</p>
            </div>
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-400">Email</label>
                <input autoFocus type="email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)}
                  required placeholder="user@school.ac" className="form-field text-base py-3" />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-400">Password</label>
                <input type="password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)}
                  required className="form-field text-base py-3" />
              </div>
              {loginError && (
                <p className="rounded-xl bg-red-500/15 border border-red-500/30 px-4 py-3 text-sm text-red-300">{loginError}</p>
              )}
              <button type="submit" disabled={loginBusy} className="primary-action w-full py-4 text-base font-bold touch-manipulation">
                {loginBusy ? "Logging in..." : "Login"}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // ── Main gate keeper UI ───────────────────────────────────
  return (
    <div className="flex flex-col h-full text-white bg-slate-950">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-5 py-4 shrink-0">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-cyan-500/15 p-2.5 text-cyan-400"><FiShield className="text-xl" /></div>
          <div>
            <h2 className="text-lg font-bold">Gate Keeper</h2>
            <p className="text-xs text-slate-400">{schoolUser ? `Signed in as ${schoolUser.name}` : "Approved exits"}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void loadExits()} disabled={loading}
            className="rounded-xl border border-slate-700 bg-slate-800 p-3 text-slate-400 hover:text-white disabled:opacity-40 touch-manipulation">
            <FiRefreshCw className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={onClose} className="rounded-xl p-3 text-slate-400 hover:bg-slate-800 hover:text-white touch-manipulation">
            <FiX className="text-lg" />
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 border-b border-slate-800 bg-slate-900/60 px-5 py-3 shrink-0 flex-wrap gap-y-2">
        <div className="relative flex-1 min-w-48">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search student..."
            className="w-full rounded-xl border border-slate-700 bg-slate-800 pl-10 pr-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none" />
        </div>
        <div className="flex gap-2 flex-wrap">
          {(["pending", "outside", "all"] as const).map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`rounded-xl px-4 py-2.5 text-xs font-semibold transition touch-manipulation ${
                view === v ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40" : "border border-slate-700 text-slate-400 hover:text-white"
              }`}>
              {v === "pending" ? `Awaiting (${exits.filter(e => e.leave_state === "awaiting_physical_exit").length})`
               : v === "outside" ? `Outside (${exits.filter(e => ["outside_school","returned"].includes(e.leave_state)).length})`
               : `All (${exits.length})`}
            </button>
          ))}
        </div>
      </div>

      {/* Exit cards list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading ? (
          <div className="py-20 text-center text-slate-500 text-sm">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="py-20 text-center">
            <FiUser className="mx-auto mb-3 text-5xl text-slate-700" />
            <p className="text-slate-500 text-sm">No {view === "pending" ? "awaiting exits" : "records"} found</p>
          </div>
        ) : filtered.map(ex => {
          const s = ex.student;
          const name = s ? `${s.first_name} ${s.last_name}` : "Unknown";
          const roomKey = (ex as any)?.dormitory_id ?? (ex as any)?.room_id ?? 'all-rooms';
          const photoSrc = s?.photo_url ? schoolApi.photoUrl(s.photo_url, { studentId: s.id ?? s.student_id, roomKey }) : null;
          const isLate = ex.late_return_flagged && ex.leave_state === "outside_school";
          const isSelected = selected?.id === ex.id;
          return (
            <div key={ex.id}
              onClick={() => { setSelected(isSelected ? null : ex); setNotes(""); }}
              className={`flex items-center gap-4 rounded-2xl border p-4 cursor-pointer transition touch-manipulation
                ${isSelected ? "border-cyan-500/50 bg-cyan-500/10" : "border-slate-700 bg-slate-900/60 hover:border-slate-600"}
                ${isLate ? "border-red-500/40 bg-red-500/5" : ""}`}>
              {/* Photo */}
              <div className="h-28 w-20 shrink-0 rounded-xl overflow-hidden border-2 border-slate-700">
                {photoSrc ? (
                  <img src={photoSrc} alt={name} className="h-full w-full object-cover"
                    onError={e => { (e.currentTarget as any).style.display = "none"; }} />
                ) : (
                  <div className="h-full w-full flex items-center justify-center bg-slate-800 font-bold text-slate-400">
                    {name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()}
                  </div>
                )}
              </div>
              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-0.5">
                  <span className="font-bold text-sm">{name}</span>
                  {isLate && <span className="rounded-full bg-red-500/20 border border-red-500/30 px-2 py-0.5 text-[10px] font-bold text-red-300">LATE</span>}
                </div>
                <p className="text-xs font-mono text-slate-400">{s?.student_id_number ?? "—"}</p>
                <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
                  <span>Exit: <strong className="text-slate-300">{ex.exited_at ? new Date(ex.exited_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) : ex.start_time ?? ex.start_date}</strong></span>
                  <span>Return by: <strong className="text-slate-300">{ex.expected_return_time ?? ex.end_date}</strong></span>
                </div>
              </div>
              <span className={`rounded-full px-3 py-1.5 text-xs font-bold shrink-0 ${STATE_BADGE[ex.leave_state] ?? "bg-slate-700 text-slate-400"}`}>
                {ex.leave_state.replace(/_/g, " ")}
              </span>
            </div>
          );
        })}
      </div>

      {/* Action panel for selected */}
      {selected && (
        <div className="shrink-0 border-t-2 border-cyan-500/30 bg-slate-900 p-5 space-y-4">
          <div className="flex items-center gap-4">
            <div className="h-28 w-20 shrink-0 rounded-2xl overflow-hidden border-2 border-cyan-500/40">
              {selected.student?.photo_url ? (
                <img src={schoolApi.photoUrl(selected.student.photo_url, {
                  studentId: selected.student.id ?? selected.student.student_id,
                  roomKey: (selected as any)?.dormitory_id ?? (selected as any)?.room_id ?? 'all-rooms',
                })} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="h-full w-full flex items-center justify-center bg-slate-800 text-2xl font-black text-slate-400">
                  {`${selected.student?.first_name?.[0] ?? ""}${selected.student?.last_name?.[0] ?? ""}`}
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xl font-black leading-tight">
                {selected.student ? `${selected.student.first_name} ${selected.student.last_name}` : "—"}
              </p>
              <p className="font-mono text-sm text-cyan-300 mt-0.5">{selected.student?.student_id_number}</p>
              <div className="mt-2 grid grid-cols-2 gap-x-4 text-xs text-slate-400">
                <span>Destination: <strong className="text-white">{selected.destination ?? "—"}</strong></span>
                <span>Return by: <strong className="text-white">{selected.expected_return_time ?? selected.end_date}</strong></span>
              </div>
            </div>
          </div>

          {selected.leave_state === "awaiting_physical_exit" && (
            <input value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Optional notes (e.g. ID verified, parent present)"
              className="form-field text-sm w-full py-3" />
          )}

          <div className="flex gap-3">
            {selected.leave_state === "awaiting_physical_exit" && (
              <button onClick={confirmExit} disabled={acting}
                className="flex-1 rounded-2xl bg-emerald-600 py-5 text-xl font-black text-white hover:bg-emerald-500 disabled:opacity-50 transition shadow-lg shadow-emerald-900/40 active:scale-95 touch-manipulation">
                {acting ? "Processing..." : "✓ CONFIRM GATE EXIT"}
              </button>
            )}
            {["outside_school", "returned"].includes(selected.leave_state) && (
              <button onClick={confirmReturn} disabled={acting}
                className="flex-1 rounded-2xl bg-blue-600 py-5 text-xl font-black text-white hover:bg-blue-500 disabled:opacity-50 transition shadow-lg shadow-blue-900/40 active:scale-95 touch-manipulation">
                {acting ? "Processing..." : "✓ CONFIRM RETURN"}
              </button>
            )}
            <button onClick={() => setSelected(null)}
              className="rounded-2xl border border-slate-700 px-6 py-5 font-bold text-slate-300 hover:bg-slate-800 transition touch-manipulation">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
