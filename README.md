# Grok Remote - PWA Remote Control for Grok Build

Yo bro, this is the proof-of-concept for a mobile PWA that lets you run and control Grok-powered builds on your computer from your phone. Think Claude's computer-use vibe but with xAI Grok doing the heavy lifting on your PC.

## What it does (MVP)
- Installable PWA on your phone (add to home screen)
- Chat interface: Type prompts like "build me a landing page" or "fix this bug"
- Sends to your PC's backend server
- Backend calls Grok API (or mocks for now) and replies
- Future: Execute builds locally, save projects to folder, run commands safely, maybe even screenshot/control if we level up

## Quick Start (on your computer)

1. Make sure you have Node.js installed (v18+)
2. cd into backend/
3. npm install express cors
4. Get your xAI API key from https://console.x.ai (if you don't have one yet)
5. Set env var: export XAI_API_KEY=your_key_here   (or hardcode for testing - don't do this in prod)
6. node server.js
7. Note your computer's local IP (run `ipconfig` on Windows or `ifconfig` / `ip addr` on Mac/Linux) - something like 192.168.1.42
8. Open the frontend/index.html in a browser on your PC first to test (or serve it)

## On your phone
1. Open the frontend/index.html URL (or host it simply with `npx serve frontend` and access via phone on same WiFi)
2. Or better: Deploy frontend somewhere public later, but for POC use local network
3. Enter your PC's IP:3000 in the settings
4. Chat away! It should feel like remote-controlling Grok on your rig

## Tech Stack
- Frontend: Pure HTML/CSS/JS PWA (no heavy frameworks for simplicity)
- Backend: Node + Express
- Future upgrades: WebSockets for real-time, Socket.io, file system integration for actual builds, auth, ngrok for internet access from anywhere

## Next Level Ideas (tell me what to add)
- Actual code generation + file writing on PC ("build a todo app" → creates /projects/todo-app/)
- Run terminal commands from phone (whitelisted safe ones)
- Live preview of generated sites
- Voice input on mobile
- Multiple sessions / projects dashboard
- Full Claude-style computer use simulation (virtual mouse/keyboard via phone gestures - ambitious!)

This is 100% proof-of-concept to see how far we can push it. Let's iterate fast!

If you run into issues or want changes, just say the word. Let's build this thing! 🚀