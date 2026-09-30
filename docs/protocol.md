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
  a severity. A `hard` conflict **refuses** the claim (`claimId: null`, `blocking: true`,
  `recommendation: "stand_down"`) unless the caller passes `force: true`, which is
  recorded. `soft` never blocks.
- **repoId** — the repository's root commit sha (`git rev-list --max-parents=0 HEAD`),
  identical across every clone, fork and mirror. Claims partition on it, so a fork and its
  upstream coordinate. Omit it and the server falls back to the normalized remote URL.
- **Intent** — a plain-English description of work an agent is _about to start_.
  `propose_intent` matches it against what everyone else is doing, so duplicated effort is
  caught before the research, and even when the two agents would write different files.
- **Decision** — a recorded architecture choice and the reasoning behind it (shared memory).
- **Message** — an async agent-to-agent note: `kind` is `message` (chat), `task`
  (delegated work), or `task_update` (status reply, threaded via `replyTo`).
  `toAgentId: "*"` broadcasts to every agent on the repo; each recipient's read state is
  tracked separately. Delivery is pull-based — MCP has no push channel — so
  `claim_intent` responses carry the caller's `unreadMessages` count as the wake-up signal.
  A `task` message doubles as a lifecycle object (`open → accepted → done | failed`) under
  the **same id** — workers `accept_task` and `complete_task` it.
- **Worker** — a `tower work` daemon that runs delegated tasks. It calls `heartbeat_worker`
  each poll; the board treats a worker seen in the last 30s as **online**, so you can see
  (and target) machines that are actually ready to run work. The heartbeat carries a
  self-reported **status** (`ok` | `low` — cooling down after a rate-limit failure or over
  its `--budget`), and tasks may carry an advisory **size** (`s`/`m`/`l`). Decisions tagged
  `rule` are team-wide standing orders: workers prepend them to every delegated prompt.

## Severity

Conflicts carry a `kind`. `write_write` is the classic overlap; `write_read` is an
**antidependency** — someone is changing, or has already changed, a declaration you built
against.

| Severity | Kind          | Meaning           | When                                                                    |
| -------- | ------------- | ----------------- | ----------------------------------------------------------------------- |
| `hard`   | `write_write` | Do not proceed    | Same file **and** same symbol, or either side claims the whole file     |
| `soft`   | `write_write` | Proceed with care | Same file, different symbols (overlapping diffs likely)                 |
| `hard`   | `write_read`  | Do not proceed    | A declaration in your `reads` **has already moved** — the `sig` differs |
| `soft`   | `write_read`  | Proceed with care | Another agent holds a declaration you read, but it still matches        |
| `info`   | —             | FYI               | Reserved; off by default                                                |

## Freshness — `reads`, `sig`, and why a write set is not enough

A claim is only as fresh as the read that produced it. Comparing write sets catches two
agents editing one symbol, and is structurally blind to the more common case: A moves
`AuthService.verify` while B, having read the old signature, writes a caller in another
file. Different file, different symbol — the write-write pass exits immediately, and B
finds out at CI.

So `claim_intent` and `check_collision` take an optional **`reads`**: the declarations the
work was written against. Each `SymbolRef` may carry:

- **`sig`** — a scheme-tagged digest (`c1:…`) of the symbol's **declaration**, body
  excluded. A rewritten body, a renamed local, a comment or a `prettier` run never move
  it; an added parameter or a changed return type always does. Interfaces, type aliases
  and enums hash whole, because every part of them is visible to a caller.
- **`sigText`** — the same declaration in readable form, capped at 240 chars.

When a `write_read` conflict is `hard`, the response carries `wasSigText` and
`nowSigText`, so an agent patches its call sites from a two-line delta rather than pulling
the module back into context:

```
[HARD] AuthService.verify moved under you — alice changed the declaration you read
    was: verify(token: string)
    now: verify(token: string, opts: Opts)
```

Everything here is optional. Send no `reads` and the behaviour is exactly as before.

**Current limit, stated plainly:** detection runs when the _reader_ calls, against claims
that are already open. An agent that claimed first is not retroactively notified when
someone later moves a declaration it read — delivery on `heartbeat` is the next step.
Behavioural changes under an identical signature are invisible by design; that is the
trade that keeps false positives near zero.

## Tools

All twenty tools take and return JSON validated by the schemas in
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
| `pending`          | Read-only count of unread messages + open tasks; marks nothing read.  |
| `accept_task`      | Claim an open delegated task — first accept wins, sets the assignee.  |
| `complete_task`    | Finish a task (done/failed) with a result, optional commit sha + PR.  |
| `list_tasks`       | List delegated tasks by repo, status, recipient, or assignee.         |
| `request_approval` | Park a task for human approval (worker remote-approve mode).          |
| `resolve_approval` | Approve or reject a parked task (the board / a phone taps this).      |
| `heartbeat_worker` | A worker announces it's online & ready (drives live presence).        |
| `record_reads`     | Record declarations an agent read, so its next claim carries them.    |

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
