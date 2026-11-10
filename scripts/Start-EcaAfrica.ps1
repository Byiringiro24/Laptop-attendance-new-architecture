# ============================================================
#  Start-EcaAfrica.ps1
#  Runtime startup, auto-update, rollback, and watchdog.
#
#  Called by:
#   - Scheduled Task "EcaAfrica Kiosk" at every logon (hidden)
#   - Run-Setup.cmd option [2] and [6]
#
#  Flow:
#   1. Kill any stale EcaAfrica node/FKBridge processes
#   2. Git fetch - detect new commits
#   3. If update available: backup ΓåÆ pull ΓåÆ npm install ΓåÆ build ΓåÆ verify
#      On build failure: rollback to known-good commit
#   4. Start FKBridge (hidden)
#   5. Start backend (node server.js, hidden) - wait up to 60s
#   6. Start frontend (npm start, hidden) - wait up to 90s
#   7. Launch Chrome in kiosk mode
#   8. Log final health summary
# ============================================================

param(
    [switch]$ForceUpdate,   # Force pull + rebuild even if no new commit
    [switch]$NoChrome       # Skip Chrome launch (useful for headless testing)
)

$ErrorActionPreference = 'Continue'
. "$PSScriptRoot\Common-EcaAfrica.ps1"

$LOG = Join-Path $script:LogDir 'startup.log'
Ensure-EcaDirs
Rotate-Log $LOG

function L([string]$m, [string]$lv = 'INFO') { Write-Log $m $lv $LOG }

L "============================================================"
L "EcaAfrica startup  |  $env:COMPUTERNAME  |  $env:USERNAME"
L "============================================================"

# ΓöÇΓöÇ Prevent duplicate startup instances ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
$myPid = $PID
$dupes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.ProcessId -ne $myPid -and
        $_.Name -match 'powershell' -and
        $_.CommandLine -match 'Start-EcaAfrica'
    }
