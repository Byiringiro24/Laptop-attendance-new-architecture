"use client";
/**
 * FilterBar — shared device + date filter used by Dashboard, Students, and Device Users.
 *
 * Shows:
 *  - "All Devices" pill + one pill per registered device (name, online badge)
 *  - Date picker (defaults to today, clearable)
 *  - Selected device info strip (IP, location, student count)
 */

import { FiCalendar, FiX, FiWifi, FiWifiOff, FiCpu } from "react-icons/fi";
import type { PerDeviceStat } from "@/components/types";

interface Props {
  devices: PerDeviceStat[];
  selectedDeviceId: string;          // "" = All
  onSelectDevice: (id: string) => void;
  date: string;                      // "YYYY-MM-DD" or ""
  onDateChange: (d: string) => void;
  /** Optional counts to show in the "All" pill */
  totalStudents?: number;
}

export default function FilterBar({
  devices,
  selectedDeviceId,
  onSelectDevice,
  date,
  onDateChange,
  totalStudents,
}: Props) {
  const today = new Date().toISOString().slice(0, 10);
  const selectedDevice = devices.find(d => d.id === selectedDeviceId) ?? null;

  return (
    <div className="flex flex-col gap-2 shrink-0">
      {/* ── Row 1: device pills + date ─────────────────── */}
      <div className="flex flex-wrap items-center gap-2">

        {/* All devices pill */}
        <button
          onClick={() => onSelectDevice("")}
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition border
            ${selectedDeviceId === ""
              ? "bg-cyan-600 border-cyan-500 text-white"
              : "bg-slate-800/80 border-slate-700 text-slate-400 hover:text-white hover:border-slate-500"
            }`}
        >
          <FiCpu className="text-[11px]" />
          All Devices
          {totalStudents !== undefined && (
            <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold
              ${selectedDeviceId === "" ? "bg-cyan-500/30 text-cyan-100" : "bg-slate-700 text-slate-400"}`}>
              {totalStudents}
            </span>
          )}
        </button>

        {/* Per-device pills */}
        {devices.map(d => (
          <button
            key={d.id}
            onClick={() => onSelectDevice(d.id)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition border
              ${selectedDeviceId === d.id
                ? "bg-cyan-600 border-cyan-500 text-white"
                : "bg-slate-800/80 border-slate-700 text-slate-400 hover:text-white hover:border-slate-500"
              }`}
          >
            {d.connected
              ? <FiWifi  className="text-[11px] text-emerald-400 shrink-0" />
              : <FiWifiOff className="text-[11px] text-slate-600 shrink-0" />
            }
            <span className="truncate max-w-[120px]">{d.name || d.ipAddress}</span>
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold
              ${selectedDeviceId === d.id ? "bg-cyan-500/30 text-cyan-100" : "bg-slate-700 text-slate-400"}`}>
              {d.studentCount}
            </span>
          </button>
        ))}

        {/* Date picker */}
        <div className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 ml-auto">
          <FiCalendar className="text-slate-500 text-[12px] shrink-0" />
          <input
            type="date"
            value={date}
            max={today}
            onChange={e => onDateChange(e.target.value)}
            className="bg-transparent text-xs text-slate-300 outline-none w-[110px] cursor-pointer"
          />
          {date && (
            <button onClick={() => onDateChange("")}
              className="text-slate-500 hover:text-white transition ml-1">
              <FiX className="text-[11px]" />
            </button>
          )}
        </div>
      </div>

      {/* ── Row 2: selected device info strip ──────────── */}
      {selectedDevice && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-[11px]">
          <span className={`flex items-center gap-1 font-semibold
            ${selectedDevice.connected ? "text-emerald-400" : "text-slate-500"}`}>
            {selectedDevice.connected ? <FiWifi /> : <FiWifiOff />}
            {selectedDevice.connected ? "Online" : "Offline"}
          </span>
          <span className="text-slate-500">·</span>
          <span className="font-mono text-slate-400">{selectedDevice.ipAddress}</span>
          {selectedDevice.location && <>
            <span className="text-slate-500">·</span>
            <span className="text-slate-400">{selectedDevice.location}</span>
          </>}
          <span className="text-slate-500">·</span>
          <span className="text-slate-400">
            <strong className="text-white">{selectedDevice.studentCount}</strong> students
          </span>
        </div>
      )}

      {/* Date active notice */}
      {date && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300">
          <FiCalendar className="shrink-0" />
          Showing students registered on {date}
          <button onClick={() => onDateChange("")} className="ml-auto text-amber-400 hover:text-white transition">
            <FiX />
          </button>
        </div>
      )}
    </div>
  );
}
