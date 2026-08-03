#!/usr/bin/env node
// Tower SessionStart hook for Claude Code.
//
// Registers this editor session as a live agent the moment it opens.
//
// Presence used to depend on an agent volunteering a `heartbeat_worker` call, which an
// interactive session never makes — so the board read "0 agents online" during active
// multi-agent work, which is exactly when it should be most informative. Driving it from
// the session lifecycle makes liveness a property of the harness rather than of agent
// goodwill.
//
// Wire it up in .claude/settings.json (or run `tower init --hooks`):
//   "hooks": { "SessionStart": [{ "hooks": [
//     { "type": "command", "command": "node hooks/sessionstart-tower.mjs" }] }] }
//
// For a remote team Tower, export TOWER_URL / TOWER_TOKEN. With neither set it uses the
// local .tower store. Requires `npm run build` first.
//
// Fails OPEN but LOUD: never blocks a session, but says when it could not reach Tower.
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
    () => {}, // silent on the happy path — a hook that prints costs context every session
  );
} catch (err) {
  process.stderr.write(
    `Tower: this session is NOT registered — ${err?.message || err}\n` +
      `       (teammates will not see you on the board)\n`,
  );
}

process.exit(0);
