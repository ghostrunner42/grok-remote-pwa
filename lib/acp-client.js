/**
 * ACP WebSocket client for Grok Remote (Node + browser).
 * Phases 2–5: handshake, prompt streaming, permissions, fs helpers.
 */

function createAcpClient(WebSocketImpl) {
  class AcpWsClient {
    constructor(url, { log = () => {} } = {}) {
      this.url = url;
      this.ws = null;
      this.nextId = 1;
      this.pending = new Map();
      this.onNotification = null;
      /** @type {(method: string, params: any) => Promise<any>|any} */
      this.onAgentRequest = null;
      /**
       * Permission mode:
       *  - 'auto'  — pick allow_once / first allow option
       *  - 'deny'  — reject
       *  - 'prompt'— call onPermissionRequest(params) → optionId or { outcome }
       */
      this.permissionMode = "auto";
      /** @type {(params: any) => Promise<string|object>} */
      this.onPermissionRequest = null;
      /** Optional Node-style fs for client-side fs/* (Node e2e only) */
      this.localFs = null;
      /**
       * Terminal execution:
       *  - terminalHost: Node createTerminalHost() instance (in-process)
       *  - terminalBridge: { baseUrl, secret } HTTP bridge (browser → launcher)
       */
      this.terminalHost = null;
      this.terminalBridge = null;
      this.log = log;
      this.agentInfo = null;
      this.sessionId = null;
      this._closed = false;
    }

    connect({ timeoutMs = 10_000 } = {}) {
      this._closed = false;
      return new Promise((resolve, reject) => {
        this.log("ws", `connecting ${this.url}`);
        this.ws = new WebSocketImpl(this.url);

        const timer = setTimeout(() => {
          cleanup();
          try {
            this.ws.close();
          } catch {
            /* ignore */
          }
          reject(new Error(`WebSocket connect timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        const onOpen = () => {
          cleanup();
          this.log("ws", "open");
          resolve();
        };
        const onError = (err) => {
          cleanup();
          reject(err?.error || err || new Error("WebSocket error"));
        };
        const cleanup = () => {
          clearTimeout(timer);
          this.ws.removeEventListener?.("open", onOpen);
          this.ws.removeEventListener?.("error", onError);
          this.ws.off?.("open", onOpen);
          this.ws.off?.("error", onError);
        };

        if (this.ws.addEventListener) {
          this.ws.addEventListener("open", onOpen);
          this.ws.addEventListener("error", onError);
          this.ws.addEventListener("message", (ev) =>
            this._onMessage(ev.data ?? ev)
          );
          this.ws.addEventListener("close", (ev) => {
            this.log("ws", `closed code=${ev.code}`);
            this._closed = true;
            this._rejectAll(new Error("WebSocket closed"));
            if (typeof this.onClose === "function") {
              try {
                this.onClose(ev);
              } catch {
                /* ignore */
              }
            }
          });
        } else {
          this.ws.on("open", onOpen);
          this.ws.on("error", onError);
          this.ws.on("message", (data) => this._onMessage(data));
          this.ws.on("close", (code) => {
            this.log("ws", `closed code=${code}`);
            this._closed = true;
            this._rejectAll(new Error("WebSocket closed"));
            if (typeof this.onClose === "function") {
              try {
                this.onClose({ code });
              } catch {
                /* ignore */
              }
            }
          });
        }
      });
    }

    get ready() {
      if (!this.ws) return false;
      // Browser: OPEN=1; Node ws: same
      return this.ws.readyState === 1;
    }

    _rejectAll(err) {
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    }

    _onMessage(raw) {
      const text = typeof raw === "string" ? raw : raw.toString();
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        this.log("ws", "non-JSON", text.slice(0, 120));
        return;
      }

      if (
        msg.id !== undefined &&
        (msg.result !== undefined || msg.error !== undefined)
      ) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(
            Object.assign(new Error(msg.error.message || "RPC error"), {
              code: msg.error.code,
              raw: msg.error,
            })
          );
        } else {
          pending.resolve(msg.result);
        }
        return;
      }

      if (msg.method && msg.id !== undefined) {
        this._handleAgentRequest(msg);
        return;
      }

      if (msg.method && this.onNotification) {
        this.onNotification(msg);
      }
    }

    async _handleAgentRequest(msg) {
      const { method, params, id } = msg;
      try {
        if (this.onAgentRequest) {
          const result = await this.onAgentRequest(method, params);
          if (result !== undefined) {
            this._respond(id, result ?? {});
            return;
          }
        }

        if (method === "session/request_permission") {
          const outcome = await this._resolvePermission(params);
          this._respond(id, outcome);
          return;
        }

        if (method === "fs/read_text_file" && this.localFs) {
          const content = this.localFs.readFileSync(params.path, "utf8");
          this._respond(id, { content });
          return;
        }

        if (method === "fs/write_text_file" && this.localFs) {
          this.localFs.writeFileSync(params.path, params.content ?? "", "utf8");
          this._respond(id, {});
          return;
        }

        // Browser: fs reads are fulfilled by agent tools, not client — soft deny
        if (method === "fs/read_text_file" || method === "fs/write_text_file") {
          this._respondError(
            id,
            -32000,
            "Client filesystem not available in browser; use agent tools"
          );
          return;
        }

        // ACP terminal/* — desktop host or HTTP bridge
        if (method.startsWith("terminal/")) {
          const result = await this._handleTerminal(method, params);
          this._respond(id, result);
          return;
        }

        this.log("client-method", `unhandled ${method}`);
        this._respondError(id, -32601, `Not implemented: ${method}`);
      } catch (err) {
        this._respondError(id, -32000, String(err.message || err));
      }
    }

    async _handleTerminal(method, params) {
      const host = this.terminalHost;
      const bridge = this.terminalBridge;

      if (host) {
        if (method === "terminal/create") {
          return host.create({
            command: params.command,
            args: params.args,
            env: params.env,
            cwd: params.cwd || this._cwd,
            outputByteLimit: params.outputByteLimit,
          });
        }
        if (method === "terminal/output") {
          return host.output(params.terminalId);
        }
        if (method === "terminal/wait_for_exit") {
          return host.waitForExit(params.terminalId);
        }
        if (method === "terminal/kill") {
          return host.kill(params.terminalId);
        }
        if (method === "terminal/release") {
          return host.release(params.terminalId);
        }
        throw new Error(`Unknown terminal method ${method}`);
      }

      if (bridge && bridge.baseUrl) {
        return this._terminalBridgeFetch(method, params, bridge);
      }

      throw new Error(
        "Shell not available: no terminal host/bridge (start grok-remote launcher)"
      );
    }

    async _terminalBridgeFetch(method, params, bridge) {
      const base = String(bridge.baseUrl).replace(/\/$/, "");
      const headers = {
        "Content-Type": "application/json",
        "X-Grok-Remote-Secret": bridge.secret || "",
      };

      const fetchFn =
        typeof fetch !== "undefined"
          ? fetch
          : (...args) =>
              import("node:http").then(() => {
                throw new Error("fetch not available in this Node version");
              });

      if (method === "terminal/create") {
        const res = await fetchFn(`${base}/api/term/create`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            command: params.command,
            args: params.args,
            env: params.env,
            cwd: params.cwd || this._cwd,
            outputByteLimit: params.outputByteLimit,
          }),
        });
        if (!res.ok) {
          const t = await res.text();
          throw new Error(`term create failed: ${res.status} ${t}`);
        }
        return res.json();
      }

      const id = params.terminalId;
      if (!id) throw new Error("terminalId required");

      if (method === "terminal/output") {
        const res = await fetchFn(`${base}/api/term/${encodeURIComponent(id)}/output`, {
          headers,
        });
        if (!res.ok) throw new Error(`term output ${res.status}`);
        return res.json();
      }

      if (method === "terminal/wait_for_exit") {
        const res = await fetchFn(`${base}/api/term/${encodeURIComponent(id)}/wait`, {
          method: "POST",
          headers,
        });
        if (!res.ok) throw new Error(`term wait ${res.status}`);
        return res.json();
      }

      if (method === "terminal/kill") {
        const res = await fetchFn(`${base}/api/term/${encodeURIComponent(id)}/kill`, {
          method: "POST",
          headers,
        });
        if (!res.ok) throw new Error(`term kill ${res.status}`);
        return res.json();
      }

      if (method === "terminal/release") {
        const res = await fetchFn(`${base}/api/term/${encodeURIComponent(id)}/release`, {
          method: "POST",
          headers,
        });
        if (!res.ok) throw new Error(`term release ${res.status}`);
        return res.json();
      }

      throw new Error(`Unknown terminal method ${method}`);
    }

    async _resolvePermission(params) {
      const options = params?.options || [];
      const pickAllow = () => {
        const allow =
          options.find((o) => o.optionId === "allow_once") ||
          options.find((o) => o.kind === "allow_once") ||
          options.find((o) => /allow/i.test(o.optionId || o.name || "")) ||
          options[0];
        return {
          outcome: {
            outcome: "selected",
            optionId: allow?.optionId || allow?.id || "allow_once",
          },
        };
      };
      const pickDeny = () => {
        const deny =
          options.find((o) => o.optionId === "reject_once") ||
          options.find((o) => /reject|deny/i.test(o.optionId || "")) ||
          null;
        if (deny) {
          return {
            outcome: {
              outcome: "selected",
              optionId: deny.optionId || deny.id,
            },
          };
        }
        return { outcome: { outcome: "cancelled" } };
      };

      if (this.permissionMode === "auto") return pickAllow();
      if (this.permissionMode === "deny") return pickDeny();

      if (this.onPermissionRequest) {
        const choice = await this.onPermissionRequest(params);
        if (typeof choice === "string") {
          return { outcome: { outcome: "selected", optionId: choice } };
        }
        if (choice && choice.outcome) return choice;
        if (choice && choice.optionId) {
          return { outcome: { outcome: "selected", optionId: choice.optionId } };
        }
      }
      return pickAllow();
    }

    request(method, params, { timeoutMs = 120_000 } = {}) {
      const id = this.nextId++;
      const payload = { jsonrpc: "2.0", id, method, params };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Timeout ${timeoutMs}ms on ${method}`));
        }, timeoutMs);

        this.pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });

        this.log("→", method, `id=${id}`);
        this.ws.send(JSON.stringify(payload));
      });
    }

    notify(method, params) {
      // Omit params when undefined — some agents reject empty {}
      const msg = { jsonrpc: "2.0", method };
      if (params !== undefined) msg.params = params;
      this.ws.send(JSON.stringify(msg));
    }

    _respond(id, result) {
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    }

    _respondError(id, code, message) {
      this.ws.send(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })
      );
    }

    /**
     * After initialize, authenticate if the agent advertised methods.
     * Grok uses cached desktop credentials (methodId: cached_token).
     */
    async authenticateIfNeeded(initResult) {
      const methods = initResult?.authMethods || [];
      if (!methods.length) return null;

      const preferred =
        initResult?._meta?.defaultAuthMethodId ||
        methods.find((m) => m.id === "cached_token")?.id ||
        methods[0]?.id;

      if (!preferred) return null;

      this.log("auth", `authenticate methodId=${preferred}`);
      try {
        return await this.request(
          "authenticate",
          { methodId: preferred },
          { timeoutMs: 30_000 }
        );
      } catch (err) {
        // Some builds auto-auth via serve secret; don't hard-fail reconnect
        this.log("auth", "authenticate failed:", err.message);
        return null;
      }
    }

    async handshake(opts = {}) {
      const initResult = await this.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
          clientInfo: {
            name: "grok-remote-pwa",
            title: "Grok Remote",
            version: "0.4.0",
          },
        },
        { timeoutMs: 30_000 }
      );
      this.agentInfo = initResult;

      // Do NOT send LSP-style notifications/initialized — Grok logs
      // "Method not found" and can destabilize the worker.

      await this.authenticateIfNeeded(initResult);

      let session = null;
      if (opts.createSession !== false && opts.cwd) {
        // Prefer resume when we have a prior session id
        if (opts.resumeSessionId && initResult?.agentCapabilities?.loadSession) {
          try {
            session = await this.request(
              "session/load",
              {
                sessionId: opts.resumeSessionId,
                cwd: opts.cwd,
                mcpServers: [],
              },
              { timeoutMs: 60_000 }
            );
            this.log("session", "resumed", opts.resumeSessionId);
          } catch (err) {
            this.log("session", "resume failed, creating new:", err.message);
            session = null;
          }
        }

        if (!session) {
          session = await this.request(
            "session/new",
            { cwd: opts.cwd, mcpServers: [] },
            { timeoutMs: 60_000 }
          );
        }
        this.sessionId = session?.sessionId || session?.session_id || null;
      }

      return { initResult, session };
    }

    /**
     * Send a user prompt and stream updates until the prompt RPC completes.
     * @param {string} text
     * @param {{
     *   sessionId?: string,
     *   onUpdate?: (update: object, raw: object) => void,
     *   timeoutMs?: number
     * }} [opts]
     */
    async prompt(text, opts = {}) {
      const sessionId = opts.sessionId || this.sessionId;
      if (!sessionId) throw new Error("No sessionId — call handshake first");

      const prev = this.onNotification;
      const onUpdate = opts.onUpdate || (() => {});

      this.onNotification = (msg) => {
        try {
          if (prev) prev(msg);
        } catch {
          /* ignore */
        }

        if (msg.method === "session/update") {
          const update = msg.params?.update ?? msg.params;
          if (update) onUpdate(update, msg);
          return;
        }

        // Grok extensions often nest updates here
        if (
          msg.method === "_x.ai/session_notification" ||
          msg.method === "x.ai/session_notification"
        ) {
          const update = msg.params?.update;
          if (update) onUpdate(update, msg);
        }
      };

      try {
        const result = await this.request(
          "session/prompt",
          {
            sessionId,
            prompt: [{ type: "text", text }],
          },
          { timeoutMs: opts.timeoutMs || 300_000 }
        );
        return result;
      } finally {
        this.onNotification = prev;
      }
    }

    async cancel() {
      if (!this.sessionId) return;
      try {
        this.notify("session/cancel", { sessionId: this.sessionId });
      } catch {
        /* ignore */
      }
    }

    // --- Filesystem helpers (agent-side extensions; best-effort) ---

    async fsList(relOrAbsPath = "") {
      const path = this._absPath(relOrAbsPath);
      // Grok agent serve exposes underscore-prefixed extensions
      const attempts = [
        ["_x.ai/fs/list", { path }],
        ["x.ai/fs/list", { path }],
      ];
      for (const [method, params] of attempts) {
        try {
          const r = await this.request(method, params, { timeoutMs: 20_000 });
          return this._normalizeList(r, path);
        } catch (e) {
          this.log("fsList", method, e.message);
        }
      }
      throw new Error(
        "x.ai/fs/list not available on this agent; files tab limited"
      );
    }

    async fsRead(relOrAbsPath) {
      const path = this._absPath(relOrAbsPath);
      const attempts = [
        ["_x.ai/fs/read_file", { path }],
        ["x.ai/fs/read_file", { path }],
      ];
      for (const [method, params] of attempts) {
        try {
          const r = await this.request(method, params, { timeoutMs: 30_000 });
          const body = r?.result ?? r;
          if (typeof body === "string") return body;
          if (body?.content != null) return body.content;
          if (body?.text != null) return body.text;
          return JSON.stringify(body, null, 2);
        } catch (e) {
          this.log("fsRead", method, e.message);
        }
      }
      throw new Error("x.ai/fs/read_file not available");
    }

    async fsWrite(relOrAbsPath, content) {
      const path = this._absPath(relOrAbsPath);
      const attempts = [
        ["_x.ai/fs/write_file", { path, content }],
        ["x.ai/fs/write_file", { path, content }],
      ];
      for (const [method, params] of attempts) {
        try {
          return await this.request(method, params, { timeoutMs: 30_000 });
        } catch (e) {
          this.log("fsWrite", method, e.message);
        }
      }
      throw new Error("x.ai/fs/write_file not available");
    }

    _absPath(p) {
      if (!p || p === "/" || p === ".") {
        return this._cwd || p || "/";
      }
      if (String(p).startsWith("/")) return p;
      const base = (this._cwd || "").replace(/\/$/, "");
      return `${base}/${p}`.replace(/\/+/g, "/");
    }

    setCwd(cwd) {
      this._cwd = cwd;
    }

    _normalizeList(result, path) {
      // RPC result may be { result: { nodes: [...] } } or flat
      const body = result?.result ?? result;
      let entries =
        body?.nodes || body?.files || body?.entries || body?.items || body;
      if (!Array.isArray(entries)) {
        if (body && typeof body === "object") {
          entries = Object.keys(body).map((k) => ({ name: k, ...body[k] }));
        } else {
          entries = [];
        }
      }
      return {
        path,
        files: entries.map((e) => {
          if (typeof e === "string") {
            return { name: e, isDirectory: false, path: e };
          }
          const name = e.name || e.path || e.fileName || String(e);
          const isDirectory = !!(
            e.isDirectory ||
            e.is_dir ||
            e.type === "directory" ||
            e.kind === "directory"
          );
          return {
            name: String(name).split("/").pop(),
            isDirectory,
            path: e.path || name,
          };
        }),
      };
    }

    close() {
      this._closed = true;
      try {
        if (this.ws) this.ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  return AcpWsClient;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createAcpClient };
}

if (typeof window !== "undefined") {
  window.createAcpClient = createAcpClient;
}
