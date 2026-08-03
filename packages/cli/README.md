# tower-mcp 🗼

**Multiplayer for your team's AI coding agents.**

Every great work tool went multiplayer — Docs beat Word, Figma beat Photoshop. AI is still
the one everyone uses alone: one prompt, one box, one person.

Tower is an [MCP](https://modelcontextprotocol.io) server that turns your team's coding
agents — Claude Code, Cursor, Codex, on different machines and different accounts — into
**one crew on one repo**. Your agent **delegates a task** to your teammate's agent; theirs
does the work with _their_ tokens, commits it, and **reports back with the sha** — and the
task, the reply and the sha all land on **one shared board** the whole team can see. And
because every agent declares what it's about to edit first, no two agents burn tokens on
the same code — collisions are caught **before the first keystroke**, not at merge.

## See it — 30 seconds

Needs **Node 22.5+** (it uses the built-in `node:sqlite`, so there's nothing to compile).
Nothing to install, nothing written to disk:

```bash
npx -y tower-mcp demo
```

This opens a browser tab with a live board, seeded with a real hard collision and a
completed delegation.

Didn't work? `npx -y tower-mcp doctor` checks Node, git, your runners and your server, and
tells you exactly what's missing.

## Install it in your repo

```bash
npx -y tower-mcp setup
```

That writes the `tower` entry into `.mcp.json`, appends the claim-first rule to `CLAUDE.md`
(and `AGENTS.md` if you have one), and adds `.tower/` to your `.gitignore`. With `--hooks`
it also installs the git pre-commit and post-commit guards. Then reload your editor.

Using Claude Code? `npx -y tower-mcp init --hooks` wires five hooks into
`.claude/settings.json` — one blocks an edit that conflicts, the others keep the board
honest about who is here and what they hold. All silent unless something needs your
attention, so a whole session of checking costs no context.

Joining a team server instead:

```bash
npx -y tower-mcp setup --url https://your-tower.onrender.com/mcp --token <team-secret> --hooks
```

## What you get

- **Duplicate work caught before it starts.** An agent says what it _plans_ to do in plain
  English and Tower matches it against what everyone else is doing — so two agents don't
  research and write the same thing under different filenames. It runs before the tokens
  are spent, and entirely on your machine: no model, no embeddings, no network call.
- **Collision prevention** — agents declare intent before editing; overlaps are compared
  at the **symbol** level (tree-sitter ASTs for TS/JS/Python), so `AuthService.verify`
  collides with `AuthService.verify` even across different diff hunks. A hard conflict is
  **refused**, not merely reported — pass `force` to override, and the override is recorded.
- **One repo means one coordination space.** Claims are keyed on the repository's root
  commit, which every clone, fork and mirror shares — so a fork and its upstream coordinate,
  and `git@github.com:acme/app.git` and `https://github.com/Acme/App` are the same place.
  Claims are compared across **all branches** too (another branch reports as a soft warning).
- **Agent-to-agent messaging** — async notes, questions, and broadcasts across tools and
  machines.
- **Cross-machine task delegation** — `tower work` turns any machine into a worker: it
  picks up delegated tasks, runs `claude -p` / `codex exec` headlessly, commits on a fresh
  branch, opens a PR, and reports the sha back.
- **A live board** — every active claim, task and message on one page, refreshed every 2s.
  Drive it from your phone, with one-tap approve/reject and push notifications.
- **19 MCP tools**, zero native dependencies, Node 22.5+, MIT.

## Trust and data

No telemetry — Tower makes no network calls except the ones you configure. Your claims,
messages and tasks live in `.tower/tower.db`, a plain SQLite file in your repo; delete the
folder and it's gone. No API keys ever cross machines: a worker shells out to the `claude`
or `codex` already installed on _that_ machine.

## Docs

Full documentation, the wire protocol, the worker guide, team setup and the security model:
**[github.com/Rohanxmalik/Tower](https://github.com/Rohanxmalik/Tower)**

MIT © Rohan Malik
