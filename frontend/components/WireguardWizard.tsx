"use client";
/**
 * WireGuard VPN Wizard - 5 step tunnel setup
 * Extracted from page.tsx to keep the main file manageable.
 */
import {
  FiActivity, FiAlertTriangle, FiCheckCircle, FiChevronRight,
  FiCopy, FiDownloadCloud, FiExternalLink, FiLoader, FiLock,
  FiRefreshCw, FiSettings, FiShield, FiWifi, FiWifiOff, FiX,
} from "react-icons/fi";
import { DiagFix } from "./DiagFix";

type WgStatus = {
  installed: boolean;
  isAdmin: boolean;
  tunnelActive: boolean;
  vpnIp: string | null;
  publicKey: string | null;
  lastHandshake: string | null;
};

type SvcStatus = {
  bridgeService: string;
  frontendService: string;
  bothRunning: boolean;
};

interface Props {
  wgStep:       1|2|3|4|5;
  setWgStep:    (s: 1|2|3|4|5) => void;
  wgBusy:       boolean;
  wgError:      string;
  setWgError:   (s: string) => void;
  wgKeys:       { privateKey: string; publicKey: string } | null;
  wgStatus:     WgStatus | null;
  wgInstalled:  boolean;
  wgForm:       { serverPublicKey: string; serverEndpoint: string; vpnIp: string; dns: string };
  setWgForm:    (f: any) => void;
  wgAllowedIPs: string;
  wgPingTarget:     string;
  setWgPingTarget:  (s: string) => void;
  wgPingResult:     { success: boolean; output: string } | null;
  setWgPingResult:  (r: any) => void;
  wgDiagnosis:  any;
  wgDiagBusy:   boolean;
  svcStatus:    SvcStatus | null;
  svcInstalling:boolean;
  copiedKey:    boolean;
  onClose:          () => void;
  onRefreshStatus:  () => Promise<void>;
  onGenerateKeys:   () => Promise<void>;
  onInstall:        () => Promise<void>;
  onDeactivate:     () => Promise<void>;
  onPing:           () => Promise<void>;
  onDiagnose:       () => Promise<void>;
  onSyncKey:        () => Promise<void>;
  onCheckServices:  () => Promise<void>;
  onInstallServices:() => Promise<void>;
  onCopy:           (text: string) => void;
}

const STEPS = [
  { n: 1 as 1|2|3|4|5, label: "Install" },
  { n: 2 as 1|2|3|4|5, label: "Keys" },
  { n: 3 as 1|2|3|4|5, label: "Configure" },
  { n: 4 as 1|2|3|4|5, label: "Activate" },
  { n: 5 as 1|2|3|4|5, label: "Ping Test" },
];

