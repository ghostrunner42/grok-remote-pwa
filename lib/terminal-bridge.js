/**
 * Desktop terminal host for ACP terminal/* methods.
 * Shell always runs on the PC (launcher process), never on the phone.
 */

const { spawn } = require("child_process");
const { randomBytes } = require("crypto");

function createTerminalHost({ defaultCwd = process.cwd(), log = () => {} } = {}) {
  /** @type {Map<string, any>} */
  const terminals = new Map();

  function makeId() {
    return "term_" + randomBytes(8).toString("hex");
  }

  /**
   * @param {{
   *   command: string,
   *   args?: string[],
   *   env?: {name:string,value:string}[],
   *   cwd?: string,
   *   outputByteLimit?: number
   * }} opts
   */
  function create(opts) {
    const terminalId = makeId();
    const cwd = opts.cwd || defaultCwd;
    const limit = Math.max(1024, Number(opts.outputByteLimit) || 200_000);

    const env = { ...process.env };
    for (const e of opts.env || []) {
      if (e && e.name) env[e.name] = e.value ?? "";
    }

    // Agent often sends full shell line as command; args optional
    let cmd = opts.command;
    let args = Array.isArray(opts.args) ? opts.args.slice() : [];
    let shell = false;
    if (!args.length && /[\s|;&<>$`]/.test(cmd)) {
      // already a shell command string
      shell = true;
    }

    log("term", `create ${terminalId} cwd=${cwd} cmd=${cmd}`);

    const child = shell
      ? spawn(cmd, {
          cwd,
          env,
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(cmd, args, {
          cwd,
          env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });

    const state = {
      id: terminalId,
      child,
      output: "",
      truncated: false,
      exitCode: null,
      signal: null,
      exited: false,
      waiters: [],
      limit,
      createdAt: Date.now(),
    };

    const append = (chunk) => {
      state.output += chunk.toString("utf8");
      if (Buffer.byteLength(state.output, "utf8") > limit) {
        // Truncate from the start at a char boundary
        let drop = Buffer.byteLength(state.output, "utf8") - limit;
        let i = 0;
        while (drop > 0 && i < state.output.length) {
          const c = state.output[i];
          drop -= Buffer.byteLength(c, "utf8");
          i += 1;
        }
        state.output = state.output.slice(i);
        state.truncated = true;
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err) => {
      append(`\n[terminal error] ${err.message}\n`);
      state.exited = true;
      state.exitCode = 1;
      flushWaiters();
    });
    child.on("close", (code, signal) => {
      state.exited = true;
      state.exitCode = code;
      state.signal = signal;
      flushWaiters();
      log("term", `exit ${terminalId} code=${code} signal=${signal}`);
    });

    function flushWaiters() {
      const w = state.waiters.splice(0);
      for (const fn of w) fn();
    }

    terminals.set(terminalId, state);
    return { terminalId };
  }

  function get(id) {
    return terminals.get(id);
  }

  function output(terminalId) {
    const t = terminals.get(terminalId);
    if (!t) throw new Error(`unknown terminal ${terminalId}`);
    const result = {
      output: t.output,
      truncated: t.truncated,
    };
    if (t.exited) {
      result.exitStatus = {
        exitCode: t.exitCode,
        signal: t.signal,
      };
    }
    return result;
  }

  function waitForExit(terminalId, { timeoutMs = 600_000 } = {}) {
    const t = terminals.get(terminalId);
    if (!t) return Promise.reject(new Error(`unknown terminal ${terminalId}`));
    if (t.exited) {
      return Promise.resolve({ exitCode: t.exitCode, signal: t.signal });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`wait_for_exit timeout ${terminalId}`));
      }, timeoutMs);
      t.waiters.push(() => {
        clearTimeout(timer);
        resolve({ exitCode: t.exitCode, signal: t.signal });
      });
    });
  }

  function kill(terminalId) {
    const t = terminals.get(terminalId);
    if (!t) throw new Error(`unknown terminal ${terminalId}`);
    if (!t.exited && t.child && !t.child.killed) {
      try {
        t.child.kill("SIGTERM");
        setTimeout(() => {
          if (!t.exited) {
            try {
              t.child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          }
        }, 2000);
      } catch {
        /* ignore */
      }
    }
    return {};
  }

  function release(terminalId) {
    const t = terminals.get(terminalId);
    if (!t) return {};
    if (!t.exited && t.child) {
      try {
        t.child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    terminals.delete(terminalId);
    return {};
  }

  /** Express-ish request handler factory for Node http */
  function handleHttp(req, res, url, secret) {
    const auth =
      req.headers["x-grok-remote-secret"] ||
      url.searchParams.get("secret") ||
      "";
    if (secret && auth !== secret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return true;
    }

    const pathName = url.pathname;
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-Grok-Remote-Secret",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return true;
    }

    const readBody = () =>
      new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            resolve(raw ? JSON.parse(raw) : {});
          } catch (e) {
            reject(e);
          }
        });
        req.on("error", reject);
      });

    const json = (code, obj) => {
      res.writeHead(code, {
        "Content-Type": "application/json",
        ...cors,
      });
      res.end(JSON.stringify(obj));
    };

    if (pathName === "/api/term/create" && req.method === "POST") {
      readBody()
        .then((body) => {
          const r = create(body);
          json(200, r);
        })
        .catch((e) => json(400, { error: e.message }));
      return true;
    }

    const m = pathName.match(/^\/api\/term\/([^/]+)\/(output|wait|kill|release)$/);
    if (m) {
      const id = m[1];
      const action = m[2];
      try {
        if (action === "output" && req.method === "GET") {
          json(200, output(id));
          return true;
        }
        if (action === "wait" && (req.method === "GET" || req.method === "POST")) {
          waitForExit(id)
            .then((r) => json(200, r))
            .catch((e) => json(400, { error: e.message }));
          return true;
        }
        if (action === "kill" && req.method === "POST") {
          json(200, kill(id));
          return true;
        }
        if (action === "release" && req.method === "POST") {
          json(200, release(id));
          return true;
        }
      } catch (e) {
        json(400, { error: e.message });
        return true;
      }
    }

    return false;
  }

  return {
    create,
    output,
    waitForExit,
    kill,
    release,
    handleHttp,
    setDefaultCwd(cwd) {
      defaultCwd = cwd;
    },
  };
}

module.exports = { createTerminalHost };
