@echo off
:: ============================================================
:: EcaAfrica Tablet Bridge — Quick Start
:: Run this once after cloning on a new PC/laptop.
:: Double-click this file to start both backend and frontend.
:: ============================================================

title EcaAfrica Bridge Launcher

echo.
echo  =========================================
echo   EcaAfrica FK623 Attendance Bridge
echo  =========================================
echo.

:: Check Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed.
    echo Please install Node.js from https://nodejs.org ^(LTS version^)
    echo Then run this file again.
    pause
    exit /b 1
)

:: Check .NET Runtime for FKBridge.exe
where dotnet >nul 2>&1
if errorlevel 1 (
    echo [WARNING] .NET Runtime not found.
    echo FKBridge.exe requires .NET 8 Runtime.
    echo Download from: https://dotnet.microsoft.com/download/dotnet/8.0
    echo ^(Download the ".NET Runtime" for Windows x64^)
    echo.
    echo The bridge will still try to start - if FK devices fail to connect,
    echo install .NET 8 Runtime and restart.
    echo.
)

:: Install backend dependencies if needed
if not exist "backend\node_modules\express\package.json" (
    echo [1/3] Installing backend dependencies...
    cd backend
    call npm install
    cd ..
    echo Backend dependencies installed.
) else (
    echo [1/3] Backend dependencies: OK
)

:: Install frontend dependencies if needed
if not exist "frontend\node_modules\next\package.json" (
    echo [2/3] Installing frontend dependencies...
    cd frontend
    call npm install
    cd ..
    echo Frontend dependencies installed.
) else (
    echo [2/3] Frontend dependencies: OK
)

:: Create backend .env if it doesn't exist
if not exist "backend\.env" (
    echo [3/3] Creating backend .env from template...
    copy "backend\.env.example" "backend\.env" >nul 2>&1
    if errorlevel 1 (
        echo # EcaAfrica Bridge Configuration > backend\.env
        echo DEVICE_IP=192.168.1.101 >> backend\.env
        echo DEVICE_PORT=5005 >> backend\.env
        echo DEVICE_LICENSE=1261 >> backend\.env
        echo SERVER_API_URL=https://backend.ecareafrica.net/api/v1 >> backend\.env
        echo WG_SERVER_ENDPOINT=169.58.124.150:51820 >> backend\.env
        echo VPN_ALLOWED_IPS=10.0.0.0/16 >> backend\.env
        echo WG_TUNNEL_NAME=EcareAfrica >> backend\.env
        echo WG_DNS=1.1.1.1 >> backend\.env
    )
    echo .env created. Edit backend\.env to set your device IP if needed.
) else (
    echo [3/3] Backend .env: OK
)

echo.
echo  Starting services...
echo  ─────────────────────────────────────────
echo  Backend:  http://localhost:5000
echo  Frontend: http://localhost:3000
echo  ─────────────────────────────────────────
echo  Press Ctrl+C in each window to stop.
echo.

:: Start backend in a new window
start "EcaAfrica Backend (port 5000)" cmd /k "cd /d %~dp0backend && npm run dev"

:: Wait 3 seconds for backend to start before opening frontend
timeout /t 3 /nobreak >nul

:: Start frontend in a new window
start "EcaAfrica Frontend (port 3000)" cmd /k "cd /d %~dp0frontend && npm run dev"

:: Wait 5 more seconds then open browser
timeout /t 5 /nobreak >nul
start http://localhost:3000

echo.
echo  Both services are starting in separate windows.
echo  Browser opening at http://localhost:3000
echo.
pause
