# Tower — Testing Findings & Fix Brief

**Status:** ✅ **all fixed in v0.9.0** (2026-08-04). Every defect below (TWR-01 … TWR-11),
all four requested capabilities (REQ-A/B/C/D) and DEV-01 are implemented, with acceptance
tests T1–T8 in `packages/server/src/coordination.test.ts`,
`packages/server/src/engine/intent.test.ts` and `packages/cli/src/commands.test.ts`.
325 tests, 81.6% branches.

One extra defect was found while starting the work and is also fixed — **TWR-12: the test
suite was not hermetic.** `remoteConfig()` defaults to `process.env`, so on any machine
with `TOWER_URL` exported (the normal state for anyone running a worker) the unit tests
silently talked to a live hosted server and failed against real claims. `vitest.setup.ts`
now strips the ambient vars.

**Still to do:** the manual end-to-end check below, and the two-agent live verification —
both need real machines and cannot be proven by unit tests.
**Source:** live two-agent session against the hosted instance (`tower-z4xy.onrender.com`, v0.8.0), 2 Aug 2026.
**Audience:** the Claude Code session that will implement these fixes in this repo.

Read this whole file before changing anything. It contains findings you cannot reproduce
from the source alone, because several of them only appear when two agents run at once.

---

## The one-line summary

> Across an entire live session with two agents editing the same repo simultaneously, **every
> collision check returned `conflicts: []`**. Collision detection has never been observed to
> fire. The matching logic in `packages/server/src/engine/collision.ts` is correct — the
> _lookup key_ prevents it from ever running.

Fixing that is the point of this brief.

---

## What was actually tested

Two Claude Code agents (`claude-code-rohan`, `claude-mayank`) worked the same repo
(`Rohanxmalik/genos-ai`) at the same time, both writing a blog post on the same topic.

**Verified working:**

- MCP over HTTP with bearer auth (valid token → 200, invalid → 401)
- `send_message(kind=task)` → `accept_task` → `complete_task` end to end
- `claim_intent` → `complete_claim`
- `fetch_messages`, board snapshot rendering
- `heartbeat_worker` and its 30-second expiry — behaved exactly as coded
- `tower doctor` correctly reported server reachable + token accepted

**Never observed working:**

- A non-empty `conflicts` array — _the core product promise_
- `hard` vs `soft` severity (every claim passed `symbols: []`, so everything is whole-file)
- First-accept-wins under an actual race
- The pre-commit hook refusing a commit
- Approvals (`request_approval` / `resolve_approval`)
- Pinned-rule propagation to delegated tasks
- `next_task`, `release_claim`

---

## Confirmed defects

Severity is about blast radius, not effort.

### TWR-01 · CRITICAL · stdio `serve` silently ignores `TOWER_URL`

`cmdServe` unconditionally calls `buildService(cwd)` and never consults `remoteConfig()`.
Only CLI subcommands honour `TOWER_URL` via `withRemote`.

**Observed:** a decision logged through the MCP tool landed in the local `.tower/tower.db`
while the hosted board stayed empty.

**Why it is the highest severity:** it fails with _no visible symptom_. A team can believe
they are coordinating on a shared server while every write goes to a local SQLite file.

**Fix:** either proxy to the remote when `TOWER_URL` is set, or refuse to start and tell the
user to register the HTTP endpoint instead. Silent local fallback is not acceptable.

---

### TWR-02 · CRITICAL · repo key is an unnormalized exact string

Claims are partitioned by a caller-supplied free-text `repo` compared with SQL equality:

```
activeClaims(repo, branch) { ... WHERE repo = ? AND branch = ? AND status = 'active' }
```

**Observed:** the two agents registered `github.com/Rohanxmalik/genos-ai` and
`mayank-9031/genos-ai` and were completely invisible to each other.

**Important nuance:** `hooks/pretooluse-tower.mjs` _does_ normalize — it derives repo from
`git remote origin` through its own `normalizeRepo()`. The **MCP tool path does not**. So
agents coordinating via hooks and agents calling MCP tools directly land in different
partitions. Two code paths, two conventions.

