# Server ↔ Tablet Connection Guide

**Date**: September 2026  
**Server**: `169.58.124.150` (EcaAfrica backend — `backend.ecareafrica.net`)  
**Tablets**: Any number of Windows tablets, each at a school gate

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                     EcaAfrica Server                                │
│                   169.58.124.150                                    │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  School Backend API   (backend.ecareafrica.net/api/v1)      │   │
│  │  - Authentication  POST /auth/login                         │   │
│  │  - Students        GET  /students                           │   │
│  │  - Attendance      POST /gate/logs                          │   │
│  │  - Tablet bridge   GET  /tablet-bridge/tablet-info/:uuid    │   │
│  │  - Dev password    GET  /tablet-bridge/dev-password/:uuid   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────┐                              │
│  │  WireGuard VPN (wg0)             │                              │
│  │  Interface IP: 10.0.0.1/24       │                              │
│  │  Listen port:  51820 UDP          │                              │
│  └──────────────────────────────────┘                              │
└─────────────────────────────────────────────────────────────────────┘
           │                          │
    WireGuard VPN              WireGuard VPN
    10.0.0.2 (Tablet 1)        10.0.0.3 (Tablet 2)  ...
           │                          │
┌──────────▼──────────┐    ┌──────────▼──────────┐
│   Tablet — School A │    │   Tablet — School B │
│   FK623 device LAN  │    │   FK623 device LAN  │
│   port 5000 backend │    │   port 5000 backend │
└─────────────────────┘    └─────────────────────┘
```

---

## Why Push Fails Without Correct Configuration

The tablet backend (`server.js`) pushes attendance data to the school server in two ways:

1. **School server login** — the tablet logs in with school staff credentials via `POST /api/school/login` which calls `POST /auth/login` on the server. Without a valid login, no data can be pushed.

2. **Tablet UUID registration** — every tablet must have a `TABLET_UUID` set in `backend/.env`. Without it, the server cannot identify which tablet is sending data, and `tablet-bridge` endpoints return errors.

**Root cause of "push is refusing"**: The `backend/.env` file was missing (deleted in a git cleanup commit). This meant `TABLET_UUID` was `null` and `SERVER_API_URL` had no authentication context. The fix is to recreate `.env` with the correct values for each tablet.

---

## Part 1 — Server Setup (done once)

### 1.1 WireGuard on the Server

The server must have WireGuard running with a peer entry for **every tablet**.

```bash
ssh root@169.58.124.150

# Check WireGuard is running
systemctl status wg-quick@wg0

# Show all registered tablet peers
wg show
```

For each new tablet, add it as a peer:

```bash
# Replace <TABLET_PUBLIC_KEY> and <TABLET_VPN_IP> for each tablet
wg set wg0 peer <TABLET_PUBLIC_KEY> allowed-ips <TABLET_VPN_IP>/32

# Example — Tablet 1 at School A:
wg set wg0 peer AbCdEfGh1234...= allowed-ips 10.0.0.2/32

# Example — Tablet 2 at School B:
wg set wg0 peer XyZwVuTs9876...= allowed-ips 10.0.0.3/32

# Save so peers persist on reboot
wg-quick save wg0
```

### 1.2 VPN IP Assignment Plan

| VPN IP | Role |
|--------|------|
| `10.0.0.1` | Server (169.58.124.150) |
| `10.0.0.2` | Tablet 1 — first school |
| `10.0.0.3` | Tablet 2 — second school |
| `10.0.0.4` | Tablet 3 — third school |
| `10.0.0.5+` | Additional tablets |

### 1.3 Firewall on the Server

```bash
# Allow WireGuard UDP
ufw allow 51820/udp

# Allow HTTPS (school API)
ufw allow 443/tcp

ufw reload
ufw status
```

### 1.4 Register Each Tablet in the Portal

For each tablet:
1. Log in to `https://backend.ecareafrica.net` as Super Admin
2. Go to **Hardware → Tablets → Add Tablet**
3. Fill in: school name, location, gate label
4. The portal generates a **TABLET_UUID** — save it
5. Assign the tablet its **VPN IP** (e.g. `10.0.0.2`)

---

## Part 2 — Tablet Configuration (per tablet)

Each tablet needs its own `backend/.env` file. This file is never committed to git — it stays on the tablet only.

### 2.1 The `.env` File

