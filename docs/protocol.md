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
  recorded. `soft` never blocks. A refusal is not a dead end: it carries `alternatives`
  (what is still safe to work on) and Tower messages the refused agent when the blocking
  claim ends — see [Nobody waits](#nobody-waits--what-a-refusal-hands-you).
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
| `soft`   | `write_read`  | Code against it   | The holder **declared** its new signature — `declaredSigText` has it    |
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

Detection runs at three moments, so neither side has to call first: when the reader
**reads** (`record_reads` returns `conflicts`), when it **claims**, and on every
**`heartbeat`** after it claimed, which reports anything that moved or was declared since.

**Limit, stated plainly:** behavioural changes under an identical signature are
invisible by design; that is the trade that keeps false positives near zero.

## Nobody waits — what a refusal hands you

A `hard` conflict used to end in `stand_down` and nothing else, so one conflict parked an
agent until a human noticed. Since 0.12.0 each of the four places an agent could stall
has an answer on the wire. All of it is additive: a client that ignores these fields
behaves exactly as before.

**1. A refusal says what to do instead.** A refused `claim_intent` carries
`alternatives`:

| Field             | Meaning                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `avoid`           | Stay out of these for now — everything the blocking claims hold, plus code **inferred** to depend on it (below). Anything else is free. |
| `nextTask`        | A module the sequencer says is safe to start, when `.tower/policy.yaml` defines modules; otherwise `null`.                              |
| `notifyOnRelease` | `true` — Tower will message you when the block ends.                                                                                    |
| `advice`          | One line the agent can act on without parsing the rest.                                                                                 |

**Dependencies are inferred, not configured.** Tower already records what each claim
read. If a claim wrote `checkout` having read `verify`, then `checkout` depends on
`verify` — so while `verify` is held, `checkout` lands in `avoid` too. One hop, over the
last seven days of claims, capped at 50 entries. No `policy.yaml` needed.

**2. The refused agent is told when it is free.** Refusal registers the agent as a
waiter on each blocking claim. When that claim is completed, released or expires, Tower
sends it a message from `tower` naming what freed up. No retry loop.

**3. You are warned when you read, not when you edit.** `record_reads` returns
`conflicts`: anyone currently changing what you just read. That is the cheapest moment to
find out — before any plan has been built on it. The `PostToolUse` hook delivers this to
Claude Code as `additionalContext` on every `Read`.

**4. Contract-first: declare the signature before you write it.** A `SymbolRef` you
claim may carry **`declares`** — the declaration it _will_ have once your change lands:

```
claim_intent  symbols: [{ file: "src/auth.ts", symbol: "AuthService.verify",
                          declares: "verify(token: string, opts: Opts): boolean" }]
```

Write it as it will read in the source, up to the body — `verify(…)` for a method,
`function charge(…)` for a function. `export`, whitespace and a trailing comma are
ignored. Anyone whose work reads `AuthService.verify` gets a `soft` `write_read` conflict with
`declaredSigText` set, and codes against the new contract in parallel instead of waiting
for yours to land. A declared contract is never `hard`; a reader whose `sig` already
matches the declaration is not warned at all.

`complete_claim` takes the claimed **`symbols`** as they stand after the change (the
`tower complete` CLI and post-commit hook fill them from the working tree). Where a
declaration moved — or was declared — every agent whose work read it is messaged the
landed signature and told whether it **matches what was declared**. The response
reports how many: `{ ok, notified }`.

## Tools

All twenty tools take and return JSON validated by the schemas in
[`packages/shared/src/protocol.ts`](../packages/shared/src/protocol.ts).

| Tool               | Purpose                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `claim_intent`     | Register intent **and** get collisions in one call. The primary tool. |
| `check_collision`  | Dry-run collision check without persisting a claim.                   |
| `heartbeat`        | Extend a claim's TTL; unheartbeated claims auto-expire.               |
| `complete_claim`   | Release a claim on commit; tells readers what their contract became.  |
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
| `propose_intent`   | Before researching: catch another agent already doing the same work.  |
| `record_reads`     | Record what an agent read; returns anyone changing it right now.      |

### The agent loop

```
1. Before editing            → claim_intent { agentId, repo, branch, files, symbols, purpose }
2. If a "hard" conflict      → stop and ask (default), or with --keep-going work outside
                               alternatives.avoid; either way Tower messages you when it frees up
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