**Fix:** normalize server-side on both write and query so every caller converges. Then see
REQ-C for a key stronger than any string.

---

### TWR-03 · CRITICAL · forks are treated as unrelated repositories

`mayank-9031/genos-ai` is a GitHub fork whose parent is `Rohanxmalik/genos-ai` — same
codebase, same paths, destined for the same `main` via PR. Tower models them as two projects.

Fork-and-PR is the standard flow for outside contributors, and it is exactly the case where
coordination matters most because participants share no working tree.

**String normalization cannot fix this** — the two names have nothing in common. It requires
identity derived from repository content. See REQ-C.

---

### TWR-04 · HIGH · claims on different branches are never compared

```
if (a.repo !== b.repo || a.branch !== b.branch) continue;
```

Branch is part of the lookup key, and pairwise comparison skips cross-branch pairs outright.
Agents normally work on separate feature branches — that is the common case, so detection is
disabled by default in precisely the situation it exists for. Two agents rewriting one file
on two branches still produce one merge conflict.

**Fix:** compare across branches. Same branch stays `hard`; cross-branch becomes `soft`
rather than silence.

---

### TWR-05 · HIGH · hard conflicts and no conflicts are indistinguishable in effect

`claim_intent` returns conflicts but registers the claim regardless. Nothing is refused and
no `force` acknowledgement is required, so severity is decorative — an agent that ignores the
response proceeds exactly like one that never checked.

**Fix:** refuse by default on hard conflict; require explicit `force: true` to override, and
record who forced past what.

---

### TWR-06 · HIGH · no auto-scan, no stand-down recommendation

Nothing polls the board. `check_collision`, `list_claims` and `pending` run only when an agent
volunteers, and the server never returns a recommended action.

**Observed:** the duplicate article was caught by the _human_, not the tool. Without that
intervention a duplicate post would have been committed.

---

### TWR-07 · HIGH · worker presence expires in 30s and is never refreshed automatically

```
var WORKER_ONLINE_MS = 3e4;
workers: this.store.listWorkers(WORKER_ONLINE_MS)
```

`lastSeen` only updates on an explicit `heartbeat_worker` call that ordinary agent sessions
never make.

**Observed:** one heartbeat appeared on the board, then vanished 30 seconds later while the
agent kept working for another hour. The board reads _0 workers online_ during active
multi-agent work.

---

### TWR-08 · MEDIUM · matching is path-only, so duplicated work is invisible

The two agents wrote:

```
ai-agent-security-prompt-injection.mdx     agent A
prompt-injection-agent-security.mdx        agent B
```

**These would have merged cleanly.** Zero git conflict, two near-identical articles, two full
research-and-write cycles for one deliverable.

The duplication was plainly visible in both `purpose` strings — each said "prompt injection" —
but nothing reads that field. Note that **no file-level check, however aggressive, catches
this**. See DEV-01.

---

### TWR-09 · MEDIUM · board status line contradicts itself

Header reads `connected — 0 worker(s) online`. "Connected" describes the browser's socket;
the count describes agents. Two unrelated facts in one sentence — it was the first thing that
looked broken during testing and the only thing that wasn't.

**Fix:** a link-state dot for the page socket, and a separate agent roster with per-agent state.

---

### TWR-10 · LOW · failed `accept_task` gives no reason

```
accept_task("d56b3d74")  →  {"ok": false, "task": null}
```

Indistinguishable from "already taken by another agent" — the one case an agent most needs to
tell apart, since it is the normal first-accept-wins outcome.

**Fix:** return a reason code (`not_found`, `already_accepted`, `wrong_agent`) and accept id
prefixes, since the CLI already displays ids truncated.

---

### TWR-11 · LOW · claim liveness is unlinked from worker liveness

Claims expire on their own TTL regardless of whether the owner is alive. A crashed agent keeps
blocking a file until its lease lapses; a live agent on a slow task can have its claim expire
underneath it.

**Fix:** treat a claim as stale once its owner's presence goes offline, and auto-extend while
the owner is demonstrably alive.