export default function WireguardWizard(p: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-8 pt-7 pb-5 shrink-0">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-cyan-500/15 p-3 text-cyan-400"><FiShield className="text-xl" /></div>
            <div>
              <h2 className="text-xl font-bold">WireGuard VPN Setup</h2>
              <p className="text-sm text-slate-400">Secure tunnel: Tablet to Server</p>
            </div>
          </div>
          <button type="button" onClick={p.onClose} className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white"><FiX /></button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-0 px-8 py-4 shrink-0 border-b border-slate-800">
          {STEPS.map((s, i) => (
            <div key={s.n} className="flex items-center flex-1 min-w-0">
              <button onClick={() => { p.setWgError(""); p.setWgStep(s.n); }}
                className={`flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-semibold transition whitespace-nowrap
                  ${p.wgStep === s.n ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40" :
                    s.n < p.wgStep ? "text-emerald-400" : "text-slate-600 hover:text-slate-400"}`}>
                <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold shrink-0
                  ${p.wgStep === s.n ? "bg-cyan-500 text-slate-900" :
                    s.n < p.wgStep ? "bg-emerald-500 text-slate-900" : "bg-slate-700 text-slate-400"}`}>
                  {s.n < p.wgStep ? "v" : s.n}
                </span>
                {s.label}
              </button>
              {i < 4 && <div className={`h-px flex-1 mx-1 ${s.n < p.wgStep ? "bg-emerald-500/40" : "bg-slate-700"}`} />}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="flex-1 overflow-y-auto px-8 py-6 space-y-5">

          {/* Error banner */}
          {p.wgError && (
            <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              <FiAlertTriangle className="mt-0.5 shrink-0 text-base" />
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{p.wgError}</pre>
            </div>
          )}

          {/* Not-admin warning */}
          {p.wgStatus && p.wgStatus.isAdmin === false && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              <FiAlertTriangle className="mt-0.5 shrink-0 text-base" />
              <div className="space-y-1">
                <p className="font-semibold">Bridge not running as Administrator</p>
                <p className="text-xs text-amber-300/80">WireGuard requires Administrator rights. To fix:</p>
                <ol className="list-decimal ml-4 text-xs text-amber-300/80 space-y-0.5">
                  <li>Close the current bridge window</li>
                  <li>Right-click the bridge shortcut</li>
                  <li>Click "Run as administrator"</li>
                  <li>Refresh this page</li>
                </ol>
              </div>
            </div>
          )}

          {/* STEP 1: Install */}
          {p.wgStep === 1 && (
            <div className="space-y-5">
              <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-5 space-y-3">
                <div className="flex items-center gap-2 text-base font-bold text-white">
                  <FiDownloadCloud className="text-cyan-400" /> Install WireGuard
                </div>
                <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${p.wgInstalled ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30" : "bg-amber-500/15 text-amber-300 border border-amber-500/30"}`}>
                  {p.wgInstalled ? <FiCheckCircle /> : <FiAlertTriangle />}
                  {p.wgInstalled ? "WireGuard is installed" : "WireGuard is NOT installed yet"}
                </div>
              </div>

              {!p.wgInstalled && (
                <div className="space-y-3">
                  <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 space-y-2">
                    <p className="text-sm font-semibold text-slate-200">1. Download WireGuard for Windows</p>
                    <a href="https://www.wireguard.com/install/" target="_blank" rel="noreferrer"
                      className="flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-cyan-300 transition w-fit">
                      <FiExternalLink /> Download WireGuard
                    </a>
                  </div>
                  <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4">
                    <p className="text-sm font-semibold text-slate-200">2. Run the installer and accept the UAC prompt</p>
                  </div>
                  <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4">
                    <p className="text-sm font-semibold text-slate-200">3. Click "Check Again" below</p>
                  </div>
                </div>
              )}

              {/* Auto-Start Services panel */}
              <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-base font-bold text-white">
                    <FiSettings className="text-amber-400" /> Auto-Start Services
                  </div>
                  <button onClick={p.onCheckServices} className="text-xs text-slate-500 hover:text-slate-300 flex items-center gap-1">
                    <FiRefreshCw className="text-xs" /> Refresh
                  </button>
                </div>
                <p className="text-sm text-slate-400">
                  Install bridge and frontend as Windows services for automatic start on every boot.
                </p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {[
                    { label: "Bridge (port 5000)", key: "bridgeService" },
                    { label: "Frontend (port 3000)", key: "frontendService" },
                  ].map(({ label, key }) => {
                    const state = p.svcStatus ? (p.svcStatus as any)[key] as string : null;
                    const running = state === "Running";
                    return (
                      <div key={key} className={`rounded-lg border px-3 py-2 flex items-center gap-2 ${running ? "border-emerald-500/30 bg-emerald-500/10" : "border-slate-700 bg-slate-800/40"}`}>
                        {running ? <FiCheckCircle className="text-emerald-400 shrink-0" /> : <FiSettings className="text-slate-500 shrink-0" />}
                        <div>
                          <p className="font-semibold text-slate-200">{label}</p>
                          <p className={running ? "text-emerald-400" : "text-slate-500"}>{state ?? "Not checked"}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {p.svcStatus?.bothRunning ? (
                  <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                    <FiCheckCircle /> Both services running - auto-start active
                  </div>
                ) : (
                  <button onClick={p.onInstallServices} disabled={p.svcInstalling}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-amber-600 px-4 py-3 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50">
                    {p.svcInstalling ? <><FiLoader className="animate-spin" /> Installing (up to 2 min)...</> : <><FiSettings /> Install as Auto-Start Services</>}
                  </button>
                )}
              </div>

              <div className="flex gap-3">
                <button onClick={async () => { await p.onRefreshStatus(); if (p.wgInstalled) p.setWgStep(2); }} disabled={p.wgBusy}
                  className="secondary-action flex-1 py-2.5 text-sm">
                  {p.wgBusy ? <><FiLoader className="animate-spin" /> Checking...</> : <><FiRefreshCw /> Check Again</>}
                </button>
                {p.wgInstalled && (
                  <button onClick={() => p.setWgStep(2)} className="primary-action flex-1 py-2.5 text-sm">
                    WireGuard is installed - Next <FiChevronRight />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* STEP 2: Generate Keys */}
          {p.wgStep === 2 && (
            <div className="space-y-5">
              <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-5 space-y-2">
                <div className="flex items-center gap-2 text-base font-bold text-white">
                  <FiLock className="text-cyan-400" /> Generate Tablet Key Pair
                </div>
                <p className="text-sm text-slate-400">
                  Creates a private key (stays on tablet) and public key (paste on server).
                </p>
                {p.wgStatus?.publicKey && (
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                    Keys already exist. You can regenerate or reuse the existing public key below.
                  </div>
                )}
              </div>

              {p.wgKeys && (
                <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4 space-y-3">
                  <div>
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Private Key (never share)</p>
                    <code className="block truncate rounded-lg bg-slate-900 px-3 py-2 text-xs text-red-300 font-mono border border-red-500/20">
                      ----hidden----
                    </code>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Public Key - copy this to the server</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 truncate rounded-lg bg-slate-900 px-3 py-2 text-xs text-cyan-300 font-mono border border-cyan-500/20">
                        {p.wgKeys.publicKey}
                      </code>
                      <button onClick={() => p.onCopy(p.wgKeys!.publicKey)}
                        className="shrink-0 flex items-center gap-1 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:border-cyan-500 hover:text-cyan-300">
                        {p.copiedKey ? <FiCheckCircle className="text-emerald-400" /> : <FiCopy />}
                        {p.copiedKey ? "Copied!" : "Copy"}
                      </button>
                    </div>
                  </div>
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 space-y-2 text-sm text-amber-200">
                    <p className="font-semibold">Register this tablet on the school server:</p>
                    <ol className="list-decimal ml-4 text-xs text-amber-300/80 space-y-1">
                      <li>Go to <strong>Super Admin, Hardware, VPN Setup</strong></li>
                      <li>In Step 1 panel, note the server public key and next VPN IP</li>
                      <li>In Step 2 panel, paste the tablet public key above and click Add Peer</li>
                      <li>Copy server public key + VPN IP from the success box</li>
                      <li>Come back here, click Next - Configure, paste those values</li>
                    </ol>
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <button onClick={p.onGenerateKeys} disabled={p.wgBusy}
                  className="primary-action flex-1 py-2.5 text-sm">
                  {p.wgBusy ? <><FiLoader className="animate-spin" /> Generating...</> : <><FiLock /> {p.wgKeys ? "Regenerate Keys" : "Generate Keys"}</>}
                </button>
                {p.wgKeys && (
                  <button onClick={() => p.setWgStep(3)} className="secondary-action flex-1 py-2.5 text-sm">
                    Next - Configure <FiChevronRight />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* STEP 3: Configure */}
          {p.wgStep === 3 && (
            <div className="space-y-5">
              <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-5 space-y-2">
                <div className="flex items-center gap-2 text-base font-bold text-white">
                  <FiSettings className="text-cyan-400" /> Configure Tunnel
                </div>
                <p className="text-sm text-slate-400">
                  Paste the server public key and fill in connection details from the Super Admin portal.
                </p>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-300">
                    Server Public Key <span className="text-red-400">*</span>
                  </label>
                  <input type="text" value={p.wgForm.serverPublicKey}
                    onChange={e => p.setWgForm({ ...p.wgForm, serverPublicKey: e.target.value.trim() })}
                    placeholder="Paste server public key (from Super Admin, VPN Setup, Step 1)"
                    className="form-field font-mono text-xs" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-300">Server Endpoint <span className="text-red-400">*</span></label>
                    <input type="text" value={p.wgForm.serverEndpoint}
                      onChange={e => p.setWgForm({ ...p.wgForm, serverEndpoint: e.target.value.trim() })}
                      placeholder="169.58.124.150:51820" className="form-field font-mono text-xs" />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-300">Tablet VPN IP <span className="text-red-400">*</span></label>
                    <input type="text" value={p.wgForm.vpnIp}
                      onChange={e => p.setWgForm({ ...p.wgForm, vpnIp: e.target.value.trim() })}
                      placeholder="10.0.0.2" className="form-field font-mono text-xs" />
                  </div>
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-300">DNS Server</label>
                  <input type="text" value={p.wgForm.dns}
                    onChange={e => p.setWgForm({ ...p.wgForm, dns: e.target.value.trim() })}
                    placeholder="1.1.1.1" className="form-field font-mono text-xs" />
                </div>
              </div>

              {/* Config preview */}
              <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-4">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Config Preview - EcareAfrica.conf</p>
                <pre className="text-xs font-mono text-emerald-300 whitespace-pre-wrap">{
`[Interface]
PrivateKey = <saved on tablet>
Address    = ${p.wgForm.vpnIp || "10.0.0.2"}/32
DNS        = ${p.wgForm.dns || "1.1.1.1"}

[Peer]
PublicKey           = ${p.wgForm.serverPublicKey || "<paste server public key>"}
AllowedIPs          = ${p.wgAllowedIPs}
Endpoint            = ${p.wgForm.serverEndpoint || "169.58.124.150:51820"}
PersistentKeepalive = 25`}</pre>
              </div>

              <div className="flex gap-3">
                <button onClick={() => p.setWgStep(2)} className="secondary-action py-2.5 text-sm px-5">Back</button>
                <button onClick={p.onInstall} disabled={p.wgBusy || !p.wgForm.serverPublicKey}
                  className="primary-action flex-1 py-2.5 text-sm">
                  {p.wgBusy ? <><FiLoader className="animate-spin" /> Installing...</> : <><FiWifi /> Save and Activate Tunnel</>}
                </button>
              </div>
            </div>
          )}

          {/* STEP 4: Tunnel Status */}
          {p.wgStep === 4 && (
            <div className="space-y-5">
              <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-base font-bold text-white">
                    <FiWifi className="text-cyan-400" /> Tunnel Status
                  </div>
                  <button onClick={p.onRefreshStatus} disabled={p.wgBusy} className="secondary-action py-1.5 px-3 text-xs">
                    <FiRefreshCw className={p.wgBusy ? "animate-spin" : ""} /> Refresh
                  </button>
                </div>

                <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${p.wgStatus?.tunnelActive ? "border-emerald-500/30 bg-emerald-500/10" : "border-amber-500/30 bg-amber-500/10"}`}>
                  <div className={`text-2xl ${p.wgStatus?.tunnelActive ? "text-emerald-400" : "text-amber-400"}`}>
                    {p.wgStatus?.tunnelActive ? <FiCheckCircle /> : <FiWifiOff />}
                  </div>
                  <div>
                    <p className={`font-bold ${p.wgStatus?.tunnelActive ? "text-emerald-300" : "text-amber-300"}`}>
                      {p.wgStatus?.tunnelActive ? "Tunnel Active - EcareAfrica" : "Tunnel Inactive"}
                    </p>
                    {p.wgStatus?.vpnIp && <p className="text-xs text-slate-400">VPN IP: {p.wgStatus.vpnIp}</p>}
                    {p.wgStatus?.lastHandshake && <p className="text-xs text-slate-400">Last handshake: {p.wgStatus.lastHandshake}</p>}
                  </div>
                </div>

                {p.wgStatus?.publicKey && (
                  <div>
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Tablet Public Key</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 truncate rounded-lg bg-slate-900 px-3 py-2 text-xs text-cyan-300 font-mono border border-cyan-500/20">
                        {p.wgStatus.publicKey}
                      </code>
                      <button onClick={() => p.onCopy(p.wgStatus!.publicKey!)}
                        className="shrink-0 flex items-center gap-1 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:border-cyan-500 hover:text-cyan-300">
                        {p.copiedKey ? <FiCheckCircle className="text-emerald-400" /> : <FiCopy />}
                        {p.copiedKey ? "Copied!" : "Copy"}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {!p.wgStatus?.tunnelActive && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200 space-y-2">
                  <p className="font-semibold">Tunnel not active - possible causes:</p>
                  <ul className="list-disc pl-5 space-y-1 text-xs text-amber-300/80">
                    <li>Server has not added this tablet as a peer yet</li>
                    <li>Server firewall not open on UDP port 51820 - run: ufw allow 51820/udp</li>
                    <li>Backend is not running as Administrator</li>
                  </ul>
                  {!p.wgForm.serverPublicKey && (
                    <p className="text-xs text-amber-300/80 mt-2">
                      Go back to Step 3 and paste the server public key first
                    </p>
                  )}
                </div>
              )}

              <div className="flex gap-3">
                {p.wgStatus?.tunnelActive ? (
                  <>
                    <button onClick={p.onDeactivate} disabled={p.wgBusy}
                      className="secondary-action flex-1 py-2.5 text-sm border-red-500/30 text-red-400 hover:border-red-400">
                      {p.wgBusy ? <FiLoader className="animate-spin" /> : <FiWifiOff />} Stop Tunnel
                    </button>
                    <button onClick={() => { p.setWgStep(5); p.setWgPingResult(null); }}
                      className="primary-action flex-1 py-2.5 text-sm">
                      Test Connection <FiChevronRight />
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={() => p.setWgStep(3)} className="secondary-action flex-1 py-2.5 text-sm">Re-configure</button>
                    <button onClick={p.onInstall} disabled={p.wgBusy || !p.wgForm.serverPublicKey}
                      className="primary-action flex-1 py-2.5 text-sm">
                      {p.wgBusy ? <><FiLoader className="animate-spin" /> Activating...</> : <><FiWifi /> Re-activate Tunnel</>}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* STEP 5: Ping Test */}
          {p.wgStep === 5 && (
            <div className="space-y-5">
              <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-5 space-y-2">
                <div className="flex items-center gap-2 text-base font-bold text-white">
                  <FiActivity className="text-cyan-400" /> Ping Test - Verify VPN Connectivity
                </div>
                <p className="text-sm text-slate-400">
                  Ping the server through the WireGuard tunnel. Server VPN IP is typically 10.0.0.1.
                </p>
              </div>

              {/* Diagnose panel */}
              <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Connection Diagnostics</p>
                  <button onClick={p.onDiagnose} disabled={p.wgDiagBusy}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-cyan-500 hover:text-cyan-300 disabled:opacity-50">
                    {p.wgDiagBusy ? <><FiLoader className="animate-spin" /> Diagnosing...</> : <><FiRefreshCw /> Run Diagnosis</>}
                  </button>
                </div>

                {!p.wgDiagnosis && !p.wgDiagBusy && (
                  <p className="text-xs text-slate-500">Click "Run Diagnosis" to detect any connection problems.</p>
                )}

                {p.wgDiagnosis && (
                  <div className="space-y-2">
                    <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${p.wgDiagnosis.healthy ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30" : "bg-red-500/15 text-red-300 border border-red-500/30"}`}>
                      {p.wgDiagnosis.healthy ? <FiCheckCircle /> : <FiAlertTriangle />}
                      {p.wgDiagnosis.healthy ? "Connection looks healthy" : `${p.wgDiagnosis.problems?.length ?? 1} problem(s) detected`}
                    </div>
                    {p.wgDiagnosis.activeKey && (
                      <div className="rounded-lg bg-slate-900/60 px-3 py-2 text-xs space-y-1">
                        <p className="text-slate-400">Active tunnel key:</p>
                        <p className="font-mono text-cyan-300 break-all">{p.wgDiagnosis.activeKey}</p>
                        {p.wgDiagnosis.keyMismatch && <p className="text-amber-300 font-semibold">Key differs from saved wizard data</p>}
                        {p.wgDiagnosis.vpnIp && <p className="text-slate-400">VPN IP: <span className="font-mono text-slate-200">{p.wgDiagnosis.vpnIp}</span></p>}
                      </div>
                    )}
                    {p.wgDiagnosis.problems?.length > 0 && (
                      <ul className="space-y-1">
                        {p.wgDiagnosis.problems.map((prob: string, i: number) => (
                          <li key={i} className="flex items-start gap-2 text-xs text-red-300">
                            <FiAlertTriangle className="mt-0.5 shrink-0 text-red-400" /> {prob}
                          </li>
                        ))}
                      </ul>
                    )}
                    {p.wgDiagnosis.fixes?.map((fix: any, i: number) => (
                      <DiagFix key={i} fix={fix} wgDiagBusy={p.wgDiagBusy} wgBusy={p.wgBusy} onSyncKey={p.onSyncKey} onRestart={p.onInstall} />
                    ))}
                  </div>
                )}
              </div>

              {/* Ping control */}
              <div className="space-y-3">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-300">Target IP to ping</label>
                  <div className="flex gap-2">
                    <input type="text" value={p.wgPingTarget} onChange={e => p.setWgPingTarget(e.target.value.trim())}
                      placeholder="10.0.0.1" className="form-field font-mono text-sm flex-1" />
                    <button onClick={p.onPing} disabled={p.wgBusy || !p.wgPingTarget}
                      className="primary-action px-6 py-2.5 text-sm shrink-0">
                      {p.wgBusy ? <><FiLoader className="animate-spin" /> Pinging...</> : <><FiActivity /> Ping</>}
                    </button>
                  </div>
                </div>

                {p.wgPingResult && (
                  <div className={`rounded-xl border p-4 space-y-2 ${p.wgPingResult.success ? "border-emerald-500/30 bg-emerald-500/10" : "border-red-500/30 bg-red-500/10"}`}>
                    <div className={`flex items-center gap-2 font-bold text-sm ${p.wgPingResult.success ? "text-emerald-300" : "text-red-300"}`}>
                      {p.wgPingResult.success ? <FiCheckCircle /> : <FiAlertTriangle />}
                      {p.wgPingResult.success ? `Ping successful - ${p.wgPingTarget} is reachable via VPN` : `Ping failed - ${p.wgPingTarget} did not respond`}
                    </div>
                    <pre className="rounded-lg bg-slate-900/80 p-3 text-xs font-mono text-slate-300 overflow-x-auto whitespace-pre-wrap max-h-48">
                      {p.wgPingResult.output}
                    </pre>
                    {!p.wgPingResult.success && (
                      <ul className="list-disc pl-5 text-xs text-red-300/80 space-y-1">
                        <li>Confirm tunnel is Active in Step 4</li>
                        <li>Server must have this tablet registered as a peer</li>
                        <li>Open server firewall: ufw allow 51820/udp</li>
                        <li>Check server tunnel: systemctl status wg-quick@wg0</li>
                      </ul>
                    )}
                  </div>
                )}
              </div>

              <div className="flex gap-3">
                <button onClick={() => p.setWgStep(4)} className="secondary-action py-2.5 text-sm px-5">Back</button>
                {p.wgPingResult?.success && (
                  <div className="flex-1 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-4 space-y-3">
                    <div className="flex items-center gap-2 font-bold text-sm text-emerald-300">
                      <FiCheckCircle className="text-lg shrink-0" /> Setup Complete - VPN tunnel is live
                    </div>
                    <div className="text-xs text-emerald-200/80 space-y-1">
                      <p>WireGuard tunnel is active and encrypted</p>
                      <p>School server will detect this tablet within 30 seconds</p>
                      <p>Attendance logs pull automatically - no further setup needed</p>
                    </div>
                    <button onClick={p.onClose}
                      className="w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-700 transition">
                      Close - Tablet is ready
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
