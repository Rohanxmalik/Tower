# CLAUDE.md — Tower

Tower is an MCP server that stops two AI agents from colliding on the same code:
agents register edit **intent** before editing, and Tower detects semantic overlap
(tree-sitter symbols) with other active agents, warning **before** the edit — not at
merge time.

## 🛑 The claim-first rule (dogfooding Tower)

**Before editing any file, call the `claim_intent` MCP tool** with the files and
symbols you're about to change, plus a short `purpose`.

- If a **`hard`** conflict is returned → **stop and ask the user** (another agent is
  mid-change on that symbol). Offer: wait / take a dependent task / branch from their WIP.
- If a **`soft`** conflict is returned → proceed carefully; you share a file with another
  agent.
- While editing, call `heartbeat` (~every 60s) so your claim doesn't expire.
- After committing, call `complete_claim` with the commit sha (or let the git
  post-commit hook do it — see `examples/git-hooks/post-commit`).

The `tower` MCP server is wired up in [.mcp.json](.mcp.json). Run `npm run build` once so
`packages/cli/dist` exists, then reload your editor to load the server.

## Commands

```bash
npm install
npm run build     # tsc -b (required before serve/demo)
npm test          # vitest, 80% coverage gate (strict TDD)
npm run lint      # eslint + prettier --check
npm run demo      # the two-agent collision demo
```

## Layout

| Package | What |
|---------|------|
| `packages/shared` | Protocol types + zod schemas — the single source of truth (9 tools) |
| `packages/server` | Collision engine (tree-sitter), sequencer, SQLite store, MCP server, transports |
| `packages/cli` | The `tower` command: init / serve / status / watch / claim / complete |

Wire contract: [docs/protocol.md](docs/protocol.md). Full design: [MVP-SPEC.md](MVP-SPEC.md).

## Conventions

- **TDD, tests first.** 80% coverage gate is enforced; keep it green.
- **Zod at every boundary** — schemas in `packages/shared/src/protocol.ts` are canonical;
  don't redefine wire types elsewhere.
- **Node 22+** (uses the built-in `node:sqlite` — no native modules).
- Symbols come from **tree-sitter ASTs** (TS/JS/Python); unknown languages fall back to a
  file-level symbol.
- Keep files small and focused; commit messages use Conventional Commits.

## Do NOT build (roadmap, on purpose)

ML conflict prediction, auto-resolution, cross-repo/org intent graph, enterprise
policy/SSO/audit, A2A adapter. These are post-launch and some need real usage data first.