Location: `C:\EcaAfrica\backend\.env`

```env
PORT=5000
SERVER_API_URL=https://backend.ecareafrica.net/api/v1
TABLET_UUID=<paste UUID from Super Admin portal>
DEV_PASSWORD=admin1234
WG_SERVER_ENDPOINT=169.58.124.150:51820
VPN_ALLOWED_IPS=10.0.0.0/16
WG_DNS=1.1.1.1
```

**Fill in `TABLET_UUID`** after registering in the portal. Without it:
- Server cannot identify the tablet
- `tablet-bridge` endpoints return 404
- Dev password cannot be remotely managed
- Attendance push will be rejected

### 2.2 Device Config

Location: `C:\EcaAfrica\backend\data\device-config.json`

```json
{
  "ipAddress": "192.168.1.XX",
  "port": 5005,
  "license": 1261,
  "deviceId": "DV-KGL-01",
  "netPassword": 0,
  "protocolType": -1,
  "timeoutMs": 10000
}
```

`ipAddress` must be the IP of the FK623 biometric device on the **local school network** (not the VPN IP). This is a LAN address like `192.168.1.xx`. Update it per school.

### 2.3 Quick Way to Set Per-Tablet Config

Use `Enroll-Tablet.ps1` from the scripts folder:

```powershell
# Run as Administrator
cd C:\EcaAfrica\scripts
.\Enroll-Tablet.ps1 -BiometricDeviceIp 192.168.1.76 -DeviceId "DV-KGL-01" -TabletUuid "your-uuid-here"
```

This writes both `device-config.json` and `backend/.env` in one step.

---

## Part 3 — How the Tablet Talks to the Server

### 3.1 Connection Flow

```
Tablet boots
    │
    ├─► WireGuard tunnel starts (auto)
    │       Tablet gets VPN IP: 10.0.0.2
    │       Tunnel to server: 169.58.124.150:51820
    │
    ├─► Backend starts (node server.js)
    │       Reads TABLET_UUID from .env
    │       Polls /tablet-bridge/tablet-info/:uuid every 30s
    │       Gets: tablet name, location, dev password
    │
    ├─► FK623 device connects (auto)
    │       TCP to 192.168.1.xx:5005 (local LAN)
    │       Time sync on connect
    │
    └─► Dashboard opens in Chrome (http://localhost:3000)
            Staff logs in with school credentials
            Token stored in memory
            Attendance data pushed on each scan
```

### 3.2 Authentication — Login Required

The tablet does **not** auto-login to the school server. A staff member must log in once per session:

1. Open dashboard → sidebar → **Login** (or school auth panel)
2. Enter school staff email + password
3. Token stored in memory — valid for ~12 hours, auto-refreshed

**Without login, these features are unavailable:**
- Push attendance logs to server
- Pull students list from server
- Access dormitory/boarding data
- View approved exits

**These work without login (local only):**
- FK623 device connection
- Attendance flash screen
- Local student registration
- WireGuard VPN management

### 3.3 API Routes Used Between Tablet and Server

| Direction | Endpoint | When |
|-----------|----------|------|
| Tablet → Server | `POST /auth/login` | Staff login |
| Tablet → Server | `POST /auth/refresh` | Every 12 hours automatically |
| Tablet → Server | `POST /gate/logs` | Every attendance scan |
| Tablet → Server | `GET /students` | Pull students list |
| Tablet → Server | `GET /boarding/dormitories` | Pull dormitory list |
| Server → Tablet | `GET /tablet-bridge/tablet-info/:uuid` | Polled every 30s |
| Server → Tablet | `GET /tablet-bridge/dev-password/:uuid` | Polled every 30s |

### 3.4 Network Traffic Path

```
FK623 device  ──LAN──►  Tablet backend (port 5000)
                                │
                         WireGuard VPN
                         (UDP 51820)
                                │
                     ┌──────────▼──────────┐
                     │  Server             │
                     │  169.58.124.150     │
                     │  backend.ecareafrica│
                     └─────────────────────┘
```

The tablet **never** connects directly to the server over the public internet. All traffic goes through the WireGuard tunnel on `10.0.0.0/16`.

---

## Part 4 — Multiple Tablets, One Server

Each tablet is independent — same code, different configuration.

### 4.1 What Is Different Per Tablet

