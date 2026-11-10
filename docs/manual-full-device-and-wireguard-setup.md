# Manual Full Device and WireGuard Setup

**Date**: September 2026  
**Purpose**: Complete manual setup of a Windows tablet for EcaAfrica — no scripts, every command typed by hand  
**Install path**: `C:\EcaAfrica`  
**Time needed**: 20–30 minutes

> Run all commands in **PowerShell as Administrator**.  
> Open Start Menu → search "PowerShell" → right-click → "Run as Administrator"

---

## Part 1 — Install Required Software

### 1.1 Node.js

Download from: `https://nodejs.org/dist/v20.19.0/node-v20.19.0-x64.msi`

Run the installer. Accept all defaults. Ensure "Add to PATH" is checked.

Verify:
```powershell
node --version
npm --version
```
Expected: `v20.x.x` and `10.x.x` or higher.

---

### 1.2 .NET 8 Desktop Runtime x86

> The FK623 biometric device DLL is 32-bit. You MUST install the **x86** version.

Download Runtime x86: `https://aka.ms/dotnet/8.0/windowsdesktop-runtime-win-x86.exe`

Download SDK x86 (needed to compile FKBridge):  
`https://aka.ms/dotnet/8.0/dotnet-sdk-win-x86.exe`

Run both installers with defaults.

Verify:
```powershell
& "C:\Program Files (x86)\dotnet\dotnet.exe" --list-runtimes
& "C:\Program Files (x86)\dotnet\dotnet.exe" --list-sdks
```
Both must show lines containing `8.0`.

---

### 1.3 Git

Download: `https://github.com/git-for-windows/git/releases/download/v2.47.0.windows.1/Git-2.47.0-64-bit.exe`

Run installer, accept all defaults.

Verify:
```powershell
git --version
```

---

### 1.4 WireGuard

Download: `https://download.wireguard.com/windows-client/wireguard-installer.exe`

Run installer, accept UAC prompt.

Verify:
```powershell
Test-Path "C:\Program Files\WireGuard\wireguard.exe"
Test-Path "C:\Program Files\WireGuard\wg.exe"
```
Both must return `True`.

---

### 1.5 Google Chrome

Download: `https://dl.google.com/chrome/install/ChromeSetup.exe`

Run installer.