---

## Requested capabilities

### REQ-C · repo identity that survives forks — **do this first**

Use the **root commit SHA** as the repository primary key. Every clone, fork and mirror shares
its initial commit, so the value is identical across all of them, survives renames and
transfers, needs no API call or authentication, and works for non-GitHub remotes.

```
git rev-list --max-parents=0 HEAD

Rohanxmalik/genos-ai   → caaa8780f2853aec824905cc3278402fc26caa0a
mayank-9031/genos-ai   → caaa8780f2853aec824905cc3278402fc26caa0a   (fork)
```

**This was verified during the session** against both the upstream and the fork that Tower
failed to associate. Identical.

**Shape:** key claims on `repoId` (root SHA); keep the normalized URL as a human-readable label
only. Accept a `repoId` parameter on the MCP tools and derive it automatically in the CLI and
hooks. For repos with multiple root commits, take the earliest by commit date and store the set.

---

### REQ-A · presence that means "connected and working"

Three changes together — widening the window alone just makes stale entries linger:

- **Automatic heartbeat**, driven by session lifecycle hooks rather than agent goodwill.
- **Three states:** `working` (tool activity or active claim within ~2 min), `idle` (session
  alive, no recent activity), `offline` (no heartbeat past TTL). Show relative last-seen.
- **Join the roster to active claims** so each agent shows _what_ it is working on. That is the
  view that actually prevents duplicate work.

Keep a short window for `working` and a much longer one for `connected`.

---

### REQ-B · auto-scan and auto stand-down

- **Server:** `claim_intent` returns a directive, not just data —
  `{ blocking: true, recommendation: "stand_down", heldBy, since, purpose }` — and refuses
  unless `force: true`. (Fixes TWR-05.)
- **Client:** an MCP server cannot compel an agent to call it. Enforcement must live in the
  `PreToolUse` hook, which already exists.

---

### REQ-D · hooks — mostly built, three gaps

**Already correct, do not rewrite:**

- `hooks/pretooluse-tower.mjs` — blocks on hard conflict via `cmdGuard`, exit 2, silent on the
  happy path.
- `hooks/userpromptsubmit-nudge.mjs` — runs `tower nudge`, prints **only** when tasks or
  messages are waiting.

Both are silent by default and fail open. That is the right design: **a hook that exits without
printing costs zero tokens**, so per-edit checking is free across a whole session.

| Hook                  | State   | Job                                                   |
| --------------------- | ------- | ----------------------------------------------------- |
| `SessionStart`        | missing | register worker; inject scoped decisions              |
| `UserPromptSubmit`    | exists  | nudge — prints only if work waiting                   |
| `PreToolUse`          | exists  | `Edit\|Write\|MultiEdit` → `cmdGuard` → exit 2 blocks |
| `PostToolUse`         | missing | reconcile claim against the real diff                 |
| `Stop` / `SessionEnd` | missing | release claims; write decisions; mark offline         |

**Gap 1 — the invariant.** Both hooks fail open _silently_
(`main().catch(() => process.exit(ALLOW))`). A Tower outage is therefore indistinguishable from
a clean check. Make it fail open but **loud**: allow the edit, print that coordination was not
enforced.

> **Silence must always mean verified-clear, never "did not check."**

**Gap 2 — repo id consistency.** The hook normalizes; the MCP path does not. See TWR-02.

**Gap 3 — defaults.** The hooks ship in the repo but nothing installs them. Add
`tower init --hooks` to write the block into `.claude/settings.json`. An unwired hook enforces
nothing.

---

## Highest-value new feature

### DEV-01 · check intent at plan time, not write time

The session's waste happened **entirely before any file existed**. Both agents ran web
searches, read the codebase and drafted ~1,500 words. By the time either touched a claimable
path, the tokens were already spent — and because the filenames differed, _no file-level check
would ever have fired_.

