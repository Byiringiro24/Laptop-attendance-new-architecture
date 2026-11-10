"use client";
import { FiLoader, FiWifi } from "react-icons/fi";

type Fix = { action: string; label: string; activeKey?: string };

export function DiagFix({
  fix, wgDiagBusy, wgBusy, onSyncKey, onRestart,
}: {
  fix: Fix;
  wgDiagBusy: boolean;
  wgBusy: boolean;
  onSyncKey: () => void;
  onRestart: () => void;
}) {
  const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => {});

  if (fix.action === "sync_key") {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
        <p className="text-xs font-semibold text-amber-200">Fix: Key Mismatch</p>
        <p className="text-xs text-amber-300/80">
          The running tunnel uses key <span className="font-mono">{fix.activeKey?.slice(0, 20)}...</span> but
          the wizard data has a different key.
        </p>
        <ol className="list-decimal ml-4 text-xs text-amber-300/80 space-y-1">
          <li>Click <strong>Sync Key Files</strong> below</li>
          <li>Go to <strong>Super Admin, VPN Setup, Fix Key Mismatch</strong> and register the active key</li>
        </ol>
        <button onClick={onSyncKey} disabled={wgDiagBusy}
          className="inline-flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50">
          {wgDiagBusy ? <><FiLoader className="animate-spin" /> Syncing...</> : "Sync Key Files on Tablet"}
        </button>
        {fix.activeKey && (
          <div className="rounded-lg bg-slate-900/80 p-2 text-xs">
            <p className="text-slate-400 mb-1">Active key (paste in server Fix panel):</p>
            <div className="flex items-center gap-2">
              <p className="font-mono text-cyan-300 break-all flex-1">{fix.activeKey}</p>
              <button onClick={() => copy(fix.activeKey ?? "")}
                className="shrink-0 rounded border border-slate-600 px-2 py-1 text-xs hover:border-cyan-500 hover:text-cyan-300">Copy</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (fix.action === "show_register_instructions") {
    return (
      <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-3 space-y-2">
        <p className="text-xs font-semibold text-blue-200">Fix: Register Key on Server</p>
        <p className="text-xs text-blue-300/80">
          Go to <strong>Super Admin, Hardware, VPN Setup, Step 2</strong> and register this key:
        </p>
        <div className="flex items-center gap-2">
          <p className="font-mono text-cyan-300 text-xs break-all flex-1">{fix.activeKey}</p>
          <button onClick={() => copy(fix.activeKey ?? "")}
            className="shrink-0 rounded border border-slate-600 px-2 py-1 text-xs hover:border-cyan-500 hover:text-cyan-300">Copy</button>
        </div>
      </div>
    );
  }

  if (fix.action === "restart_tunnel") {
    return (
      <button onClick={onRestart} disabled={wgBusy}
        className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50">
        {wgBusy ? <><FiLoader className="animate-spin" /> Restarting...</> : <><FiWifi /> Restart Tunnel</>}
      </button>
    );
  }

  return null;
}