Verify:
```powershell
Test-Path "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

---

### 1.6 Reload PATH after installs

```powershell
$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
```

---

## Part 2 — Get the Code

### 2.1 Clone from GitHub

```powershell
git clone --branch Testing-Branch https://github.com/Byiringiro24/Tablet_Setup.git C:\EcaAfrica
```

If `C:\EcaAfrica` already exists, remove it first:
```powershell
Remove-Item C:\EcaAfrica -Recurse -Force
git clone --branch Testing-Branch https://github.com/Byiringiro24/Tablet_Setup.git C:\EcaAfrica
```

### 2.2 Create required folders

```powershell
New-Item -ItemType Directory -Force -Path C:\EcaAfrica\logs
New-Item -ItemType Directory -Force -Path C:\EcaAfrica\tools
New-Item -ItemType Directory -Force -Path C:\EcaAfrica\backups
New-Item -ItemType Directory -Force -Path C:\EcaAfrica\backend\data
New-Item -ItemType Directory -Force -Path C:\EcaAfrica\backend\cache\photos\all-rooms
```

---

## Part 3 — Write Configuration Files

### 3.1 Backend environment file (`backend\.env`)

```powershell
@"
PORT=5000
SERVER_API_URL=https://backend.ecareafrica.net/api/v1
TABLET_UUID=
DEV_PASSWORD=admin1234
WG_SERVER_ENDPOINT=169.58.124.150:51820
VPN_ALLOWED_IPS=10.0.0.0/16
WG_DNS=1.1.1.1
"@ | Set-Content C:\EcaAfrica\backend\.env -Encoding UTF8
```

> Fill `TABLET_UUID=` after registering in the Super Admin portal.

---

### 3.2 Device config (`backend\data\device-config.json`)

D:\Projectts 2026\Latest EcaAfrica 7-8-2026\Tablet Setup

> Replace `192.168.1.76` with the FK623 device's actual IP on this school's network.

---

### 3.3 Frontend environment file (`frontend\.env.local`)

```powershell
"NEXT_PUBLIC_API_URL=http://localhost:5000" | Set-Content C:\EcaAfrica\frontend\.env.local -Encoding UTF8
```

---

### 3.4 Create empty students file

```powershell
if (-not (Test-Path C:\EcaAfrica\backend\data\students.json)) {
    "[]" | Set-Content C:\EcaAfrica\backend\data\students.json -Encoding UTF8
}
```

---

## Part 4 — Build

### 4.1 Backend dependencies

```powershell
cd C:\EcaAfrica\backend
npm install
```

---

### 4.2 Build FKBridge (.NET x86)

```powershell
$dotnet = "C:\Program Files (x86)\dotnet\dotnet.exe"
cd C:\EcaAfrica\FKBridge
& $dotnet restore FKBridge.csproj
& $dotnet build FKBridge.csproj -c Release --no-restore
```

Confirm:
```powershell
Test-Path C:\EcaAfrica\FKBridge\bin\Release\net8.0\FKBridge.exe
```
Must return `True`.

---

### 4.3 Frontend build

```powershell
cd C:\EcaAfrica\frontend
npm install
npm run build
```

Build takes 2–3 minutes. Confirm:
```powershell
Test-Path C:\EcaAfrica\frontend\.next
```

---

## Part 5 — Manual Test Run

### 5.1 Start backend (PowerShell window 1 — as Administrator)

```powershell
cd C:\EcaAfrica\backend
node server.js
```

Expected output:
```
FK Attendance Backend running on http://localhost:5000
FK bridge ready
Auto-connect: connected successfully to 192.168.1.76
[Time Sync] Device clock synced to tablet time: ...
```

### 5.2 Start frontend (PowerShell window 2)

```powershell
cd C:\EcaAfrica\frontend
npm run start
```

Expected output:
```
▲ Next.js
- Local: http://localhost:3000
✓ Ready
```

### 5.3 Health check

```powershell
Invoke-RestMethod http://localhost:5000/api/health | Select-Object status, bridgeReady
```

Expected: `status: ok`, `bridgeReady: True`

### 5.4 Open dashboard

Open Chrome → **http://localhost:3000**

Confirm device shows as **Online** (green badge) and attendance logs load.

If everything works, press `Ctrl+C` in both windows, then continue to Part 6.

---

## Part 6 — Auto-Start Using Windows Task Scheduler

Windows Task Scheduler runs both services automatically at every logon as **highest privileges** — no manual start needed after reboot.

> No third-party tools (NSSM, etc.) are required. Task Scheduler is built into every Windows installation.

---

### 6.1 Create the backend startup script

```powershell
@'
# EcaAfrica Backend Startup Script
$LOG = "C:\EcaAfrica\logs\backend.log"
$ERR = "C:\EcaAfrica\logs\backend-err.log"
if (-not (Test-Path C:\EcaAfrica\logs)) { New-Item -ItemType Directory -Path C:\EcaAfrica\logs -Force | Out-Null }

$nodeExe  = (Get-Command node.exe -ErrorAction SilentlyContinue)?.Source
if (-not $nodeExe) { $nodeExe = "C:\Program Files\nodejs\node.exe" }
$serverJs = "C:\EcaAfrica\backend\server.js"

if (-not (Test-Path $serverJs)) { Add-Content $ERR "[$(Get-Date)] server.js not found at $serverJs"; exit 1 }

# Load .env into environment
$envFile = "C:\EcaAfrica\backend\.env"
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*([^#=\s]+)\s*=\s*(.*)$') {
            [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
        }
    }
}

