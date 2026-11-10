#Requires -Version 5.1
# ============================================================
#  Common-EcaAfrica.ps1
#  Compatible with Windows PowerShell 5.1 AND PowerShell 7+
#  Dot-source at top of every script:
#    . "$PSScriptRoot\Common-EcaAfrica.ps1"
#
#  PS 5.1 = Windows built-in (ships with Win 8.1 / Server 2012 R2+)
#  PS 7+  = optional install via winget or MSI
#  No PS6+ exclusive syntax used (?., ??=, -Parallel, etc.)
# ============================================================
$ErrorActionPreference = 'Continue'

# Detect PS version once - other scripts can branch on $script:PSMajor
$script:PSMajor = $PSVersionTable.PSVersion.Major
$script:IsPS7   = ($script:PSMajor -ge 7)

# ── Paths ─────────────────────────────────────────────────────
$script:EcaRoot       = 'C:\Attendance_managment_system\Attendance_managment_system'
$script:RepoDir       = 'C:\Attendance_managment_system\Attendance_managment_system'
$script:BackendDir    = 'C:\Attendance_managment_system\Attendance_managment_system\backend'
$script:FrontendDir   = 'C:\Attendance_managment_system\Attendance_managment_system\frontend'
$script:FKBridgeDir   = 'C:\Attendance_managment_system\Attendance_managment_system\FKBridge'
$script:ScriptsDir    = 'C:\Attendance_managment_system\Attendance_managment_system\scripts'
$script:LogDir        = 'C:\Attendance_managment_system\Attendance_managment_system\logs'
$script:BackupDir     = 'C:\Attendance_managment_system\Attendance_managment_system\backups'
$script:ChromeProfile = 'C:\Attendance_managment_system\Attendance_managment_system\chrome-profile'
$script:ProvisionDir  = 'C:\Attendance_managment_system\Attendance_managment_system\provisioning'
$script:ConfigPath    = 'C:\Attendance_managment_system\Attendance_managment_system\scripts\config\ecaafrica.json'
$script:DeviceCfg     = 'C:\Attendance_managment_system\Attendance_managment_system\backend\data\device-config.json'
$script:KnownGoodFile = 'C:\Attendance_managment_system\Attendance_managment_system\known-good-commit.txt'

$script:RepoUrl    = 'https://github.com/Byiringiro24/Tablet_Setup.git'
$script:RepoBranch = 'Testing-Branch'

$script:BackendPort  = 5000
$script:FrontendPort = 3000
$script:DevicePort   = 5005

# ── Logging ───────────────────────────────────────────────────
function Write-Log {
    param(
        [string]$Message = '',
        [string]$Level = 'INFO',
        [string]$LogFile = ''
    )
    if ($Message -eq '') { return }
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Write-Host $line
    if ($LogFile -ne '') {
        try {
            $dir = Split-Path $LogFile -Parent
            if ($dir -and -not (Test-Path $dir)) {
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
            }
            Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
        } catch {}
    }
}

