#!/usr/bin/env node
/**
 * End-to-end test: pair → fs → shell (terminal bridge or in-process host)
 *
 *   npm run launch   # other terminal, or use in-process host below
 *   node e2e-test.js
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const WebSocket = require("ws");
const { parsePairPayload } = require("./lib/pair");
const { createAcpClient } = require("./lib/acp-client");
const { createTerminalHost } = require("./lib/terminal-bridge");

const payloadPath =
  process.argv[2] || path.join(os.tmpdir(), "grok-remote-pair.json");

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT: " + msg);
}

async function main() {
  console.log("=== Grok Remote e2e ===\n");
  assert(fs.existsSync(payloadPath), `missing pair file ${payloadPath}`);
  const parsed = parsePairPayload(fs.readFileSync(payloadPath, "utf8"));
  assert(parsed.ok, parsed.error);
  const pair = parsed.payload;
  console.log("ws: ", pair.ws);
  console.log("cwd:", pair.cwd);
  console.log("http:", pair.http || "(none)");

  const Acp = createAcpClient(WebSocket);
  const client = new Acp(pair.ws, {
    log: (a, ...r) => console.log(`  [${a}]`, ...r),
  });
  client.localFs = fs;
  client.permissionMode = "auto";
  client.setCwd(pair.cwd);

  // Prefer HTTP bridge if launcher is up; else in-process host (same machine)
  if (pair.http) {
    client.terminalBridge = { baseUrl: pair.http, secret: pair.secret };
    console.log("terminal: HTTP bridge →", pair.http);
  } else {
    client.terminalHost = createTerminalHost({ defaultCwd: pair.cwd });
    console.log("terminal: in-process host");
  }

  console.log("\n[1] handshake");
  await client.connect({ timeoutMs: 8000 });
  const { initResult, session } = await client.handshake({ cwd: pair.cwd });
  assert(session?.sessionId, "sessionId missing");
  console.log("  session", session.sessionId);
  console.log("  model", initResult?._meta?.modelState?.currentModelId);

  console.log("\n[2] fs list");
  const listed = await client.fsList(pair.cwd);
  console.log(
    "  files:",
    listed.files.map((f) => f.name).join(", ") || "(empty)"
  );

  console.log("\n[3] shell via terminal/*");
  let message = "";
  let toolTitles = [];
  let shellFailed = false;
  const promptResult = await client.prompt(
    "Run this exact shell command and quote its full stdout: echo GROK_REMOTE_SHELL_OK && pwd",
    {
      onUpdate: (u) => {
        const k = u.sessionUpdate;
        if (k === "agent_message_chunk") message += u.content?.text || "";
        if (k === "tool_call" && u.title) toolTitles.push(u.title);
        if (k === "tool_call_update") {
          if (u.title) toolTitles.push(u.title);
          if (u.status === "failed") shellFailed = true;
        }
      },
    }
  );
  console.log("  stopReason:", promptResult?.stopReason);
  console.log("  tools:", [...new Set(toolTitles)].join(", "));
  console.log("  message:", message.replace(/\n/g, " ").slice(0, 240));

  const okShell =
    /GROK_REMOTE_SHELL_OK/.test(message) ||
    toolTitles.some((t) => /shell|terminal|Execute|run_terminal/i.test(t));
  // Strong check: marker in reply means shell output reached the model
  assert(
    /GROK_REMOTE_SHELL_OK/.test(message),
    "shell marker not in agent reply — terminal bridge may have failed"
  );
  console.log("  shellFailed flag during stream:", shellFailed);

  console.log("\n=== ALL e2e CHECKS PASSED ===\n");
  client.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((err) => {
  console.error("\n=== e2e FAILED ===");
  console.error(err);
  process.exit(1);
});