# Kill any stale node processes from EcaAfrica
Get-Process node -ErrorAction SilentlyContinue | Where-Object {
    (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -EA SilentlyContinue).CommandLine -match 'EcaAfrica'
} | Stop-Process -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 2

# Start backend — redirect stdout and stderr to log files
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName               = $nodeExe
$psi.Arguments              = "`"$serverJs`""
$psi.WorkingDirectory       = "C:\EcaAfrica\backend"
$psi.UseShellExecute        = $false
$psi.CreateNoWindow         = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError  = $true

$proc = [System.Diagnostics.Process]::Start($psi)
$proc.add_OutputDataReceived({ param($s,$e); if ($e.Data) { Add-Content -LiteralPath $LOG -Value $e.Data -EA SilentlyContinue } })
$proc.add_ErrorDataReceived({  param($s,$e); if ($e.Data) { Add-Content -LiteralPath $ERR -Value $e.Data -EA SilentlyContinue } })
$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()

Add-Content $LOG "[$(Get-Date)] Backend started. PID=$($proc.Id)"

# Keep the script alive while the process runs (Task Scheduler needs this)
$proc.WaitForExit()
Add-Content $LOG "[$(Get-Date)] Backend process exited with code $($proc.ExitCode)"
'@ | Set-Content C:\EcaAfrica\tools\start-backend.ps1 -Encoding UTF8
```

---

### 6.2 Create the frontend startup script

```powershell
@'
# EcaAfrica Frontend Startup Script
$LOG = "C:\EcaAfrica\logs\frontend.log"
$ERR = "C:\EcaAfrica\logs\frontend-err.log"
if (-not (Test-Path C:\EcaAfrica\logs)) { New-Item -ItemType Directory -Path C:\EcaAfrica\logs -Force | Out-Null }

# Wait for backend to be ready (up to 90s)
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
    try {
        $r = Invoke-WebRequest http://localhost:5000/api/health -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { break }
    } catch { Start-Sleep -Seconds 3 }
}

$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue)?.Source
if (-not $nodeExe) { $nodeExe = "C:\Program Files\nodejs\node.exe" }
$nextBin = "C:\EcaAfrica\frontend\node_modules\next\dist\bin\next"

# Rebuild .next if missing
if (-not (Test-Path C:\EcaAfrica\frontend\.next)) {
    Add-Content $LOG "[$(Get-Date)] .next missing — rebuilding frontend"
    $npmExe = (Get-Command npm -ErrorAction SilentlyContinue)?.Source ?? "C:\Program Files\nodejs\npm.cmd"
    & $npmExe install --prefix C:\EcaAfrica\frontend 2>&1 | Out-Null
    & $npmExe run build --prefix C:\EcaAfrica\frontend 2>&1 | Out-Null
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName               = $nodeExe
$psi.Arguments              = "`"$nextBin`" start --port 3000"
$psi.WorkingDirectory       = "C:\EcaAfrica\frontend"
$psi.UseShellExecute        = $false
$psi.CreateNoWindow         = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError  = $true
$psi.EnvironmentVariables["PORT"] = "3000"
$psi.EnvironmentVariables["NODE_ENV"] = "production"

$proc = [System.Diagnostics.Process]::Start($psi)
$proc.add_OutputDataReceived({ param($s,$e); if ($e.Data) { Add-Content -LiteralPath $LOG -Value $e.Data -EA SilentlyContinue } })
$proc.add_ErrorDataReceived({  param($s,$e); if ($e.Data) { Add-Content -LiteralPath $ERR -Value $e.Data -EA SilentlyContinue } })
$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()

Add-Content $LOG "[$(Get-Date)] Frontend started. PID=$($proc.Id)"
$proc.WaitForExit()
Add-Content $LOG "[$(Get-Date)] Frontend process exited with code $($proc.ExitCode)"
'@ | Set-Content C:\EcaAfrica\tools\start-frontend.ps1 -Encoding UTF8
```

---

### 6.3 Register backend as a scheduled task

```powershell
$psExe    = "powershell.exe"
$backendScript = "C:\EcaAfrica\tools\start-backend.ps1"

