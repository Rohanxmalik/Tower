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
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, isAbsolute, basename } from "node:path";

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

  let repo = basename(cwd);
  let branch = "main";
  const git = (cmd) =>
    execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  try {
    repo = basename(git("git rev-parse --show-toplevel"));
    branch = git("git rev-parse --abbrev-ref HEAD") || "main";
  } catch {
    /* not a git repo — fall back to cwd basename */
  }

  const { cmdGuard } = await import(new URL("../packages/cli/dist/commands.js", import.meta.url));
  const lines = [];
  const blocked = await cmdGuard(
    cwd,
    { agentId, repo, branch, files: [rel], symbols: [], purpose: `${tool} ${rel}` },
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

main().catch(() => process.exit(ALLOW)); // fail open: a hook bug must never brick editing
