#!/usr/bin/env node
// Tower UserPromptSubmit hook for Claude Code.
//
// Runs `tower nudge` each time you send a prompt and, if a teammate delegated you a task
// or sent a message, prints "🗼 Tower: N tasks waiting" — which Claude Code adds to the
// agent's context. This closes the no-push gap for the INTERACTIVE agent in VS Code: MCP
// can't wake an idle session, but the nudge surfaces waiting work on your next prompt so
// the agent can fetch_messages / list_tasks and pick it up.
//
// Wire it up in .claude/settings.json:
//   "hooks": { "UserPromptSubmit": [{ "hooks": [
//     { "type": "command", "command": "node hooks/userpromptsubmit-nudge.mjs" }] }] }
//
// For a REMOTE team Tower, export TOWER_URL / TOWER_TOKEN in the environment Claude Code
// runs in (same as the worker). With neither set it reads the local .tower store.
//
// Fails OPEN and SILENT: any error prints nothing and exits 0 — it never blocks a prompt.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

try {
  const input = readStdin();
  const cwd = input.cwd || process.cwd();

  // Prefer the built local CLI (this repo); otherwise fall back to the published package.
  const here = dirname(fileURLToPath(import.meta.url));
  const localCli = join(here, "..", "packages", "cli", "dist", "index.js");
  const [cmd, args] = existsSync(localCli)
    ? [process.execPath, [localCli, "nudge"]]
    : ["npx", ["-y", "tower-mcp", "nudge"]];

  const out = execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  }).trim();

  if (out) process.stdout.write(out + "\n");
} catch (err) {
  // Fail open, but say so. The nudge is allowed to find nothing; it is not allowed to
  // look like it found nothing when it never ran.
  process.stderr.write(`Tower: could not check for waiting work — ${err?.message || err}
`);
}
process.exit(0);