$action  = New-ScheduledTaskAction -Execute $psExe `
               -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$backendScript`""

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
                -AllowStartIfOnBatteries `
                -DontStopIfGoingOnBatteries `
                -StartWhenAvailable `
                -RestartCount 5 `
                -RestartInterval (New-TimeSpan -Minutes 1) `
                -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal `
                -GroupId "BUILTIN\Users" `
                -RunLevel Highest

Register-ScheduledTask "EcaAfrica-Backend" `
    -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description "Starts EcaAfrica backend (Node.js) on logon with highest privileges" `
    -Force
```

---

### 6.4 Register frontend as a scheduled task

```powershell
$psExe         = "powershell.exe"
$frontendScript = "C:\EcaAfrica\tools\start-frontend.ps1"

$action  = New-ScheduledTaskAction -Execute $psExe `
               -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$frontendScript`""

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
                -AllowStartIfOnBatteries `
                -DontStopIfGoingOnBatteries `
                -StartWhenAvailable `
                -RestartCount 5 `
                -RestartInterval (New-TimeSpan -Minutes 1) `
                -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal `
                -GroupId "BUILTIN\Users" `
                -RunLevel Highest

Register-ScheduledTask "EcaAfrica-Frontend" `
    -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description "Starts EcaAfrica frontend (Next.js) on logon with highest privileges" `
    -Force
```

---

### 6.5 Start both tasks immediately (test without rebooting)

```powershell
Start-ScheduledTask "EcaAfrica-Backend"
Start-Sleep -Seconds 15
Start-ScheduledTask "EcaAfrica-Frontend"
```

---

### 6.6 Verify tasks are running

```powershell
Get-ScheduledTask "EcaAfrica-Backend"  | Select-Object TaskName, State
Get-ScheduledTask "EcaAfrica-Frontend" | Select-Object TaskName, State
```

Both must show `State: Running`.

Check health:
```powershell
Start-Sleep -Seconds 10
Invoke-RestMethod http://localhost:5000/api/health | Select-Object status, bridgeReady
```

---

### 6.7 Task management commands (for future use)

```powershell
# Start tasks manually
Start-ScheduledTask "EcaAfrica-Backend"
Start-ScheduledTask "EcaAfrica-Frontend"

# Stop tasks (kills the running process)
Stop-ScheduledTask "EcaAfrica-Backend"
Stop-ScheduledTask "EcaAfrica-Frontend"

# Remove tasks completely
Unregister-ScheduledTask "EcaAfrica-Backend"  -Confirm:$false
Unregister-ScheduledTask "EcaAfrica-Frontend" -Confirm:$false

# View task status
Get-ScheduledTask "EcaAfrica-Backend", "EcaAfrica-Frontend"

# View logs
Get-Content C:\EcaAfrica\logs\backend.log     -Tail 50
Get-Content C:\EcaAfrica\logs\backend-err.log -Tail 50
Get-Content C:\EcaAfrica\logs\frontend.log    -Tail 50
Get-Content C:\EcaAfrica\logs\frontend-err.log -Tail 50
```

---

## Part 7 — System Hardening

### 7.1 Suppress UAC (kiosk tablet only)

```powershell
$uacKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"
Set-ItemProperty $uacKey EnableLUA                  0 -Type DWord
Set-ItemProperty $uacKey ConsentPromptBehaviorAdmin 0 -Type DWord
Set-ItemProperty $uacKey PromptOnSecureDesktop      0 -Type DWord
```

### 7.2 Disable Fast Startup

```powershell
Set-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power" HiberbootEnabled 0 -Type DWord
```

### 7.3 Extend service startup timeout

```powershell
Set-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control" ServicesPipeTimeout 120000 -Type DWord
```

### 7.4 Allow PowerShell scripts

```powershell
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope LocalMachine -Force
```

### 7.5 WireGuard Manager auto-start

```powershell
Set-Service WireGuardManager -StartupType Automatic
sc.exe failure WireGuardManager reset= 86400 actions= restart/3000/restart/5000/restart/10000
Start-Service WireGuardManager -ErrorAction SilentlyContinue
```

### 7.6 Firewall rule for FK623 device

```powershell
New-NetFirewallRule -DisplayName "EcaAfrica Device TCP 5005" `
    -Direction Inbound -Protocol TCP -LocalPort 5005 -Action Allow -Profile Any
```