foreach ($d in $dupes) {
    try { Stop-Process -Id $d.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
    L "Stopped duplicate startup PID $($d.ProcessId)"
}

# ΓöÇΓöÇ Load config and find tools ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
$cfg    = Get-EcaConfig
Update-EnvPath
$git    = Find-Git
$node   = Find-Node
$npm    = Find-Npm
$dotnet = Find-DotNetX86
$chrome = Find-Chrome

L "git=$git  node=$node  npm=$npm  dotnet=$dotnet  chrome=$chrome"
Set-GitTimeouts $git  # prevent hanging on stalled connections

# ΓöÇΓöÇ Kill stale processes ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
Stop-EcaProcesses $LOG
Start-Sleep -Seconds 2

# ΓöÇΓöÇ Git update check ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
$repo       = $script:RepoDir
$updateDone = $false

if ($git -and (Test-Path (Join-Path $repo '.git'))) {
    $currentCommit = (& $git -C $repo rev-parse HEAD 2>$null).Trim()
    L "Current commit: $currentCommit"

    # Fetch - 3 retries with back-off
    $fetched = Invoke-GitSafe $git @('fetch','origin',$script:RepoBranch,'--prune') $repo 3
    if ($fetched) {
        $remoteCommit = (& $git -C $repo rev-parse "origin/$($script:RepoBranch)" 2>$null).Trim()
        L "Remote commit : $remoteCommit"
        $needUpdate = ($currentCommit -ne $remoteCommit) -or $ForceUpdate
    } else {
        L "Git fetch failed - continuing with current version" 'WARN'
        $needUpdate = $ForceUpdate
    }

    if ($needUpdate) {
        L "Update detected - backing up config and pulling"
        Backup-Config $LOG

        $pulled = $false
        try {
            Push-Location $repo
            & $git checkout $script:RepoBranch 2>&1 | ForEach-Object { L $_ }
            & $git reset --hard "origin/$($script:RepoBranch)" 2>&1 | ForEach-Object { L $_ }
            $pulled = ($LASTEXITCODE -eq 0)
            Pop-Location
        } catch {
            try { Pop-Location } catch {}
            L "Git pull failed: $_" 'ERROR'
        }

        if ($pulled) {
            # Copy updated components into runtime dirs
            foreach ($comp in @('backend','frontend','FKBridge')) {
                $src = Join-Path $repo $comp
                $dst = Join-Path $script:EcaRoot $comp
                if (Test-Path $src) {
                    robocopy $src $dst /E /XD node_modules .next /XF .env .env.local /NFL /NDL /NJH /NJS /NP | Out-Null
                }
            }
            # Also keep the runtime scripts in sync with the repo's scripts/
            $scriptsSrc = Join-Path $repo 'scripts'
            if (Test-Path $scriptsSrc) {
                robocopy $scriptsSrc $script:ScriptsDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
                L "Scripts updated from repo"
            }

            # npm install backend
            if ($npm) {
                L "npm install backend"
                $rc = Invoke-Npm $npm @('install','--legacy-peer-deps','--no-audit','--no-fund') $script:BackendDir
                if ($rc -ne 0) { L "Backend npm install returned $rc" 'WARN' }
            }

            # npm install + build frontend
            if ($npm) {
                L "npm install frontend"
                $rc = Invoke-Npm $npm @('install','--legacy-peer-deps','--no-audit','--no-fund') $script:FrontendDir
                if ($rc -ne 0) { L "Frontend npm install returned $rc" 'WARN' }

                L "npm run build frontend"
                $rc = Invoke-Npm $npm @('run','build') $script:FrontendDir
                if ($rc -ne 0) {
                    L "Frontend build FAILED - rolling back" 'ERROR'
                    # Rollback
                    $known = if (Test-Path $script:KnownGoodFile) { (Get-Content $script:KnownGoodFile -Raw).Trim() } else { '' }
                    if ($known -and $git) {
                        Push-Location $repo
                        & $git reset --hard $known 2>&1 | ForEach-Object { L $_ }
                        Pop-Location
                        # Restore runtime from rolled-back repo
                        foreach ($comp in @('backend','frontend','FKBridge')) {
                            $src = Join-Path $repo $comp
                            $dst = Join-Path $script:EcaRoot $comp
                            if (Test-Path $src) {
                                robocopy $src $dst /E /XD node_modules .next /XF .env .env.local /NFL /NDL /NJH /NJS /NP | Out-Null
                            }
                        }
                        if ($npm) { Invoke-Npm $npm @('install','--legacy-peer-deps','--no-audit','--no-fund') $script:FrontendDir | Out-Null }
                        if ($npm) { Invoke-Npm $npm @('run','build') $script:FrontendDir | Out-Null }
                        L "Rolled back to known-good commit: $known" 'WARN'
                    }
                }
            }

            # Build FKBridge
            if ($dotnet) {
                $proj = Get-ChildItem $script:FKBridgeDir -Filter '*.csproj' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($proj) {
                    Push-Location $proj.DirectoryName
                    try {
                        & $dotnet restore $proj.FullName 2>$null | Out-Null
                        & $dotnet build   $proj.FullName -c Release --no-restore 2>$null | Out-Null
                        if ($LASTEXITCODE -eq 0) { L "FKBridge rebuild OK" }
                        else { L "FKBridge rebuild returned $LASTEXITCODE" 'WARN' }
                    } catch { L "FKBridge rebuild error: $_" 'WARN' }
                    finally { Pop-Location }
                }
            }

            # Save new known-good
            $newCommit = (& $git -C $repo rev-parse HEAD 2>$null).Trim()
            Set-Content $script:KnownGoodFile $newCommit -Encoding ASCII
            L "Update complete. New known-good: $newCommit"
            $updateDone = $true
        }
    } else {
        L "No update needed"
    }
} else {
    # Repo not cloned yet or git unavailable - try to clone now
    if ($git -and -not (Test-Path (Join-Path $repo '.git'))) {
        L "Repo not found - attempting clone now"
        Ensure-Dir (Split-Path $repo -Parent)
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            $env:GIT_TERMINAL_PROMPT = '0'
            & $git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 -c http.connectTimeout=15 `
                clone --branch $script:RepoBranch --single-branch --depth 1 $script:RepoUrl $repo 2>&1 |
                ForEach-Object { L $_ }
            if (Test-Path (Join-Path $repo '.git')) {
                $head = (& $git -C $repo rev-parse HEAD 2>$null).Trim()
                Set-Content $script:KnownGoodFile $head -Encoding ASCII
                L "Clone complete: $head"
                break
            }
            if ($attempt -lt 3) { L "Clone attempt $attempt failed - retry in 5s" 'WARN'; Start-Sleep -Seconds 5 }
        }
        if (-not (Test-Path (Join-Path $repo '.git'))) {
            L "Clone failed - continuing with existing files in runtime dirs" 'WARN'
        }
    } else {
        L "Git not found - update check skipped" 'WARN'
    }
}
# ΓöÇΓöÇ Ensure runtime dirs have content ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
foreach ($comp in @('backend','frontend','FKBridge')) {
    $dst = Join-Path $script:EcaRoot $comp
    $src = Join-Path $script:RepoDir $comp
    if (-not (Test-Path $dst) -or -not (Get-ChildItem $dst -ErrorAction SilentlyContinue)) {
        if (Test-Path $src) {
            Ensure-Dir $dst
            robocopy $src $dst /E /XD node_modules .next /XF .env .env.local /NFL /NDL /NJH /NJS /NP | Out-Null
            L "Populated $comp from repo"
        }
    }
}

# FKBridge is managed by server.js internally.
# Do NOT start it from here - it would cause a port 5005 conflict when backend also spawns it.
# Verify the binary exists so we can log a useful warning if it is missing.
$fkExe = Join-Path $script:FKBridgeDir 'bin\Release\net8.0\FKBridge.exe'
if (-not (Test-Path $fkExe)) {
    L "FKBridge.exe not found at $fkExe - backend will try to build it on first run" 'WARN'
}
# ΓöÇΓöÇ Start backend ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
$serverJs = Join-Path $script:BackendDir 'server.js'
if ($node -and (Test-Path $serverJs)) {
    if (-not (Test-PortListening $script:BackendPort)) {
        $beLog    = Join-Path $script:LogDir 'backend.log'
        $beErrLog = Join-Path $script:LogDir 'backend-err.log'
        L "Starting backend (port $($script:BackendPort))"
        try {
            # Load .env into the child process environment before spawning
            $beEnv = [System.Diagnostics.ProcessStartInfo]::new()
            $beEnvPath = Join-Path $script:BackendDir '.env'
            $envVars = @{ NODE_ENV = 'production'; PORT = [string]$script:BackendPort }
            if (Test-Path $beEnvPath) {
                foreach ($line in (Get-Content $beEnvPath)) {
                    if ($line -match '^\s*([^#=\s]+)\s*=\s*(.*)$') {
                        $envVars[$matches[1]] = $matches[2].Trim('\"')
                    }
                }
            }
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName               = $node
            $psi.Arguments              = "`"$serverJs`""
            $psi.WorkingDirectory       = $script:BackendDir
            $psi.UseShellExecute        = $false
            $psi.CreateNoWindow         = $true
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError  = $true
            foreach ($k in $envVars.Keys) { $psi.EnvironmentVariables[$k] = $envVars[$k] }
            $beProc = [System.Diagnostics.Process]::Start($psi)
            # Register handlers BEFORE Begin* to prevent 4KB pipe buffer deadlock
            $_beLog = Join-Path $script:LogDir 'backend.log'
            $_beErr = Join-Path $script:LogDir 'backend-err.log'
            $beProc.add_OutputDataReceived({ param($s,$e); if ($e.Data) { try { Add-Content -LiteralPath $_beLog -Value $e.Data -EA SilentlyContinue } catch {} } })
            $beProc.add_ErrorDataReceived({  param($s,$e); if ($e.Data) { try { Add-Content -LiteralPath $_beErr -Value $e.Data -EA SilentlyContinue } catch {} } })
            $beProc.BeginOutputReadLine()
            $beProc.BeginErrorReadLine()
        } catch { L "Backend start failed: $_" 'WARN' }

        # Wait up to 90s - backend spawns FKBridge which needs extra startup time
        if (Wait-ForPort $script:BackendPort 90 'backend') {
            L "Backend ready on port $($script:BackendPort)"
        } else {
            # Check if process is at least running even if port not yet open
            $nodeProcs = Get-Process -Name 'node' -ErrorAction SilentlyContinue
            if ($nodeProcs) {
                L "Backend process running but port not open yet - giving 30s more"
                if (Wait-ForPort $script:BackendPort 30 'backend-retry') {
                    L "Backend ready on port $($script:BackendPort)"
                } else {
                    L "Backend port $($script:BackendPort) still not open - check $beErrLog" 'WARN'
                }
            } else {
                L "Backend process not found - it may have crashed. Check $beErrLog" 'WARN'
            }
        }
    } else {
        L "Backend already running on port $($script:BackendPort)"
    }
} else {
    L "Node or server.js missing - backend skipped" 'WARN'
}

