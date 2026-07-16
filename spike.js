#!/usr/bin/env node
/**
 * Phase 1 ACP spike — connect to `grok agent serve` over WebSocket and run a
 * short real coding turn against an official Grok Build agent.
 *
 * Usage:
 *   node spike.js
 *   WS_URL=ws://127.0.0.1:2419/ws?server-key=secret CWD=/path/to/proj node spike.js
 *   node spike.js "list files and summarize README.txt"
 */

const WebSocket = require("ws");
const path = require("path");
const os = require("os");

const WS_URL =
  process.env.WS_URL ||
  "ws://127.0.0.1:2419/ws?server-key=phase0-test-secret";
const CWD = path.resolve(
  process.env.CWD || "/tmp/grok-acp-spike-workspace"
);
const PROMPT =
  process.argv.slice(2).join(" ") ||
  "List the files in this directory and quote the full contents of README.txt. Be brief.";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 120_000);

function log(section, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${section}`, ...args);
}

class AcpWsClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, method }
    this.onNotification = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      log("ws", `connecting ${this.url}`);
      this.ws = new WebSocket(this.url);

      const onOpen = () => {
        cleanupConnect();
        log("ws", "open");
        resolve();
      };
      const onError = (err) => {
        cleanupConnect();
        reject(err);
      };
      const cleanupConnect = () => {
        this.ws.off("open", onOpen);
        this.ws.off("error", onError);
      };

      this.ws.on("open", onOpen);
      this.ws.on("error", onError);
      this.ws.on("message", (data) => this._onMessage(data));
      this.ws.on("close", (code, reason) => {
        log("ws", `closed code=${code} reason=${reason?.toString?.() || ""}`);
        for (const [id, p] of this.pending) {
          p.reject(new Error(`WebSocket closed while waiting for id=${id} (${p.method})`));
        }
        this.pending.clear();
      });
    });
  }

  _onMessage(raw) {
    const text = raw.toString();
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      log("ws", "non-JSON message:", text.slice(0, 200));
      return;
    }

    // JSON-RPC response
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        log("rpc", "orphan response", JSON.stringify(msg).slice(0, 300));
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(
          Object.assign(new Error(msg.error.message || "RPC error"), {
            code: msg.error.code,
            data: msg.error.data,
            raw: msg.error,
          })
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // JSON-RPC request from agent → client (permissions, fs, terminal, …)
    if (msg.method && msg.id !== undefined) {
      this._handleAgentRequest(msg).catch((err) => {
        log("client-method", "handler failed", err);
        this._respondError(msg.id, -32000, String(err.message || err));
      });
      return;
    }

    // Notification (no id)
    if (msg.method) {
      if (this.onNotification) this.onNotification(msg);
      return;
    }

    log("ws", "unhandled message", JSON.stringify(msg).slice(0, 400));
  }

  async _handleAgentRequest(msg) {
    const { method, params, id } = msg;
    log("← agent request", method, JSON.stringify(params ?? {}).slice(0, 400));

    // Auto-approve tool permissions for the spike (serve also started with --always-approve).
    if (method === "session/request_permission") {
      const options = params?.options || [];
      const allowOnce =
        options.find((o) => o.optionId === "allow_once" || o.kind === "allow_once") ||
        options.find((o) => /allow/i.test(o.optionId || o.name || "")) ||
        options[0];
      const optionId = allowOnce?.optionId || allowOnce?.id || "allow_once";
      this._respond(id, { outcome: { outcome: "selected", optionId } });
      log("→ permission", `auto-selected optionId=${optionId}`);
      return;
    }

    // Client-side FS reads (if agent asks the client to read)
    if (method === "fs/read_text_file") {
      const fs = require("fs");
      const content = fs.readFileSync(params.path, "utf8");
      this._respond(id, { content });
      return;
    }

    if (method === "fs/write_text_file") {
      const fs = require("fs");
      fs.writeFileSync(params.path, params.content ?? "", "utf8");
      this._respond(id, {});
      return;
    }

    // Unknown client methods: soft reject so the agent can continue if possible
    log("client-method", `unhandled ${method} — rejecting`);
    this._respondError(id, -32601, `Method not implemented by spike client: ${method}`);
  }

  request(method, params, { timeoutMs = TIMEOUT_MS } = {}) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout after ${timeoutMs}ms waiting for ${method} (id=${id})`));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      log("→", method, `id=${id}`);
      this.ws.send(JSON.stringify(payload));
    });
  }

  _respond(id, result) {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  _respondError(id, code, message) {
    this.ws.send(
      JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })
    );
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

