@echo off
setlocal EnableExtensions EnableDelayedExpansion
pushd "%~dp0"
title EcaAfrica Tablet Setup

:: ============================================================
::  EcaAfrica Run-Setup.cmd
::  Works with PowerShell 5.1 (windows built-in) OR PS 7+
::  Must be run as Administrator.
:: ============================================================

:: Admin check
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Administrator privileges required.
    echo  Right-click this file and choose "Run as administrator".
    echo.
    pause
    exit /b 1
)

:: Auto-detect PowerShell — prefer powershell.exe (5.1), fall back to pwsh.exe (7+)
set "PS="
where powershell.exe >nul 2>&1 && set "PS=powershell.exe"
if "%PS%"=="" (
    where pwsh.exe >nul 2>&1 && set "PS=pwsh.exe"
)
if "%PS%"=="" (
    echo  ERROR: No PowerShell found. Install PowerShell 5.1 or 7+.
    pause
    exit /b 1
)

set "PS_ARGS=-NoLogo -NoProfile -ExecutionPolicy Bypass"
set "SCRIPTS=%~dp0"
set "LOG=C:\EcaAfrica\logs"
if not exist "%LOG%" mkdir "%LOG%" 2>nul

:MENU
cls
echo.
echo  ============================================================
echo   EcaAfrica Tablet Setup  ^|  %DATE%  %TIME%
echo  ============================================================
echo.
echo   [1]  Full Install       -- Fresh install on a new tablet
echo   [2]  Start Services     -- Start backend / frontend / kiosk
echo   [3]  Repair             -- Fix broken dependencies / rebuild
echo   [4]  Enroll Tablet      -- Set this tablet's device ID and FK623 IP
echo   [5]  Health Check       -- Show status of all components
echo   [6]  Update             -- Pull latest code and rebuild
echo   [7]  View Logs          -- Show recent log output
echo   [8]  Restart Tablet     -- Reboot to test full auto-start
echo   [9]  Exit
echo.
set /p "C=  Select option: "

if "%C%"=="1" goto :INSTALL
if "%C%"=="2" goto :START
if "%C%"=="3" goto :REPAIR
if "%C%"=="4" goto :ENROLL
if "%C%"=="5" goto :HEALTH
if "%C%"=="6" goto :UPDATE
if "%C%"=="7" goto :LOGS
if "%C%"=="8" goto :REBOOT
if "%C%"=="9" exit /b 0
echo  Invalid option. && pause && goto :MENU

:INSTALL
echo.
echo  Running full install...
%PS% -File "%SCRIPTS%Setup-EcaAfrica.ps1"
echo.
echo  Install complete. Exit code: %errorlevel%
pause
goto :MENU

:START
echo.
echo  Starting EcaAfrica services...
%PS% -WindowStyle Hidden -File "%SCRIPTS%Start-EcaAfrica.ps1"
echo  Start script launched.
pause
goto :MENU

:REPAIR
echo.
echo  Running repair...
%PS% -File "%SCRIPTS%Repair-EcaAfrica.ps1"
echo.
pause
goto :MENU

:ENROLL
echo.
echo  Tablet enrollment wizard...
echo.
echo   [A]  Auto-scan network for FK623 device (recommended)
echo   [M]  Enter IP manually
echo.
set /p "EM=  Select [A/M]: "

if /i "%EM%"=="A" (
    echo.
    echo  Scanning local network for FK623 devices on port 5005...
    echo  This may take up to 30 seconds.
    echo.
    %PS% -File "%SCRIPTS%Enroll-Tablet.ps1" -Scan
    echo.
    echo  Enrollment complete. Run option [1] to apply, or device will connect automatically.
    pause
    goto :MENU
)

echo.
set /p "IP=  FK623 biometric device IP address (e.g. 192.168.1.76): "
set /p "ID=  Custom device ID [leave blank to auto-generate from hardware]: "
if "%IP%"=="" (
    echo  IP address is required.
    pause
    goto :MENU
)
if "%ID%"=="" (
    %PS% -File "%SCRIPTS%Enroll-Tablet.ps1" -BiometricDeviceIp "%IP%"
) else (
    %PS% -File "%SCRIPTS%Enroll-Tablet.ps1" -BiometricDeviceIp "%IP%" -DeviceId "%ID%"
)
echo.
echo  Enrollment saved. Device will connect automatically.
pause
goto :MENU

:HEALTH
echo.
%PS% -File "%SCRIPTS%Repair-EcaAfrica.ps1" -HealthOnly
echo.
pause
goto :MENU

:UPDATE
echo.
echo  Pulling latest code and rebuilding...
%PS% -File "%SCRIPTS%Start-EcaAfrica.ps1" -ForceUpdate
echo.
pause
goto :MENU

:LOGS
cls
echo.
echo  ============================================================
echo   Recent Logs
echo  ============================================================
for %%F in (setup repair startup) do (
    if exist "C:\EcaAfrica\logs\%%F.log" (
        echo.
        echo  --- %%F.log (last 30 lines) ---
        %PS% -Command "Get-Content 'C:\EcaAfrica\logs\%%F.log' -Tail 30 | Write-Host"
    )
)
echo.
pause
goto :MENU

:REBOOT
echo.
echo  Rebooting in 15 seconds to test auto-start...
shutdown /r /t 15 /c "EcaAfrica: testing kiosk auto-start after reboot"
pause
goto :MENU
