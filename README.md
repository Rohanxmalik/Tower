# Tower 🗼

[![CI](https://github.com/Rohanxmalik/Tower/actions/workflows/ci.yml/badge.svg)](https://github.com/Rohanxmalik/Tower/actions/workflows/ci.yml)
![Node ≥22](https://img.shields.io/badge/node-%E2%89%A522-3fb950)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Air-traffic control for AI agents editing a shared repo — and the channel they talk on.**

**[tower-mcp on npm](https://www.npmjs.com/package/tower-mcp)** · **[Website](https://rohanxmalik.github.io/Tower/)** · **[Docs](./docs)** — setup: `npx -y tower-mcp setup`

Tower is an [MCP](https://modelcontextprotocol.io) server that connects your team's
coding agents. Any agent — Claude Code, Cursor, Codex, Gemini — registers what it's
_about to change_; Tower detects **semantic** overlap with every other active agent and
holds the second one **before it spends a token**, not at merge time. And the agents
don't just avoid each other: they **message, delegate tasks, and report back** through
Tower's agent channel, visible live on the radar board.

![Tower catches a collision before the edit](docs/demo.svg)

```
⛔ COLLISION — AuthService.verify
   Agent "cursor-bob" is mid-change (started 2s ago, ETA ~6m, purpose: replace JWT).
   Options:
     [w] wait      — retry in a few minutes; their claim expires without heartbeats
     [d] dependent — run: tower next-task  (a module that's safe to start now)
     [b] branch    — build on their WIP instead of racing them
     [f] force     — re-run guard with --force; you own the merge risk
```

> The banner above is an animated SVG. Prefer a real terminal-recording GIF? Run
> [`vhs`](https://github.com/charmbracelet/vhs): `vhs examples/two-agents-demo/demo.tape` → `docs/demo.gif`.

> Status: **v0.4 — early, building in public.** Collision detection, three enforcement
> layers, the live board, agent messaging/delegation, and the GitHub Action all work
> end-to-end today (156 tests, 80% coverage gate). Original design doc: [MVP-SPEC.md](./MVP-SPEC.md).

## Why

Memory, agent protocols (MCP/A2A), and observability dashboards are already solved. The
unowned gap is **write-side coordination** — as teams run many agents per repo in parallel,
the bottleneck becomes collisions and wasted work you only discover at merge. Tower is the
model-agnostic layer that prevents that. It sits _above_ git and _uses_ MCP; it doesn't
replace either.

## See it (5 seconds)

```bash
npm run demo
```

Two agents reach for the same symbol; the second is caught before its first keystroke.
Turn it into a GIF with [`vhs`](https://github.com/charmbracelet/vhs):
`vhs examples/two-agents-demo/demo.tape`.

## Quickstart (30 seconds)

Needs **Node 22+** (uses built-in `node:sqlite`, no native build). In your repo:

```bash
npx -y tower-mcp setup            # writes .mcp.json + agent rules; add --hooks for enforcement
```

Reload your editor — done. Joining a team server instead?

```bash
npx -y tower-mcp setup --url https://tower-xxxx.onrender.com/mcp --token <team-secret> --hooks
```

<details><summary>What setup does / manual config</summary>

`setup` writes the `tower` entry into `.mcp.json` (merging with your existing servers),
appends the claim-first + check-your-inbox rule to `CLAUDE.md` (and `AGENTS.md` if you
have one), and with `--hooks` installs the git pre/post-commit guards. Manual equivalent:

```jsonc
// Claude Code — .mcp.json
{
  "mcpServers": {
    "tower": { "command": "npx", "args": ["-y", "tower-mcp", "serve"] },
  },
}
```

```bash
npx -y tower-mcp init      # writes .tower/policy.yaml + prints MCP setup
npx -y tower-mcp serve     # MCP over stdio (or: serve --http --port 4319 --token <secret>)
```

</details>

<details><summary>From source (contributors)</summary>

```bash
git clone https://github.com/Rohanxmalik/Tower && cd Tower
npm install && npm run build
node packages/cli/dist/index.js serve
```

</details>

Then add to your agent's rules file:

> "Before editing any file, call `claim_intent` with the files and symbols you'll change.
> If a `hard` conflict returns, stop and ask the user."

Full setup → [docs/quickstart.md](./docs/quickstart.md).

## The 11 tools

| Tool                               | Purpose                                                                |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `claim_intent`                     | Register intent **and** get collisions in one call (primary)           |
| `check_collision`                  | Dry-run collision check, no claim persisted                            |
| `heartbeat`                        | Keep a claim alive (auto-expires otherwise)                            |
| `complete_claim` / `release_claim` | Free a claim on commit / abandon                                       |
| `list_claims`                      | Live claim state                                                       |
| `log_decision` / `get_decisions`   | Shared architecture-decision memory                                    |
| `next_task`                        | Rule-based sequencer: a module that's safe to start now                |
| `send_message` / `fetch_messages`  | The agent channel: async messages + **task delegation** between agents |

Wire contract → [docs/protocol.md](./docs/protocol.md).

## How it works

```
MCP clients (Claude Code / Cursor / Codex)
        │  stdio  ·  HTTP/SSE
        ▼
Tower server ── collision engine (tree-sitter) · agent inbox · sequencer · SQLite · /board UI
        ▲
tower CLI: setup · serve · status · watch · claim · guard · send · inbox · next-task · complete
```

- **Semantic, not textual:** symbols come from tree-sitter ASTs (TS/JS/Python), so
  `AuthService.verify` collides even across different diff hunks.
- **Model-agnostic:** it's an MCP server — every major agent works today.

## Enforcement (don't rely on the agent remembering)

A tool call the agent _chooses_ to make isn't a safety net. Tower has **three enforcement
layers** — stack them:

1. **MCP tools + rules file** — every agent (Claude, Cursor, Codex) claims before editing.
2. **Claude Code PreToolUse hook** — a conflicting `Edit`/`Write` is physically **blocked**:
   ```bash
   npm run build
   cp .claude/settings.example.json .claude/settings.json   # then reload Claude Code
   ```
3. **Universal git pre-commit guard** — works with _any_ editor or agent; the commit itself
   is refused while a teammate's agent holds a conflicting claim:
   ```bash
   cp examples/git-hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
   ```

Details + scope → [docs/enforcement.md](./docs/enforcement.md).

## Live radar board

Every `serve --http` Tower ships a real-time board at **`/board`**: every agent's claims as
ATC flight strips, collisions flashing red, TTL countdowns. Open it next to your editor and
watch your team's agents coordinate.

![Tower live board — a collision between two agents on AuthService.verify](docs/board.png)

## Agents that talk to each other

Tower is Slack for your agents, literally: agents leave each other **async messages and
task requests**, delivered on the recipient's next Tower contact (MCP has no push channel,
so delivery is inbox-style — like Slack, not a phone call).

- **"You've got mail" is automatic:** every `claim_intent` response carries the agent's
  `unreadMessages` count, and the rules file tells agents to `fetch_messages` when it's >0.
- **Task delegation across people:** your Claude sends `kind: "task"` → your co-founder's
  Claude picks it up on its next contact, does the work **on their machine, with their
  account**, and replies with `kind: "task_update"`. Nobody shares API keys — each agent
  runs under its own credentials, always.
- **The whole conversation is visible** in the **COMMS panel on `/board`**, next to the
  flight strips.

From a terminal — just run `send`; it asks the rest (who you are + the repo come from git):

```
$ npx -y tower-mcp send
To (agent id, or * for everyone): bob
Message: add rate limiting to /login
Is this a task for them? [y/N]: y
📨 Sent task c78094d1 → bob

$ npx -y tower-mcp inbox         # your messages (identity inferred from git)
```

(Scripts/agents pass flags instead: `send --to bob --body "..." --task` — prompts
never appear outside a real terminal.)

## GitHub Action: PR collision reports

No server needed — one workflow file comments on any PR that touches the same files
(overlapping lines flagged) as another open PR, and shows live agent claims if you run a
hosted Tower:

```yaml
- uses: Rohanxmalik/Tower/action@main
```

Setup + screenshots → [docs/action.md](./docs/action.md).

## Team mode (whole team, different machines)

Point everyone's agents — Claude, Cursor, Codex — at **one** Tower. When two people's
agents reach for the same file, the second is flagged **before it spends a token** — not at
merge. Two setups, pick by your team:

- **Same office / same WiFi (or living together):** no deploy, no tunnel — one laptop hosts
  (`serve --http --host 0.0.0.0`), everyone points at its `192.168.x.x` address. 2 minutes.
- **Remote / different networks:** host one Tower online for a permanent HTTPS URL.

Deploy your own online in ~5 minutes (free tiers available), no tunnels:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Rohanxmalik/Tower)

Or self-manage with Docker:

```bash
TOWER_TOKEN=your-secret docker compose up -d   # http://<host>:4319/mcp
```

Each dev's `.mcp.json` uses `"type": "http", "url": ".../mcp"` — now your Claude tells your
co-founder's Codex "don't touch auth until commit abc123." Full setup, beginner-friendly —
same-WiFi mode + click-by-click Render steps + per-editor config →
[docs/team.md](./docs/team.md).

> 🚀 **Don't want to host it?** [Tower Cloud](https://rohanxmalik.github.io/Tower/#cloud) —
> a managed, always-on coordination server for teams — is coming. Join the waitlist.

## Monorepo layout

```
packages/shared   protocol types + zod schemas (source of truth)
packages/server   collision engine, sequencer, SQLite store, MCP server, transports
packages/cli      the `tower` command
hooks/            Claude Code PreToolUse enforcement hook
action/           GitHub Action — PR collision reports
examples/         two-agents-demo, git-hooks (pre-commit guard, post-commit release)
docs/             quickstart, protocol, enforcement, team, action, waitlist
Dockerfile        hosted team server
```

## Develop

```bash
npm install
npm test          # vitest, 80% coverage gate
npm run build     # tsc -b
```

## Roadmap

- Per-agent identity & auth (today: one shared team token) — the Tower Cloud foundation
- More language grammars for symbol extraction (Go, Rust, Java — [contributions welcome](./CONTRIBUTING.md))
- Predictive conflict detection (ML on your merge history) — the eventual moat
- Auto-resolution / reconciliation agent
- Cross-repo / org-wide intent graph + API-contract break detection
- Enterprise: policy engine, SSO, audit ledger

## Contributing & community

PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) (TDD, small PRs, good-first ideas
inside). Security reports → [SECURITY.md](./SECURITY.md). Changes → [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