### 7.7 Boot health-check task (safety net)

```powershell
@'
Start-Sleep -Seconds 90
$tasks = @('EcaAfrica-Backend','EcaAfrica-Frontend')
foreach ($t in $tasks) {
    $task = Get-ScheduledTask $t -ErrorAction SilentlyContinue
    if ($task -and $task.State -ne 'Running') { Start-ScheduledTask $t -ErrorAction SilentlyContinue }
}
$wg = Get-Service 'WireGuardTunnel$EcareAfrica' -ErrorAction SilentlyContinue
if ($wg -and $wg.Status -ne 'Running') { Start-Service 'WireGuardTunnel$EcareAfrica' -ErrorAction SilentlyContinue }
'@ | Set-Content C:\EcaAfrica\tools\boot-check.ps1 -Encoding UTF8

$action    = New-ScheduledTaskAction -Execute "powershell.exe" `
                 -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"C:\EcaAfrica\tools\boot-check.ps1`""
$trigger1  = New-ScheduledTaskTrigger -AtStartup
$trigger2  = New-ScheduledTaskTrigger -AtLogOn
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
                 -StartWhenAvailable -RunOnlyIfNetworkAvailable:$false -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask "EcaAfrica-Boot-Ensure" `
    -Action $action -Trigger @($trigger1, $trigger2) `
    -Settings $settings -Principal $principal `
    -Description "Ensures EcaAfrica tasks and WireGuard start on every boot" -Force
```

---

## Part 8 — WireGuard VPN Setup

### 8.1 Generate keys using the dashboard

Open Chrome → **http://localhost:3000** → sidebar → **WireGuard VPN** → password `admin1234` → click **Generate Keys**.

The wizard generates real Curve25519 keys and saves them to:
- `C:\EcaAfrica\backend\data\wireguard-private.key` — stays on tablet, never share
- `C:\EcaAfrica\backend\data\wireguard-public.key` — copy this, send to Super Admin

**Copy the public key** using the Copy button in the wizard.

---

### 8.2 Add tablet as peer on the server (Super Admin — SSH)

```bash
ssh root@169.58.124.150

# Replace with tablet's actual public key and assigned VPN IP
wg set wg0 peer <TABLET_PUBLIC_KEY> allowed-ips <TABLET_VPN_IP>/32

# Example:
wg set wg0 peer x9zmQduWk7C2q47KYLwH3Xm/o+2aJZzlVKikrJt6I1M= allowed-ips 10.0.0.2/32

# Save so it persists after server reboot
wg-quick save wg0

# Confirm peer added — share the server public key with the technician
wg show
cat /etc/wireguard/server_public.key
```

---

### 8.3 Configure tunnel using the dashboard

Back in the WireGuard wizard Step 3:
1. Paste **Server Public Key** (from `cat /etc/wireguard/server_public.key`)
2. **Server Endpoint** is pre-filled: `169.58.124.150:51820`
3. **Tablet VPN IP**: the IP assigned by Super Admin (e.g. `10.0.0.2`)
4. Click **Save & Activate Tunnel**

---

### 8.4 Write the WireGuard config manually (alternative to wizard)

If not using the wizard, write the config directly:

