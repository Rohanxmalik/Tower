# Enforcement (Claude Code hook)

Asking an agent to "please call `claim_intent` before editing" is a suggestion — LLMs
forget. The **PreToolUse hook** makes it a guarantee: Claude physically cannot edit a file
another active agent is mid-change on.

## How it works

`hooks/pretooluse-tower.mjs` runs before every `Edit` / `Write` / `MultiEdit`:

1. It calls `tower guard` for the target file.
2. If another active agent holds a **hard**-conflicting claim → the hook exits `2`,
   Claude Code **blocks the edit**, and the reason (who / what / ETA) is fed back to Claude.
3. Otherwise it registers a claim for this agent and lets the edit through.

It **fails open** — any error in the hook allows the edit, so a hook bug can never brick
your session.

## Enable it

```bash
npm run build                       # the hook imports the built CLI
cp .claude/settings.example.json .claude/settings.json
```

Then reload Claude Code. That's it — open two Claude sessions on the same repo and watch
the second one get blocked when it reaches for a file the first is editing.

```jsonc
// .claude/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "node hooks/pretooluse-tower.mjs" }],
      },
    ],
  },
}
```

## Scope & limits (honest)

- **Single machine, multiple agents** today: the hook uses the repo's local
  `.tower/tower.db`, so it coordinates the Claude/agent sessions running on _your_ machine
  in _this_ repo. That already covers the common "I'm running 3 parallel agents" case.
- **Cross-developer enforcement** (blocking based on a teammate's claim on another machine)
  needs the hook to query a shared hosted Tower — see [team.md](./team.md). Cooperative
  `claim_intent` calls over hosted MCP already work cross-machine; hook-level _blocking_
  across machines is the next step.
- Granularity is **file-level** in the hook (PreToolUse can't know which symbol you'll
  touch yet). Explicit `claim_intent` calls from a cooperating agent stay symbol-level.
