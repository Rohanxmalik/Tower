#!/usr/bin/env node
// Tower PostToolUse hook for Claude Code.
//
// Runs after every Edit / Write / MultiEdit and refreshes this session's presence, so the
// board shows "working" for as long as the agent is actually working. `PreToolUse` proves
// intent; this proves activity — and it is the signal that keeps a long-running claim
// from expiring underneath a live agent. After a Read it records what the agent looked
// at, and hands it a warning if someone else is changing that code right now.
//
// Wire it up in .claude/settings.json (or run `tower init --hooks`):
//   "hooks": { "PostToolUse": [{ "matcher": "Edit|Write|MultiEdit|Read", "hooks": [
//     { "type": "command", "command": "node hooks/posttooluse-tower.mjs" }] }] }
//
// Fails OPEN and quiet on the happy path: presence is best-effort telemetry about *your
// own* session, not a safety property, so a failure here is worth one line on stderr and
// nothing more. Requires `npm run build` first.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { agentIdFor, finish, repoContext, loadCommands } from "./_tower-lib.mjs";

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

async function main() {
  const input = readStdin();
  const tool = input.tool_name ?? "";
  if (!/^(Edit|Write|MultiEdit|Read)$/.test(tool)) return;

  const cwd = input.cwd ?? process.cwd();

  // A Read is the other half of a claim. Watching it here is what makes version-aware
  // claims work in practice: the agent never has to remember what it looked at, and a
  // read set costs it no extra call and no extra tokens. Tower learns the declaration
  // and its signature at the moment the agent actually saw them.
  if (tool === "Read") {
    try {
      const file = input.tool_input?.file_path;
      if (file) {
        const { repo, repoId, branch } = repoContext(cwd);
        const cli = await loadCommands(dirname(fileURLToPath(import.meta.url)));
        const args = {
          agentId: agentIdFor(input),
          repo,
          ...(repoId ? { repoId } : {}),
          branch,
          file,
        };
        // 0.12.0: warn at the moment of reading. Plain stdout from PostToolUse never reaches
        // the agent — only additionalContext JSON does — so the CLI hands back exactly the
        // string to print. An older built CLI has no hookRecordReads; record silently then.
        if (cli.hookRecordReads) {
          const printed = await cli.hookRecordReads(cwd, args);
          if (printed) process.stdout.write(printed);
        } else {
          await cli.cmdRecordReads(cwd, args);
        }
      }
    } catch (err) {
      // Best-effort: a missed read costs a warning Tower could have given, never
      // correctness. Never make a Read fail because coordination was unavailable.
      process.stderr.write(`Tower: read not recorded — ${err?.message || err}
`);
    }
    return;
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
}

// Always exit 0: neither half of this hook may fail the tool call it follows.
await main();
finish(0);
