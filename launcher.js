#!/usr/bin/env node
/**
 * Phase 2 desktop launcher
 *
 * Starts official `grok agent serve`, prints a pair QR, and hosts the PWA
 * + pairing page over HTTP for the phone.
 *
 * Usage:
 *   node launcher.js
 *   node launcher.js --cwd /path/to/project
 *   node launcher.js --host 192.168.1.248 --port 2419 --http-port 3020
 *   node launcher.js --secret mysecret --no-approve
 */

const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { URL } = require("url");

const {
  DEFAULT_PORT,
  buildPairPayload,
  detectLanIp,
  listLanCandidates,
  randomSecret,
} = require("./lib/pair");
const { createTerminalHost } = require("./lib/terminal-bridge");

function parseArgs(argv) {
  const out = {
    cwd: process.cwd(),
    host: null,
    port: DEFAULT_PORT,
    httpPort: 3020,
    secret: process.env.GROK_AGENT_SECRET || null,
    alwaysApprove: true,
    openBrowser: true,
    allowLocalhost: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--cwd":
        out.cwd = path.resolve(next());
        break;
      case "--host":
        out.host = next();
        break;
      case "--port":
        out.port = Number(next());
        break;
      case "--http-port":
        out.httpPort = Number(next());
        break;
      case "--secret":
        out.secret = next();
        break;
      case "--no-approve":
        out.alwaysApprove = false;
        break;
      case "--no-open":
        out.openBrowser = false;
        break;
      case "--localhost":
        // Explicit opt-in for same-machine browser testing only
        out.allowLocalhost = true;
        if (!out.host) out.host = "127.0.0.1";
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        if (a.startsWith("-")) {
          console.error(`Unknown flag: ${a}`);
          printHelp();
          process.exit(1);
        }
    }
  }
  return out;
}

function printHelp() {
  console.log(`
Grok Remote launcher

  node launcher.js [options]

Options:
  --cwd <path>       Project directory for ACP sessions (default: cwd)
  --host <ip>        LAN IP phones should use (auto-detected; never 127.0.0.1)
  --port <n>         Agent serve port (default: 2419)
  --http-port <n>    Pair page + PWA static port (default: 3020)
  --secret <token>   Agent auth secret (default: random / GROK_AGENT_SECRET)
  --no-approve       Do not pass --always-approve to grok agent
  --no-open          Do not open the pair page in a browser
  --localhost        Same-machine only (QR uses 127.0.0.1 — phones cannot connect)
`);
}

function isLoopback(host) {
  return !host || host === "127.0.0.1" || host === "localhost" || host.startsWith("127.");
}

