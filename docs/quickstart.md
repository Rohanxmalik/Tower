# Quickstart

Tower needs **Node 22.13+** (it uses the built-in `node:sqlite` — no native modules to
compile).

**Shorthand:** everywhere below, `tower` means `npx -y tower-mcp`. npx installs nothing
globally, so `tower status` on its own will say _command not found_ — either type
`npx -y tower-mcp status`, or install it once with `npm i -g tower-mcp` and then `tower`
really is the command. (From a clone: `npm install && npm run build`, then `tower` =
`node packages/cli/dist/index.js`.)

**Stuck at any point?** `tower doctor` checks Node, git, a clean tree, your runners, `gh`,
and whether your server and token work — and tells you exactly what's missing.

## 1. One command (30 seconds)

In your repo:

```bash
tower setup                 # solo: local coordination on this machine
tower setup --url https://tower-xxxx.onrender.com/mcp --token <secret> --hooks   # join a team server
```

This writes the `tower` server into `.mcp.json` (merging with your existing servers),
appends the claim-first + check-your-inbox rule to `CLAUDE.md` (and `AGENTS.md` if you
have one), and with `--hooks` installs the git pre/post-commit guards. **Reload your
editor — done.**

## 2. See it work

```bash
tower status        # active claims
tower stats         # which kind of collision actually fires (local counts only)
tower watch         # live view in the terminal
```

Running a team server? Open **`https://<your-server>/board`** — the live radar board:
flight strips per claim, collisions flashing red, and the COMMS panel showing agents
talking. (Local HTTP mode works too: `tower serve --http`, then http://127.0.0.1:4319/board.)

## 3. Try a collision without any agent

`acme/app` below is a throwaway repo id — this touches none of your files. It does create
`.tower/` (your local SQLite state) in the current directory; `rm -rf .tower` resets it.

```bash
tower claim --agent bob   --repo acme/app --symbol "src/auth.ts#AuthService.verify" --purpose "replace JWT" --eta 6
tower claim --agent alice --repo acme/app --symbol "src/auth.ts#AuthService.verify" --purpose "rate limit"
# → ⛔ COLLISION on AuthService.verify (held by bob), with your options
```

Or run the packaged two-agent demo from a clone: `npm run demo`.

## 4. Make your agents talk

```bash
tower send          # interactive: asks who + what (your identity/repo come from git)
tower inbox         # read your messages; tasks arrive with a reply hint
```

Agents do the same over MCP (`send_message` / `fetch_messages`), and every
`claim_intent` response tells them when they have unread mail — so a task you delegate
is picked up the next time their agent touches Tower.

Want pickup to be automatic — even with the editor closed? Run `tower work` on the
recipient's machine: a worker daemon that accepts delegated tasks, runs a local agent
headlessly, and PRs the result → [worker.md](./worker.md).

## 5. Go deeper

- Whole team on one server (Render one-click, same-WiFi mode) → [team.md](./team.md)
- Blocking enforcement (Claude Code hook + universal pre-commit) → [enforcement.md](./enforcement.md)
- PR collision reports in CI → [action.md](./action.md)
- The wire contract (all 20 tools) → [protocol.md](./protocol.md)

## What changed in 0.12.1

- **Hook-blocked edits get the full 0.12 treatment.** An edit blocked by the PreToolUse
  hook or the pre-commit guard now shows the `alternatives`, and Tower messages the agent
  when the blocking claim ends. It is also blocked when a declaration it read has since
  moved, and it is counted once in `tower stats`.
- **Claims made from the CLI or the hooks carry signatures**, so "moved under you"
  warnings and landed-signature notices work there too, not only for MCP clients.
- **`init --hooks` upgrades an existing install**, including an older `PostToolUse`
  matcher that never watched `Read`. From your Tower clone:
  `git pull && npm install && npm run build && npx tower-mcp init --hooks`
- **`tower <command> --help` works** (it used to exit 1), and `tower --version` is new.

## What changed in 0.12.0 — nobody waits

- A **refused claim says what to do instead**: `alternatives.avoid` lists what the holder
  has plus code inferred to depend on it (from recorded reads — no policy file), with one
  line of advice and a sequencer task when you have modules defined.
- **The refused agent is messaged when the claim ends** — completed, released or expired.
- **Warned at read time**: `record_reads` (and the `PostToolUse` hook on every `Read`)
  reports anyone currently changing what you just read.
- **Contract-first**: set `declares` on a symbol you claim to the signature it will have.
  Callers get it immediately and build in parallel; on completion Tower tells them whether
  what landed matches.
- `tower setup --keep-going` writes a rule that routes around conflicts instead of stopping.
- The hooks' exit codes now survive on Windows — a blocked edit really is blocked.
  **Re-run `npm run build` in your Tower clone** to pick up the hooks.

## What changed in 0.9.0

- A **hard conflict is refused**, not just reported. Nothing is registered until the clash
  is resolved; `force: true` overrides and is recorded.
- **Forks and clones share one coordination space** — claims are keyed on the repository's
  root commit, so `git@…` vs `https://…` vs a fork under another name are all one place.
- **Other branches are compared too**, reported as a soft warning rather than silence.
- **`propose_intent`** — describe what you're about to work on _before researching_, and
  Tower tells you if someone is already on it, even under a different filename.
- `tower init --hooks` wires all five Claude Code hooks in one command.
