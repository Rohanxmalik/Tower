# Tower 🗼

**Air-traffic control for AI agents editing a shared repo.**

Tower is an [MCP](https://modelcontextprotocol.io) server that stops two AI agents from
colliding on the same code. Any agent — Claude Code, Cursor, Codex, Gemini — registers
what it's _about to change_; Tower detects **semantic** overlap with other active agents
and warns **before** the edit happens, not at merge time.

![Tower catches a collision before the edit](docs/demo.svg)

```
⛔ COLLISION — AuthService.verify
   Agent "cursor-bob" is mid-change (started 2s ago, ETA ~6m, purpose: replace JWT).
   Options:  [w] wait   [d] take dependent task   [b] branch from their WIP   [f] force
```

> The image above is a static preview. Generate the animated GIF with
> [`vhs`](https://github.com/charmbracelet/vhs): `vhs examples/two-agents-demo/demo.tape` → `docs/demo.gif`.

> Status: **early / building in public.** MVP works end-to-end. See [MVP-SPEC.md](./MVP-SPEC.md)
> for the full design and roadmap.

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
Record it — that's the launch GIF.

## Quickstart

Needs **Node 22+** (uses built-in `node:sqlite`, no native build).

```bash
npx @tower/cli init      # writes .tower/policy.yaml + prints MCP setup
npx @tower/cli serve     # MCP over stdio (or: serve --http --port 4319 --token <secret>)
```

Point your agent's MCP config at Tower and add to its rules file:

> "Before editing any file, call `claim_intent` with the files and symbols you'll change.
> If a `hard` conflict returns, stop and ask the user."

Full setup → [docs/quickstart.md](./docs/quickstart.md).

## The 9 tools

| Tool                               | Purpose                                                      |
| ---------------------------------- | ------------------------------------------------------------ |
| `claim_intent`                     | Register intent **and** get collisions in one call (primary) |
| `check_collision`                  | Dry-run collision check, no claim persisted                  |
| `heartbeat`                        | Keep a claim alive (auto-expires otherwise)                  |
| `complete_claim` / `release_claim` | Free a claim on commit / abandon                             |
| `list_claims`                      | Live claim state                                             |
| `log_decision` / `get_decisions`   | Shared architecture-decision memory                          |
| `next_task`                        | Rule-based sequencer: a module that's safe to start now      |

Wire contract → [docs/protocol.md](./docs/protocol.md).

## How it works

```
MCP clients (Claude Code / Cursor / Codex)
        │  stdio  ·  HTTP/SSE
        ▼
Tower server ── collision engine (tree-sitter symbols) · sequencer · SQLite store
        ▲
tower CLI: init · serve · status · watch · claim · complete   (+ git post-commit hook)
```

- **Semantic, not textual:** symbols come from tree-sitter ASTs (TS/JS/Python), so
  `AuthService.verify` collides even across different diff hunks.
- **Advisory, not a lock server:** Tower informs; the agent/human decides.
- **Model-agnostic:** it's an MCP server — every major agent works today.

## Monorepo layout

```
packages/shared   protocol types + zod schemas (source of truth)
packages/server   collision engine, sequencer, SQLite store, MCP server, transports
packages/cli      the `tower` command
examples/         two-agents-demo, git-hooks
docs/             quickstart, protocol
```

## Develop

```bash
npm install
npm test          # vitest, 80% coverage gate
npm run build     # tsc -b
```

## Roadmap

- Predictive conflict detection (ML on your merge history) — the eventual moat
- Auto-resolution / reconciliation agent
- Cross-repo / org-wide intent graph + API-contract break detection
- Enterprise: policy engine, SSO, audit ledger
- A2A adapter for cross-vendor agent delegation

## License

MIT
