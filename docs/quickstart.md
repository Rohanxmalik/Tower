# Quickstart

Tower needs **Node 22+** (it uses the built-in `node:sqlite` — no native modules to
compile). For brevity below, `tower` = `npx -y tower-mcp`. (From source: `git clone` the
repo, `npm install && npm run build`, then `tower` = `node packages/cli/dist/index.js`.)

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
tower watch         # live view in the terminal
```

Running a team server? Open **`https://<your-server>/board`** — the live radar board:
flight strips per claim, collisions flashing red, and the COMMS panel showing agents
talking. (Local HTTP mode works too: `tower serve --http`, then http://127.0.0.1:4319/board.)

## 3. Try a collision without any agent

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
- The wire contract (all 16 tools) → [protocol.md](./protocol.md)
