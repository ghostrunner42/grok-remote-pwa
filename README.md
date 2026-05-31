# Grok Remote

**Mobile-first remote control for Grok Build** — Scan a QR code on your computer and instantly control Grok from your phone with a full remote file browser.

Think Claude computer-use, but built for xAI Grok and optimized for mobile.

---

## ✨ Features

- **QR Code Pairing** — One-tap connection from phone to PC
- **Remote Chat** — Talk to Grok from your phone while it runs on your computer
- **Remote File Browser** — Browse, open, edit, and save files directly from your phone (safe sandboxed to `/projects`)
- **API Key Security** — Protected endpoints with simple key-based auth
- **PWA** — Installable on iOS and Android home screen
- **Docker Ready** — One-command deployment

---

## Quick Start (3 Commands)

```bash
git clone https://github.com/ghostrunner42/grok-remote-pwa.git
cd grok-remote-pwa
docker-compose up --build
```

That's it.

Open `http://localhost:3000` on your computer → beautiful QR code appears automatically.

Scan it with your phone → instantly connected with full remote file browser.

(Uses demo key by default. Change `GROK_REMOTE_KEY` in `.env` for production use.)

---

## How to Use

1. Start the backend on your computer
2. Open `http://YOUR-PC-IP:3000` in your browser
3. On your phone, open the PWA (or scan the QR directly)
4. Tap **📷 Scan QR** — connection is automatic
5. Switch between **Chat** and **Files** tabs

In the Files tab you can:
- Browse folders
- Open and edit files
- Save changes back to your PC in real time

---

## Security

- All sensitive endpoints require an API key
- File access is sandboxed to the `projects/` directory only
- Never expose this publicly without proper auth + HTTPS

---

## Why This Matters for xAI

This is a complete, working prototype of **mobile remote development for Grok**.

Key advantages:
- Extremely low friction onboarding (QR scan)
- Real file system access from phone
- Designed to work with future Grok computer-use features
- Minimal new infrastructure required
- Feels native to how developers actually work

This could become a flagship mobile experience for Grok Build.

---

## Roadmap (Community + xAI)

- [x] QR pairing
- [x] Remote file browser + edit/save
- [x] API key security
- [x] Docker support
- [ ] WebSocket real-time updates
- [ ] Voice input on mobile
- [ ] Project templates ("build a Next.js app" → auto scaffold + open in phone)
- [ ] Full Claude-style computer use integration (when available)

---

## Contributing

This started as a proof-of-concept. Pull requests welcome!

Especially looking for:
- Better mobile UX
- More secure auth (JWT, etc.)
- Integration with real xAI API streaming

---

**Built with ❤️ for the xAI community**

*“The best way to predict the future is to build it.”* — and then control it from your phone.