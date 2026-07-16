/**
 * Grok Remote pair payload v1
 *
 * QR codes and deep-links carry this JSON so a phone PWA can connect
 * to official `grok agent serve` without the old Express mock backend.
 *
 * Example:
 * {
 *   "v": 1,
 *   "ws": "ws://192.168.1.248:2419/ws?server-key=abc",
 *   "secret": "abc",
 *   "cwd": "/home/you/project",
 *   "host": "192.168.1.248",
 *   "port": 2419
 * }
 */

const DEFAULT_PORT = 2419;

/**
 * @typedef {Object} PairPayloadV1
 * @property {1} v
 * @property {string} ws       Full WebSocket URL including server-key
 * @property {string} secret
 * @property {string} cwd      Absolute project path on the desktop
 * @property {string} [host]
 * @property {number} [port]
 * @property {string} [http]   Optional URL where the PWA is hosted
 * @property {string} [createdAt]
 */

/**
 * Build a WebSocket URL for grok agent serve.
 * @param {string} host
 * @param {number} port
 * @param {string} secret
 */
function buildWsUrl(host, port, secret) {
  const key = encodeURIComponent(secret);
  return `ws://${host}:${port}/ws?server-key=${key}`;
}

/**
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port]
 * @param {string} opts.secret
 * @param {string} opts.cwd
 * @param {string} [opts.http]
 * @returns {PairPayloadV1}
 */
function buildPairPayload(opts) {
  const host = opts.host;
  const port = Number(opts.port || DEFAULT_PORT);
  const secret = String(opts.secret || "");
  const cwd = String(opts.cwd || "");

  if (!host) throw new Error("pair payload requires host");
  if (!secret) throw new Error("pair payload requires secret");
  if (!cwd || !cwd.startsWith("/")) {
    throw new Error("pair payload requires absolute cwd");
  }

  /** @type {PairPayloadV1} */
  const payload = {
    v: 1,
    ws: buildWsUrl(host, port, secret),
    secret,
    cwd,
    host,
    port,
    createdAt: new Date().toISOString(),
  };

  if (opts.http) payload.http = opts.http;
  return payload;
}

/**
 * Parse and validate a pair payload from QR text or settings paste.
 * Accepts v1 objects, or legacy { url, token } for a soft migration hint.
 * @param {string|object} raw
 * @returns {{ ok: true, payload: PairPayloadV1 } | { ok: false, error: string, legacy?: object }}
 */
function parsePairPayload(raw) {
  let data = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return { ok: false, error: "empty payload" };
    try {
      data = JSON.parse(text);
    } catch {
      // Plain ws:// URL with optional secret not in JSON
      if (text.startsWith("ws://") || text.startsWith("wss://")) {
        try {
          const u = new URL(text);
          const secret = u.searchParams.get("server-key") || "";
          if (!secret) {
            return { ok: false, error: "ws URL missing server-key query param" };
          }
          const host = u.hostname;
          const port = Number(u.port || DEFAULT_PORT);
          return {
            ok: true,
            payload: buildPairPayload({
              host,
              port,
              secret,
              cwd: process.env.CWD || "/tmp",
            }),
          };
        } catch (e) {
          return { ok: false, error: `invalid ws URL: ${e.message}` };
        }
      }
      return { ok: false, error: "payload is not valid JSON" };
    }
  }

  if (!data || typeof data !== "object") {
    return { ok: false, error: "payload must be an object" };
  }

  // Legacy Express QR: { url, token }
  if (data.url && !data.ws && data.v !== 1) {
    return {
      ok: false,
      error: "legacy Express pair payload (v0) — start the Phase 2 launcher instead",
      legacy: data,
    };
  }

  if (data.v !== 1) {
    return { ok: false, error: `unsupported pair version: ${data.v}` };
  }

  const secret = data.secret || "";
  let ws = data.ws;
  const host = data.host;
  const port = Number(data.port || DEFAULT_PORT);
  const cwd = data.cwd;

  if (!cwd || typeof cwd !== "string" || !cwd.startsWith("/")) {
    return { ok: false, error: "v1 payload requires absolute cwd" };
  }
  if (!secret) {
    return { ok: false, error: "v1 payload requires secret" };
  }

  if (!ws) {
    if (!host) return { ok: false, error: "v1 payload requires ws or host" };
    ws = buildWsUrl(host, port, secret);
  }

  // Ensure server-key is present on ws
  try {
    const u = new URL(ws);
    if (!u.searchParams.get("server-key")) {
      u.searchParams.set("server-key", secret);
      ws = u.toString();
    }
  } catch {
    return { ok: false, error: "v1 payload has invalid ws URL" };
  }

  /** @type {PairPayloadV1} */
  const payload = {
    v: 1,
    ws,
    secret,
    cwd,
    host: host || new URL(ws).hostname,
    port: port || Number(new URL(ws).port || DEFAULT_PORT),
    createdAt: data.createdAt || new Date().toISOString(),
  };
  if (data.http) payload.http = data.http;

  return { ok: true, payload };
}

