# Tower — MVP Spec

> Working name: **Tower** (air-traffic control for AI agents editing a shared repo). Swappable — alternatives: Baton, Airlock, Semaphore, Relay.

**One-liner:** An MCP server that stops two AI agents from colliding on the same code. Any agent (Claude Code, Cursor, Codex, Gemini) registers what it's about to change; Tower warns _before_ the edit happens, not at merge.

**The demo (the reason people star it):**

> Two agents, one repo. Agent B starts refactoring `AuthService.verify`. Agent A tries to touch the same symbol →
>
> ```
> ⛔ COLLISION — AuthService.verify
>    Agent "cursor-bob" is mid-refactor (started 2m ago, ETA ~6m, purpose: replace JWT).
>    Options:  [w] wait   [d] take dependent task   [b] branch from their WIP   [f] force
> ```

Record that as a GIF. That GIF is the launch.

---

## 1. Scope

### In (MVP)

- **Phase 0 (hidden plumbing):** intent claims, live shared state, decision log. Invisible; exists only to enable the hero feature.
- **Phase 1 (the hero):** symbol-level claims + **semantic pre-flight collision detection** + a clean terminal prompt.
- **Phase 2 (lite slice only):** **rule-based** work sequencer from a config file. NOT the ML conflict-prediction model (needs data we don't have yet — that's post-launch).

### Out (roadmap, stated in README as "coming")

- Predictive conflict AI (needs merge-history data from real users)
- Auto-resolution / reconciliation agent
- Cross-repo / org-wide intent graph
- Enterprise policy engine, SSO, audit ledger
- A2A transport adapter (MCP first; A2A when cross-vendor delegation matters)

Rule: ship real features + a roadmap. Never ship fake features (they generate issues, not stars).

---

## 2. Architecture

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Claude Code │   │    Cursor    │   │    Codex     │   ...any MCP client
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │ MCP (stdio/HTTP)  │                  │
       └──────────────┬────┴──────────────────┘
                      ▼
             ┌──────────────────┐
             │   Tower Server   │   MCP server
             │ ┌──────────────┐ │
             │ │ tool handlers│ │  claim / check / release / decision
             │ ├──────────────┤ │
             │ │ collision    │ │  symbol overlap engine (tree-sitter)
             │ │ engine       │ │
             │ ├──────────────┤ │
             │ │ sequencer    │ │  rule-based dep ordering (lite)
             │ ├──────────────┤ │
             │ │ SQLite store │ │  claims, decisions, TTL
             │ └──────────────┘ │
             └──────────────────┘
                      ▲
             ┌────────┴────────┐
             │  tower CLI      │  serve / status / watch / claim
             │  + git hook     │  post-commit → auto-release claim
             └─────────────────┘
```

**Design choices (all optimized for stars = zero-friction adoption):**

- **Language: TypeScript.** MCP SDK is TS-first; biggest contributor pool.
- **Store: SQLite.** Single file, zero-config, `npx tower serve` just works. Redis/Postgres later for multi-node.
- **Transport: MCP over stdio (local) + optional HTTP/SSE (multi-user).**
- **Model-agnostic by construction:** it's an MCP server, so every major agent speaks to it today. This is the moat vs editor-locked tools — say it loudly.
- **Works solo:** run 2 agents yourself → no cold-start / network-effect problem.

---

## 3. Data model

```ts
type SymbolRef = {
  file: string; // repo-relative path
  symbol: string; // e.g. "AuthService.verify" ("" = whole file)
  kind?: "function" | "class" | "method" | "type" | "file";
};

type Claim = {
  id: string;
  agentId: string; // "claude-1", "cursor-bob" — human-readable
  repo: string;
  branch: string;
  files: string[];
  symbols: SymbolRef[];
  purpose: string; // short intent string, shown in collision prompt
  status: "active" | "completed" | "expired";
  etaMinutes?: number;
  createdAt: number;
  expiresAt: number; // TTL; refreshed by heartbeat, auto-expires dead agents
  commitSha?: string; // set on completion
};

type Conflict = {
  claimId: string; // the existing claim we collide with
  agentId: string;
  severity: "hard" | "soft" | "info";
  reason: string;
  overlap: SymbolRef[];
  etaMinutes?: number;
};

