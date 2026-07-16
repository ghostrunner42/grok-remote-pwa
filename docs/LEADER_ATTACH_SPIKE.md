# Leader attach spike (2026-07-16)

Workspace: `/tmp/grok-leader-spike`  
Grok: `0.2.101`  
Session under test: `019f6c0e-4df2-7392-b8c9-e5c84a7731f7`

## Goals

1. Can multiple clients share one agent **backend** via `grok agent leader`?
2. Can the **phone path** (`agent serve` + ACP WebSocket) join that world?
3. Can they share one **session transcript** (disk + model context)?
4. Is **live concurrent** dual-drive safe?

## Setup

```bash
# 1) Shared leader (kept up for the spike)
grok agent leader --no-exit-on-disconnect --relay-on-demand
# → ~/.grok/leader.sock  (PID listed by `grok leader list`)

# 2) Headless client through leader
grok --leader -p "…" --cwd /tmp/grok-leader-spike --output-format json

# 3) Phone-shaped path: standalone serve (NOT --leader)
grok agent --no-leader --always-approve serve \
  --bind 127.0.0.1:2425 --secret leader-spike-secret
```

## Results

| Experiment | Result | Notes |
|------------|--------|--------|
| Start `grok agent leader` | **OK** | Socket + `grok leader list/info` |
| `grok --leader -p …` (new session) | **OK** | Returns `sessionId`, uses leader |
| Second `grok --leader -p … --resume <id>` | **OK** | Full history (`LEADER_OK` remembered) |
| `grok agent --leader serve` | **FAIL** | Prints banner and **exits**; **no** WebSocket listen |
| `grok agent --no-leader serve` while leader runs | **OK** | Independent serve process |
| ACP `session/load` of leader session via serve | **OK** | Resume id normalized under `_meta` still required (0.4.2 fix) |
| Prompt on serve after load | **OK** | Model saw prior leader turns (`SERVE_LOAD_OK` / `PHONE_OK` history) |
| Headless `--leader --resume` while serve is up | **OK** (sequential) | `CONCURRENT_OK` |
| Two parallel ACP WS clients, same session, simultaneous `session/prompt` | **RACY** | Stream/text interleaving (`A` empty / `B` got `A_DONEB_DONE`); history eventually contains both turns |
| Final headless history check | **OK** | Agent listed: `LEADER_OK, RESUME_OK, PHONE_OK, CONCURRENT_OK, A_DONE, B_DONE` |
| `grok sessions list` in spike cwd | **OK** | Discovers the shared session |

## Architecture reality (0.2.101)

```
                    ┌──────────────────────────┐
  TUI / headless ──►│  grok agent leader       │  ← shared backend (unix socket)
  (--leader)        └──────────────────────────┘
                              │
                              │  NOT wired to serve in this build
                              ✗
                    ┌──────────────────────────┐
  Phone PWA ───────►│  grok agent serve (solo) │  ← separate process
  (ACP WebSocket)   └───────────┬──────────────┘
                                │
                                ▼
                    ~/.grok/sessions/<cwd>/<sessionId>/
                    (shared on disk — session/load works)
```

**Leader does share a backend for CLI/TUI-style clients.**  
**`agent serve` does not attach to leader** (`--leader serve` is a no-op exit).  
**Session identity is still shareable via disk:** phone serve can `session/load` the TUI/leader session id and continue the same conversation.

## Implications for Grok Remote

### Viable v1 (recommend)

**“Attach to session” mode** — not true multi-client live fan-out:

1. Discover session for project cwd:
   - user flag `--session <id>`, or
   - `grok sessions list` / most-recent local session for cwd, or
   - TUI writes “active session” into pair payload / file.
2. Launcher still runs **standalone** `grok agent serve` (as today).
3. Pair payload gains optional `sessionId`.
4. PWA handshake: `session/load` that id; fall back to `session/new`.
5. Document:
   - Phone and TUI share **history** after load/resume.
   - **Do not** drive both UIs at the same time (prompt races).
   - TUI may need `/resume` or reopen to see phone turns if it was already open (live mirror **not** proven).

### Not viable yet (without upstream)

- Single process: TUI + phone both attached to one live leader **with serve as the phone door** — `serve --leader` does not work.
- Safe simultaneous dual control of one session.

### Optional later

- Spike whether an open TUI auto-refreshes when `updates.jsonl` grows (file watch / resume).
- Feature request to xAI: `grok agent --leader serve` should proxy ACP WebSocket onto the leader.
- Leader IPC bridge in grok-remote (reverse-engineer unix protocol) — high cost, fragile.

## Cleanup

```bash
# spike leftovers
fuser -k 2425/tcp 2>/dev/null || true
grok leader kill   # if you want the spike leader gone
```

## One-liner conclusion

**Shared transcript: yes (via `sessionId` + `session/load`).**  
**Shared live leader backend for the phone serve path: no (not in 0.2.101).**  
**Build “attach session” first; treat true TUI live-mirror as a separate upstream-dependent milestone.**