# ΓöÇΓöÇ Start frontend ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
if ($npm -and (Test-Path (Join-Path $script:FrontendDir 'package.json'))) {
    if (-not (Test-PortListening $script:FrontendPort)) {
        # Rebuild .next if missing
        if (-not (Test-Path (Join-Path $script:FrontendDir '.next'))) {
            L "Frontend build output missing - rebuilding"
            Invoke-Npm $npm @('install','--legacy-peer-deps','--no-audit','--no-fund') $script:FrontendDir | Out-Null
            Invoke-Npm $npm @('run','build') $script:FrontendDir | Out-Null
        }
        $feLog    = Join-Path $script:LogDir 'frontend.log'
        $feErrLog = Join-Path $script:LogDir 'frontend-err.log'
        L "Starting frontend (port $($script:FrontendPort))"
        try {
            # Use node directly with next binary ΓÇö avoids npm.cmd Start-Process issues
            $nextBin = Join-Path $script:FrontendDir 'node_modules\.bin\next.cmd'
            if (-not (Test-Path $nextBin)) {
                $nextBin = Join-Path $script:FrontendDir 'node_modules\.bin\next'
            }
            # Decide: use production start if .next build exists, else dev mode
            $hasBuilt = Test-Path (Join-Path $script:FrontendDir '.next')
            $feCmd    = if ($hasBuilt) { 'start' } else { 'dev' }
            L "Frontend mode: $feCmd  (built=$hasBuilt)"
            $feEnvPath = Join-Path $script:FrontendDir '.env.local'
            $feEnvVars = @{ PORT = [string]$script:FrontendPort; NODE_ENV = if ($hasBuilt) { 'production' } else { 'development' } }
            if (Test-Path $feEnvPath) {
                foreach ($envLine in (Get-Content $feEnvPath)) {
                    if ($envLine -match '^\s*([^#=\s]+)\s*=\s*(.*)$') { $feEnvVars[$matches[1]] = $matches[2] }
                }
            }
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            if (Test-Path $nextBin) {
                $psi.FileName   = $node
                $psi.Arguments  = "`"$nextBin`" $feCmd --port $($script:FrontendPort)"
            } else {
                # Fallback: use npm start directly via cmd
                $psi.FileName   = 'cmd.exe'
                $psi.Arguments  = "/c `"`"$npm`"`" run $feCmd"
            }
            $psi.WorkingDirectory       = $script:FrontendDir
            $psi.UseShellExecute        = $false
            $psi.CreateNoWindow         = $true
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError  = $true
            foreach ($k in $feEnvVars.Keys) { $psi.EnvironmentVariables[$k] = $feEnvVars[$k] }
            $feProc = [System.Diagnostics.Process]::Start($psi)
            # Register handlers BEFORE Begin* to prevent 4KB pipe buffer deadlock
            $_feLog = Join-Path $script:LogDir 'frontend.log'
            $_feErr = Join-Path $script:LogDir 'frontend-err.log'
            $feProc.add_OutputDataReceived({ param($s,$e); if ($e.Data) { try { Add-Content -LiteralPath $_feLog -Value $e.Data -EA SilentlyContinue } catch {} } })
            $feProc.add_ErrorDataReceived({  param($s,$e); if ($e.Data) { try { Add-Content -LiteralPath $_feErr -Value $e.Data -EA SilentlyContinue } catch {} } })
            $feProc.BeginOutputReadLine()
            $feProc.BeginErrorReadLine()
        } catch { L "Frontend start failed: $_" 'WARN' }

        # Next.js dev first compile takes 2-3 min on slow tablets; production start ~10s
        $feWaitSec = if ($hasBuilt) { 60 } else { 180 }
        if (Wait-ForPort $script:FrontendPort $feWaitSec 'frontend') {
            L "Frontend ready on port $($script:FrontendPort)"
        } else {
            L "Frontend not on port $($script:FrontendPort) after ${feWaitSec}s - check $feErrLog" 'WARN'
        }
    } else {
        L "Frontend already running on port $($script:FrontendPort)"
    }
} else {
    L "npm or frontend package.json missing - frontend skipped" 'WARN'
}