function mime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".webmanifest": "application/manifest+json",
    }[ext] || "application/octet-stream"
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const secret = opts.secret || randomSecret();
  const cwd = path.resolve(opts.cwd);

  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    console.error(`cwd is not a directory: ${cwd}`);
    process.exit(1);
  }

  const candidates = listLanCandidates(os);
  let host = detectLanIp(os, opts.host, { allowLocalhost: opts.allowLocalhost });

  // Refuse 127.0.0.1 in QR unless --localhost (phones cannot reach loopback)
  if (!host || (isLoopback(host) && !opts.allowLocalhost)) {
    console.error("\n❌ Could not find a LAN IP for phone pairing.\n");
    if (candidates.length) {
      console.error("   Interfaces seen:");
      for (const c of candidates) {
        console.error(`     ${c.addr.padEnd(16)}  ${c.name}  (score ${c.score})`);
      }
    } else {
      console.error("   No non-loopback IPv4 interfaces found.");
    }
    console.error("\n   Fix: connect Wi‑Fi/Ethernet, or pass your LAN IP explicitly:");
    console.error("     node launcher.js --host 192.168.x.x\n");
    console.error("   Same-machine browser only:");
    console.error("     node launcher.js --localhost\n");
    process.exit(1);
  }

  if (isLoopback(host)) {
    console.warn(
      "\n⚠️  Pair QR uses 127.0.0.1 — a phone cannot connect. Use without --localhost for LAN.\n"
    );
  }

  // Prefer local grok on PATH
  const grokBin = process.env.GROK_BIN || "grok";

  console.log("\n🚀 Grok Remote launcher\n");
  console.log(`   cwd:     ${cwd}`);
  console.log(`   host:    ${host}   ← phone must reach this IP`);
  if (candidates.length) {
    console.log("   ifaces:");
    for (const c of candidates.slice(0, 6)) {
      const mark = c.addr === host ? "  ← selected" : "";
      console.log(`     ${c.addr.padEnd(16)}  ${c.name}${mark}`);
    }
  }
  console.log(`   agent:   ws://${host}:${opts.port}/ws?server-key=…`);
  console.log(`   http:    http://${host}:${opts.httpPort}/`);
  console.log(`   pwa:     http://${host}:${opts.httpPort}/app/`);
  console.log(`   secret:  ${secret}`);
  console.log(`   approve: ${opts.alwaysApprove ? "always (--always-approve)" : "interactive"}\n`);

  const agentArgs = ["agent"];
  if (opts.alwaysApprove) agentArgs.push("--always-approve");
  agentArgs.push(
    "serve",
    "--bind",
    `0.0.0.0:${opts.port}`,
    "--secret",
    secret
  );

  console.log(`📦 Starting: ${grokBin} ${agentArgs.join(" ")}\n`);

  const agent = spawn(grokBin, agentArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GROK_AGENT_SECRET: secret },
  });

  let agentReady = false;
  const onAgentLine = (line) => {
    process.stdout.write(`[agent] ${line}\n`);
    if (line.includes("WebSocket URL") || line.includes("Grok agent server starting")) {
      agentReady = true;
    }
  };

  agent.stdout.on("data", (buf) => {
    buf.toString().split(/\r?\n/).filter(Boolean).forEach(onAgentLine);
  });
  agent.stderr.on("data", (buf) => {
    buf.toString().split(/\r?\n/).filter(Boolean).forEach(onAgentLine);
  });
  agent.on("exit", (code, signal) => {
    console.error(`\n[agent] exited code=${code} signal=${signal || ""}`);
    process.exit(code || 1);
  });

  // Wait briefly for listen
  await sleep(1200);
  if (agent.exitCode !== null) {
    console.error("Agent failed to start.");
    process.exit(1);
  }

  const httpBase = `http://${host}:${opts.httpPort}`;
  // Phone camera apps only open URLs — NOT raw pair JSON.
  // /join stores the pair and redirects into the PWA.
  const joinUrl = `${httpBase}/join`;
  const appUrl = `${httpBase}/app/`;
  const payload = buildPairPayload({
    host,
    port: opts.port,
    secret,
    cwd,
    http: httpBase,
  });

  // Write payload for tooling / verify-pair
  const payloadPath = path.join(os.tmpdir(), "grok-remote-pair.json");
  fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
  console.log(`\n💾 Pair payload written to ${payloadPath}`);

  // Terminal QR — must be an http(s) URL for stock phone cameras
  try {
    const QRCodeTerminal = require("qrcode-terminal");
    console.log("\n📱 Scan this QR with your phone camera (opens the app):\n");
    console.log(`   ${joinUrl}\n`);
    QRCodeTerminal.generate(joinUrl, { small: true });
  } catch {
    console.log("\n(install qrcode-terminal for terminal QR: npm i qrcode-terminal)\n");
    console.log(`   Join URL: ${joinUrl}\n`);
  }

  console.log("\nPair payload (advanced / Settings paste):\n");
  console.log(JSON.stringify(payload, null, 2));
  console.log(`\n🌐 Join URL (phone):  ${joinUrl}`);
  console.log(`   Pair page (PC):    ${httpBase}/`);
  console.log(`   PWA direct:        ${appUrl}`);
  console.log(`   Project cwd:       ${cwd}`);
  console.log(`   Terminal bridge:   ${httpBase}/api/term/*`);
  console.log(`   WS:                ${payload.ws}`);
  if (isLoopback(host)) {
    console.log("\n⚠️  QR is loopback-only. Phones will fail to connect.");
  } else {
    console.log(
      `\n✅ Scan the QR with your phone camera → should open ${joinUrl}`
    );
    console.log(
      "   Phone + PC must share Wi‑Fi (disable AP/client isolation if it still fails)."
    );
  }
  console.log("\nPress Ctrl+C to stop agent + HTTP server.\n");

  const frontendDir = path.resolve(__dirname, "frontend");
  const acpClientPath = path.join(__dirname, "lib/acp-client.js");
  const pairLibPath = path.join(__dirname, "lib/pair.js");

  let qrDataUrl = "";
  try {
    const QRCode = require("qrcode");
    // Encode openable join URL for phone cameras
    qrDataUrl = await QRCode.toDataURL(joinUrl, {
      width: 360,
      margin: 2,
      color: { dark: "#0A0A0C", light: "#ffffff" },
    });
  } catch {
    /* optional */
  }

  // Shell runs here on the desktop — phone ACP client proxies terminal/*
  const termHost = createTerminalHost({
    defaultCwd: cwd,
    log: (tag, ...args) => console.log(`[${tag}]`, ...args),
  });

  const server = http.createServer(async (req, res) => {
    try {
      // Log remote peers so we can see if a phone ever reaches the host
      const ra = req.socket.remoteAddress || "?";
      if (!String(req.url || "").includes("favicon")) {
        console.log(`[http] ${ra} ${req.method} ${req.url}`);
      }
      const u = new URL(req.url, httpBase);

      // Terminal bridge (auth = pair secret)
      if (u.pathname.startsWith("/api/term")) {
        if (termHost.handleHttp(req, res, u, secret)) return;
      }

      if (u.pathname === "/api/pair" || u.pathname === "/pair.json") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(payload));
        return;
      }

      // Phone camera entry: save pair + bounce into PWA
      if (u.pathname === "/join" || u.pathname === "/go") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(joinPageHtml({ payload, appUrl, httpBase }));
        return;
      }

      if (u.pathname === "/" || u.pathname === "/pair") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          pairPageHtml({ payload, qrDataUrl, httpBase, joinUrl, appUrl })
        );
        return;
      }

      // Shared libs for the PWA
      if (u.pathname === "/lib/acp-client.js") {
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
        res.end(fs.readFileSync(acpClientPath));
        return;
      }
      if (u.pathname === "/lib/pair.js") {
        // Browser cannot use module.exports; serve a small browser shim instead
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
        res.end(browserPairShim());
        return;
      }

      // Static PWA under /app/
      let rel = u.pathname;
      if (rel === "/app" || rel === "/app/") rel = "/app/index.html";
      if (rel.startsWith("/app/")) {
        const fileRel = rel.slice("/app/".length) || "index.html";
        const filePath = path.normalize(path.join(frontendDir, fileRel));
        if (!filePath.startsWith(frontendDir)) {
          res.writeHead(403).end("forbidden");
          return;
        }
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          res.writeHead(404).end("not found");
          return;
        }
        res.writeHead(200, { "Content-Type": mime(filePath) });
        res.end(fs.readFileSync(filePath));
        return;
      }

      // Convenience: root-level frontend assets if requested
      if (rel === "/index.html" || rel === "/manifest.json" || rel === "/sw.js") {
        const filePath = path.join(frontendDir, path.basename(rel));
        if (fs.existsSync(filePath)) {
          res.writeHead(200, { "Content-Type": mime(filePath) });
          res.end(fs.readFileSync(filePath));
          return;
        }
      }

      res.writeHead(404).end("not found");
    } catch (err) {
      res.writeHead(500).end(String(err.message || err));
    }
  });

  await new Promise((resolve, reject) => {
    server.listen(opts.httpPort, "0.0.0.0", (err) => (err ? reject(err) : resolve()));
  });

  if (opts.openBrowser) {
    const openCmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    try {
      spawn(openCmd, [httpBase], { stdio: "ignore", detached: true }).unref();
    } catch {
      /* ignore */
    }
  }

  const shutdown = () => {
    console.log("\nShutting down…");
    try {
      server.close();
    } catch {
      /* ignore */
    }
    try {
      agent.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function pairPageHtml({ payload, qrDataUrl, httpBase, joinUrl, appUrl }) {
  const json = JSON.stringify(payload, null, 2);
  const qrImg = qrDataUrl
    ? `<img src="${qrDataUrl}" alt="Join QR" width="280" height="280" style="display:block;margin:0 auto;border-radius:12px;background:#fff;padding:10px;" />`
    : `<pre style="text-align:left;font-size:11px;overflow:auto;">${escapeHtml(joinUrl)}</pre>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0A0A0C" />
  <title>Grok Remote · Pair</title>
  <link rel="icon" type="image/png" href="${httpBase}/app/assets/favicon.png" />
  <style>
    :root {
      --void:#050506; --bg:#0A0A0C; --surface:#121214; --border:rgba(255,255,255,.08);
      --text:#F4F4F5; --mute:#71717A; --dim:#A1A1AA; --accent:#E879F9;
      --font: system-ui, -apple-system, Segoe UI, sans-serif;
      --mono: ui-monospace, SF Mono, Menlo, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin:0; min-height:100vh; background:
        radial-gradient(900px 480px at 50% -5%, rgba(232,121,249,.08), transparent 55%), var(--void);
      color:var(--text); font-family:var(--font); text-align:center; padding:40px 18px 48px;
      -webkit-font-smoothing: antialiased;
    }
    .mark {
      width:52px; height:52px; margin:0 auto 16px; border-radius:14px; background:var(--surface);
      border:1px solid var(--border); display:flex; align-items:center; justify-content:center;
      box-shadow:0 0 40px rgba(232,121,249,.25);
    }
    .mark img { width:28px; height:28px; }
    .eyebrow { font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--mute); font-weight:500; }
    h1 { font-size:1.5rem; font-weight:600; letter-spacing:-.03em; margin:6px 0 8px; }
    .lead { color:var(--dim); font-size:14px; line-height:1.5; max-width:360px; margin:0 auto 22px; }
    .card {
      background:var(--surface); display:inline-block; padding:22px; border-radius:16px;
      border:1px solid var(--border); max-width:100%;
    }
    .urlbox {
      background:rgba(0,0,0,.35); border:1px solid var(--border); border-radius:12px;
      padding:12px 14px; margin:18px auto; max-width:440px; word-break:break-all;
      font-family:var(--mono); font-size:13px;
    }
    a { color:var(--accent); text-decoration:none; }
    a:hover { text-decoration:underline; }
    .meta { color:var(--mute); font-size:12px; margin-top:12px; font-family:var(--mono); }
    .hint {
      max-width:440px; margin:20px auto; text-align:left; color:var(--mute); font-size:12px;
      line-height:1.5; background:var(--surface); border:1px solid var(--border);
      border-radius:12px; padding:14px 16px;
    }
    .hint strong { color:var(--dim); }
    .hint code { color:var(--accent); font-size:11px; }
    .actions { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin-top:14px; }
    button {
      background:transparent; color:var(--dim); border:1px solid var(--border);
      padding:10px 14px; border-radius:999px; cursor:pointer; font-size:13px;
    }
    button:hover { border-color:rgba(255,255,255,.2); color:var(--text); }
    button.primary { background:var(--accent); color:#0A0A0C; border-color:transparent; font-weight:600; }
    pre {
      max-width:520px; margin:20px auto 0; text-align:left; background:var(--surface);
      padding:12px; border-radius:12px; font-size:10px; overflow:auto; color:var(--mute);
      border:1px solid var(--border); font-family:var(--mono);
    }
  </style>
</head>
<body>
  <div class="mark"><img src="${httpBase}/app/assets/spacexai-symbol-white.png" alt="SpaceXAI" /></div>
  <div class="eyebrow">SpaceXAI · Grok Build</div>
  <h1>Grok Remote</h1>
  <p class="lead">Scan with your phone camera to open the join link and pair with the agent on this machine.</p>
  <div class="card">${qrImg}</div>
  <div class="urlbox"><a href="${escapeHtml(joinUrl)}">${escapeHtml(joinUrl)}</a></div>
  <p class="meta">cwd · ${escapeHtml(payload.cwd)}</p>
  <div class="actions">
    <button class="primary" onclick='navigator.clipboard.writeText(${JSON.stringify(joinUrl)})'>Copy join URL</button>
    <button onclick='navigator.clipboard.writeText(${JSON.stringify(json)})'>Copy pair JSON</button>
    <a href="${escapeHtml(appUrl)}" style="display:inline-flex;align-items:center;padding:10px 14px;font-size:13px;">Open app here →</a>
  </div>
  <div class="hint">
    <strong>If the phone can’t load</strong>
    <ol style="margin:8px 0 0 18px;padding:0;">
      <li>Same Wi‑Fi as this PC (not guest isolation).</li>
      <li>NordVPN: <code>nordvpn set lan-discovery enable</code> and allowlist ports 3020 / 2419, or disconnect.</li>
      <li>Type the join URL manually in the phone browser.</li>
    </ol>
  </div>
  <pre>${escapeHtml(json)}</pre>
</body>
</html>`;
}

/** Phone-camera landing page: persist pair, then enter PWA. No external assets. */
function joinPageHtml({ payload, appUrl, httpBase }) {
  const pairJson = JSON.stringify(payload);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0A0A0C" />
  <meta http-equiv="Cache-Control" content="no-store" />
  <title>Joining Grok Remote…</title>
  <style>
    :root { --void:#050506; --accent:#E879F9; --text:#F4F4F5; --mute:#71717A; }
    body {
      margin:0; min-height:100vh; background:
        radial-gradient(700px 400px at 50% 0%, rgba(232,121,249,.08), transparent 55%), var(--void);
      color:var(--text); font-family:system-ui,-apple-system,sans-serif; text-align:center;
      padding:56px 20px; -webkit-font-smoothing:antialiased;
    }
    .mark {
      width:48px; height:48px; margin:0 auto 18px; border-radius:14px; background:#121214;
      border:1px solid rgba(255,255,255,.1); display:flex; align-items:center; justify-content:center;
    }
    .mark img { width:26px; height:26px; }
    .eyebrow { font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--mute); }
    h1 { font-size:1.25rem; font-weight:600; letter-spacing:-.02em; margin:8px 0 6px; }
    #msg { color:var(--mute); font-size:13px; }
    .spin {
      width:32px; height:32px; border:2px solid rgba(255,255,255,.1);
      border-top-color:var(--accent); border-radius:50%; margin:28px auto;
      animation:s .75s linear infinite;
    }
    @keyframes s { to { transform: rotate(360deg); } }
    a { color:var(--accent); font-size:14px; }
    .err { color:#F87171; margin-top:16px; white-space:pre-wrap; font-size:13px; }
    code { color:var(--mute); font-size:11px; word-break:break-all; font-family:ui-monospace,monospace; }
  </style>
</head>
<body>
  <div class="mark"><img src="${httpBase}/app/assets/spacexai-symbol-white.png" alt="" /></div>
  <div class="eyebrow">SpaceXAI</div>
  <h1>Joining Grok Remote</h1>
  <div class="spin" id="spin"></div>
  <p id="msg">Saving pair · local only</p>
  <p class="err" id="err" hidden></p>
  <p style="margin-top:20px;"><a id="manual" href="${escapeHtml(appUrl)}">Open app →</a></p>
  <p style="margin-top:28px;"><code>${escapeHtml(httpBase)}</code></p>
  <script>
    (function () {
      var KEY = "grokRemotePairV1";
      var APP = ${JSON.stringify(appUrl)};
      var EMBEDDED = ${pairJson};
      function go() {
        // cache-bust so old SW/HTML with unpkg is not reused
        var dest = APP + (APP.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now();
        location.replace(dest);
      }
      function save(p) {
        try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) {}
      }
      async function run() {
        // Always save embedded first so /app works even if fetch fails
        if (EMBEDDED && EMBEDDED.ws) save(EMBEDDED);
        try {
          var res = await fetch("/api/pair", { cache: "no-store" });
          if (res.ok) {
            var live = await res.json();
            if (live && live.ws) save(live);
          }
        } catch (e) {}
        document.getElementById("msg").textContent = "Paired — opening app…";
        setTimeout(go, 150);
      }
      run().catch(function (e) {
        document.getElementById("spin").style.display = "none";
        document.getElementById("err").hidden = false;
        document.getElementById("err").textContent = String(e && e.message || e);
        if (EMBEDDED && EMBEDDED.ws) {
          save(EMBEDDED);
          document.getElementById("msg").textContent = "Saved offline pair — tap Open app";
        }
      });
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function browserPairShim() {
  // Inlined browser-safe pair helpers (no Node path/os).
  return `
(function (root) {
  const DEFAULT_PORT = 2419;
  function buildWsUrl(host, port, secret) {
    return 'ws://' + host + ':' + port + '/ws?server-key=' + encodeURIComponent(secret);
  }
  function buildPairPayload(opts) {
    const host = opts.host, port = Number(opts.port || DEFAULT_PORT);
    const secret = String(opts.secret || ''), cwd = String(opts.cwd || '');
    if (!host || !secret || !cwd.startsWith('/')) throw new Error('invalid pair fields');
    const payload = { v: 1, ws: buildWsUrl(host, port, secret), secret, cwd, host, port, createdAt: new Date().toISOString() };
    if (opts.http) payload.http = opts.http;
    return payload;
  }
  function parsePairPayload(raw) {
    let data = raw;
    if (typeof raw === 'string') {
      const text = raw.trim();
      if (!text) return { ok: false, error: 'empty payload' };
      try { data = JSON.parse(text); }
      catch (e) {
        if (text.startsWith('ws://') || text.startsWith('wss://')) {
          try {
            const u = new URL(text);
            const secret = u.searchParams.get('server-key') || '';
            if (!secret) return { ok: false, error: 'ws URL missing server-key' };
            return { ok: true, payload: { v: 1, ws: text, secret, cwd: '/', host: u.hostname, port: Number(u.port || DEFAULT_PORT) } };
          } catch (err) { return { ok: false, error: err.message }; }
        }
        return { ok: false, error: 'not valid JSON' };
      }
    }
    if (!data || typeof data !== 'object') return { ok: false, error: 'must be object' };
    if (data.url && !data.ws && data.v !== 1) {
      return { ok: false, error: 'legacy Express pair payload — use Phase 2 launcher', legacy: data };
    }
    if (data.v !== 1) return { ok: false, error: 'unsupported version ' + data.v };
    const secret = data.secret || '';
    let ws = data.ws;
    const host = data.host;
    const port = Number(data.port || DEFAULT_PORT);
    const cwd = data.cwd;
    if (!cwd || !String(cwd).startsWith('/')) return { ok: false, error: 'absolute cwd required' };
    if (!secret) return { ok: false, error: 'secret required' };
    if (!ws) {
      if (!host) return { ok: false, error: 'ws or host required' };
      ws = buildWsUrl(host, port, secret);
    }
    try {
      const u = new URL(ws);
      if (!u.searchParams.get('server-key')) {
        u.searchParams.set('server-key', secret);
        ws = u.toString();
      }
    } catch (e) { return { ok: false, error: 'invalid ws URL' }; }
    const payload = { v: 1, ws, secret, cwd, host: host || new URL(ws).hostname, port: port || Number(new URL(ws).port || DEFAULT_PORT), createdAt: data.createdAt || new Date().toISOString() };
    if (data.http) payload.http = data.http;
    return { ok: true, payload };
  }
  root.GrokPair = { DEFAULT_PORT, buildWsUrl, buildPairPayload, parsePairPayload };
})(typeof window !== 'undefined' ? window : globalThis);
`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