/**
 * Score a candidate IPv4 for phone↔desktop LAN pairing (higher = better).
 * Never prefer loopback or typical VPN tunnels when a real LAN iface exists.
 */
function scoreLanCandidate(addr, ifName) {
  const name = String(ifName || "").toLowerCase();
  let score = 0;

  if (addr === "127.0.0.1" || addr.startsWith("127.")) return -1000;

  // Prefer classic home/office LAN
  if (addr.startsWith("192.168.")) score += 100;
  else if (addr.startsWith("10.")) score += 40;
  else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(addr)) score += 50;
  else score += 10; // public / other

  // Interface name hints
  if (/^(en|eth|wl|wlan|wi-?fi|wlp|enp|eno)/.test(name)) score += 30;
  if (name.includes("docker") || name.includes("br-") || name.includes("veth"))
    score -= 80;
  if (
    name.includes("nord") ||
    name.includes("tun") ||
    name.includes("tap") ||
    name.includes("wg") ||
    name.includes("tailscale") ||
    name.includes("utun") ||
    name === "nordlynx"
  ) {
    score -= 100;
  }

  // Known VPN / overlay ranges
  if (
    addr.startsWith("10.5.") || // nordlynx often
    addr.startsWith("10.8.") ||
    addr.startsWith("100.64.") || // CGNAT / some mesh
    addr.startsWith("10.0.0.") // sometimes docker — slight penalty only
  ) {
    score -= 50;
  }

  return score;
}

/**
 * List non-internal IPv4 candidates with scores (for launcher diagnostics).
 * @param {import('os')} os
 * @returns {{ addr: string, name: string, score: number }[]}
 */
function listLanCandidates(os) {
  const nets = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const family = net.family;
      if (family !== "IPv4" && family !== 4) continue;
      if (net.internal) continue;
      const addr = net.address;
      candidates.push({
        addr,
        name,
        score: scoreLanCandidate(addr, name),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

/**
 * Pick a LAN IPv4 suitable for phone ↔ desktop pairing.
 * @param {import('os')} os
 * @param {string} [preferred]
 * @param {{ allowLocalhost?: boolean }} [opts]
 */
function detectLanIp(os, preferred, opts = {}) {
  if (preferred) return preferred;

  const candidates = listLanCandidates(os);
  const best = candidates.find((c) => c.score > 0) || candidates[0];

  if (best && best.score > -50) return best.addr;

  if (opts.allowLocalhost) return "127.0.0.1";
  return null;
}

function randomSecret() {
  return (
    "grk_" +
    Math.random().toString(36).slice(2, 12) +
    Math.random().toString(36).slice(2, 12)
  );
}

module.exports = {
  DEFAULT_PORT,
  buildWsUrl,
  buildPairPayload,
  parsePairPayload,
  detectLanIp,
  listLanCandidates,
  scoreLanCandidate,
  randomSecret,
};
