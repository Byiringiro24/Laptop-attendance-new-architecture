# EcaAfrica Tablet Bridge — How to Run Locally

This guide explains how to run the Windows laptop bridge on any school laptop.
The bridge connects the FK623 biometric devices on the school LAN to the EcaAfrica server over WireGuard VPN.

---

## What runs on the laptop

| Component | Folder | Port | What it does |
|---|---|---|---|
| **Backend (bridge)** | `backend/` | 5000 | Node.js server. Talks to FK623 devices via SDK. Communicates with school server over VPN. |
| **Frontend (UI)** | `frontend/` | 3000 | Next.js dashboard. Shows device status, logs, attendance. Runs in browser on the laptop. |
| **FKBridge.exe** | `FKBridge/` | — | C# process. Wraps FK623 SDK DLL. Started automatically by the backend. |

---

## Requirements

- Windows 10 or 11 (64-bit)
- **Node.js 18 or newer** — download from https://nodejs.org
- FK623 biometric device connected to the **same LAN** as the laptop (Ethernet or WiFi)
- WireGuard VPN installed (for school server communication)

Check your Node.js version:
```
node --version
```
If it shows `v18.x.x` or higher, you are ready.

---

## Step 1 — Configure the backend `.env`

Open `backend/.env` in Notepad and fill in your values:

```env
# FK623 Biometric Device — LAN IP and port
DEVICE_IP=192.168.1.101        # ← Change to your FK623 device IP
DEVICE_PORT=5005               # ← Usually 5005 (default FK623 port)
DEVICE_LICENSE=1261            # ← License number on the sticker on the device

# School Server
SERVER_API_URL=https://staging.ecareafrica.net/api/v1  # ← Your server URL

# WireGuard VPN
WG_SERVER_ENDPOINT=169.58.124.150:51820
VPN_ALLOWED_IPS=10.0.0.0/16
WG_TUNNEL_NAME=EcareAfrica
WG_DNS=1.1.1.1

# Tablet identity — set by the registration script, or manually:
TABLET_UUID=         # ← Paste the UUID from Super Admin → Hardware → Tablets
DEV_PASSWORD=admin1234  # ← Bridge security password (set in Super Admin UI)
```

**How to find your FK623 IP:**
- Check your router's DHCP table
- Or use the FK623 device's built-in menu (hold button to show IP)
- Default is usually `192.168.1.76` or `192.168.1.101`

---

## Step 2 — Install dependencies (first time only)

Open **Command Prompt** or **PowerShell** in the `Tablet Setup` folder.

Install backend:
```
cd backend
npm install
cd ..
```

Install frontend:
```
cd frontend
npm install
cd ..
```

---

## Step 3 — Run the backend

Open a **new Command Prompt window** in the `backend/` folder:

```
cd "D:\Projectts 2026\Latest EcaAfrica 7-8-2026 - Copy\EcaAfrica_Active_Implementation\Tablet Setup\backend"
npm run dev
```

You should see:
```
FK Attendance Backend running on http://localhost:5000
[bridge-mgr] Starting bridges for 2 device(s)...
[bridge:Testing] connected ✓ (192.168.1.101)
```

If you see `connected ✓` — the FK623 device is reachable. Leave this window open.

**Common startup messages:**
| Message | Meaning |
|---|---|
| `connected ✓` | FK623 is online and responding |
| `Device not reachable` | FK623 IP is wrong or device is off |
| `FK_LoadGeneralLogData failed: -3` | No new logs (normal, not an error) |
| `FK_LoadGeneralLogData failed: -8` | Device busy — retrying automatically |
| `Bridge process not ready` | FKBridge.exe starting — wait a few seconds |

---

## Step 4 — Run the frontend

Open a **second Command Prompt window** in the `frontend/` folder:

```
cd "D:\Projectts 2026\Latest EcaAfrica 7-8-2026 - Copy\EcaAfrica_Active_Implementation\Tablet Setup\frontend"
npm run dev
```

