# ============================================================
#  Enroll-Tablet.ps1
#  Per-tablet provisioning - set device ID and FK623 IP.
#  Supports auto-discovery via local network scan.
#
#  Usage examples:
#    .\Enroll-Tablet.ps1 -BiometricDeviceIp 192.168.1.76
#    .\Enroll-Tablet.ps1 -BiometricDeviceIp 192.168.1.76 -DeviceId ECA-KGL-001
#    .\Enroll-Tablet.ps1 -BiometricDeviceIp 192.168.1.76 -Port 5005 -License 1261
#    .\Enroll-Tablet.ps1 -Scan               # auto-discover FK623 on local network
#    .\Enroll-Tablet.ps1 -Scan -Port 5005    # scan a specific port
#
#  What it does:
#   - Writes C:\EcaAfrica\provisioning\device.json
#   - Writes C:\EcaAfrica\backend\data\device-config.json
#   - Both files are read by Setup and Start scripts automatically
#   - Run Setup (option 1) after enrolling to apply changes
# ============================================================

param(
    [string]$BiometricDeviceIp = '',  # Leave blank when using -Scan
    [int]   $Port     = 5005,
    [int]   $License  = 1261,
    [string]$DeviceId = '',           # Leave blank to auto-generate from hardware
    [string]$TabletUuid = '',         # Optional: set in backend .env as TABLET_UUID
    [switch]$Scan,                    # Auto-discover FK623 on local network
    [int]   $ScanTimeoutMs = 1000,    # Timeout per host during scan
    [switch]$NoPrompt
)

$ErrorActionPreference = 'Continue'
. "$PSScriptRoot\Common-EcaAfrica.ps1"

$LOG = Join-Path $script:LogDir 'setup.log'
Ensure-EcaDirs

function L([string]$m, [string]$lv = 'INFO') { Write-Log $m $lv $LOG }

Require-Admin

# ── Auto-discover FK623 via TCP scan if -Scan specified ────────
if ($Scan -or [string]::IsNullOrWhiteSpace($BiometricDeviceIp)) {
    L "Scanning local network for FK623 biometric devices on port $Port ..."
    Write-Host ""
    Write-Host "  Scanning local network for FK623 devices (port $Port) ..." -ForegroundColor Cyan
    Write-Host "  This may take up to 30 seconds." -ForegroundColor Gray
    Write-Host ""

    # Get local IPs to determine subnets to scan
    $localIp = Get-LocalIP
    if (-not $localIp) {
        L "Cannot determine local IP - check network connection" 'ERROR'
        Write-Host "  ERROR: Cannot determine local IP address." -ForegroundColor Red
        if (-not $NoPrompt) { Read-Host "Press Enter to exit" | Out-Null }
        exit 1
    }

    L "Local IP: $localIp  Scanning /$($localIp -replace '\.\d+$', '.x') subnet"

    # Build subnet address list (.1 to .254)
    $prefix = ($localIp -split '\.')[ 0..2 ] -join '.'
    $addrs = 1..254 | ForEach-Object { "$prefix.$_" }

    # Parallel TCP probe using runspaces (works on PS5 without -Parallel)
    $found = @()
    $pool = [RunspaceFactory]::CreateRunspacePool(1, 40)
    $pool.Open()
    $jobs = @()

    foreach ($addr in $addrs) {
        $ps = [PowerShell]::Create()
        $ps.RunspacePool = $pool
        [void]$ps.AddScript({
            param($h, $p, $t)
            try {
                $tcp = New-Object System.Net.Sockets.TcpClient
                $conn = $tcp.BeginConnect($h, $p, $null, $null)
                $ok = $conn.AsyncWaitHandle.WaitOne($t, $false)
                if ($ok -and $tcp.Connected) { $h }
                $tcp.Close()
            } catch {}
        }).AddArgument($addr).AddArgument($Port).AddArgument($ScanTimeoutMs)
        $jobs += [pscustomobject]@{ PS = $ps; Handle = $ps.BeginInvoke() }
    }

    foreach ($j in $jobs) {
        $result = $j.PS.EndInvoke($j.Handle)
        if ($result) { $found += $result }
        $j.PS.Dispose()
    }
    $pool.Close()

    if ($found.Count -eq 0) {
        L "No FK623 devices found on port $Port" 'WARN'
        Write-Host "  No FK623 devices found on port $Port." -ForegroundColor Yellow
        Write-Host "  Make sure the FK623 device is:" -ForegroundColor Yellow
        Write-Host "   - Powered on"
        Write-Host "   - Connected to the same network as this tablet (same router/switch)"
        Write-Host "   - Network port $Port is not blocked by a firewall"
        Write-Host ""
        Write-Host "  You can specify the IP manually:" -ForegroundColor Cyan
        Write-Host "   .\Enroll-Tablet.ps1 -BiometricDeviceIp 192.168.1.76"
        if (-not $NoPrompt) { Read-Host "Press Enter to exit" | Out-Null }
        exit 1
    }

    Write-Host ""
    Write-Host "  Found $($found.Count) device(s) on port ${Port}:" -ForegroundColor Green
    for ($i = 0; $i -lt $found.Count; $i++) {
        Write-Host "    [$($i+1)] $($found[$i])" -ForegroundColor Green
    }

    if ($found.Count -eq 1) {
        $BiometricDeviceIp = $found[0]
        Write-Host ""
        Write-Host "  Auto-selected: $BiometricDeviceIp" -ForegroundColor Cyan
        L "Auto-discovered FK623 at $BiometricDeviceIp"
    } else {
        Write-Host ""
        $choice = Read-Host "  Select device [1-$($found.Count)] (default: 1)"
        $idx = [int]($choice -replace '[^0-9]', '') - 1
        if ($idx -lt 0 -or $idx -ge $found.Count) { $idx = 0 }
        $BiometricDeviceIp = $found[$idx]
        Write-Host "  Selected: $BiometricDeviceIp" -ForegroundColor Cyan
        L "User selected FK623 at $BiometricDeviceIp"
    }
}

