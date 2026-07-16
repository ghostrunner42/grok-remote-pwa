/**
 * Discover Grok Build sessions on disk for a project cwd.
 * Used by the launcher to attach the phone to an existing TUI/headless session.
 *
 * Layout (see grok sessions docs):
 *   ~/.grok/sessions/<url-encoded-cwd>/<session-id>/summary.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Encode cwd the way Grok groups session dirs (URL-encode full path).
 * @param {string} cwd
 */
function encodeSessionCwd(cwd) {
  const abs = path.resolve(cwd);
  // encodeURIComponent produces %2F for slashes — matches Grok's layout
  return encodeURIComponent(abs);
}

/**
 * @param {string} [grokHome]
 */
function sessionsRoot(grokHome) {
  const home = grokHome || process.env.GROK_HOME || path.join(os.homedir(), ".grok");
  return path.join(home, "sessions");
}

/**
 * @param {string} cwd
 * @param {{ grokHome?: string }} [opts]
 * @returns {{ sessionId: string, dir: string, mtimeMs: number, summary?: object }[]}
 */
function listLocalSessionsForCwd(cwd, opts = {}) {
  const root = sessionsRoot(opts.grokHome);
  const group = path.join(root, encodeSessionCwd(cwd));
  if (!fs.existsSync(group) || !fs.statSync(group).isDirectory()) {
    return [];
  }

  const out = [];
  for (const name of fs.readdirSync(group)) {
    if (!UUID_RE.test(name)) continue;
    const dir = path.join(group, name);
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    let summary = null;
    let mtimeMs = st.mtimeMs;
    const summaryPath = path.join(dir, "summary.json");
    try {
      if (fs.existsSync(summaryPath)) {
        const raw = fs.readFileSync(summaryPath, "utf8");
        summary = JSON.parse(raw);
        const updated =
          summary.updated_at ||
          summary.updatedAt ||
          summary.last_active_at ||
          summary.lastActiveAt;
        if (updated) {
          const t = Date.parse(updated);
          if (!Number.isNaN(t)) mtimeMs = t;
        } else {
          mtimeMs = fs.statSync(summaryPath).mtimeMs;
        }
      }
    } catch {
      /* ignore bad summary */
    }

    out.push({ sessionId: name, dir, mtimeMs, summary });
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Most recently updated local session for cwd, or null.
 * @param {string} cwd
 * @param {{ grokHome?: string }} [opts]
 * @returns {{ sessionId: string, dir: string, mtimeMs: number, summary?: object }|null}
 */
function findLatestSessionForCwd(cwd, opts = {}) {
  const list = listLocalSessionsForCwd(cwd, opts);
  return list[0] || null;
}

/**
 * Fallback: parse `grok sessions list` (prefer status "local").
 * @param {string} cwd
 * @param {{ grokBin?: string }} [opts]
 * @returns {string|null} sessionId
 */
function findLatestSessionViaCli(cwd, opts = {}) {
  const grokBin = opts.grokBin || process.env.GROK_BIN || "grok";
  const res = spawnSync(grokBin, ["sessions", "list", "--limit", "20"], {
    encoding: "utf8",
    cwd: path.resolve(cwd),
    timeout: 15_000,
  });
  if (res.error || res.status !== 0) return null;
  const text = (res.stdout || "") + "\n" + (res.stderr || "");
  const lines = text.split(/\r?\n/);
  let bestLocal = null;
  let bestAny = null;
  for (const line of lines) {
    const m = line.match(
      /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+/i
    );
    if (!m) continue;
    const id = m[1];
    const isLocal = /\blocal\b/i.test(line);
    if (isLocal && !bestLocal) bestLocal = id;
    if (!bestAny) bestAny = id;
  }
  return bestLocal || bestAny;
}

/**
 * Resolve attach target from flags / discovery.
 * @param {string} cwd
 * @param {{
 *   sessionId?: string|null,
 *   continueSession?: boolean,
 *   grokHome?: string,
 *   grokBin?: string,
 * }} opts
 * @returns {{ sessionId: string|null, source: string, candidates: number }}
 */
function resolveAttachSession(cwd, opts = {}) {
  if (opts.sessionId) {
    const id = String(opts.sessionId).trim();
    if (!UUID_RE.test(id)) {
      throw new Error(
        `Invalid --session id (expected UUID): ${id}`
      );
    }
    return { sessionId: id, source: "flag", candidates: 1 };
  }

  if (!opts.continueSession) {
    return { sessionId: null, source: "none", candidates: 0 };
  }

  const local = listLocalSessionsForCwd(cwd, { grokHome: opts.grokHome });
  if (local[0]) {
    return {
      sessionId: local[0].sessionId,
      source: "disk",
      candidates: local.length,
    };
  }

  const viaCli = findLatestSessionViaCli(cwd, { grokBin: opts.grokBin });
  if (viaCli) {
    return { sessionId: viaCli, source: "cli", candidates: 1 };
  }

  return { sessionId: null, source: "not-found", candidates: 0 };
}

module.exports = {
  UUID_RE,
  encodeSessionCwd,
  sessionsRoot,
  listLocalSessionsForCwd,
  findLatestSessionForCwd,
  findLatestSessionViaCli,
  resolveAttachSession,
};
