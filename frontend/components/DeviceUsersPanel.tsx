"use client";
import { useEffect, useState, useCallback } from "react";
import toast from "react-hot-toast";
import {
  FiUsers, FiX, FiRefreshCw, FiSearch, FiFilter,
  FiCheckCircle, FiXCircle, FiAlertCircle, FiDownloadCloud,
  FiCpu, FiUserCheck, FiActivity,
} from "react-icons/fi";
import { deviceApi, studentApi } from "@/lib/api";
import type { DeviceUser, Student } from "@/components/types";

// ── Biometric method badge ──────────────────────────────────────────────────
const METHOD_STYLE: Record<string, { bg: string; text: string; short: string }> = {
  Fingerprint:        { bg: "bg-blue-500/20",   text: "text-blue-300",   short: "FP" },
  "Face Recognition": { bg: "bg-violet-500/20", text: "text-violet-300", short: "FA" },
  "RFID Card":        { bg: "bg-amber-500/20",  text: "text-amber-300",  short: "CD" },
  "Password/PIN":     { bg: "bg-slate-500/20",  text: "text-slate-300",  short: "PIN" },
};

function MethodBadge({ method }: { method: string }) {
  const s = METHOD_STYLE[method] ?? { bg: "bg-slate-700", text: "text-slate-400", short: method.slice(0, 3) };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${s.bg} ${s.text}`}>
      {s.short}
    </span>
  );
}

// ── Stat pill ───────────────────────────────────────────────────────────────
function StatPill({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className={`flex flex-col items-center rounded-2xl border px-5 py-3 min-w-[80px] ${color}`}>
      <span className="text-2xl font-black leading-none">{value}</span>
      <span className="mt-1 text-[10px] font-semibold uppercase tracking-wider opacity-70">{label}</span>
    </div>
  );
}

export default function DeviceUsersPanel({ onClose }: { onClose: () => void }) {
  const [deviceUsers, setDeviceUsers]   = useState<DeviceUser[]>([]);
  const [students,    setStudents]      = useState<Student[]>([]);
  const [loading,     setLoading]       = useState(false);
  const [search,      setSearch]        = useState("");
  const [filterMethod, setFilterMethod] = useState<"all" | "fp" | "face" | "card" | "none">("all");
  const [filterEnrolled, setFilterEnrolled] = useState<"all" | "yes" | "no">("all");

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, studentsRes] = await Promise.allSettled([
        deviceApi.getUsers(),
        studentApi.getAll(),
      ]);
      if (usersRes.status === "fulfilled" && usersRes.value.data) {
        const raw = (usersRes.value.data as any);
        setDeviceUsers(Array.isArray(raw) ? raw : raw?.data ?? raw?.users ?? []);
      }
      if (studentsRes.status === "fulfilled" && studentsRes.value.data) {
        const raw = (studentsRes.value.data as any);
        setStudents(Array.isArray(raw) ? raw : raw?.data ?? raw?.students ?? []);
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to load device users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);

  // Merge device users with local student data for richer display
  const enriched = deviceUsers.map(du => {
    const match = students.find(
      s => String(s.studentDeviceId) === String(du.userId) ||
           String((s as any).deviceUserId) === String(du.userId)
    );
    return { ...du, student: match ?? null };
  });

  // Stats
  const totalFP   = enriched.filter(u => u.fingerprintRegistered).length;
  const totalFace = enriched.filter(u => u.faceRegistered).length;
  const totalCard = enriched.filter(u => u.cardRegistered).length;
  const totalNone = enriched.filter(u => u.biometricMethods.length === 0).length;
  const enrolled  = enriched.filter(u => !!u.student).length;

  // Filter + search
  const filtered = enriched.filter(u => {
    const q = search.toLowerCase();
    const nameMatch = !q
      || `${u.name} ${u.userId} ${u.student?.name ?? ""} ${(u.student as any)?.studentId ?? ""}`.toLowerCase().includes(q);
    if (!nameMatch) return false;

    if (filterEnrolled === "yes" && !u.student) return false;
    if (filterEnrolled === "no"  &&  u.student) return false;

    if (filterMethod === "fp"   && !u.fingerprintRegistered) return false;
    if (filterMethod === "face" && !u.faceRegistered)        return false;
    if (filterMethod === "card" && !u.cardRegistered)        return false;
    if (filterMethod === "none" && u.biometricMethods.length > 0) return false;

    return true;
  });

  return (
    <div className="flex flex-col h-full bg-[#070b14] text-white">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-slate-800 bg-slate-900/80 px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-cyan-500/15 p-2.5 text-cyan-400">
              <FiCpu className="text-xl" />
            </div>
            <div>
              <h2 className="text-lg font-bold leading-tight">Device Users</h2>
              <p className="text-xs text-slate-400">Enrolled on FK623 biometric device</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void loadAll()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700 disabled:opacity-40 touch-manipulation transition"
            >
              <FiRefreshCw className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
            <button
              onClick={onClose}
              className="rounded-xl p-2.5 text-slate-400 hover:bg-slate-800 hover:text-white touch-manipulation"
            >
              <FiX className="text-lg" />
            </button>
          </div>
        </div>

        {/* Stats row */}
        {!loading && deviceUsers.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            <StatPill label="Total"        value={deviceUsers.length}     color="border-slate-700 text-slate-200" />
            <StatPill label="Fingerprint"  value={totalFP}                color="border-blue-500/30 text-blue-300" />
            <StatPill label="Face"         value={totalFace}              color="border-violet-500/30 text-violet-300" />
            <StatPill label="Card"         value={totalCard}              color="border-amber-500/30 text-amber-300" />
            <StatPill label="Enrolled"     value={enrolled}               color="border-emerald-500/30 text-emerald-300" />
            {totalNone > 0 && (
              <StatPill label="No biometrics" value={totalNone}           color="border-red-500/30 text-red-300" />
            )}
          </div>
        )}
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────────── */}
      <div className="shrink-0 flex flex-wrap gap-2 border-b border-slate-800 bg-slate-900/40 px-5 py-3">
        {/* Search */}
        <div className="relative flex-1 min-w-52">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search name, device ID, student ID..."
            className="w-full rounded-xl border border-slate-700 bg-slate-800 pl-9 pr-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-cyan-500 transition"
          />
          {search && (
            <button onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white">
              <FiX className="text-xs" />
            </button>
          )}
        </div>

        {/* Biometric filter */}
        <select
          value={filterMethod}
          onChange={e => setFilterMethod(e.target.value as any)}
          className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-white outline-none"
        >
          <option value="all">All biometrics</option>
          <option value="fp">Has fingerprint</option>
          <option value="face">Has face</option>
          <option value="card">Has card</option>
          <option value="none">No biometrics</option>
        </select>

        {/* Enrolled filter */}
        <select
          value={filterEnrolled}
          onChange={e => setFilterEnrolled(e.target.value as any)}
          className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-white outline-none"
        >
          <option value="all">All users</option>
          <option value="yes">Matched students</option>
          <option value="no">Unmatched only</option>
        </select>

        <div className="flex items-center text-xs text-slate-500 self-center px-1">
          {filtered.length} / {deviceUsers.length} shown
        </div>
      </div>

      {/* ── User list ──────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 gap-4 text-slate-500">
            <FiRefreshCw className="text-4xl animate-spin text-cyan-500" />
            <p className="text-sm font-medium">Loading device users...</p>
          </div>
        ) : deviceUsers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-4 text-slate-500">
            <FiUsers className="text-5xl opacity-30" />
            <div className="text-center">
              <p className="text-base font-semibold">No users on device</p>
              <p className="text-sm mt-1 opacity-70">
                Push students from the Dashboard first
              </p>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-slate-500">
            <FiFilter className="text-4xl opacity-30" />
            <p className="text-sm">No users match the current filter</p>
            <button
              onClick={() => { setSearch(""); setFilterMethod("all"); setFilterEnrolled("all"); }}
              className="text-xs text-cyan-400 hover:underline"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((u, idx) => (
              <UserRow key={u.userId ?? idx} user={u} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Single user row ─────────────────────────────────────────────────────────
function UserRow({ user }: { user: DeviceUser & { student: Student | null } }) {
  const { student } = user;
  const displayName = student?.name || user.name || `User ${user.userId}`;
  const studentId   = (student as any)?.studentId ?? "";
  const className   = student?.className ?? "";
  const section     = student?.section ?? "";

  const initials = displayName
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0])
    .join("")
    .toUpperCase();

  return (
    <div className="flex items-center gap-4 rounded-2xl border border-slate-800/80 bg-slate-900/50 px-4 py-3.5 hover:border-slate-700 transition group">
      {/* Avatar */}
      <div className={`h-11 w-11 shrink-0 rounded-full flex items-center justify-center font-bold text-sm
        ${student ? "bg-cyan-500/15 text-cyan-300" : "bg-slate-700/50 text-slate-400"}`}>
        {initials || "?"}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm text-white truncate max-w-[180px]">{displayName}</span>

          {/* Matched badge */}
          {student ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
              <FiUserCheck className="text-[10px]" /> enrolled
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-400">
              <FiAlertCircle className="text-[10px]" /> unmatched
            </span>
          )}

          {/* Disabled badge */}
          {!user.enabled && (
            <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-bold text-red-400">
              disabled
            </span>
          )}
        </div>

        <div className="mt-1 flex items-center gap-2 flex-wrap">
          {/* Device ID */}
          <span className="text-[11px] text-slate-500 font-mono">ID: {user.userId}</span>
          {studentId && (
            <span className="text-[11px] text-slate-500">· {studentId}</span>
          )}
          {(className || section) && (
            <span className="text-[11px] text-slate-400">
              · {className}{section ? ` ${section}` : ""}
            </span>
          )}
        </div>
      </div>

      {/* Biometric methods */}
      <div className="flex items-center gap-1.5 shrink-0">
        {user.biometricMethods.length > 0 ? (
          user.biometricMethods.map(m => (
            <MethodBadge key={m} method={m} />
          ))
        ) : (
          <span className="text-[10px] text-red-400 font-medium">no biometrics</span>
        )}
      </div>

      {/* Enabled/disabled icon */}
      <div className="shrink-0">
        {user.enabled
          ? <FiCheckCircle className="text-emerald-400 text-base" />
          : <FiXCircle className="text-red-400 text-base" />
        }
      </div>
    </div>
  );
}