# ΓöÇΓöÇ Wait before Chrome ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
$delay = [int]$cfg.Kiosk.StartupDelaySeconds
L "Waiting ${delay}s before launching Chrome kiosk"
Start-Sleep -Seconds $delay

# ΓöÇΓöÇ Launch Chrome kiosk ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
if ($chrome -and -not $NoChrome) {
    Ensure-Dir $script:ChromeProfile
    $chromeArgs = @(
        '--kiosk'
        '--no-first-run'
        '--no-default-browser-check'
        '--disable-session-crashed-bubble'
        '--disable-infobars'
        '--disable-translate'
        '--disable-extensions'
        "--user-data-dir=`"$($script:ChromeProfile)`""
        $cfg.Kiosk.ChromeUrl
    )
    L "Launching Chrome kiosk ΓåÆ $($cfg.Kiosk.ChromeUrl)"
    try {
        Start-Process -FilePath $chrome -ArgumentList $chromeArgs -WindowStyle Maximized
    } catch { L "Chrome launch failed: $_" 'WARN' }
} elseif (-not $chrome) {
    L "Chrome not found - kiosk skipped" 'WARN'
}

# ΓöÇΓöÇ Health summary ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
Start-Sleep -Seconds 5
$beOk = (Test-PortListening $script:BackendPort) -and (Test-HttpOk "http://localhost:$($script:BackendPort)/api/health")
$feOk = Test-PortListening $script:FrontendPort
$fkOk = [bool](Get-Process -Name 'FKBridge' -ErrorAction SilentlyContinue) -or $beOk  # backend running means bridge is up
$wgSvc = Get-Service -Name 'WireGuardTunnel*' -ErrorAction SilentlyContinue | Select-Object -First 1
$wgOk = ($wgSvc -and $wgSvc.Status -eq 'Running')
$crOk = [bool](Get-Process -Name 'chrome' -ErrorAction SilentlyContinue)

L "============================================================"
L "Health: Backend=$beOk  Frontend=$feOk  FKBridge=$fkOk  WireGuard=$wgOk  Chrome=$crOk"
L "============================================================"

if ($beOk -and $feOk -and $crOk) {
    L "ALL SERVICES HEALTHY - startup complete"
} else {
    L "Some services pending. Run Repair (option 3) if issues persist." 'WARN'
}