| Item | Location | Unique Per Tablet |
|------|----------|-------------------|
| `TABLET_UUID` | `backend/.env` | Yes — from portal |
| `ipAddress` (FK623) | `backend/data/device-config.json` | Yes — local LAN IP |
| `deviceId` | `backend/data/device-config.json` | Yes — e.g. `DV-KGL-01` |
| VPN IP | WireGuard tunnel (set by wizard) | Yes — e.g. `10.0.0.2`, `10.0.0.3` |
| WireGuard private/public key | `backend/data/wireguard-*.key` | Yes — generated per tablet |

### 4.2 What Is the Same on Every Tablet

| Item | Value |
|------|-------|
| `SERVER_API_URL` | `https://backend.ecareafrica.net/api/v1` |
| `WG_SERVER_ENDPOINT` | `169.58.124.150:51820` |
| `DEV_PASSWORD` | `admin1234` (can be changed remotely via portal) |
| App code | Identical — pulled from `Testing-Branch` |

### 4.3 Deploying a Second Tablet

1. Run `SETUP-NEW-TABLET.bat` on the new tablet (identical to the first)
2. Register it in the portal → get a new `TABLET_UUID`
3. Assign it the next VPN IP (e.g. `10.0.0.3`)
4. Open WireGuard wizard → generate keys → send public key to Super Admin
5. Super Admin adds it as a peer on the server:
   ```bash
   wg set wg0 peer <NEW_TABLET_PUBLIC_KEY> allowed-ips 10.0.0.3/32
   wg-quick save wg0
   ```
6. Tablet wizard Step 3: paste server public key + IP `10.0.0.3` → activate
7. Run `Enroll-Tablet.ps1` to set the correct FK623 IP and UUID for this school

---

## Part 5 — Troubleshooting Connection Issues

### "Push is refusing / server rejects attendance"

| Check | Command | Expected |
|-------|---------|----------|
| Is WireGuard tunnel up? | `ipconfig \| findstr 10.0` | Shows `10.0.0.x` |
| Can tablet ping server? | `ping 10.0.0.1` | Replies < 300ms |
| Is `.env` present? | `type C:\EcaAfrica\backend\.env` | Shows all keys |
| Is TABLET_UUID set? | Check `.env` | Not blank |
| Is staff logged in? | `http://localhost:5000/api/school/me` | `loggedIn: true` |
| Is server reachable? | `curl https://backend.ecareafrica.net/api/v1/health` | `200 OK` |

### "tabletUuid: null in /api/health"

The `TABLET_UUID` is missing from `backend/.env`. Fix:
```powershell
# Edit the .env file
notepad C:\EcaAfrica\backend\.env
# Set: TABLET_UUID=<your-uuid>
# Save, then:
Restart-Service EcaAfrica-Bridge
```

### "loggedIn: false"

No staff member has logged in. Open the dashboard and use the Login panel with valid school staff credentials.

### "WireGuard tunnel active but server still unreachable"

The server firewall may be blocking. On the server:
```bash
ufw allow 51820/udp
ufw allow from 10.0.0.0/16 to any
ufw reload
wg show   # confirm tablet peer shows recent handshake
```

### "FK623 device not connecting"

The `ipAddress` in `device-config.json` is wrong for this school's network. Update via:
- Dashboard → Developer modal → update IP, or
- `Enroll-Tablet.ps1 -BiometricDeviceIp 192.168.1.XX`

---

## Part 6 — Summary: What Must Be Done for Each New Tablet

```
ON THE SERVER (Super Admin, SSH):
  1. wg set wg0 peer <TABLET_PUBLIC_KEY> allowed-ips <TABLET_VPN_IP>/32
  2. wg-quick save wg0
  3. Register tablet in portal → get TABLET_UUID

ON THE TABLET (Technician, Run-Setup.cmd):
  1. Run SETUP-NEW-TABLET.bat (or scripts\Run-Setup.cmd option 1)
  2. Run Enroll-Tablet.ps1 -BiometricDeviceIp <FK623_IP> -TabletUuid <UUID>
  3. Open WireGuard wizard → generate keys → paste server info → activate
  4. Test ping → green ✓
  5. Staff logs in via dashboard → attendance push works
```

---

*EcaAfrica Biometric Attendance System — Server-Tablet Connection Guide*  
*September 2026*
