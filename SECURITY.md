# Security Policy

## What this tool is

**Grok Remote** starts a local agent server and a small HTTP/WebSocket surface so a phone on your LAN can drive **official Grok Build** with full tool access (files, shell, etc.) on your computer.

That is powerful and dangerous if exposed carelessly.

## Threat model (honest)

| Risk | Notes |
|------|--------|
| **Full machine agency** | The agent can edit files and run shell commands under your user account (within project cwd and OS permissions). |
| **LAN exposure** | The pair page and agent listen on your network interface. Anyone who can reach the ports and guess/steal the secret can control the agent. |
| **No WAN by default** | Do **not** port-forward 3020/2419 to the internet. Use a VPN/relay you trust if you need off-LAN access later. |
| **Auth** | Pairing uses a short-lived/random server secret in the QR/join URL. Model auth uses your local `grok` login (`~/.grok`), not a phone-held API key. |
| **Terminal bridge** | Shell runs on the **desktop** via the launcher HTTP API, authenticated with the same pair secret. |

## Safe usage

1. Prefer **home/trusted Wi‑Fi**. Avoid open/guest networks with client isolation quirks or untrusted peers.
2. Keep **NordVPN kill switch / host firewalls** configured so LAN access is intentional (see README).
3. Treat the **join URL and secret like a password** for that session.
4. Stop the launcher (`Ctrl+C`) when finished.
5. Use `--no-approve` only if you want interactive tool confirmation (stricter); default demo mode is always-approve for low friction.

## Reporting issues

Open a GitHub issue on this repository for security-relevant bugs. Please avoid posting live secrets or session tokens in public issues.

## Scope

This is community software. It is not covered by xAI’s product security program.