```powershell
# Read the private key that was generated
$privateKey = Get-Content C:\EcaAfrica\backend\data\wireguard-private.key

@"
[Interface]
PrivateKey = $privateKey
Address = 10.0.0.2/24
DNS = 1.1.1.1

[Peer]
PublicKey = <SERVER_PUBLIC_KEY>
AllowedIPs = 10.0.0.0/16
Endpoint = 169.58.124.150:51820
PersistentKeepalive = 25
"@ | Set-Content "C:\ProgramData\WireGuard\EcareAfrica.conf" -Encoding UTF8
```

Install and start the tunnel:

```powershell
# Requires elevation — runs via Start-Process RunAs
Start-Process -FilePath "C:\Program Files\WireGuard\wireguard.exe" `
    -ArgumentList "/installtunnelservice","C:\ProgramData\WireGuard\EcareAfrica.conf" `
    -Verb RunAs -Wait
```

Set tunnel auto-start on boot:

```powershell
sc.exe config "WireGuardTunnel`$EcareAfrica" start= auto
sc.exe failure "WireGuardTunnel`$EcareAfrica" reset= 86400 actions= restart/5000/restart/10000/restart/30000
```

---

### 8.5 Verify tunnel

```powershell
# VPN IP should appear as 10.0.0.x
ipconfig | Select-String "10\.0\."

# Ping the server through the VPN
ping -n 4 10.0.0.1
```

Expected: `Reply from 10.0.0.1: bytes=32 time=XXXms TTL=64`

Use **Ping Test (Step 5)** in the WireGuard wizard for a visual confirmation.

---

### 8.6 Remove tunnel (if needed)

```powershell
Start-Process -FilePath "C:\Program Files\WireGuard\wireguard.exe" `
    -ArgumentList "/uninstalltunnelservice","EcareAfrica" `
    -Verb RunAs -Wait
```

---

## Part 9 — Chrome Kiosk Auto-Open on Login

Chrome opens the dashboard automatically 30 seconds after every login.

### 9.1 Register Chrome kiosk task

```powershell
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$chromeArgs = "--kiosk http://localhost:3000 --disable-infobars --no-first-run --disable-session-crashed-bubble --user-data-dir=`"C:\EcaAfrica\chrome-profile`""

$action   = New-ScheduledTaskAction -Execute $chromePath -Argument $chromeArgs
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = "PT30S"   # wait 30s for services to start first

$settings = New-ScheduledTaskSettingsSet `
                -ExecutionTimeLimit (New-TimeSpan -Hours 12) `
                -MultipleInstances IgnoreNew `
                -AllowStartIfOnBatteries `
                -DontStopIfGoingOnBatteries

$principal = New-ScheduledTaskPrincipal -GroupId "BUILTIN\Users" -RunLevel Highest

New-Item -ItemType Directory -Force -Path C:\EcaAfrica\chrome-profile | Out-Null

Register-ScheduledTask "EcaAfrica-OpenDashboard" `
    -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description "Opens EcaAfrica attendance dashboard in Chrome 30s after login" -Force
```

### 9.2 Verify

```powershell
Get-ScheduledTask "EcaAfrica-OpenDashboard" | Select-Object TaskName, State
```

### 9.3 Remove Chrome task

```powershell
Unregister-ScheduledTask "EcaAfrica-OpenDashboard" -Confirm:$false
```

---

## Part 10 — Set Tablet UUID After Portal Registration

```powershell
# Replace YOUR-UUID-HERE with the UUID from the Super Admin portal
$uuid    = "YOUR-UUID-HERE"
$envFile = "C:\EcaAfrica\backend\.env"
$content = Get-Content $envFile -Raw
$content = $content -replace "TABLET_UUID=.*", "TABLET_UUID=$uuid"
Set-Content $envFile $content -Encoding UTF8

