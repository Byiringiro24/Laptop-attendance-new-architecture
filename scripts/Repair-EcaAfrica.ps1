# ============================================================
#  Repair-EcaAfrica.ps1
#  Diagnose and repair a broken EcaAfrica installation.
#
#  Run via: Run-Setup.cmd option [3] or [5] (health only)
#  Or directly: powershell -ExecutionPolicy Bypass -File Repair-EcaAfrica.ps1
#
#  What this does:
#   - Shows health status of every component
#   - Reinstalls missing npm dependencies
#   - Rebuilds frontend if .next is missing or corrupt
#   - Rebuilds FKBridge if exe is missing
#   - Restores firewall rule if missing
#   - Re-registers scheduled task if missing
#   - Re-applies .env files if missing
#   - Optionally relaunches services
# ============================================================

param(
    [switch]$HealthOnly,    # Just print health - no repairs
    [switch]$NoPrompt,
    [switch]$NoStart        # Skip relaunching services after repair
)

$ErrorActionPreference = 'Continue'
. "$PSScriptRoot\Common-EcaAfrica.ps1"

$LOG = Join-Path $script:LogDir 'repair.log'
Ensure-EcaDirs
Rotate-Log $LOG

function L([string]$m, [string]$lv = 'INFO') { Write-Log $m $lv $LOG }
function OK([string]$label) { Write-Host "  [OK]  $label" -ForegroundColor Green;  L "[OK]  $label" }
function FAIL([string]$label) { Write-Host "  [!!]  $label" -ForegroundColor Red;   L "[!!]  $label" 'WARN' }
function SKIP([string]$label) { Write-Host "  [--]  $label" -ForegroundColor Gray;  L "[--]  $label" }

Require-Admin
L "Repair started"

$cfg    = Get-EcaConfig
Update-EnvPath
$npm    = Find-Npm
$dotnet = Find-DotNetX86
$git    = Find-Git
$chrome = Find-Chrome

# ── Health checks ─────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  EcaAfrica Health Check  -  $env:COMPUTERNAME  $((Get-Date).ToString('HH:mm:ss'))" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

$results = [ordered]@{}

# Tools
$results['Git']        = [bool]$git
$results['Node.js']    = [bool](Find-Node)
$results['npm']        = [bool]$npm
$results['.NET x86']   = [bool]$dotnet
$results['Chrome']     = [bool]$chrome
$results['WireGuard']  = [bool](Find-WireGuard)

# Files
$results['Backend server.js']    = Test-Path (Join-Path $script:BackendDir 'server.js')
$results['Backend .env']         = Test-Path (Join-Path $script:BackendDir '.env')
$results['Frontend package.json'] = Test-Path (Join-Path $script:FrontendDir 'package.json')
$results['Frontend .next build'] = Test-Path (Join-Path $script:FrontendDir '.next')
$results['Frontend .env.local']  = Test-Path (Join-Path $script:FrontendDir '.env.local')
$results['FKBridge.exe']         = Test-Path (Join-Path $script:FKBridgeDir 'bin\Release\net8.0\FKBridge.exe')
$results['device-config.json']   = Test-Path $script:DeviceCfg

# Firewall
$fwRule = Get-NetFirewallRule -DisplayName 'EcaAfrica Device TCP 5005' -ErrorAction SilentlyContinue
$results['Firewall TCP 5005']    = [bool]$fwRule

# Scheduled task
$task = Get-ScheduledTask -TaskName $cfg.Task.Name -ErrorAction SilentlyContinue
$results["Task '$($cfg.Task.Name)'"] = [bool]$task

# Runtime services
$results["Backend port $($script:BackendPort)"]  = Test-PortListening $script:BackendPort
$results["Frontend port $($script:FrontendPort)"] = Test-PortListening $script:FrontendPort
$results['FKBridge process']  = [bool](Get-Process -Name 'FKBridge' -ErrorAction SilentlyContinue)
$wgSvc = Get-Service -Name 'WireGuardTunnel*' -ErrorAction SilentlyContinue | Select-Object -First 1
$results['WireGuard tunnel']  = ($wgSvc -and $wgSvc.Status -eq 'Running')

# HTTP health
$results['Backend /api/health'] = Test-HttpOk "http://localhost:$($script:BackendPort)/api/health" 5
$results['Frontend HTTP']       = Test-HttpOk "http://localhost:$($script:FrontendPort)" 5

# Print results
foreach ($k in $results.Keys) {
    if ($results[$k]) { OK  $k } else { FAIL $k }
}

Write-Host ""
$failCount = ($results.Values | Where-Object { -not $_ }).Count
if ($failCount -eq 0) {
    Write-Host "  All checks passed." -ForegroundColor Green
} else {
    Write-Host "  $failCount check(s) failed." -ForegroundColor Yellow
}
Write-Host ""

if ($HealthOnly) {
    L "Health-only mode - no repairs performed"
    if (-not $NoPrompt) { Read-Host "Press Enter to close" | Out-Null }
    exit 0
}

# ── Repairs ───────────────────────────────────────────────────
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Running Repairs" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

$repaired = 0

