# 🎥 saasLiveStream-1K — Self-Hosted Live Streaming Platform (1,000+ Viewers + Chat + Polls)

A lightweight, self-hosted, multi-tenant live-streaming platform designed to stream privately to **1,000+ concurrent authenticated viewers** from a **single unmetered VPS**—at a fraction of the cost of Zoom Webinar or Large Meetings.

Broadcasters go live via **OBS Studio (RTMP/WHIP)** or directly from the **browser (Camera or Screen Share)**. Viewers sign in with private accounts (anti-sharing enforced) and interact via **real-time moderated chat** and **live polls**.

---

## 🏗 Architecture

| Component | Technology | Role |
| :--- | :--- | :--- |
| **Reverse Proxy** | Caddy 2 (`caddy:2-alpine`) | Automatic HTTPS (Let's Encrypt), HTTP/2 & HTTP/3, WebSocket & HLS routing |
| **Media Server** | MediaMTX `1.21.4` | RTMP & WebRTC (WHIP) ingest → in-memory **Low-Latency HLS** fan-out (zero transcoding, zero disk I/O) |
| **Backend & Realtime** | Node.js 22 + Express + `ws` | Async `scrypt` auth, RAM-cached HLS token verification, WebSocket chat/polls/presence |
| **Database** | SQLite (WAL mode) | Users, sessions, schedules, chat history, poll votes |
| **Player** | `hls.js` 1.7.4 + Native Safari fallback | Smooth playback across Desktop, Android, and iOS |

---

## 💻 Hardware & Network Requirements (1,000 Concurrent Viewers)

Because MediaMTX **does not transcode** and serves HLS chunks straight from RAM, **network port speed and monthly bandwidth**—not CPU—determine capacity.

| Target Audience | Stream Bitrate | Sustained Outbound | Data / 4-Hour Stream | Monthly Data (Daily 4h) | Recommended Single VPS Spec |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **250 viewers** | 1.5 Mbps | ~375 Mbps | ~675 GB | ~20 TB | 2 vCPU, 2 GB RAM, **1 Gbps unmetered** |
| **500 viewers** | 1.5 Mbps | ~750 Mbps | ~1.35 TB | ~40 TB | 2–4 vCPU, 4 GB RAM, **1–2 Gbps unmetered** |
| **1,000 viewers** | 1.0 Mbps (slides/lectures) | ~1.0 Gbps | ~1.8 TB | ~54 TB | 4 vCPU, 4–8 GB RAM, **2.5–10 Gbps unmetered** |
| **1,000 viewers** | 1.5 Mbps (720p30) | ~1.5 Gbps | ~2.7 TB | ~81 TB | 4 vCPU, 8 GB RAM, **2.5–10 Gbps unmetered** |
| **1,000 viewers** | 2.0 Mbps (crisp 720p) | ~2.0 Gbps | ~3.6 TB | ~108 TB | 4–6 vCPU, 8 GB RAM, **3–10 Gbps unmetered** (or entry dedicated server) |

> **Critical VPS Buying Tip:** For daily 4+ hour streams, choose a VPS with **truly unmetered traffic** (typically Europe/North America plans from providers like OVHcloud, Hetzner, or Netcup). Many Asia-Pacific VPS plans cap bandwidth at 1–3 TB/month. Europe-to-India latency (~140 ms) is unnoticeable on HLS streams.

---

## 🛠 Software Requirements

| Item | Requirement |
| :--- | :--- |
| **Host OS** | **Ubuntu 22.04 / 24.04 LTS** or **Debian 12** (64-bit Linux only — `network_mode: host` does not work on Windows/macOS Docker Desktop) |
| **Architecture** | `x86_64` (amd64) or `arm64` |
| **Access** | Root / `sudo` |
| **Network** | Direct Public IPv4 (not behind CGNAT) |
| **Pre-installed Software** | None — `install.sh` automatically installs Docker, applies Linux TCP BBR kernel tuning, and configures `ufw` |

---

## 🌐 DNS Setup (Do This First)

Create **two `A` records** pointing to your VPS public IPv4 address:

| Type | Hostname | Points To | Purpose |
| :--- | :--- | :--- | :--- |
| `A` | `stream.yourdomain.com` | Your VPS IP | Portal, HLS video, WebSocket chat/polls, WHIP, OBS RTMP |
| `A` | `api.yourdomain.com` | Your VPS IP | Backend API |

Wait for DNS propagation (`ping stream.yourdomain.com`) before running the installer so Caddy can issue Let's Encrypt TLS certificates.

---

## 🔥 Required Firewall Ports

`install.sh` opens these in `ufw`. If your cloud provider has an external firewall/Security Group, open them there too:

| Port | Protocol | Purpose |
| :--- | :--- | :--- |
| `22` | TCP | SSH |
| `80` | TCP | Let's Encrypt certificate challenge & HTTP→HTTPS redirect |
| `443` | TCP & UDP | HTTPS (Portal, HLS playback, WebSockets, WHIP, HTTP/3) |
| `1935` | TCP | **OBS RTMP ingest** (recommended for 1,000 viewers) |
| `8189` | UDP & TCP | Browser / OBS WebRTC WHIP ingest |

---

## 🚀 Installation

### Interactive
```bash
git clone https://github.com/migandhi/saasLiveStream-1K.git
cd saasLiveStream-1K
chmod +x install.sh upgrade.sh
sudo ./install.sh
```

### Unattended
```bash
sudo STREAM_DOMAIN=stream.yourdomain.com \
     API_DOMAIN=api.yourdomain.com \
     ADMIN_USER=admin \
     ADMIN_PASS='ChangeThisStrongPass123!' \
     ./install.sh --yes
```

### Verify Deployment
```bash
cd /opt/saas1k
docker compose ps
docker compose logs -f
```

Open `https://stream.yourdomain.com` (allow 30–60 seconds on first visit for automatic HTTPS certificate issuance).

---

## 📖 Usage Guide

### 1. Platform Admin (`/admin.html`)
1. Log in at `https://stream.yourdomain.com` with your `ADMIN_USER` and `ADMIN_PASS`.
2. Tune global limits:
   - **Max viewers per room / Max total viewers** (default `1000`)
   - **Max slot length (minutes)** (default `360` = 6 hours)
   - **Require booked slot** (`0` = open anytime, `1` = strict calendar enforcement)
3. Approve, renew, suspend, or kick broadcasters from the subscriber table.

### 2. Broadcaster (`/sub.html` & `/studio.html`)
1. Register via **Register as a broadcaster** → wait for Admin approval.
2. In **Dashboard (`/sub.html`)**, add viewer accounts individually or bulk-import up to 2,000 rows via CSV (`username,password`).
3. Click **Open Live Studio (`/studio.html`)**:
   - **Recommended for 1,000 viewers (OBS Studio):** Click **OBS Credentials**, copy the **RTMP Server** and **Stream Key** into OBS (`Settings → Stream → Service: Custom`).
     - Recommended OBS Output settings: **CBR 1200–1500 Kbps**, **720p @ 24–30 fps**, **Keyframe Interval: 2 seconds**, **Audio: AAC 96–128 Kbps**.
   - **Zero-install Browser Broadcast:** Select a bitrate (`1.0` / `1.5` / `2.0 Mbps`) and click **Go Live (Camera)** or **Go Live (Screen + Mic)**.
4. **Live Chat Moderation:** Toggle chat ON/OFF, enable Slow Mode (`5s` / `15s` / `30s`), pin announcements, delete individual messages, clear chat, mute noisy viewers (`🔇`), or kick viewers (`🚫`).
5. **Live Polls:** Open the **Live Polls** tab, enter a question and 2–6 options, and click **Launch Poll**. View live percentages update in real time, then **Close Voting** or **Remove Poll**.

### 3. Viewers (`/watch.html`)
1. Sign in at `https://stream.yourdomain.com` with the credentials provided by the broadcaster.
2. If the stream hasn't started yet, viewers sit in the **Waiting Room** and auto-start the moment the host goes live.
3. Only **one active session per account** is allowed—signing in on a second device automatically disconnects the first device's video and WebSocket session.

---

## 🔄 Upgrading & Backups

```bash
cd ~/saasLiveStream-1K
sudo ./upgrade.sh
```
`upgrade.sh` automatically backs up `/opt/saas1k/backend/data/database.db` to `/opt/saas1k/backups/`, preserves `.env` and TLS certificates, pulls the latest code, and rebuilds containers with ~20–30 seconds of downtime.

---

## ⚠️ Limitations (Read Before Production)

1. **One-Way Broadcast Only (3–8s Latency):** Unlike Zoom, viewers cannot turn on cameras or speak over audio. Interaction happens via real-time Chat and Polls.
2. **No Adaptive Bitrate (ABR / Transcoding):** To keep CPU usage tiny and VPS costs low, MediaMTX relays the single stream bitrate you send. Keep broadcast bitrate at **1.0–1.5 Mbps** so viewers on 4G/mobile networks do not buffer.
3. **Browser Broadcast Audio on Older iOS:** Broadcasting directly from a browser sends Opus audio, which plays on Chrome, Firefox, Edge, Android, and iOS 17.1+ (via `hls.js` Managed Media Source). For **100% compatibility with older iPhones and Smart TVs**, stream from **OBS Studio via RTMP** (H.264 + AAC).
4. **Single-Server Scale Ceiling:** Designed for up to ~1,000–2,000 viewers depending on VPS NIC speed (2.5–10 Gbps). Beyond a single server's network port, place an HTTP Pull CDN in front of `/live/*` or move to a multi-node cluster.
5. **No Built-In Recording / VOD:** Live-only by default to protect disk space and I/O during 4+ hour streams. Record locally in OBS if you need replays.
6. **Single-VPS Fair Use:** Pushing 2 Gbps for 4+ hours daily (~100 TB/month) on ultra-cheap shared VPS plans may trigger provider fair-use throttling. Use a reputable unmetered VPS (e.g., OVHcloud Europe 3 Gbps) or an entry-level unmetered dedicated server.

---

## 🔐 Security Highlights

- **Non-blocking `scrypt` password hashing** with random per-user salts and timing-safe verification.
- **Anti-sharing enforcement:** Logging in on a second device immediately revokes the prior session cookie, evicts the cached HLS playback token, and closes the prior WebSocket.
- **Internal services locked to `127.0.0.1`:** Node backend (`:3000`), MediaMTX Control API (`:9997`), MediaMTX HLS (`:8888`), and MediaMTX WHIP HTTP (`:8889`) are inaccessible from the public internet.
- **XSS protection & spam throttling:** All chat messages and poll text are HTML-escaped on render, with server-side rate limiting and WebSocket backpressure protection.
