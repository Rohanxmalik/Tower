#!/usr/bin/env node
// Tower SessionEnd hook for Claude Code.
//
// Releases every claim this session holds when the editor closes.
//
// Without it, a closed session keeps blocking the files it was editing until its lease
// lapses — up to the full TTL. That is the phantom-block half of TWR-11: a crashed or
// closed agent should stop holding things immediately, while a *live* one gets its claims
// extended (see the PostToolUse hook).
//
// Wire it up in .claude/settings.json (or run `tower init --hooks`):
//   "hooks": { "SessionEnd": [{ "hooks": [
//     { "type": "command", "command": "node hooks/sessionend-tower.mjs" }] }] }
//
// Fails OPEN but LOUD: a failure here leaves stale claims blocking teammates, which is
// worth telling someone about. Requires `npm run build` first.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { agentIdFor, loadCommands } from "./_tower-lib.mjs";

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

const input = readStdin();
const cwd = input.cwd ?? process.cwd();

try {
  const { cmdRelease } = await loadCommands(dirname(fileURLToPath(import.meta.url)));
  await cmdRelease(cwd, agentIdFor(input), () => {});
} catch (err) {
  process.stderr.write(
    `Tower: claims NOT released — ${err?.message || err}\n` +
      `       (they will expire on their own TTL; teammates may see phantom blocks until then)\n`,
  );
}

process.exit(0);
