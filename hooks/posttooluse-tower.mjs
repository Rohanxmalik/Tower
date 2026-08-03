#!/usr/bin/env node
// Tower PostToolUse hook for Claude Code.
//
// Runs after every Edit / Write / MultiEdit and refreshes this session's presence, so the
// board shows "working" for as long as the agent is actually working. `PreToolUse` proves
// intent; this proves activity — and it is the signal that keeps a long-running claim
// from expiring underneath a live agent.
//
// Wire it up in .claude/settings.json (or run `tower init --hooks`):
//   "hooks": { "PostToolUse": [{ "matcher": "Edit|Write|MultiEdit", "hooks": [
//     { "type": "command", "command": "node hooks/posttooluse-tower.mjs" }] }] }
//
// Fails OPEN and quiet on the happy path: presence is best-effort telemetry about *your
// own* session, not a safety property, so a failure here is worth one line on stderr and
// nothing more. Requires `npm run build` first.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { agentIdFor, repoContext, loadCommands } from "./_tower-lib.mjs";

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

const input = readStdin();
if (!/^(Edit|Write|MultiEdit)$/.test(input.tool_name ?? "")) process.exit(0);

const cwd = input.cwd ?? process.cwd();

try {
  const { repo, repoId } = repoContext(cwd);
  const { cmdPresence } = await loadCommands(dirname(fileURLToPath(import.meta.url)));
  await cmdPresence(
    cwd,
    {
      agentId: agentIdFor(input),
      repo,
      ...(repoId ? { repoId } : {}),
      runner: "interactive",
    },
    () => {},
  );
} catch (err) {
  process.stderr.write(`Tower: presence not refreshed — ${err?.message || err}\n`);
}

process.exit(0);
