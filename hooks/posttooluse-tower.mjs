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
const tool = input.tool_name ?? "";
if (!/^(Edit|Write|MultiEdit|Read)$/.test(tool)) process.exit(0);

const cwd = input.cwd ?? process.cwd();

// A Read is the other half of a claim. Watching it here is what makes version-aware
// claims work in practice: the agent never has to remember what it looked at, and a
// read set costs it no extra call and no extra tokens. Tower learns the declaration
// and its signature at the moment the agent actually saw them.
if (tool === "Read") {
  try {
    const file = input.tool_input?.file_path;
    if (file) {
      const { repo, repoId } = repoContext(cwd);
      const { cmdRecordReads } = await loadCommands(dirname(fileURLToPath(import.meta.url)));
      await cmdRecordReads(cwd, {
        agentId: agentIdFor(input),
        repo,
        ...(repoId ? { repoId } : {}),
        file,
      });
    }
  } catch (err) {
    // Best-effort: a missed read costs a warning Tower could have given, never
    // correctness. Never make a Read fail because coordination was unavailable.
    process.stderr.write(`Tower: read not recorded — ${err?.message || err}
`);
  }
  process.exit(0);
}

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