**Shape:** a `propose_intent` call when an agent decides _what_ to work on ("I intend to write a
post about prompt injection"), matched semantically against active and recently completed
claims, before research begins.

**Cost:** one call per task. Cheaper than any per-edit or per-prompt check, and it is the only
thing that covers the failure actually observed.

---

## Suggested order

Ordered by what unblocks the most downstream value.

1. **REQ-C — repo identity by root commit** (fixes TWR-02, TWR-03). Nothing else matters while
   agents on one repo cannot see each other. Small change, unblocks everything below.
2. **TWR-04 — compare across branches.** With identity fixed, this is what finally lets a
   conflict fire. Do 1 and 2 together, then run the collision test below.
3. **TWR-05 — make `claim_intent` blocking.** Cheap; converts detection into a real safety
   property.
4. **REQ-D gaps 1–3** — fail-open-loud, repo id consistency, `tower init --hooks`.
5. **DEV-01 — plan-time intent matching** (closes TWR-08).
6. **REQ-A — presence rework** (fixes TWR-07, TWR-09). Depends on hooks for auto-heartbeat.
7. **TWR-01 — the silent local-mode trap.** Independent, but do not ship a public release with
   it.
8. **TWR-10, TWR-11** — error surfaces and claim liveness.

---

## Acceptance tests — write these first, they currently cannot pass

The repo already has `vitest` and tests colocated beside sources
(`packages/server/src/engine/collision.test.ts`, `service.test.ts`, `mcp.test.ts`,
`packages/cli/src/commands.test.ts`). Add to those.

**T1 — fork and upstream share one coordination space** _(REQ-C)_
Two claims on the same file, one registered as `github.com/owner/repo`, one as
`other-owner/repo`, both with the same `repoId` root SHA → `check_collision` returns a **hard**
conflict. Currently returns `[]`.

**T2 — cross-branch overlap is detected** _(TWR-04)_
Claim `src/app/page.tsx` on `main` and on `feature/x` → returns a conflict (`soft` is
acceptable). Currently returns `[]`.

**T3 — repo string variants collapse** _(TWR-02)_
`https://github.com/o/r.git`, `git@github.com:o/r`, `github.com/O/R` all resolve to one
partition and conflict with each other.

**T4 — hard conflict is refused** _(TWR-05)_
`claim_intent` on a file held by another agent → rejected, claim **not** registered. With
`force: true` → registered, and the forcing is recorded.

**T5 — first-accept-wins** _(untested surface)_
Two concurrent `accept_task` calls for one task → exactly one `ok: true`; the loser gets
`already_accepted`, not a bare `false` _(TWR-10)_.

**T6 — the hook actually blocks** _(REQ-D)_
Agent A holds a claim on `page.tsx`; agent B triggers `PreToolUse` for the same path → exit 2,
reason on stderr. Then with Tower unreachable → exit 0 **with a visible warning**, never silent
_(gap 1)_.

**T7 — semantic duplicate is caught** _(DEV-01)_
`propose_intent("write a blog post about prompt injection")` while another agent holds a claim
whose purpose is "AI agent security / prompt injection" → soft conflict, **despite the file
paths differing**. This is the exact case that cost a full duplicate this session.

**T8 — presence reflects reality** _(REQ-A)_
An agent that made a tool call 90 seconds ago still shows as connected; one silent past TTL
shows offline. Currently the first disappears after 30 seconds.

---

## Manual end-to-end check before release

The bug that started all of this is invisible to unit tests:

1. Point an agent at a hosted Tower with `TOWER_URL` set, using the **stdio** MCP server.
2. Log a decision through the MCP tool.
3. Confirm it appears on the **hosted board** and _not_ in a local `.tower/tower.db`.

Today it goes local, silently (TWR-01).

---

## Constraints

- **Do not break the existing hooks.** They are correct; they need extending, not replacing.
- **Preserve fail-open.** A Tower outage must never brick editing — but it must now say so.
- `WORKER_ONLINE_MS` is fine for "working"; do not simply widen it to fix presence.
- Keep `normalizeRepoUrl` for display labels even after `repoId` lands — humans read the board.
- Everything in this brief was reproduced against **v0.8.0**; re-verify line references if the
  source has moved since.
