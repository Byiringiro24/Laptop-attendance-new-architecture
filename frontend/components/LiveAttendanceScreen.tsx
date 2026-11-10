"use client";
import { useEffect, useState } from "react";
import { FiX, FiArrowLeft } from "react-icons/fi";
import type { AttendanceLog } from "./types";

export default function LiveAttendanceScreen({
  log,
  onDismiss,
}: {
  log: AttendanceLog;
  onDismiss: () => void;
}) {
  const [visible,  setVisible]  = useState(false);
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 40);
    const start = Date.now();
    const tick = setInterval(() => {
      setProgress(Math.max(0, 100 - ((Date.now() - start) / 4000) * 100));
    }, 50);
    return () => { clearTimeout(t); clearInterval(tick); };
  }, []);

  const raw = log.rawData ?? {};
  const deviceUserId = String(
    log.studentDeviceId ??
    log.deviceUserId ??
    raw.deviceUserId ??
    raw.userId ??
    raw.studentDeviceId ??
    "—"
  );

  const studentIdLabel = String(
    log.studentId && log.studentId !== deviceUserId ? log.studentId : "—"
  );

  const studentType = (() => {
    const value = (
      log.studentType ??
      log.boardingStatus ??
      raw.studentType ??
      raw.boardingStatus ??
      raw.boarding_status ??
      raw.student_type ??
      raw.memberType ??
      raw.status ??
      ""
    );

    if (!value || typeof value !== "string") return "Day Student";
    const normalized = value.toLowerCase();
    if (normalized.includes("boarding") || normalized.includes("boarder")) return "Boarding Student";
    if (normalized.includes("day")) return "Day Student";
    if (normalized.includes("resident")) return "Boarding Student";
    if (normalized.includes("non boarding") || normalized.includes("non-boarding")) return "Day Student";
    if (String(raw.isBoarding).toLowerCase() === "true") return "Boarding Student";
    if (String(raw.isBoarding).toLowerCase() === "false") return "Day Student";
    return value;
  })();

  const roomDisplay = (() => {
    const value = (
      log.roomName ??
      log.dormitoryName ??
      raw.roomName ??
      raw.dormitoryName ??
      raw.room_name ??
      raw.room ??
      raw.dormitory ??
      raw.hostel ??
      raw.block ??
      ""
    );
    return value ? String(value) : "—";
  })();

  const method = log.authenticationMethod || "Unknown";
  const s      = (log.status || "").toLowerCase();
  const isLate   = s.includes("late");
  const isAbsent = s.includes("absent");

  const methodIcon =
    method.toLowerCase().includes("face")    ? "ID" :
    method.toLowerCase().includes("finger")  ? "FP" :
    method.toLowerCase().includes("card")    ? "NFC" :
    method.toLowerCase().includes("pin") || method.toLowerCase().includes("pass") ? "PIN" : "OK";

  const accent = isLate
    ? "from-amber-500/20  border-amber-500/40"
    : isAbsent
    ? "from-red-500/20    border-red-500/40"
    : "from-emerald-500/20 border-emerald-500/40";

  const bar    = isLate ? "bg-amber-500"  : isAbsent ? "bg-red-500"  : "bg-emerald-500";
  const glow   = isLate ? "shadow-amber-500/20" : isAbsent ? "shadow-red-500/20" : "shadow-emerald-500/20";
  const ring   = isLate ? "border-amber-500/70" : isAbsent ? "border-red-500/70"  : "border-emerald-500/70";
  const ringBg = isLate ? "border-amber-500/50 bg-amber-500/10 text-amber-300"
               : isAbsent ? "border-red-500/50 bg-red-500/10 text-red-300"
               : "border-emerald-500/50 bg-emerald-500/10 text-emerald-300";
  const badgeColor = isLate ? "bg-amber-500/20 text-amber-300"
                   : isAbsent ? "bg-red-500/20 text-red-300"
                   : "bg-emerald-500/20 text-emerald-300";
  const tickColor  = isLate ? "text-amber-400" : isAbsent ? "text-red-400" : "text-emerald-400";

  return (
    <div className={`absolute inset-0 z-30 flex flex-col items-center justify-center
      bg-gradient-to-br via-slate-900 to-slate-900 ${accent}
      transition-all duration-700 ease-out ${visible ? "opacity-100 scale-100" : "opacity-0 scale-95"}
      overflow-y-auto px-4 py-6`}>

      {/* Dismiss buttons */}
      <button onClick={onDismiss}
        className="absolute right-4 top-4 rounded-xl border border-slate-700 bg-slate-800/80 p-3 text-slate-400 hover:text-white transition touch-manipulation">
        <FiX className="text-xl" />
      </button>
      <button onClick={onDismiss}
        className="absolute left-4 top-4 flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-3 text-sm text-slate-400 hover:text-white transition touch-manipulation">
        <FiArrowLeft /> Back
      </button>

      {/* Card — full width on small screens, capped on large */}
      <div className={`relative w-full max-w-md rounded-3xl border bg-slate-900/95 p-6 sm:p-10 shadow-2xl ${glow} shadow-2xl ${accent.split(" ")[1]}`}>

        {/* Photo or icon */}
        <div className="mb-5 flex justify-center">
          {log.photoUrl ? (
              <div className={`relative h-28 w-28 sm:h-36 sm:w-36 rounded-full border-4 overflow-hidden shadow-xl ${ring}`}>
                <img src={log.photoUrl} alt={log.studentName} className="h-full w-full object-cover"
                  onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
              </div>
          ) : (
            <div className={`flex h-24 w-24 sm:h-32 sm:w-32 items-center justify-center rounded-full border-4 text-2xl sm:text-3xl font-black shadow-xl ${ringBg}`}>
              {methodIcon}
            </div>
          )}
        </div>

        {/* Student info — scales down on narrow screens */}
        <div className="text-center">
          <p className="text-3xl sm:text-4xl md:text-5xl font-black tracking-tight text-white leading-tight break-words">
            {log.studentName}
          </p>
          <p className="mt-2 text-xl sm:text-2xl font-bold text-cyan-400">
            {deviceUserId}
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2 text-xs sm:text-sm text-slate-300">
            {studentIdLabel !== "—" && (
              <span className="rounded-full border border-slate-700 bg-slate-800/70 px-2.5 py-1">
                Student ID: {studentIdLabel}
              </span>
            )}
            <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-cyan-300">
              {studentType}
            </span>
          </div>
          {log.className && (
            <p className="mt-2 text-sm sm:text-base text-slate-400">
              {log.className}{log.section ? ` · Section ${log.section}` : ""}
            </p>
          )}
        </div>

        {/* Status badge */}
        <div className="mt-5 flex justify-center">
          <span className={`rounded-full px-5 py-2 text-base sm:text-lg font-bold ${badgeColor}`}>
            {log.status}
          </span>
        </div>

        {/* Details grid */}
        <div className="mt-6 grid grid-cols-2 gap-3 text-sm">
          {[
            { label: "Method", value: method },
            { label: "Device User ID", value: deviceUserId },
            { label: "Type", value: studentType },
            { label: "Room / Dormitory", value: roomDisplay },
            { label: "Time", value: new Date(log.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) },
            { label: "Date", value: new Date(log.timestamp).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) },
            { label: "Student ID", value: studentIdLabel },
            { label: "Device", value: log.deviceId || "—" },
          ].map(item => (
            <div key={item.label} className="rounded-xl border border-slate-800 bg-slate-800/60 p-3 text-center">
              <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">{item.label}</p>
              <p className="font-semibold text-slate-200 truncate text-xs sm:text-sm">{item.value}</p>
            </div>
          ))}
        </div>

        {/* Recorded row */}
        <div className="mt-5 flex items-center justify-center gap-2 text-sm">
          <span className={`text-lg ${tickColor}`}>&#x2714;</span>
          <span className="text-slate-300">Attendance recorded</span>
        </div>

        {/* Countdown bar */}
        <div className="mt-5 h-1.5 w-full overflow-hidden rounded-full bg-slate-700">
          <div className={`h-full rounded-full transition-none ${bar}`} style={{ width: `${progress}%` }} />
        </div>
        <p className="mt-1.5 text-center text-xs text-slate-600">Auto-returns to dashboard</p>
      </div>
    </div>
  );
}
