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
- **Message** — an async agent-to-agent note: `kind` is `message` (chat), `task`
  (delegated work), or `task_update` (status reply, threaded via `replyTo`).
  `toAgentId: "*"` broadcasts to every agent on the repo; each recipient's read state is
  tracked separately. Delivery is pull-based — MCP has no push channel — so
  `claim_intent` responses carry the caller's `unreadMessages` count as the wake-up signal.
  A `task` message doubles as a lifecycle object (`open → accepted → done | failed`) under
  the **same id** — workers `accept_task` and `complete_task` it.

## Severity

| Severity | Meaning           | When                                                                                    |
| -------- | ----------------- | --------------------------------------------------------------------------------------- |
| `hard`   | Do not proceed    | Same file **and** same symbol, or either side claims the whole file                     |
| `soft`   | Proceed with care | Same file, different symbols (overlapping diffs likely)                                 |
| `info`   | FYI               | A claimed symbol depends on another agent's claimed symbol _(reserved; off by default)_ |

## Tools

All sixteen tools take and return JSON validated by the schemas in
[`packages/shared/src/protocol.ts`](../packages/shared/src/protocol.ts).

| Tool               | Purpose                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `claim_intent`     | Register intent **and** get collisions in one call. The primary tool. |
| `check_collision`  | Dry-run collision check without persisting a claim.                   |
| `heartbeat`        | Extend a claim's TTL; unheartbeated claims auto-expire.               |
| `complete_claim`   | Release a claim on commit (optionally record the sha).                |
| `release_claim`    | Abandon a claim without committing.                                   |
| `list_claims`      | List claims by repo/branch/status.                                    |
| `log_decision`     | Record a decision + why.                                              |
| `get_decisions`    | Recall decisions.                                                     |
| `next_task`        | Ask the sequencer for a task whose module is safe to start now.       |
| `send_message`     | Message or delegate a task to another agent (`toAgentId`, or `"*"`).  |
| `fetch_messages`   | Read the caller's inbox; fetched messages are marked read.            |
| `accept_task`      | Claim an open delegated task — first accept wins, sets the assignee.  |
| `complete_task`    | Finish a task (done/failed) with a result, optional commit sha + PR.  |
| `list_tasks`       | List delegated tasks by repo, status, recipient, or assignee.         |
| `request_approval` | Park a task for human approval (worker remote-approve mode).          |
| `resolve_approval` | Approve or reject a parked task (the board / a phone taps this).      |

### The agent loop

```
1. Before editing            → claim_intent { agentId, repo, branch, files, symbols, purpose }
2. If a "hard" conflict      → stop, surface options to the user
3. If unreadMessages > 0     → fetch_messages { agentId }; act on tasks, reply with task_update
4. While editing (~60s)      → heartbeat { claimId }
5. On commit (git hook)      → complete_claim { claimId, commitSha }
```

## Design notes

- **Model-agnostic:** Tower is an MCP server, so Claude Code, Cursor, Codex, and any
  MCP client work today. Nothing is Claude-specific.
- **Collision detection is semantic, not textual:** symbols come from tree-sitter ASTs,
  so `AuthService.verify` collides with `AuthService.verify` even in different diff hunks.
- **Not a lock server:** claims are advisory. Tower informs; the agent/human decides.
