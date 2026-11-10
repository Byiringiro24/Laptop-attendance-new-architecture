"use client";
// Small reusable UI components used across the tablet app

import { FiLoader, FiWifi, FiWifiOff } from "react-icons/fi";

// ── NavItem ─────────────────────────────────────────────────
// collapsed=true  → icon-only pill (no label)
// collapsed=false → icon + label

export function NavItem({
  icon, label, active = false, collapsed = false, onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  collapsed?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={`
        group relative flex cursor-pointer items-center gap-3 rounded-xl
        px-3 py-3 text-sm font-medium transition-all duration-200 select-none
        touch-manipulation
        ${collapsed ? "justify-center" : ""}
        ${active
          ? "border border-cyan-500/50 bg-cyan-500/15 text-white shadow-sm shadow-cyan-900/30"
          : "text-slate-400 hover:bg-slate-800/80 hover:text-white"
        }
      `}
    >
      <span className="shrink-0 text-[18px] leading-none">{icon}</span>
      {!collapsed && <span className="leading-snug truncate">{label}</span>}

      {/* Tooltip when collapsed */}
      {collapsed && (
        <span className="pointer-events-none absolute left-full ml-3 z-50 whitespace-nowrap rounded-lg bg-slate-800 border border-slate-700 px-3 py-1.5 text-xs font-semibold text-white opacity-0 shadow-xl transition-opacity group-hover:opacity-100">
          {label}
        </span>
      )}
    </div>
  );
}

// ── SideField ───────────────────────────────────────────────
export function SideField({
  label, value, onChange, placeholder, required = false, type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <input
        required={required}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-slate-700 bg-slate-800/90 px-3 py-2.5 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/30 transition"
      />
    </label>
  );
}

// ── SideSelect ──────────────────────────────────────────────
export function SideSelect({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-slate-700 bg-slate-800/90 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-cyan-400 transition"
      >
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
    </label>
  );
}

// ── StatusPill ──────────────────────────────────────────────
export function StatusPill({ status, small = false }: { status: string; small?: boolean }) {
  const s = status.toLowerCase();
  const color = s.includes("late")
    ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
    : s.includes("absent")
    ? "bg-red-500/20 text-red-300 border border-red-500/30"
    : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30";
  return (
    <span className={`rounded-full font-semibold ${small ? "px-2 py-0.5 text-[10px]" : "px-3 py-1 text-xs"} ${color}`}>
      {status}
    </span>
  );
}

// ── SummaryTile ─────────────────────────────────────────────
export function SummaryTile({ label, value, color }: { label: string; value: string | number; color: string }) {
  const map: Record<string, string> = {
    cyan:    "border-cyan-500/30 bg-cyan-500/10 text-cyan-300",
    emerald: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    amber:   "border-amber-500/30 bg-amber-500/10 text-amber-300",
    indigo:  "border-indigo-500/30 bg-indigo-500/10 text-indigo-300",
    green:   "border-green-500/30 bg-green-500/10 text-green-300",
    red:     "border-red-500/30 bg-red-500/10 text-red-300",
    slate:   "border-slate-600/40 bg-slate-800/50 text-slate-300",
  };
  const displayValue = (() => {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Intl.NumberFormat().format(value) : '—';
    }
    if (value == null || value === '') return '—';
    // If string looks numeric, format it
    const n = Number((value as string).toString().replace(/[^0-9.-]/g, ''));
    if (!Number.isNaN(n) && Number.isFinite(n)) return Intl.NumberFormat().format(n);
    return String(value);
  })();

  return (
    <div className={`rounded-2xl border p-4 ${map[color] ?? map.slate}`}>
      <p className="text-xs font-medium opacity-60 truncate">{label}</p>
      <p className="mt-1 text-2xl font-black leading-none">{displayValue}</p>
    </div>
  );
}

// ── InfoRow ─────────────────────────────────────────────────
export function InfoRow({
  label, value, valueClass = "text-slate-200",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between border-b border-slate-800/60 pb-2 last:border-0 last:pb-0">
      <span className="text-sm text-slate-500">{label}</span>
      <span className={`text-sm font-semibold ${valueClass}`}>{value}</span>
    </div>
  );
}

// ── AutoConnectBadge ────────────────────────────────────────
export function AutoConnectBadge({
  status, attempt,
}: {
  status: "connecting" | "connected" | "retrying";
  attempt: number;
}) {
  if (status === "connected") {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 px-3 py-1.5 text-xs font-semibold text-emerald-300">
        <FiWifi className="shrink-0" /> Device Online
      </span>
    );
  }
  if (status === "connecting") {
    return (
      <span className="flex animate-pulse items-center gap-1.5 rounded-full bg-cyan-500/20 border border-cyan-500/30 px-3 py-1.5 text-xs font-semibold text-cyan-300">
        <FiLoader className="shrink-0 animate-spin" /> Device Connecting...
      </span>
    );
  }
  return (
    <span className="flex animate-pulse items-center gap-1.5 rounded-full bg-red-500/20 border border-red-500/30 px-3 py-1.5 text-xs font-semibold text-red-300">
      <FiWifiOff className="shrink-0" /> Device Offline{attempt > 0 ? ` (retry #${attempt + 1})` : ""}
    </span>
  );
}
