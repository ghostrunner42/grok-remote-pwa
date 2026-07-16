#!/usr/bin/env node
/**
 * Thin wrapper → Phase 2+ launcher in acp-spike.
 * Prefer:  cd ../acp-spike && npm run launch
 */

const { spawn } = require("child_process");
const path = require("path");

const launcher = path.resolve(__dirname, "../../acp-spike/launcher.js");
const child = spawn(process.execPath, [launcher, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code || 0));
