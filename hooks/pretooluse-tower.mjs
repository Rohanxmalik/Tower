#!/usr/bin/env node
// Tower PreToolUse hook for Claude Code.
//
// Before Claude edits a file, this claims it in Tower. If another active agent already
// holds a HARD-conflicting claim on that file, the edit is BLOCKED (exit 2) and the
// reason is fed back to Claude — turning "please remember to coordinate" into enforcement.
//
// Wire it up in .claude/settings.json (see docs/enforcement.md):
//   "hooks": { "PreToolUse": [{ "matcher": "Edit|Write|MultiEdit",
//     "hooks": [{ "type": "command", "command": "node hooks/pretooluse-tower.mjs" }] }] }
//
// Requires a build first: `npm run build`. Fails OPEN (never blocks on its own error).
import { readFileSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { repoContext } from "./_tower-lib.mjs";

const ALLOW = 0;
const BLOCK = 2;

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const input = readStdin();
  const tool = input.tool_name ?? "";
  if (!/^(Edit|Write|MultiEdit)$/.test(tool)) process.exit(ALLOW);

  const filePath = input.tool_input?.file_path;
  const cwd = input.cwd ?? process.cwd();
  if (!filePath) process.exit(ALLOW);

  const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
  const agentId = `claude-${(input.session_id ?? "code").slice(0, 8)}`;

  // One shared derivation — repo label, fork-proof repoId (root commit sha) and branch.
  // The hook used to normalize with its own private copy while the MCP path did not,
  // which put the two in different partitions.
  const { repo, repoId, branch } = repoContext(cwd);

  const { cmdGuard } = await import(new URL("../packages/cli/dist/commands.js", import.meta.url));
  const lines = [];
  const blocked = await cmdGuard(
    cwd,
    {
      agentId,
      repo,
      ...(repoId ? { repoId } : {}),
      branch,
      files: [rel],
      symbols: [],
      purpose: `${tool} ${rel}`,
    },
    (l) => lines.push(l),
  );

  if (blocked) {
    process.stderr.write(
      `Tower: another agent is editing ${rel}. Do not edit it yet.\n\n${lines.join("\n")}\n`,
    );
    process.exit(BLOCK);
  }
  process.exit(ALLOW);
}

// Fail OPEN but LOUD. A hook bug or a Tower outage must never brick editing — but if we
// silently exit 0, "coordination checked and clear" and "coordination never ran" look
// identical, and you cannot tell which one you got.
//
//   Silence must always mean verified-clear, never "did not check."
main().catch((err) => {
  process.stderr.write(
    `Tower: coordination NOT enforced for this edit — ${err?.message || err}
` +
      `       (allowing the edit; another agent may be editing this file)
`,
  );
  process.exit(ALLOW);
});