You should see:
```
▲ Next.js 16.x.x
- Local:   http://localhost:3000
✓ Ready in 2.2s
```

Then open your browser and go to: **http://localhost:3000**

---

## Step 5 — Register devices (first time only)

If you have multiple FK623 devices connected to this laptop:

1. Open `http://localhost:3000` in the browser
2. Click **Device Management** in the sidebar
3. Click **Add Device** for each FK623 unit
4. Fill in:
   - **Name**: e.g. "Testing" or "Main Gate"
   - **IP Address**: FK623 LAN IP (e.g. `192.168.1.101`)
   - **Port**: `5005`
   - **License Number**: from the sticker on the device
5. Click **Save** — the bridge will auto-connect

Then copy the **UUID** shown on each device card (the grey text under the device name) and paste it into the **Super Admin → Hardware → Devices** edit form on the server.

---

## Step 6 — Connect WireGuard VPN

For the laptop to communicate with the school server, WireGuard must be running.

1. Open **WireGuard** app on Windows
2. Click **Activate** on the `EcareAfrica` tunnel
3. The VPN IP assigned to this laptop (e.g. `10.0.0.2`) must match what's in Super Admin → Hardware → Tablets

Verify VPN is working:
```
ping 10.0.0.1
```
If you get replies, the VPN is active.

---

## Daily use — quick start

Once everything is set up, just run these two commands each time you start the laptop:

**Terminal 1 — backend:**
```
cd "D:\...\Tablet Setup\backend"
npm run dev
```

**Terminal 2 — frontend:**
```
cd "D:\...\Tablet Setup\frontend"
npm run dev
```

Then open `http://localhost:3000`.

---

## Troubleshooting

### "Device not reachable"
- Check the FK623 is powered on and on the same network
- Check `DEVICE_IP` in `backend/.env` is correct
- Try pinging the device: `ping 192.168.1.101`

### "FK_LoadGeneralLogData failed: -8"
- The device is busy or just connected — the bridge retries automatically
- Wait 10–15 seconds for the first successful pull

### "FKBridge.exe not found"
- Check `FKBridge/FKBridge.exe` exists in the project folder
- If missing, the C# bridge needs to be compiled: open `FKBridge/FKBridge.sln` in Visual Studio and build it

### "Module not found" / "Cannot find module"
- Run `npm install` again in both `backend/` and `frontend/`

### Push students not working from server
- Check WireGuard VPN is active (`ping 10.0.0.1`)
- Check `DEV_PASSWORD` in `backend/.env` matches what super admin set on the server
- The bridge password auto-updates from server every 30 seconds once VPN is active

### Frontend won't load
- Make sure the backend is running first on port 5000
- Check `frontend/.env.local` has `NEXT_PUBLIC_API_URL=http://localhost:5000`

---

## File structure

```
Tablet Setup/
├── backend/
│   ├── server.js          Main Node.js bridge server (port 5000)
│   ├── device-bridge.js   Per-device FK623 bridge manager
│   ├── .env               Configuration (edit this per laptop)
│   ├── data/
│   │   ├── devices-list.json    Registered FK623 devices (auto-managed)
│   │   ├── device-config.json   Single-device config (legacy)
│   │   └── students.json        Local student cache
│   └── package.json
├── frontend/
│   ├── app/               Next.js pages
│   ├── components/        UI components
│   ├── .env.local         Frontend config (do not change)
│   └── package.json
├── FKBridge/
│   ├── FKBridge.exe       FK623 SDK wrapper (auto-started by backend)
│   └── FK623Attend.dll    FK623 device SDK library
└── HOW-TO-RUN-LOCALLY.md  This file
```

---

## Ports summary

| Port | Service | Access |
|---|---|---|
| 5000 | Backend bridge API | Laptop only (localhost) |
| 3000 | Frontend dashboard | Browser on laptop |
| 5005 | FK623 device TCP | LAN only (school network) |
| 51820 | WireGuard VPN | Internet (to server) |