# Validate we have an IP at this point
if ([string]::IsNullOrWhiteSpace($BiometricDeviceIp)) {
    Write-Host ""
    Write-Host "  No FK623 IP specified. Use -BiometricDeviceIp or -Scan." -ForegroundColor Red
    Write-Host "  Example: .\Enroll-Tablet.ps1 -BiometricDeviceIp 192.168.1.76" -ForegroundColor Cyan
    if (-not $NoPrompt) { Read-Host "Press Enter to exit" | Out-Null }
    exit 1
}

# Auto-generate device ID from hardware serial if not provided
if ([string]::IsNullOrWhiteSpace($DeviceId)) {
    $id       = Get-TabletIdentity
    $DeviceId = $id.DeviceId
    L "Auto-generated DeviceId: $DeviceId  (from hardware serial $($id.Serial))"
} else {
    L "Using provided DeviceId: $DeviceId"
}

# ── Write provisioning/device.json ────────────────────────────
$provFile = Join-Path $script:ProvisionDir 'device.json'
$provObj  = [ordered]@{
    Device = [ordered]@{
        DeviceId            = $DeviceId
        BiometricDeviceIp   = $BiometricDeviceIp
        BiometricDevicePort = $Port
        License             = $License
    }
    TabletUuid  = $TabletUuid
    EnrolledAt  = (Get-Date).ToString('o')
    EnrolledBy  = $env:USERNAME
    Hostname    = $env:COMPUTERNAME
}
$provObj | ConvertTo-Json -Depth 5 | Set-Content $provFile -Encoding UTF8
L "Provisioning saved to $provFile"

# ── Write backend/data/device-config.json ─────────────────────
$cfg       = Get-EcaConfig
$dataDir   = Join-Path $script:BackendDir 'data'
Ensure-Dir $dataDir
$devCfg = [ordered]@{
    deviceId     = $DeviceId
    hostname     = $env:COMPUTERNAME
    license      = $License
    ipAddress    = $BiometricDeviceIp
    port         = $Port
    netPassword  = 0
    protocolType = -1
    timeoutMs    = [int]$cfg.Device.TimeoutMs
    localIp      = (Get-LocalIP)
    generatedAt  = (Get-Date).ToString('o')
}
$devCfg | ConvertTo-Json -Depth 5 | Set-Content $script:DeviceCfg -Encoding UTF8
L "device-config.json written to $($script:DeviceCfg)"

# ── Open firewall for FK623 TCP port ──────────────────────────
$fwResult = Ensure-FirewallRule "EcaAfrica Device TCP $Port" $Port
L "Firewall rule TCP ${Port}: $fwResult"

# ── Update TABLET_UUID in backend .env if provided ────────────
if (-not [string]::IsNullOrWhiteSpace($TabletUuid)) {
    Set-EnvFile (Join-Path $script:BackendDir '.env') @{ TABLET_UUID = $TabletUuid } -PreserveExisting
    L "TABLET_UUID set in backend .env: $TabletUuid"
}

# ── Trigger live reconnect via API if backend is running ───────
$apiBase = "http://localhost:$($script:BackendPort)"
try {
    $body = @{ ipAddress = $BiometricDeviceIp; port = $Port; license = $License; deviceId = $DeviceId; timeoutMs = 15000 } | ConvertTo-Json
    $resp = Invoke-RestMethod -Uri "$apiBase/api/device/set-ip" -Method POST `
            -Body $body -ContentType 'application/json' -TimeoutSec 20 -ErrorAction Stop
    if ($resp.connectResult.connected) {
        Write-Host ""
        Write-Host "  FK623 connected live: $($resp.connectResult.device.deviceId ?? $BiometricDeviceIp)" -ForegroundColor Green
        L "Live reconnect succeeded"
    } else {
        Write-Host ""
        Write-Host "  Config saved. Bridge will connect on next startup." -ForegroundColor Yellow
        L "Live reconnect not available: $($resp.connectResult.error ?? 'bridge not running')"
    }
} catch {
    L "Bridge not running or not reachable - config saved, will apply on next startup" 'INFO'
}

# ── Print summary ─────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Tablet Enrolled Successfully" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Device ID     : $DeviceId"
Write-Host "  FK623 IP      : ${BiometricDeviceIp}:$Port"
Write-Host "  License       : $License"
if ($TabletUuid) { Write-Host "  Tablet UUID   : $TabletUuid" }
Write-Host "  Hostname      : $env:COMPUTERNAME"
Write-Host ""
Write-Host "  Files written:" -ForegroundColor Yellow
Write-Host "   $provFile"
Write-Host "   $($script:DeviceCfg)"
Write-Host ""
Write-Host "  Next: Run Setup (option 1) to apply, or restart the tablet." -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
L "Enrollment complete for $DeviceId"

if (-not $NoPrompt) { Read-Host "Press Enter to close" | Out-Null }