type Decision = {
  id: string;
  title: string;
  body: string; // what + why
  author: string; // "claude-1 + rohan"
  tags: string[];
  createdAt: number;
  relatedFiles?: string[];
};
```

### Collision severity rules (MVP)

| Severity | Trigger                                                                 | Suggested action               |
| -------- | ----------------------------------------------------------------------- | ------------------------------ |
| `hard`   | Same `file` **and** same `symbol` claimed by an active claim            | wait / branch-from-WIP / force |
| `soft`   | Same `file`, different symbols (still risky — overlapping diffs)        | proceed with caution / notify  |
| `info`   | A claimed symbol references another agent's claimed symbol (dependency) | heads-up only                  |

MVP ships `hard` + `soft`. `info` (dependency-aware) is the stretch — needs a symbol reference graph; keep behind a flag.

---

## 4. MCP tool contract

Server exposes these MCP tools (agents call them; also usable via CLI):

| Tool              | Args                                                            | Returns                            | Purpose                                                         |
| ----------------- | --------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| `claim_intent`    | `{agentId, repo, branch, files, symbols, purpose, etaMinutes?}` | `{claimId, conflicts: Conflict[]}` | Register intent + get collisions in one call. **Primary tool.** |
| `check_collision` | `{repo, branch, files, symbols}`                                | `{conflicts: Conflict[]}`          | Pre-flight peek without claiming                                |
| `heartbeat`       | `{claimId}`                                                     | `{ok, expiresAt}`                  | Keep claim alive; missing → auto-expire                         |
| `complete_claim`  | `{claimId, commitSha?}`                                         | `{ok}`                             | Release on commit/done                                          |
| `release_claim`   | `{claimId}`                                                     | `{ok}`                             | Abandon without commit                                          |
| `list_claims`     | `{repo?, branch?, status?}`                                     | `{claims: Claim[]}`                | Live state (powers `tower status`)                              |
| `log_decision`    | `{title, body, author, tags?, relatedFiles?}`                   | `{id}`                             | Record architecture decision + why                              |
| `get_decisions`   | `{query?, tags?, relatedFiles?}`                                | `{decisions: Decision[]}`          | Recall decisions before acting                                  |
| `next_task`       | `{agentId, repo}`                                               | `{task?, reason}`                  | Rule-based sequencer: hand back a non-conflicting task          |

**Agent workflow (the loop that matters):**

1. Before editing → `claim_intent`.
2. If `conflicts` has a `hard` → surface the prompt (wait / dependent / branch / force).
3. While editing → `heartbeat` every ~60s.
4. On commit (git post-commit hook) → `complete_claim`.

Ship a tiny **system-prompt snippet** telling agents to always `claim_intent` before edits — that's how you get adoption inside Claude Code / Cursor rules files.

---

## 5. Rule-based sequencer (Phase 2 lite)

No ML. Reads `.tower/policy.yaml`:

```yaml
# module dependency graph — sequencer orders tasks by this
modules:
  auth: { path: "src/auth/**" }
  api: { path: "src/api/**", depends_on: [auth] }
  dashboard: { path: "src/dashboard/**", depends_on: [api] }

limits:
  max_agents_per_module: 2
```

`next_task` logic: given queued tasks, don't hand out a task whose module `depends_on` a module with an active in-flight claim. Pure topological ordering. Honest, useful, no fake AI. README frames the ML prediction version as roadmap.

---

## 6. Repo structure

```
tower/
├── README.md                 # hero GIF, one-liner, 5-min quickstart, roadmap
├── package.json              # npm workspaces
├── LICENSE                   # MIT (max stars/adoption)
├── packages/
│   ├── server/
│   │   └── src/
│   │       ├── index.ts          # MCP server entry (stdio + optional HTTP/SSE)
│   │       ├── tools/            # one file per MCP tool handler
│   │       │   ├── claim.ts
│   │       │   ├── collision.ts
│   │       │   ├── decision.ts
│   │       │   └── sequencer.ts
│   │       ├── engine/
│   │       │   ├── collision.ts   # overlap detection + severity
│   │       │   ├── symbols.ts     # tree-sitter symbol extraction
│   │       │   └── sequencer.ts   # topological ordering from policy.yaml
│   │       ├── store/
│   │       │   ├── sqlite.ts      # claims/decisions, TTL sweep
│   │       │   └── schema.sql
│   │       └── types.ts
│   ├── cli/
│   │   └── src/index.ts          # tower serve | status | watch | claim | init
│   └── shared/
│       └── src/protocol.ts       # shared types + tool schemas (source of truth)
├── examples/
│   └── two-agents-demo/          # scripted collision demo → record the GIF here
├── docs/
│   ├── quickstart.md
│   └── protocol.md               # the claim/collision protocol (bid to become a standard)
└── .tower/
    └── policy.yaml               # example config
```

---

## 7. Build order (fastest path to the GIF)

1. `shared/protocol.ts` — types + tool schemas.
2. `store/sqlite.ts` + `schema.sql` — claims table + TTL sweep.
3. `engine/collision.ts` — `hard`/`soft` overlap (start with file+symbol string match; tree-sitter after).
4. `tools/claim.ts` + `collision.ts` — wire into MCP server (`index.ts`, stdio).
5. `cli` — `tower serve`, `tower status` (pretty live table).
6. **`examples/two-agents-demo` → record the GIF.** ← launch asset.
7. `engine/symbols.ts` (tree-sitter) — upgrade collision from string-match to real symbols.
8. `sequencer` + `policy.yaml`, `log_decision`/`get_decisions`.
9. README + `docs/protocol.md`. Post GIF.

Steps 1–6 = the star-getting core. 7–9 = depth. Ship 1–6 first, launch, then 7–9.

---

## 8. Quickstart (goes in README — must be this short)

```bash
npx @tower/server init          # writes .tower/policy.yaml + MCP config snippet
npx @tower/server serve         # start the coordination server (SQLite, zero config)
```

Add to your agent's MCP config (Claude Code / Cursor), then add to its rules file:

> "Before editing any file, call `claim_intent` with the files and symbols you'll change. If a `hard` conflict returns, stop and ask the user."

Done. Run two agents on the same repo and watch collisions get caught.

---

## 9. Explicitly deferred (README "Roadmap")

- Predictive conflict detection (ML on merge history) — **the eventual moat; needs your usage data**
- Auto-resolution agent
- Cross-repo / org-wide intent graph + API-contract break detection
- Enterprise: policy engine, SSO, audit ledger
- A2A adapter for cross-vendor agent delegation
