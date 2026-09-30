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
// Fails OPEN: it never blocks a prompt. An error exits 0 with one line on stderr, so "no
// waiting work" and "never checked" stay distinguishable.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { finish } from "./_tower-lib.mjs";

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

  // The built CLI in this clone, like every other hook. There used to be an `npx -y
  // tower-mcp` fallback: a registry lookup on every prompt, for a machine that no other
  // hook could work on anyway, contradicting "no network calls you didn't configure".
  const here = dirname(fileURLToPath(import.meta.url));
  const localCli = join(here, "..", "packages", "cli", "dist", "index.js");
  if (!existsSync(localCli)) {
    throw new Error("the built CLI is missing — run `npm run build` in your Tower clone");
  }

  const out = execFileSync(process.execPath, [localCli, "nudge"], {
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
finish(0);
