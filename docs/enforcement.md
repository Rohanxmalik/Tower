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

Layer 1 is just `tower setup` (it writes the claim-first rule into your rules file).
**Layer 3 is documented first below**, because it works everywhere and needs nothing but
npx; Layer 2 follows.

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
> files and symbols you'll change. If a `hard` conflict returns, stop and ask the user;
> the response's `alternatives` says what is safe to work on meanwhile.

## Layer 2: the Claude Code PreToolUse hook

> **These five hooks need a clone of Tower, not the npm package.** The scripts live in
> `hooks/` and import the built CLI by relative path; the published `tower-mcp` package
> ships `dist/` only. Run `init --hooks` from npm alone and you get five entries pointing
> at files that are not there — no error, just five hooks that never fire.
>
> ```bash
> git clone https://github.com/Rohanxmalik/Tower && cd Tower
> npm install && npm run build
> npx tower-mcp init --hooks        # from the clone
> ```
>
> That writes all five hooks into `.claude/settings.json`, merging with anything you
> already have and never replacing a hook you wired up yourself.
>
> **Since 0.9.0 the hooks fail open _loudly_.** They still never block editing when Tower
> is unreachable — but they say so on stderr, because a silent pass was indistinguishable
> from a check that never ran. Silence means verified-clear, never "did not check."

### How it works

`hooks/pretooluse-tower.mjs` runs before every `Edit` / `Write` / `MultiEdit`:

1. It works out which function the edit lands in and calls `tower guard` for it.
2. If another active agent holds a **hard**-conflicting claim → the hook exits `2`,
   Claude Code **blocks the edit**, and the reason (who / what / ETA) is fed back to Claude,
   followed by **"What to do instead"**: the refusal's `alternatives` (what to avoid for
   now, and a suggested next task when modules are defined). The blocked agent is
   registered as waiting, so Tower messages it when the blocking claim is completed,
   released or expires.
3. Otherwise it registers a claim for this agent and lets the edit through.

Since 0.12.1 `tower guard` (this hook, and the pre-commit guard in Layer 3) goes straight
through `claim_intent` rather than pre-checking with `check_collision`. Before that, a
hook-blocked agent got no alternatives, no release message and no entry in `tower stats`,
and an edit against a declaration it had read — one that has since moved — went through
unclaimed instead of being blocked. A hook that retries the same blocked edit is counted
once in `tower stats`, not once per retry.

It **fails open but loud** — any error allows the edit, so a hook bug can never brick your
session, and it prints that coordination was not enforced so you can tell the difference.

### The other four hooks

`init --hooks` also installs, all silent on the happy path:

| Hook               | Job                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `SessionStart`     | registers the session, so the board shows you without waiting for a heartbeat                |
| `UserPromptSubmit` | prints "N tasks waiting" only when a teammate actually delegated something                   |
| `PostToolUse`      | refreshes presence; on `Read`, records what you read and warns you if someone is changing it |
| `SessionEnd`       | releases your claims, so a closed editor stops blocking teammates                            |

Silence is what makes this affordable: a hook that exits without printing adds **zero
tokens**, so per-edit checking is free across a whole session.

### Enable it

```bash
npm run build                   # the hooks import the built CLI
npx -y tower-mcp init --hooks   # or: cp .claude/settings.example.json .claude/settings.json
```

Then reload Claude Code. Open two Claude sessions on the same repo and watch the second
get blocked when it reaches for a file the first is editing.

**Upgrading.** Re-run the same command after pulling a new Tower:

```bash
git pull && npm install && npm run build && npx tower-mcp init --hooks
```

Since 0.12.1 `init --hooks` upgrades an existing install: it rewrites Tower's own hook
entries to the current version (for example an older `PostToolUse` matcher without
`|Read`), moves Tower's command out of a group it shares with your own hooks rather than
editing that group, and adds Tower's entry beside your own hooks for the same event. Your
own hooks are never changed, and running it twice changes nothing the second time.
`.claude/settings.example.json` is exactly what `init --hooks` writes.

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
  identity is the root commit sha, which every clone, fork and mirror shares; the `origin`
  remote only supplies the readable label (and the fallback when there is no commit yet).
- Granularity is the **function** an edit lands in, found by locating the edit's
  `old_string` in the parsed file. A `Write`, a new file, or an edit between declarations
  falls back to the whole file — over-claiming is safe, under-claiming is not.
- The verdict is the **exit code**, so the hooks never call `process.exit()` directly.
  Before 0.12.0 they did, and on Windows that aborted in libuv while tree-sitter's
  WebAssembly was still compiling: the hook exited `127` instead of `2`, and Claude Code
  let the edit through.
- Claims are compared across **all branches** in a repository. Same branch and same symbol
  is `hard`; another branch is `soft`, because the two still converge into one merge.
- A repository is identified by its **root commit sha**, so forks and clones of one
  project share a coordination space regardless of how the remote is spelled.
