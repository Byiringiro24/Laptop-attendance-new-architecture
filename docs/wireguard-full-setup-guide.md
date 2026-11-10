# WireGuard VPN — Full Setup Guide

**Project**: EcaAfrica Biometric Attendance System  
**Date**: August 7, 2026  
**Server**: `root@169.58.124.150`  
**Tunnel name**: `EcareAfrica`  
**VPN subnet**: `10.0.0.0/24`

---

## Overview — What This Does

This VPN tunnel connects each Windows tablet (running in a school) back to the central EcaAfrica server over the internet. Once active, the tablet can securely send attendance scans to `https://backend.ecareafrica.net/api/v1` through an encrypted WireGuard tunnel, even from behind school firewalls or NAT.

```
┌─────────────────────────────┐          Encrypted WireGuard          ┌──────────────────────────┐
│   Windows Tablet (School)   │ ◄────────── UDP 51820 ─────────────► │  EcaAfrica Server        │
│   VPN IP : 10.0.0.x/24      │                                        │  169.58.124.150          │
│   Node.js backend :5000      │                                        │  VPN IP: 10.0.0.1/24     │
│   FK623 biometric device     │                                        │  backend.ecareafrica.net │
└─────────────────────────────┘                                        └──────────────────────────┘
```

---

## Part 1 — Server Setup (done ONCE by DevOps / Super Admin with SSH access)

These steps are done directly on the server via SSH. They are not in the Super Admin web UI — they require terminal access to the Linux server.

### 1.1 SSH into the server

```bash
ssh root@169.58.124.150
```

### 1.2 Install WireGuard

```bash
apt update && apt install -y wireguard
```

### 1.3 Generate the server key pair

```bash
cd /etc/wireguard

# Generate private key (keep secret — never share)
wg genkey | tee server_private.key | wg pubkey > server_public.key

# Lock down permissions
chmod 600 server_private.key

# Print both keys — you will need the public key for every tablet
cat server_private.key    # → keep this secret
cat server_public.key     # → this is what tablets need (copy it)
```

### 1.4 Create the server WireGuard config

```bash
nano /etc/wireguard/wg0.conf
```

Paste this — replace `<SERVER_PRIVATE_KEY>` with the content of `server_private.key`:

```ini
[Interface]
Address    = 10.0.0.1/24
ListenPort = 51820
PrivateKey = <SERVER_PRIVATE_KEY>

# Enable IP forwarding so tablets can reach backend.ecareafrica.net through the VPN
PostUp   = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE
```

> **Note**: Replace `eth0` with the actual internet-facing interface. Run `ip route | grep default` to find it.

### 1.5 Enable IP forwarding

```bash
echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.conf
sysctl -p
```

### 1.6 Open firewall port

```bash
ufw allow 51820/udp
ufw reload
```

### 1.7 Start WireGuard and enable on boot

```bash
systemctl enable wg-quick@wg0
systemctl start wg-quick@wg0
systemctl status wg-quick@wg0
```

Expected output: `Active: active (running)`

---

## Part 2 — What Super Admin Does in the Web Portal (per tablet)

Every time a new tablet is deployed to a school, the Super Admin does the following in the EcaAfrica web portal. These steps do **not** require SSH.

### Step A — Register the tablet in the portal

1. Log in to the EcaAfrica Super Admin portal
2. Navigate to **Hardware → Tablets → Add Tablet**
3. Fill in: School name, location, device label
4. The portal generates a **Tablet UUID** — copy it
5. Assign a **VPN IP** to this tablet (e.g. `10.0.0.2` for the first tablet, `10.0.0.3` for the second, etc.)

Keep a record:

| Tablet | School | VPN IP | Tablet UUID |
|--------|--------|--------|-------------|
| DV-KGL-01 | KIGALI Main Gate | 10.0.0.2 | `<generated>` |
| DV-KGL-02 | KIGALI Side Gate | 10.0.0.3 | `<generated>` |

### Step B — Get the tablet's public key

When the on-site technician sets up the tablet (Part 3 below), they will give you the **tablet's public key**. It looks like:

```
gbHhDpRrpbqObBL3Z8idBmuYLJsMAnoTXfy+jg/kWDI=
```

### Step C — Add the tablet as a WireGuard peer on the server

