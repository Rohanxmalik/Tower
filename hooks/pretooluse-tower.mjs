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

/** The text an edit replaces — the anchor we locate in the file. MultiEdit has many. */
function editAnchors(tool, toolInput) {
  if (tool === "MultiEdit") {
    return (toolInput.edits ?? [])
      .map((e) => e?.old_string)
      .filter((s) => typeof s === "string" && s);
  }
  const old = toolInput.old_string;
  return typeof old === "string" && old ? [old] : [];
}

/**
 * Which symbols this edit touches, as `"path#name"` strings for `cmdGuard`.
 *
 * Passing `[]` was the bug: `resolveSymbols` then extracts EVERY symbol in the file, so
 * the claim covered the whole file and two agents in different functions blocked each
 * other. A single `"path#"` entry (empty name) is the explicit whole-file claim.
 *
 * A Write replaces the whole file, so it stays a file-level claim. An Edit is located by
 * finding its `old_string` and asking which declaration encloses that offset. Anything
 * unresolvable — a new file, an edit to imports, an unsupported language — falls back to
 * the file, because over-claiming is safe and under-claiming is not.
 */
async function symbolsForEdit(cwd, filePath, rel, tool, toolInput) {
  const fileLevel = [`${rel}#`]; // explicit whole-file claim
  const anchors = editAnchors(tool, toolInput);
  if (anchors.length === 0) return fileLevel; // Write, or an edit with nothing to anchor on
  let code;
  try {
    code = readFileSync(filePath, "utf8");
  } catch {
    return fileLevel; // new file
  }
  try {
    const { SymbolExtractor, symbolAt } = await import(
      new URL("../packages/server/dist/index.js", import.meta.url)
    );
    const ranges = await new SymbolExtractor().extractRanges(rel, code);
    if (ranges.length === 0) return fileLevel; // no grammar for this language
    const hits = [];
    for (const anchor of anchors) {
      const at = code.indexOf(anchor);
      if (at < 0) return fileLevel; // stale anchor — don't guess
      const sym = symbolAt(ranges, at);
      if (!sym) return fileLevel; // between declarations
      const entry = `${rel}#${sym.symbol}`;
      if (!hits.includes(entry)) hits.push(entry);
    }
    return hits.length ? hits : fileLevel;
  } catch {
    return fileLevel; // never let symbol resolution break enforcement
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

  // Name the symbols this edit actually lands in. Claiming the whole file refuses
  // correct work — two agents in different functions of one file blocked each other —
  // and a tool that blocks good edits gets uninstalled faster than one that misses a
  // conflict. Falls back to the file when the target can't be located, which is the
  // honest answer for a Write, a new file, or an edit between declarations.
  const symbols = await symbolsForEdit(cwd, filePath, rel, tool, input.tool_input ?? {});

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
      symbols,
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