function formatUpdate(update) {
  if (!update) return "";
  const kind = update.sessionUpdate || update.type || "?";
  switch (kind) {
    case "agent_message_chunk":
      return update.content?.text ?? update.content?.content ?? "";
    case "agent_thought_chunk":
      return `\n[thought] ${update.content?.text ?? ""}\n`;
    case "tool_call":
      return `\n[tool_call] ${update.title || update.toolCallId || ""} ${update.kind || ""} status=${update.status || ""}\n`;
    case "tool_call_update":
      return `\n[tool_update] ${update.toolCallId || ""} status=${update.status || ""}\n`;
    case "plan":
      return `\n[plan] ${JSON.stringify(update).slice(0, 200)}\n`;
    default:
      return `\n[${kind}] ${JSON.stringify(update).slice(0, 240)}\n`;
  }
}

async function main() {
  console.log("=== Phase 0/1 ACP spike ===");
  console.log(`host:     ${os.hostname()} node ${process.version}`);
  console.log(`ws:       ${WS_URL}`);
  console.log(`cwd:      ${CWD}`);
  console.log(`prompt:   ${PROMPT}`);
  console.log("");

  const client = new AcpWsClient(WS_URL);

  let messageBuf = "";
  const toolEvents = [];

  client.onNotification = (msg) => {
    if (msg.method === "session/update") {
      const update = msg.params?.update ?? msg.params;
      const kind = update?.sessionUpdate;
      if (kind === "agent_message_chunk") {
        const chunk = update.content?.text ?? "";
        messageBuf += chunk;
        process.stdout.write(chunk);
      } else if (kind === "tool_call" || kind === "tool_call_update") {
        toolEvents.push(update);
        process.stdout.write(formatUpdate(update));
      } else if (kind === "agent_thought_chunk") {
        // Keep thoughts quiet-ish; single-line marker
        const t = (update.content?.text || "").replace(/\s+/g, " ").slice(0, 80);
        if (t) process.stdout.write(`\n[thought…] ${t}\n`);
      } else {
        process.stdout.write(formatUpdate(update));
      }
      return;
    }
    // x.ai/* notifications etc.
    log("← notify", msg.method, JSON.stringify(msg.params ?? {}).slice(0, 200));
  };

  await client.connect();

  // 1) initialize
  let initResult;
  try {
    initResult = await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: {
        name: "grok-remote-acp-spike",
        version: "0.1.0",
      },
    });
  } catch (err) {
    // Some agents want a slightly different shape — log and rethrow
    log("initialize failed", err.message, err.raw || "");
    throw err;
  }
  log("initialize result", JSON.stringify(initResult, null, 2).slice(0, 1500));

  // Optional: authenticated notification / session new
  // ACP often expects client to send `initialized` notification after initialize
  try {
    client.ws.send(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    );
    // Also try the shorter name some stacks use
    client.ws.send(
      JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })
    );
  } catch {
    /* ignore */
  }

  // 2) session/new — cwd must be absolute per ACP
  const session = await client.request("session/new", {
    cwd: CWD,
    mcpServers: [],
  });
  log("session/new result", JSON.stringify(session, null, 2).slice(0, 1000));
  const sessionId = session.sessionId || session.session_id;
  if (!sessionId) {
    throw new Error(`No sessionId in session/new result: ${JSON.stringify(session)}`);
  }

  // 3) prompt turn
  console.log("\n--- agent stream ---\n");
  const promptResult = await client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: PROMPT }],
  });
  console.log("\n\n--- end stream ---");
  log("session/prompt result", JSON.stringify(promptResult, null, 2).slice(0, 1000));

  console.log("\n=== spike summary ===");
  console.log(`sessionId:     ${sessionId}`);
  console.log(`tool events:   ${toolEvents.length}`);
  console.log(`message chars: ${messageBuf.length}`);
  console.log(
    `stopReason:    ${promptResult?.stopReason || promptResult?.stop_reason || "(none)"}`
  );
  if (toolEvents.length === 0) {
    console.log(
      "note: no tool_call events observed — prompt may have been answered without tools."
    );
  } else {
    console.log("tools seen:");
    for (const t of toolEvents) {
      console.log(
        `  - ${t.sessionUpdate} ${t.title || t.toolCallId || ""} ${t.status || ""}`
      );
    }
  }
  console.log("\nPhase 1 OK if initialize + session/new + session/prompt all succeeded.");

  client.close();
  // Allow close to flush
  setTimeout(() => process.exit(0), 200);
}

main().catch((err) => {
  console.error("\n=== spike FAILED ===");
  console.error(err);
  process.exit(1);
});
