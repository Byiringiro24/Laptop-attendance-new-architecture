#Requires -Version 5.1
# ============================================================
#  Setup-EcaAfrica.ps1
#  Full first-time install for EcaAfrica Windows tablets.
#  Run via Run-Setup.cmd option [1] or directly as Admin.
# ============================================================
param([switch]$NoPrompt)
$ErrorActionPreference = 'Continue'
. "$PSScriptRoot\Common-EcaAfrica.ps1"

$LOG = Join-Path $script:LogDir 'setup.log'
Ensure-EcaDirs
Rotate-Log $LOG

function L([string]$m, [string]$lv = 'INFO') { Write-Log $m $lv $LOG }
function Step([string]$m) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "  $m" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    L $m
}
function LogLines($output) {
    foreach ($line in @($output)) {
        $s = "$line".Trim()
        if ($s -ne '') { L $s }
    }
}

Require-Admin
L "Setup started. User: $env:USERNAME  Computer: $env:COMPUTERNAME"

# ── 1. Detect identity ────────────────────────────────────────
Step "Detecting tablet identity"
$identity = Get-TabletIdentity
L "DeviceId : $($identity.DeviceId)"
L "Hostname : $($identity.Hostname)"
L "Serial   : $($identity.Serial)"

# ── 2. Prerequisites ──────────────────────────────────────────
Step "Checking prerequisites"
Update-EnvPath

$git = Find-Git
if (-not $git) {
    L "Git not found - installing via winget"
    Install-WithWinget 'Git.Git' 'Git' | Out-Null
    Update-EnvPath
    $git = Find-Git
}
if ($git) { L "Git : $git" } else { L "Git not found after install - git steps will be skipped" 'WARN' }
Set-GitTimeouts $git

$node = Find-Node
$npm  = Find-Npm
if (-not $node) {
    L "Node.js not found - installing via winget"
    Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS' | Out-Null
    Update-EnvPath
    $node = Find-Node
    $npm  = Find-Npm
}
if ($node) { L "Node : $node  npm: $npm" } else { L "Node.js not found - JS steps will be skipped" 'WARN' }

$chrome = Find-Chrome
if (-not $chrome) {
    L "Chrome not found - installing via winget"
    Install-WithWinget 'Google.Chrome' 'Google Chrome' | Out-Null
    Update-EnvPath
    $chrome = Find-Chrome
}
if ($chrome) { L "Chrome : $chrome" } else { L "Chrome not found - kiosk launch will be skipped" 'WARN' }

$wg = Find-WireGuard
if (-not $wg) {
    L "WireGuard not found - installing via winget"
    Install-WithWinget 'WireGuard.WireGuard' 'WireGuard' | Out-Null
    Update-EnvPath
    $wg = Find-WireGuard
}
if ($wg) { L "WireGuard : $wg" } else { L "WireGuard not found - VPN will not be configured" 'WARN' }

$dotnetX86 = Find-DotNetX86
if (-not $dotnetX86) {
    L ".NET x86 not found - installing .NET 8 Desktop Runtime x86 via winget"
    Install-WithWinget 'Microsoft.DotNet.DesktopRuntime.8' '.NET 8 Desktop Runtime x86' 'x86' | Out-Null
    Update-EnvPath
    $dotnetX86 = Find-DotNetX86
}
if ($dotnetX86) { L ".NET x86 : $dotnetX86" } else { L ".NET x86 not found - FKBridge build will be skipped" 'WARN' }

# ── 3. Clone / update repository ─────────────────────────────
Step "Syncing Tablet_Setup repository"
$repo      = $script:RepoDir
$cloneOk   = $false