# Backend .env
if (-not (Test-Path (Join-Path $script:BackendDir '.env'))) {
    Set-EnvFile (Join-Path $script:BackendDir '.env') @{
        PORT='5000'; SERVER_API_URL='https://backend.ecareafrica.net/api/v1'
        TABLET_UUID=''; WG_SERVER_ENDPOINT='169.58.124.150:51820'
        VPN_ALLOWED_IPS='10.0.0.0/16'; WG_DNS='1.1.1.1'; DEV_PASSWORD='admin1234'
    }
    L "Restored backend .env"; $repaired++
}

# Frontend .env.local
if (-not (Test-Path (Join-Path $script:FrontendDir '.env.local'))) {
    Set-EnvFile (Join-Path $script:FrontendDir '.env.local') @{ NEXT_PUBLIC_API_URL='http://localhost:5000' }
    L "Restored frontend .env.local"; $repaired++
}

# Backend npm dependencies
if ($npm -and (Test-Path (Join-Path $script:BackendDir 'package.json'))) {
    if (-not (Test-Path (Join-Path $script:BackendDir 'node_modules'))) {
        L "Reinstalling backend dependencies"
        $rc = Invoke-Npm $npm @('install','--legacy-peer-deps','--no-audit','--no-fund') $script:BackendDir
        if ($rc -eq 0) { L "Backend npm install OK"; $repaired++ }
        else { L "Backend npm install returned $rc" 'WARN' }
    }
}

# Frontend npm dependencies + build
if ($npm -and (Test-Path (Join-Path $script:FrontendDir 'package.json'))) {
    if (-not (Test-Path (Join-Path $script:FrontendDir 'node_modules'))) {
        L "Reinstalling frontend dependencies"
        $rc = Invoke-Npm $npm @('install','--legacy-peer-deps','--no-audit','--no-fund') $script:FrontendDir
        if ($rc -eq 0) { L "Frontend npm install OK"; $repaired++ }
        else { L "Frontend npm install returned $rc" 'WARN' }
    }
    if (-not (Test-Path (Join-Path $script:FrontendDir '.next'))) {
        L "Rebuilding frontend"
        $rc = Invoke-Npm $npm @('run','build') $script:FrontendDir
        if ($rc -eq 0) { L "Frontend build OK"; $repaired++ }
        else { L "Frontend build returned $rc" 'WARN' }
    }
}

# FKBridge
$fkExe = Join-Path $script:FKBridgeDir 'bin\Release\net8.0\FKBridge.exe'
if ($dotnet -and -not (Test-Path $fkExe)) {
    $proj = Get-ChildItem $script:FKBridgeDir -Filter '*.csproj' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proj) {
        L "Rebuilding FKBridge"
        Push-Location $proj.DirectoryName
        try {
            & $dotnet restore $proj.FullName 2>$null | Out-Null
            & $dotnet build   $proj.FullName -c Release --no-restore 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { L "FKBridge rebuilt OK"; $repaired++ }
            else { L "FKBridge build returned $LASTEXITCODE" 'WARN' }
        } catch { L "FKBridge build error: $_" 'WARN' }
        finally { Pop-Location }
    }
}

# Firewall
if (-not $fwRule) {
    $r = Ensure-FirewallRule 'EcaAfrica Device TCP 5005' 5005
    L "Firewall rule TCP 5005: $r"; $repaired++
}

# Scheduled task
if (-not $task) {
    $startScript = Join-Path $script:ScriptsDir 'Start-EcaAfrica.ps1'
    if (-not (Test-Path $startScript)) { $startScript = Join-Path $PSScriptRoot 'Start-EcaAfrica.ps1' }
    if (Test-Path $startScript) {
        try {
            Register-EcaTask -TaskName $cfg.Task.Name -ScriptPath $startScript -RestartMinutes ([int]$cfg.Task.RestartEveryMinutes)
            L "Scheduled task re-registered"; $repaired++
        } catch { L "Task registration failed: $_" 'WARN' }
    }
}

# WireGuard auto-start
$wgSvcs = Get-Service -Name 'WireGuardTunnel*' -ErrorAction SilentlyContinue
foreach ($svc in $wgSvcs) {
    try {
        Set-Service -Name $svc.Name -StartupType Automatic
        if ($svc.Status -ne 'Running') { Start-Service $svc.Name -ErrorAction SilentlyContinue }
    } catch {}
}

# ── Relaunch services ─────────────────────────────────────────
if (-not $NoStart -and $repaired -gt 0) {
    L "Repairs made ($repaired) - relaunching services"
    $startScript = Join-Path $script:ScriptsDir 'Start-EcaAfrica.ps1'
    if (-not (Test-Path $startScript)) { $startScript = Join-Path $PSScriptRoot 'Start-EcaAfrica.ps1' }
    if (Test-Path $startScript) {
        Start-Process powershell.exe -WindowStyle Hidden `
            -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -NoChrome"
        L "Start-EcaAfrica.ps1 relaunched"
    }
}

Write-Host ""
Write-Host "  Repair complete. $repaired fix(es) applied." -ForegroundColor Green
Write-Host "  Log: $LOG" -ForegroundColor Gray
Write-Host ""
L "Repair finished - $repaired fix(es) applied"
if (-not $NoPrompt) { Read-Host "Press Enter to close" | Out-Null }