SSH into the server and run (replace values with the tablet's real key and assigned VPN IP):

```bash
# Add the tablet peer (this takes effect immediately — no restart needed)
wg set wg0 peer <TABLET_PUBLIC_KEY> allowed-ips <TABLET_VPN_IP>/32

# Example for tablet DV-KGL-01:
wg set wg0 peer gbHhDpRrpbqObBL3Z8idBmuYLJsMAnoTXfy+jg/kWDI= allowed-ips 10.0.0.2/32

# Save so it survives reboots
wg-quick save wg0
```

### Step D — Confirm the peer was added

```bash
wg show
```

You should see the new peer listed under the interface.

### Step E — Communicate back to the technician

Tell the on-site technician:
- The **server's public key** (from `cat /etc/wireguard/server_public.key`)
- The **VPN IP** assigned to the tablet (e.g. `10.0.0.2`)
- The **Tablet UUID** from the portal

---

## Part 3 — Tablet Setup (done on-site by technician, using the frontend Developer panel)

The technician sits at the tablet, opens a browser to `http://localhost:3000`, and uses the built-in **WireGuard VPN** wizard in the sidebar.

### Step 1 — Install WireGuard

1. In the sidebar, hover to reveal it, then click **WireGuard VPN** (shield icon at the bottom)
2. The wizard opens at **Step 1 — Install**
3. If WireGuard is not installed, click **Download WireGuard for Windows** — it opens `wireguard.com/install/`
4. Run the installer, accept the UAC prompt
5. Come back and click **Check Again** — the wizard will show "WireGuard is installed"
6. Click **WireGuard is installed → Next**

### Step 2 — Generate Keys

1. Click **Generate Keys**
2. The backend calls `wg genkey` then pipes the result to `wg pubkey` via stdin
3. You see:
   - **Private Key** — shown masked, saved to `backend/data/wireguard-private.key` (never leaves the tablet)
   - **Public Key** — shown in full with a **Copy** button
4. Click **Copy** to copy the public key to clipboard
5. **Send the public key to the Super Admin** (via WhatsApp, email, or the portal)
6. The wizard also shows the exact server command the Super Admin needs to run (Step C above)

### Step 3 — Configure

After the Super Admin adds the tablet as a peer and sends back the server's public key and assigned VPN IP:

1. Click **Next → Configure**
2. Fill in:
   - **Server Public Key** — paste what Super Admin gave you (from `cat /etc/wireguard/server_public.key`)
   - **Server Endpoint** — `169.58.124.150:51820` (pre-filled)
   - **Tablet VPN IP** — the IP assigned by Super Admin (e.g. `10.0.0.2`)
   - **DNS** — `1.1.1.1` (default, leave as-is)
3. The **Config Preview** shows the exact `EcareAfrica.conf` that will be written
4. Click **Save & Activate Tunnel**

> The backend writes `C:\ProgramData\WireGuard\EcareAfrica.conf` and calls `wireguard.exe /installtunnelservice` to install the tunnel as a Windows service.

### Step 4 — Activate

1. The wizard moves to **Step 4 — Activate**
2. Status shows **Tunnel Active — EcareAfrica** with the VPN IP and last handshake time
3. If the tunnel is not active yet:
   - Confirm the Super Admin completed Step C
   - Check `ufw allow 51820/udp` was run on the server
   - The backend must be running as Administrator (right-click → Run as Administrator)

### Step 5 — Ping Test

1. Click **Test Connection →**
2. The default ping target is `10.0.0.1` (the server's VPN IP)
3. Click **Ping** — the backend runs `ping -n 4 10.0.0.1`
4. Green result = tunnel is fully working end-to-end
5. The wizard also shows the command to ping the tablet from the server side

### Final step — Set the Tablet UUID

1. Open the **Developer** modal (password: `admin1234`)
2. The `TABLET_UUID` field in `backend/.env` must be filled with the UUID from the portal (Step A)
3. Without this, the tablet cannot authenticate to `backend.ecareafrica.net`

---

## Part 4 — What Gets Copied Between Server and Tablet

### Server → Tablet (Super Admin tells the technician)

| Item | Where it comes from | Used for |
|------|---------------------|----------|
| **Server Public Key** | `cat /etc/wireguard/server_public.key` on server | Pasted into wizard Step 3 "Server Public Key" field |
| **Assigned Tablet VPN IP** | Super Admin portal (e.g. `10.0.0.2`) | Pasted into wizard Step 3 "Tablet VPN IP" field |
| **Server Endpoint** | Fixed: `169.58.124.150:51820` | Pre-filled in wizard, confirm it is correct |
| **Tablet UUID** | Generated by Super Admin portal | Entered into `backend/.env` → `TABLET_UUID=` |

### Tablet → Server (Technician sends to Super Admin)

| Item | Where it comes from | Used for |
|------|---------------------|----------|
| **Tablet Public Key** | Wizard Step 2 — Copy button | Super Admin runs `wg set wg0 peer <key> allowed-ips <ip>/32` on server |

That is the **only** value that flows from tablet to server. The private key never leaves the tablet.

---

## Part 5 — Key Exchange Diagram

```
SUPER ADMIN (server side)              TECHNICIAN (tablet side)
─────────────────────────────          ───────────────────────────────────

1. cat /etc/wireguard/server_public.key
   → copies: SERVER_PUBLIC_KEY
                                        2. Opens WireGuard wizard
                                           Clicks Generate Keys
                                           → gets: TABLET_PUBLIC_KEY

3. Receives TABLET_PUBLIC_KEY          ──── sends TABLET_PUBLIC_KEY ────►
   Runs: wg set wg0 peer
         <TABLET_PUBLIC_KEY>
         allowed-ips 10.0.0.2/32
   Runs: wg-quick save wg0
   Assigns VPN IP: 10.0.0.2

◄─── sends SERVER_PUBLIC_KEY ────       4. Pastes SERVER_PUBLIC_KEY
     sends VPN IP 10.0.0.2                  Pastes VPN IP 10.0.0.2
                                            Clicks Save & Activate Tunnel
                                            Clicks Ping → 10.0.0.1
                                            → sees: Ping successful ✓
```

---

## Part 6 — VPN IP Assignment Plan

Each tablet gets a unique IP in the `10.0.0.0/24` subnet. The server is always `10.0.0.1`.

| IP | Role |
|----|------|
| `10.0.0.1` | EcaAfrica server (169.58.124.150) |
| `10.0.0.2` | Tablet 1 (first school) |
| `10.0.0.3` | Tablet 2 (second school) |
| `10.0.0.4` | Tablet 3 |
| … | … |
| `10.0.0.254` | Maximum 253 tablets |

---

## Part 7 — Verifying the Tunnel (Server Side)

After a tablet connects, run on the server:

```bash
# Show all active peers and their last handshake
wg show

# Ping a specific tablet from the server
ping 10.0.0.2

# List all configured peers
wg show wg0 peers

# Check WireGuard service health
systemctl status wg-quick@wg0

# View WireGuard logs
journalctl -u wg-quick@wg0 -n 50
```

A healthy peer shows a **latest handshake** timestamp within the last 2 minutes (because `PersistentKeepalive = 25` sends a keepalive every 25 seconds).

---

## Part 8 — Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Tunnel shows "Inactive" on tablet | Server hasn't added the tablet as a peer | Super Admin runs `wg set wg0 peer ...` (Step C) |
| Ping fails from tablet to `10.0.0.1` | Server firewall blocking UDP 51820 | `ufw allow 51820/udp && ufw reload` on server |
| "Failed to install tunnel" error | Backend not running as Administrator | Right-click → Run as Administrator when starting `node server.js` |
| Tunnel active but no handshake | Server public key was pasted incorrectly | Regenerate keys (Step 2), redo Step C with new public key |
| `wg genkey` fails in wizard | WireGuard not installed or not found at `C:\Program Files\WireGuard\wg.exe` | Re-install WireGuard, restart the backend |
| Tunnel drops after server reboot | wg-quick service not enabled | `systemctl enable wg-quick@wg0` on server |
| Tunnel drops after tablet reboot | WireGuard tunnel service was not installed properly | Re-run Step 3–4 of wizard; the service installs automatically |

---

## Part 9 — Files Created During Setup

| File | Location | Contents | Who handles it |
|------|----------|----------|----------------|
| `wireguard-private.key` | `backend/data/wireguard-private.key` | Tablet private key | Stays on tablet only |
| `wireguard-public.key` | `backend/data/wireguard-public.key` | Tablet public key | Copied to server by Super Admin |
| `EcareAfrica.conf` | `C:\ProgramData\WireGuard\EcareAfrica.conf` | Full tunnel config | Written by wizard automatically |
| `server_private.key` | `/etc/wireguard/server_private.key` | Server private key | Stays on server only |
| `server_public.key` | `/etc/wireguard/server_public.key` | Server public key | Copied to tablet by technician |
| `wg0.conf` | `/etc/wireguard/wg0.conf` | Server tunnel config + all peers | Managed by Super Admin |

---

## Part 10 — Security Rules

1. **Private keys never leave their machine** — the tablet private key stays in `backend/data/`, the server private key stays in `/etc/wireguard/`. Never email or message a private key.
2. **Only public keys are exchanged** between the technician and Super Admin.
3. **The backend must run as Administrator** on Windows for WireGuard tunnel management.
4. **Add `backend/data/wireguard-private.key` to `.gitignore`** — it must never be committed to git.
5. **Each tablet gets its own unique key pair** — never reuse keys across tablets.

---

## Quick Reference Card

```
SUPER ADMIN needs from technician:
  → Tablet Public Key (44-char base64, ends in =)

TECHNICIAN needs from Super Admin:
  → Server Public Key  (44-char base64, ends in =)
  → Assigned VPN IP    (e.g. 10.0.0.2)
  → Tablet UUID        (from portal, for backend/.env)
  → Server Endpoint    (169.58.124.150:51820)
```

---

*Document version 1.0 — August 7, 2026*  
*EcaAfrica Biometric Attendance System*
