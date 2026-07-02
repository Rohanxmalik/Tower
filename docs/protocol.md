# The Tower protocol

Tower is a thin coordination layer that any AI coding agent can speak to over
[MCP](https://modelcontextprotocol.io). This document specifies the wire contract so
other tools and models can interoperate — the long-term goal is a vendor-neutral
standard for **write-side coordination**, the way A2A standardized agent-to-agent
transport and MCP standardized agent-to-tool access.

## Concepts

- **Claim** — an agent's declaration of _intent_ to edit specific files/symbols, made
  **before** editing. Claims have a TTL and are kept alive with heartbeats.
- **Symbol** — a `{ file, symbol, kind }` reference. `symbol: ""` means the whole file.
- **Conflict** — a detected overlap between an incoming intent and an active claim, with
  a severity.
- **Decision** — a recorded architecture choice and the reasoning behind it (shared memory).

## Severity

| Severity | Meaning           | When                                                                                    |
| -------- | ----------------- | --------------------------------------------------------------------------------------- |
| `hard`   | Do not proceed    | Same file **and** same symbol, or either side claims the whole file                     |
| `soft`   | Proceed with care | Same file, different symbols (overlapping diffs likely)                                 |
| `info`   | FYI               | A claimed symbol depends on another agent's claimed symbol _(reserved; off by default)_ |

## Tools

All nine tools take and return JSON validated by the schemas in
[`packages/shared/src/protocol.ts`](../packages/shared/src/protocol.ts).

| Tool              | Purpose                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `claim_intent`    | Register intent **and** get collisions in one call. The primary tool. |
| `check_collision` | Dry-run collision check without persisting a claim.                   |
| `heartbeat`       | Extend a claim's TTL; unheartbeated claims auto-expire.               |
| `complete_claim`  | Release a claim on commit (optionally record the sha).                |
| `release_claim`   | Abandon a claim without committing.                                   |
| `list_claims`     | List claims by repo/branch/status.                                    |
| `log_decision`    | Record a decision + why.                                              |
| `get_decisions`   | Recall decisions.                                                     |
| `next_task`       | Ask the sequencer for a task whose module is safe to start now.       |

### The agent loop

```
1. Before editing            → claim_intent { agentId, repo, branch, files, symbols, purpose }
2. If a "hard" conflict      → stop, surface options to the user
3. While editing (~60s)      → heartbeat { claimId }
4. On commit (git hook)      → complete_claim { claimId, commitSha }
```

## Design notes

- **Model-agnostic:** Tower is an MCP server, so Claude Code, Cursor, Codex, and any
  MCP client work today. Nothing is Claude-specific.
- **Collision detection is semantic, not textual:** symbols come from tree-sitter ASTs,
  so `AuthService.verify` collides with `AuthService.verify` even in different diff hunks.
- **Not a lock server:** claims are advisory. Tower informs; the agent/human decides.
