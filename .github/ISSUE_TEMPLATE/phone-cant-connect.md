---
name: Phone can’t connect
about: Join URL / QR fails on mobile (LAN, VPN, firewall)
title: "[connect] "
labels: ["networking"]
---

## Environment

- OS (desktop):
- `node -v`:
- `grok --version`:
- Grok Remote version / commit:
- Phone OS + browser:
- VPN on desktop? (NordVPN etc.): yes / no
- VPN on phone?: yes / no

## What you see

- [ ] QR / join URL never loads on phone
- [ ] Join page loads but status stays Offline
- [ ] Works on desktop browser, not on phone
- [ ] Other:

Join URL printed by launcher (redact secret if you want):

```
http://…
```

## Already tried

- [ ] Same Wi‑Fi (not guest network)
- [ ] Disabled VPN / enabled LAN discovery
- [ ] Allowed ports **3020** and **2419**
- [ ] Forced host: `grok-remote --host <LAN-IP>`

## Notes

Paste any launcher console output (no secrets if possible).
