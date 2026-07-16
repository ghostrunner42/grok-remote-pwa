# Changelog

## 0.5.0 — 2026-07-16

### Features
- **Session attach** — share a desktop/TUI Grok session with the phone via `session/load`
  - `grok-remote --session <uuid>` or `GROK_REMOTE_SESSION`
  - `grok-remote -c` / `--continue-session` attaches the most recent **local** session for the launch cwd
  - Pair payload includes optional `sessionId`; PWA prefers it over phone-local storage
- Status / settings show attach mode; welcome copy notes shared history

### Notes
- Still a **standalone** `agent serve` (not leader-attached — upstream `serve --leader` does not listen).
- Shared **transcript / agent memory**, not live dual-control. Avoid prompting from TUI and phone at once.
- See `docs/LEADER_ATTACH_SPIKE.md` for spike evidence.

## 0.4.3 — 2026-07-16

### Features
- **Install detection + handoff** — join page and app try to detect an installed PWA (`getInstalledRelatedApps`, standalone, cookie/localStorage flag) and auto-open `/app` with pair
- **Manifest link capture** — `scope: "/"`, `handle_links: preferred`, `launch_handler`, `capture_links` so Android can open QR/join in the installed app when “Open supported links” is on
- **Open installed app banner** when visiting in a normal browser tab after prior install

### Notes
- Browsers cannot always force-open a home-screen app (especially iOS). Detection is best-effort; Android link capture needs a one-time OS setting.

## 0.4.2 — 2026-07-16

### Fixes
- **Reconnect after leave/return** — `session/load` returns `sessionId` under `_meta`; we now normalize it so prompts no longer fail with “call handshake first”
- **Auth** — `authenticate` is required when the agent advertises methods (avoids `AuthorizationRequired` worker deaths)
- **In-app QR on LAN HTTP** — guides users to system-camera → join URL (browser blocks camera without HTTPS)
- **Join deep-link** — `/join` opens `/app/?pair=…` so pairing survives storage isolation
- **PWA header** — safe-area + standalone top padding so the banner isn’t under the status bar

## 0.4.1 — 2026-07-16

### Improvements
- **Chat history after reconnect** — phone-side transcript persists in localStorage and restores when you reopen the PWA or the WebSocket drops
- **Clear chat history** control in Settings (pair/session on the PC unchanged)
- **Startup prerequisites** — clear errors if Node &lt; 18 or `grok` is missing; prints Node + `grok --version` at launch
- **README** — FAQ for phone vs TUI sessions, npx install path, overview image
- **npm package** — `files` field for a lean publish; `npx grok-remote` ready when published

### Notes
- Tested with Grok Build CLI `0.2.x`
- Chat history is local to the phone/browser, not a shared TUI transcript

## 0.4.0 — 2026-07-15

- Official `grok agent serve` (ACP) remote from phone/browser
- QR join URL, terminal bridge, project cwd from launch directory
- SpaceXAI-styled PWA with Add to Home Screen install flow
- MIT license, SECURITY notes, unified package layout