# Restart the backend task to apply the change
Stop-ScheduledTask "EcaAfrica-Backend"  -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Start-ScheduledTask "EcaAfrica-Backend"
```

---

## Part 11 — Update Code

```powershell
# Stop tasks
Stop-ScheduledTask "EcaAfrica-Frontend" -ErrorAction SilentlyContinue
Stop-ScheduledTask "EcaAfrica-Backend"  -ErrorAction SilentlyContinue
Get-Process FKBridge -ErrorAction SilentlyContinue | Stop-Process -Force

# Pull latest
cd C:\EcaAfrica
git pull origin Testing-Branch

# Rebuild
$dotnet = "C:\Program Files (x86)\dotnet\dotnet.exe"
cd C:\EcaAfrica\backend  ; npm install
cd C:\EcaAfrica\FKBridge ; & $dotnet build FKBridge.csproj -c Release
cd C:\EcaAfrica\frontend ; npm install ; npm run build

# Restart
Start-ScheduledTask "EcaAfrica-Backend"
Start-Sleep -Seconds 10
Start-ScheduledTask "EcaAfrica-Frontend"
```

---

## Part 12 — Full Checklist

```
INSTALLED SOFTWARE
[ ] Node.js v20+   — node --version
[ ] .NET 8 x86     — C:\Program Files (x86)\dotnet\dotnet.exe --list-sdks
[ ] Git            — git --version
[ ] WireGuard      — C:\Program Files\WireGuard\wireguard.exe exists
[ ] Chrome         — C:\Program Files\Google\Chrome\Application\chrome.exe exists

CODE & BUILD
[ ] C:\EcaAfrica\backend\server.js exists
[ ] C:\EcaAfrica\FKBridge\bin\Release\net8.0\FKBridge.exe exists
[ ] C:\EcaAfrica\frontend\.next exists

CONFIG FILES
[ ] C:\EcaAfrica\backend\.env exists (TABLET_UUID filled)
[ ] C:\EcaAfrica\backend\data\device-config.json exists (correct FK623 IP)
[ ] C:\EcaAfrica\frontend\.env.local exists

SCHEDULED TASKS
[ ] EcaAfrica-Backend       — Get-ScheduledTask EcaAfrica-Backend  → Running
[ ] EcaAfrica-Frontend      — Get-ScheduledTask EcaAfrica-Frontend → Running
[ ] EcaAfrica-OpenDashboard — Get-ScheduledTask EcaAfrica-OpenDashboard → Ready
[ ] EcaAfrica-Boot-Ensure   — Get-ScheduledTask EcaAfrica-Boot-Ensure  → Ready

WIREGUARD
[ ] WireGuard Manager       — Get-Service WireGuardManager → Running
[ ] Tunnel service          — sc.exe query WireGuardTunnel$EcareAfrica → RUNNING
[ ] Ping server VPN         — ping 10.0.0.1 → Reply from 10.0.0.1

HEALTH
[ ] http://localhost:5000/api/health → status:ok, bridgeReady:true
[ ] http://localhost:3000            → dashboard loads, device shows Online
[ ] Reboot tablet → Chrome opens dashboard after 30s
```

---

## Passwords and Keys Reference

| Item | Value | Where |
|------|-------|-------|
| Developer modal password | `admin1234` | Dashboard → Developer / WireGuard VPN |
| WireGuard private key | Never share | `C:\EcaAfrica\backend\data\wireguard-private.key` |
| WireGuard public key | Send to Super Admin | `C:\EcaAfrica\backend\data\wireguard-public.key` |
| Tablet UUID | From Super Admin portal | `C:\EcaAfrica\backend\.env` → `TABLET_UUID=` |
| FK623 device IP | Local school network | `C:\EcaAfrica\backend\data\device-config.json` |
| School Server URL | Can change via Developer modal | `C:\EcaAfrica\backend\.env` → `SERVER_API_URL=` |

---

*EcaAfrica Biometric Attendance System — Manual Full Setup Guide*  
*Task Scheduler edition — no third-party tools required*  
*September 2026*
