# Enforcement — every editor, three layers

Asking an agent to "please call `claim_intent` before editing" is a suggestion — LLMs
forget. Enforcement makes it a guarantee. Tower gives you three layers; stack them:

| Layer                              | Blocks at   | Works in                                 |
| ---------------------------------- | ----------- | ---------------------------------------- |
| **1. MCP tools + rules file**      | intent time | every MCP agent (Claude, Cursor, Codex…) |
| **2. Claude Code PreToolUse hook** | edit time   | Claude Code                              |
| **3. git `pre-commit` guard**      | commit time | **everything** — any agent, any editor   |

Layer 2 is the strongest (the edit physically can't happen) but is Claude Code-only —
Cursor and Codex don't expose a blocking file-edit hook yet. Layer 3 is the universal
backstop: whatever tool wrote the code, the **commit is refused** while a teammate's agent
holds a hard-conflicting claim.

## Layer 3: the universal pre-commit guard (Cursor, Codex, anything)

```bash
cp examples/git-hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

On every commit it runs `tower guard` on the staged files. Hard conflict → commit blocked
with who/what/why; clear → a claim is registered for you. Set `TOWER_URL` + `TOWER_TOKEN`
and it enforces against your **team's** hosted Tower ([team.md](./team.md)). Escape hatch:
`git commit --no-verify`.

For Cursor/Codex, also add to your rules file (`.cursor/rules/` or `AGENTS.md`):

> Before editing any file, call the `claim_intent` tool on the `tower` MCP server with the
> files and symbols you'll change. If a `hard` conflict returns, stop and ask the user.

## Layer 2: the Claude Code PreToolUse hook

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

- **Single machine, multiple agents** (default): the hook uses the repo's local
  `.tower/tower.db`, coordinating the agent sessions on _your_ machine in _this_ repo.
- **Cross-developer enforcement**: set `TOWER_URL` (and `TOWER_TOKEN`) and the hook blocks
  based on _teammates'_ claims on a shared hosted Tower — see [team.md](./team.md). Repo
  identity is taken from the git `origin` remote so it matches across everyone's clones.
- Granularity is **file-level** in the hook (PreToolUse can't know which symbol you'll
  touch yet). Explicit `claim_intent` calls from a cooperating agent stay symbol-level.