if ($git) {
    if (Test-Path (Join-Path $repo '.git')) {
        L "Repo already cloned - pulling latest ($($script:RepoBranch))"
        $fetchOk = Invoke-GitSafe $git @('fetch','--prune','origin',$script:RepoBranch) $repo 3
        if ($fetchOk) {
            Invoke-GitSafe $git @('checkout',$script:RepoBranch) $repo 2 | Out-Null
            Invoke-GitSafe $git @('reset','--hard',"origin/$($script:RepoBranch)") $repo 2 | Out-Null
            $head = (& $git -C $repo rev-parse HEAD 2>$null).Trim()
            L "Repo updated to: $head"
            $cloneOk = $true
        } else {
            L "Git fetch failed (no network?) - continuing with current local version" 'WARN'
            $cloneOk = (Test-Path (Join-Path $repo 'backend'))
        }
    } else {
        L "Cloning $($script:RepoUrl) branch $($script:RepoBranch)"
        Ensure-Dir (Split-Path $repo -Parent)
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            $env:GIT_TERMINAL_PROMPT = '0'
            $cloneOut = & $git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 -c http.connectTimeout=15 `
                clone --branch $script:RepoBranch --single-branch --depth 1 $script:RepoUrl $repo 2>&1
            LogLines $cloneOut
            if (Test-Path (Join-Path $repo '.git')) { $cloneOk = $true; break }
            if ($attempt -lt 3) {
                L "Clone attempt $attempt failed - retrying in 5s..." 'WARN'
                Start-Sleep -Seconds 5
            }
        }
        if ($cloneOk) {
            L "Clone complete"
        } else {
            L "GitHub clone failed after 3 attempts" 'WARN'
        }
    }
} else {
    L "Git not available" 'WARN'
}

# Offline fallback: copy from alongside this script (USB deploy)
if (-not $cloneOk) {
    $scriptDir = $PSScriptRoot
    if (-not $scriptDir) { $scriptDir = Split-Path $MyInvocation.MyCommand.Path -Parent }
    $anyFound = $false
    foreach ($comp in @('backend','frontend','FKBridge')) {
        $src = Join-Path $scriptDir $comp
        if (Test-Path $src) {
            Ensure-Dir (Join-Path $script:EcaRoot $comp)
            robocopy $src (Join-Path $script:EcaRoot $comp) /E /XD node_modules .next /XF .env .env.local /NFL /NDL /NJH /NJS /NP | Out-Null
            L "Offline fallback: copied $comp from $src" 'WARN'
            $anyFound = $true
        }
    }
    if (-not $anyFound) {
        $parentDir  = Split-Path $scriptDir -Parent
        $tsDir      = Join-Path $parentDir "Tablet Setup"
        foreach ($comp in @('backend','frontend','FKBridge')) {
            $src = Join-Path $tsDir $comp
            if (Test-Path $src) {
                Ensure-Dir (Join-Path $script:EcaRoot $comp)
                robocopy $src (Join-Path $script:EcaRoot $comp) /E /XD node_modules .next /XF .env .env.local /NFL /NDL /NJH /NJS /NP | Out-Null
                L "Offline fallback (parent): copied $comp from $src" 'WARN'
                $anyFound = $true
            }
        }
    }
    if (-not $anyFound) {
        L "No offline source found. Connect to internet OR place backend/ frontend/ FKBridge/ next to Setup-EcaAfrica.ps1" 'ERROR'
    }
}

# Save known-good commit
if ($git -and (Test-Path (Join-Path $repo '.git'))) {
    $commit = (& $git -C $repo rev-parse HEAD 2>$null).Trim()
    if ($commit -ne '') { Set-Content $script:KnownGoodFile $commit -Encoding ASCII }
}

# ── 4. Copy repo components into runtime dirs ─────────────────
Step "Copying application components"
foreach ($comp in @('backend','frontend','FKBridge')) {
    $src = Join-Path $repo $comp
    $dst = Join-Path $script:EcaRoot $comp
    if (Test-Path $src) {
        Ensure-Dir $dst
        robocopy $src $dst /E /XD node_modules .next /XF .env .env.local /NFL /NDL /NJH /NJS /NP | Out-Null
        L "Copied $comp -> $dst"
    } else {
        L "$comp not found in repo at $src" 'WARN'
    }
}

# ── 5. Patch Google Fonts for offline builds ──────────────────
Step "Patching frontend for offline build"
$layoutFile = Join-Path $script:FrontendDir 'app\layout.tsx'
if (Test-Path $layoutFile) {
    $layoutContent = [System.IO.File]::ReadAllText($layoutFile, [System.Text.Encoding]::UTF8)
    if ($layoutContent -match 'from "next/font/google"') {
        # Replace Google Fonts with a system font stack - no network needed at build time
        $layoutContent = $layoutContent -replace 'import \{ Inter \} from "next/font/google";', '// Google Fonts removed for offline build compatibility'
        $layoutContent = $layoutContent -replace 'const inter = Inter\(\{[^}]+\}\);', 'const inter = { className: "font-inter" };'
        [System.IO.File]::WriteAllText($layoutFile, $layoutContent, [System.Text.UTF8Encoding]::new($false))
        L "Patched layout.tsx: replaced Google Fonts with system font"
    } else {
        L "layout.tsx already patched or no Google Fonts found"
    }
}
# Also set NEXT_FONT_GOOGLE_MOCKED in Next.js config as belt-and-suspenders
$nextCfgFile = Join-Path $script:FrontendDir 'next.config.js'
if (Test-Path $nextCfgFile) {
    $cfg = [System.IO.File]::ReadAllText($nextCfgFile, [System.Text.Encoding]::UTF8)
    if ($cfg -notmatch 'NEXT_PUBLIC_FONT_OFFLINE|optimizePackageImports.*inter') {
        # Already configured or not needed - leave alone
    }
    L "next.config.js intact"
}

# ── 6. Write .env files (preserve existing values) ────────────
Step "Writing environment config files"

# Resolve FK623 IP/port before writing .env (same logic as step 7)
$cfgEarly = Get-EcaConfig
$bioIpEarly   = $cfgEarly.Device.DefaultBiometricDeviceIp
$bioPortEarly = [int]$cfgEarly.Device.DefaultBiometricDevicePort
$provFileEarly = Join-Path $script:ProvisionDir 'device.json'
if (Test-Path $provFileEarly) {
    try {
        $provEarly = Get-Content $provFileEarly -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($provEarly.Device.BiometricDeviceIp)   { $bioIpEarly   = $provEarly.Device.BiometricDeviceIp }
        if ($provEarly.Device.BiometricDevicePort)  { $bioPortEarly = [int]$provEarly.Device.BiometricDevicePort }
    } catch {}
}
# Also read existing device-config.json if present (highest priority — already enrolled)
if (Test-Path $script:DeviceCfg) {
    try {
        $existDev = Get-Content $script:DeviceCfg -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($existDev.ipAddress) { $bioIpEarly   = $existDev.ipAddress }
        if ($existDev.port)      { $bioPortEarly = [int]$existDev.port }
    } catch {}
}

Set-EnvFile (Join-Path $script:BackendDir '.env') @{
    PORT               = '5000'
    SERVER_API_URL     = 'https://backend.ecareafrica.net/api/v1'
    TABLET_UUID        = ''
    WG_SERVER_ENDPOINT = '169.58.124.150:51820'
    VPN_ALLOWED_IPS    = '10.0.0.0/16'
    WG_DNS             = '1.1.1.1'
    DEV_PASSWORD       = 'admin1234'
    DEVICE_IP          = $bioIpEarly
    DEVICE_PORT        = "$bioPortEarly"
    DEVICE_LICENSE     = "$([int]$cfgEarly.Device.License)"
} -PreserveExisting
L "Backend .env written (DEVICE_IP=$bioIpEarly DEVICE_PORT=$bioPortEarly)"

Set-EnvFile (Join-Path $script:FrontendDir '.env.local') @{
    NEXT_PUBLIC_API_URL = 'http://localhost:5000'
} -PreserveExisting
L "Frontend .env.local written"

# ── 7. Write device-config.json (preserve existing) ───────────
Step "Writing device config"
$cfg = Get-EcaConfig
if (-not (Test-Path $script:DeviceCfg)) {
    Ensure-Dir (Split-Path $script:DeviceCfg -Parent)
    $bioIp   = $cfg.Device.DefaultBiometricDeviceIp
    $bioPort = [int]$cfg.Device.DefaultBiometricDevicePort
    $provFile = Join-Path $script:ProvisionDir 'device.json'
    if (Test-Path $provFile) {
        try {
            $prov = Get-Content $provFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($prov.Device.BiometricDeviceIp)   { $bioIp   = $prov.Device.BiometricDeviceIp }
            if ($prov.Device.BiometricDevicePort)  { $bioPort = [int]$prov.Device.BiometricDevicePort }
        } catch {}
    }
    $devObj = [ordered]@{
        deviceId     = $identity.DeviceId
        hostname     = $identity.Hostname
        serialNumber = $identity.Serial
        license      = [int]$cfg.Device.License
        ipAddress    = $bioIp
        port         = $bioPort
        netPassword  = 0
        protocolType = -1
        timeoutMs    = [int]$cfg.Device.TimeoutMs
        localIp      = (Get-LocalIP)
        generatedAt  = (Get-Date).ToString('o')
    }
    $devObj | ConvertTo-Json -Depth 5 | Set-Content $script:DeviceCfg -Encoding UTF8
    L "device-config.json created  (deviceId=$($devObj.deviceId), ip=$bioIp)"
} else {
    L "Existing device-config.json preserved"
}

# ── 8. Firewall ────────────────────────────────────────────────
Step "Configuring firewall"
$fwResult = Ensure-FirewallRule 'EcaAfrica Device TCP 5005' 5005
L "Firewall rule TCP 5005: $fwResult"

# ── 9. npm install ─────────────────────────────────────────────
if ($npm) {
    if (Test-Path (Join-Path $script:BackendDir 'package.json')) {
        Step "Installing backend npm dependencies"
        $rc = Invoke-Npm $npm @('install','--legacy-peer-deps','--no-audit','--no-fund') $script:BackendDir
        if ($rc -eq 0) { L "Backend npm install OK" } else { L "Backend npm install returned $rc" 'WARN' }
    } else {
        L "Backend package.json not found - npm install skipped" 'WARN'
    }

    if (Test-Path (Join-Path $script:FrontendDir 'package.json')) {
        Step "Installing frontend npm dependencies"
        $rc = Invoke-Npm $npm @('install','--legacy-peer-deps','--no-audit','--no-fund') $script:FrontendDir
        if ($rc -eq 0) { L "Frontend npm install OK" } else { L "Frontend npm install returned $rc" 'WARN' }

        Step "Building frontend"
        $rc = Invoke-Npm $npm @('run','build') $script:FrontendDir
        if ($rc -eq 0) { L "Frontend build OK" } else { L "Frontend build returned $rc" 'WARN' }
    } else {
        L "Frontend package.json not found - npm install skipped" 'WARN'
    }
} else {
    L "npm not found - dependency install skipped" 'WARN'
}

# ── 10. Build FKBridge (x86) ──────────────────────────────────
if ($dotnetX86) {
    Step "Building FKBridge (.NET x86)"
    $proj = Get-ChildItem $script:FKBridgeDir -Filter '*.csproj' -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if ($proj) {
        Push-Location $proj.DirectoryName
        try {
            $restoreOut = & $dotnetX86 restore $proj.FullName 2>&1
            LogLines $restoreOut
            $buildOut = & $dotnetX86 build $proj.FullName -c Release --no-restore 2>&1
            LogLines $buildOut
            if ($LASTEXITCODE -eq 0) { L "FKBridge build OK" }
            else { L "FKBridge build returned $LASTEXITCODE" 'WARN' }
        } catch { L "FKBridge build error: $_" 'WARN' }
        finally { Pop-Location }
    } else {
        L "No .csproj found in $($script:FKBridgeDir)" 'WARN'
    }
}

# ── 11. Copy scripts into C:\EcaAfrica\scripts ────────────────
Step "Installing runtime scripts"
foreach ($f in @('Start-EcaAfrica.ps1','Repair-EcaAfrica.ps1','Common-EcaAfrica.ps1','Enroll-Tablet.ps1','Run-Setup.cmd')) {
    $src = Join-Path $PSScriptRoot $f
    $dst = Join-Path $script:ScriptsDir $f
    if (Test-Path $src) {
        Copy-Item $src $dst -Force
        L "Installed $f -> $dst"
    } else {
        L "$f not found beside Setup-EcaAfrica.ps1" 'WARN'
    }
}
# Copy config subfolder
$cfgSrc = Join-Path $PSScriptRoot 'config'
$cfgDst = Join-Path $script:ScriptsDir 'config'
if (Test-Path $cfgSrc) {
    Ensure-Dir $cfgDst
    Copy-Item "$cfgSrc\*" $cfgDst -Force -Recurse
    L "Installed config/ -> $cfgDst"
} else {
    L "config/ not found beside Setup-EcaAfrica.ps1" 'WARN'
}

# ── 12. Register scheduled task ───────────────────────────────
Step "Registering startup task"
$startScript = Join-Path $script:ScriptsDir 'Start-EcaAfrica.ps1'
if (Test-Path $startScript) {
    try {
        Register-EcaTask -TaskName $cfg.Task.Name -ScriptPath $startScript -RestartMinutes ([int]$cfg.Task.RestartEveryMinutes)
        L "Scheduled task '$($cfg.Task.Name)' registered (AtLogon, restart every $($cfg.Task.RestartEveryMinutes) min)"
    } catch { L "Task registration failed: $_" 'WARN' }
} else {
    L "Start script not found at $startScript" 'WARN'
}

# ── 13. WireGuard auto-start ──────────────────────────────────
Step "Configuring WireGuard auto-start"
$wgSvcs = Get-Service -Name 'WireGuardTunnel*' -ErrorAction SilentlyContinue
if ($wgSvcs) {
    foreach ($svc in @($wgSvcs)) {
        try {
            Set-Service -Name $svc.Name -StartupType Automatic -ErrorAction SilentlyContinue
            if ($svc.Status -ne 'Running') { Start-Service $svc.Name -ErrorAction SilentlyContinue }
            L "WireGuard service '$($svc.Name)' set to Automatic"
        } catch { L "WireGuard service config failed: $_" 'WARN' }
    }
} else {
    L "No WireGuard tunnel installed yet - configure VPN after setup" 'WARN'
}

# ── 14. Launch startup ────────────────────────────────────────
Step "Launching services in background"
if (Test-Path $startScript) {
    Start-Process powershell.exe -WindowStyle Hidden `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`""
    L "Start-EcaAfrica.ps1 launched in background"
}

# ── Summary ───────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  EcaAfrica Setup Complete" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Root       : $($script:EcaRoot)"
Write-Host "  Device ID  : $($identity.DeviceId)"
Write-Host "  Task       : $($cfg.Task.Name)"
Write-Host "  Log        : $LOG"
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Yellow
Write-Host "   1. Import WireGuard tunnel config (if not already done)"
Write-Host "   2. Restart the tablet to test auto-start"
Write-Host "   3. If FK623 IP is different, run Enroll-Tablet.ps1"
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
L "Setup finished"

if (-not $NoPrompt) { Read-Host "Press Enter to close" | Out-Null }
