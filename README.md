# Grok Remote

**Unofficial community companion** for [SpaceXAI Grok Build](https://x.ai/cli): drive the real desktop agent from your phone (or any browser) over the local network.

```bash
cd ~/your-project
grok-remote
# Phone (same Wi‑Fi): open the join URL / scan the QR
```

Not affiliated with or endorsed by xAI / SpaceXAI. Requires the official `grok` CLI installed and logged in on your computer.

---

## Features

- **QR / join URL pairing** — phone camera opens `http://LAN:3020/join`
- **Real Grok Build agent** via ACP (`grok agent serve`), not a mock chat API
- **Project cwd** = the directory where you launched `grok-remote`
- **Shell on the desktop** — terminal bridge so agent shell tools work from the phone
- **Files** — browse/read/write via agent FS extensions
- **PWA-friendly** — installable UI; works offline from the LAN host (no CDN)

---

## Prerequisites

| Requirement | Notes |
|-------------|--------|
| **Node.js 18+** | For the launcher + PWA server |
| **`grok` CLI** | [Install](https://x.ai/cli) and run `grok login` once |
| **Same Wi‑Fi** | Phone and PC on the same LAN (not guest isolation if possible) |

Check:

```bash
node -v
grok --version
grok models   # should show you are logged in
```

---

## Install

```bash
git clone https://github.com/ghostrunner42/grok-remote-pwa.git
cd grok-remote-pwa
npm install
npm link          # puts `grok-remote` on your PATH (optional)
```

Without linking:

```bash
node /path/to/grok-remote-pwa/launcher.js
# or
npx --yes --prefix /path/to/grok-remote-pwa grok-remote
```

---

## Usage

```bash
cd ~/Documents/MyProject   # agent workspace = this directory
grok-remote
```

Then on your phone:

1. Open **`http://<printed-lan-ip>:3020/join`** (or scan the QR — it encodes that URL)
2. You should land in the app with status like **ACP · grok-4.5**
3. Chat, run tools, browse **Files**

Stop with **Ctrl+C** in the terminal.

### Flags

```bash
grok-remote --cwd /path/to/project
grok-remote --host 192.168.1.42      # force LAN IP if auto-detect is wrong
grok-remote --port 2419              # agent WebSocket port
grok-remote --http-port 3020         # pair page + PWA
grok-remote --secret my-token        # or GROK_AGENT_SECRET
grok-remote --no-approve             # do not pass --always-approve to agent
grok-remote --no-open                # don’t open the pair page in a browser
grok-remote --localhost              # 127.0.0.1 only (phones cannot connect)
```

---

## Network / VPN

If the join page works on the PC but **not on the phone**:

**NordVPN (common):** kill switch blocks LAN inbound.

```bash
nordvpn set lan-discovery enable
nordvpn allowlist add port 3020
nordvpn allowlist add port 2419
# or: nordvpn disconnect
```

Also check:

- Same SSID (not guest Wi‑Fi with client isolation)
- Host firewall allowing TCP **3020** and **2419**
- Phone VPN off

---

## Architecture

```
Phone PWA  ── WebSocket ACP ──►  grok agent serve  (official CLI)
    │                                    │
    └── terminal/*  ──HTTP──►  launcher (shell on PC, project cwd)
```

| Path | Role |
|------|------|
| `bin/grok-remote` | CLI entry |
| `launcher.js` | Starts agent + HTTP + QR + terminal bridge |
| `lib/acp-client.js` | ACP client (browser + Node) |
| `lib/terminal-bridge.js` | Desktop shell host |
| `lib/pair.js` | Pair payload v1 |
| `frontend/` | PWA UI |
| `legacy/` | Old Docker/Express mock (deprecated) |

---

## Security (short version)

This grants **remote agent control of your machine** on the LAN. Do not expose ports to the public internet. See [SECURITY.md](./SECURITY.md).

---

## Development / tests

```bash
# terminal A
npm start

# terminal B (with launcher running)
npm run e2e
npm run verify-pair
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `grok: command not found` | Install CLI from https://x.ai/cli |
| Auth / login errors | Run `grok login` on the desktop |
| Phone can’t load join URL | VPN/firewall/LAN isolation (see above) |
| Blank app / old UI | Hard-refresh `/app/` or re-open `/join` |
| Shell tools fail | Ensure launcher is up (terminal bridge); re-join after upgrade |
| Chat not in TUI | Expected — phone uses `agent serve`, a separate session from interactive `grok` |

---

## License

MIT — see [LICENSE](./LICENSE).

Grok Build and SpaceXAI marks belong to their respective owners. This project is a community companion.