# ── Directory helpers ──────────────────────────────────────────
function Ensure-Dir {
    param([string]$Path)
    if ($Path -ne '' -and -not (Test-Path $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Ensure-EcaDirs {
    $dirs = @(
        $script:EcaRoot, $script:LogDir, $script:BackupDir,
        $script:BackendDir, $script:FrontendDir, $script:FKBridgeDir,
        $script:ScriptsDir, $script:ChromeProfile, $script:ProvisionDir,
        (Split-Path $script:ConfigPath -Parent)
    )
    foreach ($d in $dirs) { Ensure-Dir $d }
}

# ── Admin check ────────────────────────────────────────────────
function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Require-Admin {
    if (Test-IsAdmin) { return }
    Write-Host 'Restarting as Administrator...'
    Start-Process powershell.exe -Verb RunAs `
        -ArgumentList ("-NoProfile -ExecutionPolicy Bypass -File `"" + $PSCommandPath + "`"") -Wait
    exit 0
}

# ── Config ────────────────────────────────────────────────────
function Get-EcaConfig {
    $cfg = $null
    if (Test-Path $script:ConfigPath) {
        try {
            $cfg = Get-Content $script:ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        } catch {
            Write-Host "Config load failed, using defaults: $_"
        }
    }
    if ($cfg -eq $null) {
        $cfg = [pscustomobject]@{
            Git     = [pscustomobject]@{
                Repository = $script:RepoUrl
                Branch     = $script:RepoBranch
                AutoUpdate = $true
                RollbackOnFailure = $true
            }
            Runtime = [pscustomobject]@{
                BackendPort   = 5000
                FrontendPort  = 3000
                DevicePort    = 5005
                BackendHealth = '/api/health'
            }
            Device  = [pscustomobject]@{
                License                   = 1261
                DefaultBiometricDeviceIp   = '192.168.1.76'
                DefaultBiometricDevicePort = 5005
                TimeoutMs                  = 10000
            }
            Kiosk   = [pscustomobject]@{
                ChromeUrl            = 'http://localhost:3000'
                StartupDelaySeconds  = 15
            }
            Task    = [pscustomobject]@{
                Name                 = 'EcaAfrica Kiosk'
                RestartEveryMinutes  = 5
            }
        }
    }
    # Merge provisioning/device.json if present
    $prov = Join-Path $script:ProvisionDir 'device.json'
    if (Test-Path $prov) {
        try {
            $p = Get-Content $prov -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($p.Device -ne $null) {
                foreach ($prop in $p.Device.PSObject.Properties) {
                    $cfg.Device | Add-Member -NotePropertyName $prop.Name -NotePropertyValue $prop.Value -Force
                }
            }
        } catch {}
    }
    return $cfg
}

# ── Machine identity ───────────────────────────────────────────
function Get-TabletIdentity {
    try {
        $serial = (Get-CimInstance Win32_BIOS -ErrorAction Stop).SerialNumber
        $serial = $serial -replace '[^A-Za-z0-9]', ''
        if ($serial -eq '' -or $serial -match '(?i)^(Default|None|Unknown|ToBeFilledBy)') {
            $serial = (Get-CimInstance Win32_ComputerSystemProduct -ErrorAction Stop).UUID
            $serial = $serial -replace '[^A-Za-z0-9]', ''
        }
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($serial.ToUpper())
        $sha   = [System.Security.Cryptography.SHA256]::Create()
        $hash  = $sha.ComputeHash($bytes)
        $hex   = ''
        foreach ($b in $hash) { $hex += $b.ToString('x2') }
        $short = $hex.Substring(0, 12).ToUpper()
        return [pscustomobject]@{ Hostname = $env:COMPUTERNAME; Serial = $serial; DeviceId = "ECA-$short" }
    } catch {
        return [pscustomobject]@{ Hostname = $env:COMPUTERNAME; Serial = 'UNKNOWN'; DeviceId = "ECA-$env:COMPUTERNAME" }
    }
}

function Get-LocalIP {
    try {
        $addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
            Sort-Object InterfaceMetric
        if ($addrs) { return $addrs[0].IPAddress }
    } catch {}
    return $null
}

# ── Tool discovery ─────────────────────────────────────────────
function Find-Git {
    $paths = @(
        'C:\Program Files\Git\cmd\git.exe',
        'C:\Program Files\Git\bin\git.exe',
        "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe"
    )
    foreach ($p in $paths) { if (Test-Path $p) { return $p } }
    $cmd = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Find-Node {
    $paths = @(
        'C:\Program Files\nodejs\node.exe',
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )
    foreach ($p in $paths) { if (Test-Path $p) { return $p } }
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Find-Npm {
    # Try npm.cmd first (most reliable on PS5), then npm (no ext), then npm.ps1
    $candidates = @(
        'C:\Program Files\nodejs\npm.cmd'
        "$env:LOCALAPPDATA\Programs\nodejs\npm.cmd"
        'C:\Program Files\nodejs\npm'
        "$env:LOCALAPPDATA\Programs\nodejs\npm"
        'C:\Program Files\nodejs\npm.ps1'
        "$env:LOCALAPPDATA\Programs\nodejs\npm.ps1"
    )
    foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
    # Fallback: search PATH
    $cmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Find-DotNetX86 {
    $paths = @('C:\Program Files (x86)\dotnet\dotnet.exe')
    $pf86 = [System.Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    if ($pf86) { $paths += "$pf86\dotnet\dotnet.exe" }
    foreach ($p in $paths) {
        if (Test-Path $p) {
            $sdks = & $p --list-sdks 2>$null | Out-String
            # Match .NET 8, 9, 10, 11 ... (any major version >= 8)
            if ($sdks -match '\b([89]|[1-9]\d)\.\d') { return $p }
        }
    }
    return $null
}

function Find-Chrome {
    $pf86 = [System.Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    $paths = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    if ($pf86) { $paths += "$pf86\Google\Chrome\Application\chrome.exe" }
    foreach ($p in $paths) { if (Test-Path $p) { return $p } }
    return $null
}

function Find-WireGuard {
    $p = "$env:ProgramFiles\WireGuard\wireguard.exe"
    if (Test-Path $p) { return $p }
    return $null
}

# ── PATH refresh ───────────────────────────────────────────────
function Update-EnvPath {
    $m = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $u = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $m) { $m = '' }
    if (-not $u) { $u = '' }
    $env:Path = "$m;$u"
}

# ── Port checks ────────────────────────────────────────────────
function Test-PortListening {
    param([int]$Port)
    try {
        $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
        return ($conns -ne $null -and @($conns).Count -gt 0)
    } catch { return $false }
}

function Wait-ForPort {
    param([int]$Port, [int]$TimeoutSec = 90, [string]$Label = '')
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-PortListening $Port) { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

# ── HTTP health ────────────────────────────────────────────────
function Test-HttpOk {
    param([string]$Url, [int]$TimeoutSec = 8)
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
    } catch { return $false }
}

# ── Process management ─────────────────────────────────────────
function Stop-EcaProcesses {
    param([string]$LogFile = '')
    foreach ($name in @('node', 'FKBridge')) {
        $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
        if (-not $procs) { continue }
        foreach ($p in @($procs)) {
            $wmi = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction SilentlyContinue
            $cmd = if ($wmi) { $wmi.CommandLine } else { '' }
            if ($cmd -match 'EcaAfrica' -or $name -eq 'FKBridge') {
                try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
                Write-Log "Stopped $name (PID $($p.Id))" 'INFO' $LogFile
            }
        }
    }
}

# ── npm wrapper ────────────────────────────────────────────────
# npm wrapper - uses & operator directly (cmd /c breaks with quoted paths on PS5)
function Invoke-Npm {
    param([string]$Npm, [string[]]$NpmArgs, [string]$WorkDir = '.')
    if (-not $Npm -or -not (Test-Path $Npm)) {
        Write-Host "npm not found at: $Npm"
        return 1
    }
    if (-not (Test-Path $WorkDir)) {
        Write-Host "WorkDir not found: $WorkDir"
        return 1
    }
    Push-Location $WorkDir
    try {
        & $Npm @NpmArgs 2>&1 | ForEach-Object { Write-Host $_ }
        return $LASTEXITCODE
    } finally { Pop-Location }
}

# ── Firewall ───────────────────────────────────────────────────
function Ensure-FirewallRule {
    param([string]$Name, [int]$Port)
    try {
        $existing = Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue
        if (-not $existing) {
            New-NetFirewallRule -DisplayName $Name -Direction Inbound -Protocol TCP `
                -LocalPort $Port -Action Allow -Profile Any | Out-Null
            return 'created'
        }
        return 'exists'
    } catch { return 'failed' }
}

# ── Scheduled Task ─────────────────────────────────────────────
# Scheduled Task - compatible with PS 5.1 and PS 7+
# Uses powershell.exe on PS5, pwsh.exe on PS7 if available
function Register-EcaTask {
    param([string]$TaskName, [string]$ScriptPath, [int]$RestartMinutes = 5)
    $psExe = 'powershell.exe'
    if ($script:IsPS7) {
        $pwshCmd = Get-Command pwsh.exe -ErrorAction SilentlyContinue
        if ($pwshCmd) { $psExe = $pwshCmd.Source }
    }
    $action   = New-ScheduledTaskAction -Execute $psExe `
                    -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"" + $ScriptPath + "`"")
    $trigger  = New-ScheduledTaskTrigger -AtLogOn
    $interval = New-TimeSpan -Minutes $RestartMinutes
    $settings = New-ScheduledTaskSettingsSet `
                    -AllowStartIfOnBatteries `
                    -DontStopIfGoingOnBatteries `
                    -StartWhenAvailable `
                    -MultipleInstances IgnoreNew `
                    -RestartCount 5 `
                    -RestartInterval $interval
    # Run for ALL users at logon (not just the installing user) with highest privileges
    $principal = New-ScheduledTaskPrincipal `
                    -GroupId 'BUILTIN\Users' `
                    -RunLevel Highest
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force | Out-Null
    Enable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
}

# ── Git helpers ────────────────────────────────────────────────
# Set safe git timeouts - prevents hanging on slow/stalled connections
# Call once at script start. Uses per-command -c flags AND global config as fallback.
function Set-GitTimeouts {
    param([string]$Git = "")
    # Set env var to prevent git from prompting for credentials (would hang unattended)
    $env:GIT_TERMINAL_PROMPT = "0"
    $env:GIT_SSH_COMMAND = "ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=no"
    # Apply global config if git is available
    if ($Git -ne "" -and (Test-Path $Git)) {
        & $Git config --global http.lowSpeedLimit 1000   2>$null | Out-Null
        & $Git config --global http.lowSpeedTime  30     2>$null | Out-Null
        & $Git config --global http.connectTimeout 15    2>$null | Out-Null
        # Fix template dir warning if it points to a missing path
        $tplDir = & $Git config --global init.templateDir 2>$null
        if ($tplDir -ne "" -and $tplDir -ne $null -and -not (Test-Path $tplDir)) {
            New-Item -ItemType Directory -Path $tplDir -Force -ErrorAction SilentlyContinue | Out-Null
        }
    }
}

function Invoke-GitSafe {
    param([string]$Git, [string[]]$Args, [string]$WorkDir = '.', [int]$Retries = 3)
    for ($i = 1; $i -le $Retries; $i++) {
        Push-Location $WorkDir
        try {
            & $Git @Args 2>&1
            if ($LASTEXITCODE -eq 0) { return $true }
        } catch {}
        finally { Pop-Location }
        if ($i -lt $Retries) { Start-Sleep -Seconds ($i * 3) }
    }
    return $false
}

# ── Log rotation ───────────────────────────────────────────────
function Rotate-Log {
    param([string]$Path, [long]$MaxBytes = 2097152)
    if (-not (Test-Path $Path)) { return }
    if ((Get-Item $Path).Length -lt $MaxBytes) { return }
    for ($i = 4; $i -ge 0; $i--) {
        $src = "$Path.$i"
        $dst = "$Path.$($i+1)"
        if (Test-Path $src) { Move-Item $src $dst -Force -ErrorAction SilentlyContinue }
    }
    Move-Item $Path "$Path.0" -Force -ErrorAction SilentlyContinue
    New-Item $Path -ItemType File -Force | Out-Null
}

# ── winget wrapper ─────────────────────────────────────────────
function Install-WithWinget {
    param([string]$Id, [string]$Name, [string]$Arch = '')
    $wg = $null
    $wgCmd = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($wgCmd) {
        $wg = $wgCmd.Source
    } else {
        $wgPath = "$env:LOCALAPPDATA\Microsoft\WindowsApps\winget.exe"
        if (Test-Path $wgPath) { $wg = $wgPath }
    }
    if (-not $wg) {
        Write-Host "winget not available - cannot auto-install $Name. Install manually."
        return $false
    }
    $a = @('install', '--id', $Id, '--exact', '--silent',
           '--accept-package-agreements', '--accept-source-agreements')
    if ($Arch -ne '') { $a += @('--architecture', $Arch) }
    & $wg @a | Out-Null
    return ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq -1978335189)
}

# ── .env file helper ───────────────────────────────────────────
function Set-EnvFile {
    param([string]$Path, [hashtable]$Values, [switch]$PreserveExisting)
    $existing = @{}
    if ($PreserveExisting -and (Test-Path $Path)) {
        foreach ($line in (Get-Content $Path)) {
            if ($line -match '^\s*([^#=\s]+)\s*=\s*(.*)$') {
                $existing[$matches[1]] = $matches[2]
            }
        }
    }
    foreach ($k in $Values.Keys) {
        if (-not $PreserveExisting -or -not $existing.ContainsKey($k)) {
            $existing[$k] = $Values[$k]
        }
    }
    Ensure-Dir (Split-Path $Path -Parent)
    $lines = @()
    foreach ($k in ($existing.Keys | Sort-Object)) {
        $lines += "$k=$($existing[$k])"
    }
    $lines | Set-Content -LiteralPath $Path -Encoding UTF8
}

# ── Backup helper ──────────────────────────────────────────────
function Backup-Config {
    param([string]$LogFile = '')
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dest  = Join-Path $script:BackupDir $stamp
    Ensure-Dir $dest
    $files = @(
        $script:DeviceCfg,
        (Join-Path $script:BackendDir '.env'),
        (Join-Path $script:FrontendDir '.env.local'),
        $script:KnownGoodFile
    )
    foreach ($f in $files) {
        if ($f -ne $null -and (Test-Path $f)) {
            Copy-Item $f $dest -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Log "Config backed up to $dest" 'INFO' $LogFile
}
