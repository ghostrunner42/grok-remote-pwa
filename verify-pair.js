#!/usr/bin/env node
/**
 * Phase 2 verification: load pair payload → WS connect → ACP initialize
 * (and session/new against payload.cwd).
 *
 *   node verify-pair.js
 *   node verify-pair.js --payload /tmp/grok-remote-pair.json
 *   WS_URL=... CWD=... SECRET=... node verify-pair.js
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const WebSocket = require("ws");
const { parsePairPayload } = require("./lib/pair");
const { createAcpClient } = require("./lib/acp-client");

function parseArgs(argv) {
  const out = { payloadPath: path.join(os.tmpdir(), "grok-remote-pair.json") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--payload") out.payloadPath = argv[++i];
    if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("node verify-pair.js [--payload /path/to/pair.json]");
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let payload;

  if (process.env.WS_URL && process.env.CWD) {
    const parsed = parsePairPayload({
      v: 1,
      ws: process.env.WS_URL,
      secret:
        process.env.SECRET ||
        new URL(process.env.WS_URL).searchParams.get("server-key"),
      cwd: process.env.CWD,
    });
    if (!parsed.ok) throw new Error(parsed.error);
    payload = parsed.payload;
  } else if (fs.existsSync(args.payloadPath)) {
    const raw = fs.readFileSync(args.payloadPath, "utf8");
    const parsed = parsePairPayload(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    payload = parsed.payload;
  } else {
    console.error(
      `No payload at ${args.payloadPath}. Start launcher first, or pass --payload.`
    );
    process.exit(1);
  }

  console.log("=== Phase 2 verify-pair ===");
  console.log("ws: ", payload.ws);
  console.log("cwd:", payload.cwd);

  const AcpWsClient = createAcpClient(WebSocket);
  const client = new AcpWsClient(payload.ws, {
    log: (a, ...rest) => console.log(`[${a}]`, ...rest),
  });

  await client.connect({ timeoutMs: 8_000 });
  const { initResult, session } = await client.handshake({
    cwd: payload.cwd,
    createSession: true,
  });

  const agentVersion = initResult?._meta?.agentVersion || "?";
  const model = initResult?._meta?.modelState?.currentModelId || "?";
  const sessionId = session?.sessionId;

  console.log("\n=== RESULT ===");
  console.log("initialize: OK");
  console.log("agentVersion:", agentVersion);
  console.log("model:", model);
  console.log("sessionId:", sessionId || "(none)");
  console.log("\nPhase 2 health check PASSED.");

  client.close();
  setTimeout(() => process.exit(0), 200);
}

main().catch((err) => {
  console.error("\nPhase 2 verify-pair FAILED");
  console.error(err);
  process.exit(1);
});
