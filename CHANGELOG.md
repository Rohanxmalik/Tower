# Changelog

All notable changes to `tower-mcp`. Follows [Keep a Changelog](https://keepachangelog.com);
versions are [semver](https://semver.org) (0.x — expect movement).

## 0.12.1 - 2026-10-01

**0.12.0's promises now hold on the path most blocked edits actually take.** An audit
after release found that `tower guard` — what the PreToolUse hook and the pre-commit
guard run — never reached the code 0.12.0 added. Everything below is a fix or a
correction; no protocol changes, still 20 tools.

### Fixed

- **A hook-blocked agent was promised a message it never got.** `tower guard`
  pre-checked with `check_collision` and returned before `claim_intent`, so the blocked
  agent was never registered as a waiter, never saw `alternatives`, and the collision
  never reached `tower stats` — while the prompt printed "[w] wait — Tower messages you"
  and 0.12.0's notes said the same. `guard` now goes straight through `claim_intent`
  (a refusal registers nothing, so the pre-check bought nothing).
- **An edit built on a moved declaration went through unclaimed.** The same pre-check
  ignored the agent's recorded reads; the claim that followed was refused over them, and
  the refusal was dropped. It now blocks.
- **Claims from the CLI and the hooks carried no signatures.** `path#name` symbols were
  sent without their declaration fingerprint, so on the hook path there was no hard
  `write_read`, no heartbeat invalidation and no landed-signature notice on complete —
  only MCP clients that sent `sig` themselves got any of it. They are now fingerprinted
  from the working tree.
- **`tower stats` counted a retry as a new collision.** A hook retries a blocked edit each
  time the agent reaches for it. A refusal is now counted once per agent per blocking
  claim.
- **`init --hooks` never upgraded an existing install.** It skipped any event already in
  `.claude/settings.json`, so an install from before 0.11 kept a `PostToolUse` matcher
  without `Read` — no recorded reads, none of 0.12's read-time warnings — and re-running
  the documented command said "already wires every Tower hook". It now rewrites Tower's
  own entries, moves Tower's command out of a group it shares with yours rather than
  editing that group, adds Tower's entry beside your own hooks for the same event, and
  never changes your hooks. **Upgrade:** in your Tower clone,
  `git pull && npm install && npm run build && npx tower-mcp init --hooks`.
- `.claude/settings.example.json` had the old matcher too; a test now holds it equal to
  what `init --hooks` writes.
- `tower init` printed a hand-copied pre-0.12 rule; it now prints the one `tower setup`
  writes.
- `tower <command> --help` exited 1 with "Unknown option"; every command now prints help
  and exits 0. New: `tower --version`. Help now lists `work`'s `--agent`, `--repo`,
  `--cmd`, `--interval`, `--max-minutes`, `--no-push`, `--no-pr` and `serve`'s `--host`.
- The UserPromptSubmit nudge hook fell back to `npx -y tower-mcp nudge` — a registry call
  on every prompt, contradicting "no network calls you didn't configure". Like every
  other hook it now needs the built CLI, and says so on stderr if it is missing.
- `tower-anywhere` had the same guard bug; its `guard` now goes through `claim_intent`
  too, and both commands print what is still free when refused.
- Docs: SECURITY.md described one hook on one machine; team.md and enforcement.md said
  repo identity comes from `origin` (it is the root commit sha); worker.md never said what
  happens when a headless run hits a conflict; the site's tool grid listed 19 of 20
  tools. Sample repo ids and agent names in tests and on the site are now made up.

### Added

- `site/logo.png` (listed as the registry icon) and `site/og.png`, the link preview.
- `glama.json`, for claiming the Glama directory listing.

## 0.12.0 - 2026-10-01

**Nobody waits.** Before this release a `hard` conflict ended in `stand_down` and
nothing else, and the rule `tower setup` writes said "stop and ask the user" — so a single
conflict parked an agent until a human noticed. Each of the four places an agent could
stall now has an answer on the wire. All of it is additive and optional: a client that
ignores the new fields behaves exactly as on 0.11. Still 20 tools.

### Added

- **A refusal says what to do instead.** A refused `claim_intent` carries
  `alternatives`: `avoid` (what the blocking claims hold, plus code inferred to depend on
  it), `nextTask` (a sequencer task, when `.tower/policy.yaml` defines modules),
  `notifyOnRelease`, and one line of `advice`. `tower claim` prints it under the refusal.
- **Dependencies inferred from reads, not configured.** A claim that wrote `checkout`
  having read `verify` is evidence that `checkout` depends on `verify`, so while `verify`
  is held `checkout` is in `avoid` too. One hop, the last seven days of claims, capped at
  50 — no `policy.yaml` required.
- **The refused agent is messaged when the block ends.** Refusal registers a waiter on
  each blocking claim; completion, release or expiry sends it a message from `tower`
  naming what freed up. No retry loop.
- **Warned at read time.** `record_reads` returns `conflicts` — anyone changing what you
  just read — and takes an optional `branch`, so work on another branch warns `soft`. The
  `PostToolUse` hook delivers this to Claude Code as `additionalContext` on every `Read`
  (plain stdout from that hook never reaches the agent).
- **Contract-first: `declares`.** A `SymbolRef` you claim may carry the declaration it
  will have once your change lands. Readers get a `soft` `write_read` with
  `declaredSigText` and build against it in parallel; a declared contract is never `hard`,
  and a reader already on it is not warned. `heartbeat` delivers a declaration to readers
  that claimed first.
- **`complete_claim` reports the contract that landed.** It takes the claimed `symbols`
  as they stand after the change (`tower complete` and the post-commit hook fill them
  from the working tree). Every agent that read a declaration which moved — or was
  declared — is messaged the landed signature and whether it matches the declaration. The
  output is now `{ ok, notified }`.
- `tower setup --keep-going` writes a rule that routes around a conflict instead of
  stopping: work outside `avoid`, and ask the human only when nothing safe is left. The
  default rule still says stop and ask.

### Fixed

- **On Windows, a blocked edit was not blocked.** The hooks ended with `process.exit()`,
  which aborts in libuv (`!(handle->flags & UV_HANDLE_CLOSING)`) while V8 is still
  compiling tree-sitter's WebAssembly in the background. The PreToolUse hook printed its
  refusal and exited `127` instead of `2`, which Claude Code treats as a non-blocking
  error — so the edit went ahead. The same crash discarded every `PostToolUse` context.
  The hooks now set `process.exitCode` and let the process end, with an unref'd timer as
  a backstop; measured 0/10 correct exit codes before and 10/10 after. **Re-run
  `npm run build` in your Tower clone** — the hooks run from there, not from npm.
- `cmdRecordReads` did not fall back to deriving `repoId` the way `cmdClaim` does, so a
  caller that omitted it recorded reads in a different partition from its own claims. The
  shipped hook always passed one; this closes the gap for every other caller.
- A `declares` written with a leading `export` fingerprints the same as the parsed
  declaration, which never includes it.
- `[w] wait` in the collision prompt said "retry in a few minutes"; Tower now messages you.
- Docs: the protocol tool table omitted `propose_intent`, the README and site still said
  the hook claims at file granularity (it has claimed the enclosing function since
  0.10), and the protocol's "current limit" described heartbeat delivery as unshipped.

## 0.11.1 - 2026-09-30

**Listed on the official MCP Registry.** The registry is upstream of the directory
ecosystem — Glama, PulseMCP and mcp.so sync from it — so one listing reaches further
than filling in each of their forms by hand.

### Added

- `server.json` — the registry manifest, validated against the live registry rather
  than a schema file. (The schema served at `2025-07-09` is stale and snake_case; the
  current one is `2025-12-11` and camelCase, and validating locally against the old
  copy reports "valid" for a document the registry rejects with a 422.)
- `mcpName` in the published package. The registry proves npm ownership by fetching the
  package and matching this field against the server name. **This is the only functional
  reason for this release** — npm versions are immutable, so the field cannot be added
  to one already published.
- A workflow that publishes the manifest on every release, authenticating with GitHub
  Actions OIDC. `mcp-publisher login github` is broken in every published build
  (modelcontextprotocol/registry#1543, fixed by #1588 but unreleased as of v1.8.1);
  OIDC is a separate code path. Publishing from CI also means the listing cannot drift
  from the release, which hand-publishing does the first time anyone forgets a step.

### Fixed

- The landing page claimed 429 tests; the suite was at 433. Now states `430+`, which
  stays true as tests are added — a precise number that is wrong reads worse than an
  approximate one that is right.

No API, protocol or tool changes. Still 20 tools.

## 0.11.0 - 2026-09-30

**A claim is only as fresh as the read that produced it.** Comparing write sets catches
two agents editing one symbol and is structurally blind to the more common failure: A
moves `AuthService.verify` in `auth.ts` while B, having read the old signature, writes a
caller in `payments.ts`. Different file, different symbol, so the collision check exited
on its first line and told both agents to proceed. B found out at CI.

### Added - version-aware claims

- **`reads` on `claim_intent` and `check_collision`** - the declarations the work was
  written against. A second detection pass compares them against what other agents hold
  open, and reports `kind: "write_read"` when one is moving or has already moved.
- **Signature fingerprints.** `SymbolRef` carries an optional `sig` - a digest of the
  symbol's **declaration**, body excluded - and `sigText`, the readable form. A rewritten
  body, a renamed local, a comment or a `prettier` run never move it; an added parameter
  or a changed return type always does. That precision is the point: a staleness warning
  that fires on a reformat gets muted, and a muted tool is worth nothing.
- **Tower watches reads rather than asking for them.** The PostToolUse hook now also
  matches `Read` and records what the agent looked at, with each declaration's signature
  at that moment. An agent that never learns to send `reads` is covered anyway.
  **Re-run `tower init --hooks` from a clone to pick this up.** PreToolUse stays
  write-only on purpose - it blocks edits, and a Read must never be blocked.
- **`heartbeat` reports what moved after you claimed.** Claim-time detection only sees
  claims already open, so an agent that claimed first was never told when a declaration
  moved under it later. `HeartbeatOutput` now carries `invalidations`, riding the call
  agents already make every ~60s - no push channel, no polling.
- **`record_reads`** - the twentieth tool. Normally called by the hook, not by an agent.

A hard `write_read` conflict carries the delta:

```
[HARD] AuthService.verify moved under you - alice changed the declaration you read
    was: verify(token: string)
    now: verify(token: string, opts: Opts)
```

Two lines instead of "your context may be stale, re-read the file", which costs a whole
module back in context to discover one parameter moved. Tower exists to spend fewer
tokens, so a staleness signal that costs a file read is worse than silence.

### Added - `tower stats`

Tower detected collisions for four versions and forgot every one, so "which kind actually
happens, and how often" had no answer. A `conflicts` table now records kind, severity and
whether it was forced - **no file names, no symbol names, no code**, and nothing is sent
anywhere. `tower stats` reads it locally.

### Compatibility

Every new field is optional and every new behaviour is additive. A client that sends no
`reads` gets exactly 0.10.1's behaviour, and there is a test that says so. Calling
`record_reads` against an older hosted Tower fails harmlessly - the hook swallows it, and
a missed read costs a warning, never correctness.

### Known limits, stated rather than left to be found

Behavioural changes under an identical signature are invisible. That is deliberate: it is
the trade that keeps false positives near zero. Cross-file _inference_ is not attempted -
Tower knows what an agent read because it watched, not because it resolved a dependency
graph.

429 tests, 89.9% statements, 81.5% branches.

## 0.10.1 - 2026-09-30

**`tower setup --url ... --token ...` wrote your team token into a file teams commit.**
0.10.0 moved the token out of an `Authorization` header and into the `env` block of
`.mcp.json`, and a test named "keeps the token out of an Authorization header written to
disk" locked that in. Both were true. Neither mattered: `.mcp.json` is shared project
config - Tower's own repo tracks it - so anyone following the documented setup command
and committing their config published a live team token.

### Fixed

- **`setup --token` now adds `.mcp.json` to `.gitignore`** and says plainly that the file
  holds a secret, including the `git rm --cached .mcp.json` needed when git already tracks
  it. Without a token the file stays out of `.gitignore`, because then it is ordinary
  shared config a team is right to commit.
- **The local-mode warning no longer recommends the bug 0.10.0 fixed.** When `TOWER_URL`
  was set, `serve` refused to start and told you to point your agent at a
  `"type": "http"` entry - the exact shape that leaves no process on your machine to
  compute `repoId`, which is how a fork and its upstream split in silence. It now shows
  the `serve --remote` proxy form.

- **`tower doctor` green-lit machines Tower cannot run on.** 0.9.1 fixed the Node floor in
  `requireModernNode`, but `doctor` carried its own copy of the naive `>= 22.5` check - so
  the command whose entire job is "is this machine ready?" passed 22.5-22.12 and 23.0-23.3,
  the two windows where `node:sqlite` is still behind a flag, and the real command then
  died on `ERR_UNKNOWN_BUILTIN_MODULE`. It now calls `requireModernNode` directly. Its
  tests had encoded the wrong floor too, including a "healthy machine" fixture pinned to
  v22.5.0.

- **`init --hooks` installed five hooks that could never fire.** The hook scripts live in
  `hooks/` in a clone; the npm package ships `dist/` only. Run from npm, the command wrote
  five entries pointing at files that were not there, printed
  `✔ .claude/settings.json — installed …`, and told the user to run `npm run build` in a
  project where that script does not exist. Nothing errored, so the `PreToolUse` hook that
  is supposed to block a conflicting edit simply never ran — and the user had every reason
  to think they were covered. It now refuses when the scripts are absent and gives the
  clone-first steps. The git guards, which shell out to `npx -y tower-mcp`, are unaffected
  and still work straight from the package.

- **The PR collision action had never read a single input.** GitHub exposes an input as
  `INPUT_<NAME>`, uppercased with _spaces_ mapped to underscores — hyphens are kept. The
  action mapped hyphens too, so it read `INPUT_GITHUB_TOKEN` while the runner had set
  `INPUT_GITHUB-TOKEN`; `github-token`, `tower-url` and `tower-token` were all undefined.
  It failed on the token before reaching any collision logic, caught its own throw, printed
  `::warning::` and exited 0 — a green check on an action that did nothing. Surfaced by
  opening the repository's first-ever pull request.

- **`tower --help` exited 1.** `--help`, `-h` and `help` all fell through to the unknown-
  command branch: the right text printed, then a failure code. `tower --help && …` broke,
  and so did every smoke test. They are real commands now and exit 0. Bare `tower` was
  already correct. Caught on the first run of the new packaged-tarball CI job.

## 0.10.0 — 2026-08-11

**A fork and its upstream coordinated in separate spaces, in silence.** Two agents on one
project — one on `rohanxmalik/acme-web`, one on their own fork — both claimed the same
work, both got `recommendation: "proceed"`, and no conflict was ever reported. Nothing
errored. Found in a live two-machine session.

0.9.0 shipped `repoId` to fix exactly this. It did not work, for two reasons.

### Fixed — identity now reaches the server

- **Nothing on the MCP path ever _sent_ `repoId`.** No tool description mentioned it, and
  with `.mcp.json` pointing a `type: "http"` entry straight at the hosted URL, there is no
  process on the developer's machine to compute it. `tower setup --url` now writes a
  **local proxy** instead — `tower serve --remote <url>` — which resolves this repo's
  identity once from `cwd` and stamps it onto every call before forwarding. The agent
  never learns the concept exists.
- **Only 4 of 19 tools accepted `repoId`.** `send_message`, `fetch_messages`, `pending`,
  `list_tasks`, `next_task` and `heartbeat_worker` did not, so messaging and delegation
  split even when claims matched. All repo-scoped tools now carry identity.
- **`messages`, `tasks` and `workers` were keyed on the raw repo string** — there was no
  `repoKey` on those tables at all. Every repo-scoped table now carries and queries the
  same key, with a migration that backfills existing rows.
- **`projectId`** — set `projectId: <name>` in `.tower/policy.yaml` (or `TOWER_PROJECT_ID`)
  and every clone converges regardless of git history, remote URL, or whether it is a git
  repo at all. Resolution order is `projectId` → `repoId` → normalized remote.
- `claim_intent` stored claims without the `projectId` it had just used for the lookup, so
  a claim could be written under a key no reader would compute. Caught by a new test.

### Fixed — it never fails silently again

- `claim_intent` returns **`projectWarning`** when another active agent is on a repo with
  the same name under a different owner. Advisory only — the claim still succeeds, and
  matching on name is deliberately never used to partition, because two teams can both own
  a repo called `api`. The original failure was the silence, not the mismatch.

### Fixed — presence and duplicate detection

- **Presence came only from `heartbeat_worker`**, which the `tower work` daemon calls and
  an ordinary agent session never does. An agent claiming and messaging all day read as
  "seen earlier" forever. Any authenticated tool call now refreshes presence.
- **`propose_intent` ignored delegated work.** It matched other stated intents but not
  open or accepted tasks, so it returned `proceed` while the same job sat in the queue. It
  now matches against both.

### Fixed — the blocker is finally symbol-level

- **`hooks/pretooluse-tower.mjs` passed `symbols: []`.** Symbol-level detection is the
  headline claim, and the one layer that actually _blocks_ an edit ignored it — so two
  agents in different functions of one file blocked each other. The hook now locates the
  edit's `old_string` in the file, asks tree-sitter which declaration encloses that
  offset, and claims **that symbol**. New `SymbolExtractor.extractRanges()` and
  `symbolAt()` back it. Falls back to a file-level claim for a `Write`, a new file, an
  unsupported language, or an edit between declarations — over-claiming is safe,
  under-claiming is not.

### Fixed — decisions no longer leak between teams

- `log_decision` / `get_decisions` were global. On a shared server one team's
  architecture notes surfaced in another team's recall — the same silent cross-partition
  leak as the fork bug, one table over. Decisions now carry a project key and are scoped
  when the caller names one. Rows written before scoping stay visible to everyone, which
  is what they already were.

### Fixed — the proxy can no longer take the editor down

- `cmdServe` dialled the hosted server **before** serving stdio. A cold host (Render's
  free tier sleeps and takes ~50s to wake), a stale token or a dropped network killed the
  process before it spoke MCP, leaving the editor with a dead server and **no Tower tools
  at all** — worse than the bug it replaced. The connection is now lazy, retries once on
  a fresh socket, and survives sleep and redeploys. An unreachable server surfaces as a
  loud per-call error saying coordination was not enforced, never as silence.

### Board

Split "who's connected" into three live tables, all from data the snapshot already
carried: **Live agents** (status / runner / last seen), **Active claims** (agent / file /
symbol / purpose / ETA) and **Active work** (task / from / to / status / size).

### Upgrading

Re-run `tower setup --url <your-server> --token <token> --hooks` on **every machine** so
`.mcp.json` switches to the proxy form. A direct `type: "http"` entry still works but
cannot supply identity, which is the bug. Teams whose clones share no git history should
also commit `projectId` to `.tower/policy.yaml`.

## 0.9.1 — 2026-08-05

**The Node version check was wrong, and it cost the first outside user their first command.**

`node:sqlite` landed in Node 22.5, but stayed behind `--experimental-sqlite` until
**23.4** (backported unflagged to **22.13**). The guard only checked `>= 22.5`, so two
whole windows — **22.5–22.12** and **23.0–23.3** — passed the check and then died on
`require("node:sqlite")` with a raw `ERR_UNKNOWN_BUILTIN_MODULE` stack trace instead of
an answer. Reported from a live setup on Node 23.3.0.

### Fixed

- `requireModernNode` now gates on the versions where `node:sqlite` is actually
  unflagged: **22.13+, 23.4+, or 24+**. The error names your version, the upgrade, and
  the flag.
- A flagged Node is now accepted when you have opted in yourself, via either
  `--experimental-sqlite` in `execArgv` or `NODE_OPTIONS`. Running
  `NODE_OPTIONS=--experimental-sqlite tower <command>` on 23.3 is a supported path, not a
  workaround that trips the guard.
- `engines.node` is now `>=22.13 <23 || >=23.4`, so npm warns on the flagged window
  rather than claiming those versions work.
- Corrected the "Node 22.5+" claim in the README badge, quickstart, CONTRIBUTING,
  CLAUDE.md and the launch/demo docs.

### Note

This makes the failure legible; it cannot make `node:sqlite` exist. On 22.5–22.12 or
23.0–23.3 you still need `NODE_OPTIONS=--experimental-sqlite`, or an upgrade to Node 24.

## 0.9.0 — 2026-08-04

**Collision detection fires for the first time.** A live two-agent session against a
hosted instance found that _every_ collision check returned `conflicts: []` — including
two agents editing the same file at the same moment. The matching engine was correct all
along; the lookup key meant it never ran. This release is that fix, plus the things
testing found around it.

- **One repo means one coordination space.** Claims are partitioned on a key resolved
  server-side, not on whatever string the caller happened to send. `repoId` — the
  repository's **root commit sha** — is identical across every clone, fork and mirror, so
  **a fork and its upstream now coordinate**; previously they were modelled as unrelated
  projects, which is precisely the case where coordination matters most (participants
  share no working tree). Callers that send no `repoId` fall back to the normalized URL,
  so `git@…` vs `https://…` vs different casing no longer splits one team into isolated
  groups that never see each other. Existing databases are backfilled on open.
- **Agents on different branches can finally see each other.** Branch was part of the
  lookup key, so detection was disabled by default in the common case — agents normally
  work on separate feature branches, and two of them rewriting one function still produce
  a single merge. Cross-branch overlaps now report as **`soft`** rather than as silence.
- **A hard conflict is actually refused.** `claim_intent` used to return conflicts and
  register the claim anyway, which made severity decorative: an agent that ignored the
  response behaved exactly like one that never checked. It now returns
  `blocking: true`, `recommendation: "stand_down"` and **writes nothing**. Pass
  `force: true` to override; the override is recorded so the board can show who forced
  past what. **Breaking:** `claimId` is now nullable.
- **`propose_intent` — catch duplicated work before the tokens are spent.** The session's
  real loss was not a merge conflict: two agents independently researched and wrote the
  same article under different filenames, git merged them cleanly, and the result was two
  full research-and-write cycles for one deliverable. The new 19th tool takes a plain
  English description of what you're about to do and matches it against what everyone
  else is doing — so it catches a duplicate **even when the file paths differ**, and it
  fires before the research rather than after. Matching is lexical and dependency-free:
  no model, no embeddings, and no network call, because Tower makes no network calls you
  didn't configure.
- **The board stops claiming nobody is there.** Presence used a single 30-second window
  refreshed only by an explicit `heartbeat_worker` that interactive sessions never call,
  so the board read _0 agents online_ during active multi-agent work. There are now two
  windows — "working" and "still here" — three states (`working` / `idle` / `offline`),
  and the roster is **joined to each agent's live claims**, so you can see _what_ everyone
  is doing. The self-contradicting `connected — 0 worker(s) online` header is split into a
  link-state indicator and an agent roster.
- **Claims track their owner's liveness.** A heartbeat extends the claims that agent
  holds, so a live agent on a slow task no longer has its claim expire underneath it, and
  the new `SessionEnd` hook releases claims when an editor closes instead of leaving
  phantom blocks until the TTL lapses.
- **stdio `serve` no longer writes locally in silence.** It called `buildService()`
  unconditionally and never consulted `TOWER_URL`, so a team could believe it was
  coordinating on a shared server while every write went to a SQLite file on one laptop —
  with no visible symptom. It now explains the problem, asks when there's a TTY, and
  refuses when there isn't (an MCP client spawns it with no TTY, so there's nobody to
  ask). `--http` is unaffected; it _is_ the shared server.
- **`accept_task` says why it failed** — `not_found` / `already_accepted` /
  `awaiting_approval` / `rejected`. Losing a race is the _normal_ outcome of a broadcast
  and must not look like an error. It also accepts a unique id prefix, since the CLI and
  board both print ids truncated.
- **Hooks: three new, and silence now means something.** `SessionStart` registers the
  session, `PostToolUse` keeps presence and claims alive, `SessionEnd` releases them. The
  two existing hooks still fail open — a Tower outage must never brick editing — but they
  now **say so**, because a silent pass was indistinguishable from a check that never ran.
  **`tower init --hooks`** writes all five into `.claude/settings.json`, merging with what
  you already have; the hooks shipped in the repo before but nothing installed them, and
  an unwired hook enforces nothing.
- **The test suite no longer talks to production.** `remoteConfig()` reads `process.env`,
  so on any machine with `TOWER_URL` exported — the normal state for anyone running a
  worker — unit tests silently hit a live server and failed against real claims. The
  suite is now hermetic.
- 325 tests (up from 262), 80% coverage gate green.

## 0.8.0 — 2026-07-27

- **Your agent gets tapped on the shoulder.** New 18th MCP tool **`pending`** — a
  read-only count of unread messages + open tasks waiting for an agent, marking nothing
  read. It powers **`tower nudge [--agent <id>] [--json]`** (local or remote; silent when
  nothing's waiting) and a **UserPromptSubmit hook** (`hooks/userpromptsubmit-nudge.mjs`,
  wired in `.claude/settings.example.json`), so an interactive Claude Code agent sees
  _"2 tasks waiting"_ on its next prompt. MCP has no push channel; this closes the gap
  without running a worker daemon.
- **Delegated tasks can finally run git, tests, and builds.** The headless `claude` runner
  defaults to `--permission-mode acceptEdits`, which gates Bash behind a TTY that isn't
  there — so a task could write code but never verify or commit it, then report a
  misleading _"I couldn't push"_. **`tower work --permission-mode bypass`** runs the runner
  with `--dangerously-skip-permissions` so an approved task can run commands (`acceptEdits`
  stays the default; unknown values are rejected). The task prompt now also states that
  **the worker owns commit and push**, so the runner stops attempting git itself.
- **A run that changed nothing no longer shows green.** The worker reports
  **`filesChanged`**; a 0-file run renders an amber **"done · no changes"** chip on the
  board and says so in the `task_update`. Stored in a new nullable `tasks.filesChanged`
  column, migrated in place — existing databases upgrade cleanly.
- **`setup --hooks` installed a post-commit hook that could never run.** It was hardcoded
  to `node packages/cli/dist/index.js`, a path that only exists inside this monorepo, and
  the failure was swallowed — so claims never cleared and teammates saw phantom locks. It
  now calls `npx -y tower-mcp`, matching the pre-commit hook.
- **`setup` adds `.tower/` to your `.gitignore`**, so the local SQLite db stops showing up
  as an unexplained binary in `git status`.
- **Two scary warnings gone from first run.** Every command printed Node's `DEP0190`
  shell-args deprecation ("can lead to security vulnerabilities") and the `node:sqlite`
  `ExperimentalWarning` before any useful output. Both silenced — the sqlite filter is
  scoped to that one warning, everything else still surfaces.
- **Node requirement stated honestly: 22.5+**, not 22. `node:sqlite` landed in 22.5, and
  below it you now get a one-line explanation instead of a raw `Cannot find module` stack
  trace. `engines`, `doctor` and the docs all agree now.
- **Board polish** — roomier padding, wider right column, focus rings, and the send-form
  hint no longer overflows its row on narrow phones.
- **Repositioning, and a copy audit against the code.** Tower now leads with _multiplayer
  for AI coding agents_; collision detection is the safety floor, not the pitch. Every
  public claim was re-checked against the implementation and corrected where the code
  didn't back it: the board is a **live status board refreshed every 2s**, not a live
  session transcript; the site had advertised "seventeen tools" and omitted `pending`;
  "real-time" and "TTL countdowns" are gone; and the PreToolUse hook's real granularity is
  now documented — it claims **whole files**, so two agents in different functions of one
  file still block each other.
- The npm package now ships a README and LICENSE (the package page was blank).

## 0.7.1 — 2026-07-16

- **Your phone buzzes when the work lands.** Push notifications now fire on task
  completion too — "task done ✓" with the PR link and sha, or "task failed ✗" with the
  reason — not just when a task needs approval. Same one-time 🔔 opt-in on the board.
- Site: cookie-less visit counts (GoatCounter) on the landing page only — the Tower
  product itself still has no telemetry.

## 0.7.0 — 2026-07-13

- **`tower demo`** — the 30-second wow moment: one command boots an in-memory Tower,
  seeds two agents into a hard collision plus a delegated task with its reply, and opens
  the live board (`#token=demo`). Nothing touches disk; Ctrl+C throws it away.
- **`tower doctor`** — setup diagnostics in one command: Node ≥22, git + clean tree,
  `claude`/`codex`/`gh` on PATH, server reachability, token accepted, version drift.
  Exits 1 on blocking problems.
- **Phones buzz on approvals (web push).** Opt in with the board's **🔔 Notify me**
  button; when a worker parks a task, every subscribed browser gets a notification —
  no open tab needed. VAPID keys are generated per server and persisted; bounced
  subscriptions clean themselves up. New endpoints: `GET /api/push-key`,
  `POST /api/push-subscribe`, `GET /board-sw.js`.
- **Team rules ride every task.** Decisions tagged `rule` (pinned from the board's new
  **Team rules** panel — `POST /api/decision` — or via `log_decision`) are prepended to
  every delegated task prompt. Phone-editable guardrails; no git commit needed.
- **Capacity-aware workers.** A rate-limit-looking failure puts the worker in a 10-min
  cooldown: it reports status `low` (board shows _low capacity_), accepts nothing, and
  recovers on its own. `--budget <n>` caps task starts per rolling 24 h. Tasks can carry
  an advisory `size` (`s`/`m`/`l`). `heartbeat_worker` gained a `status` field.
- **Version handshake.** `/health` now reports the server version; workers warn on
  major.minor drift at startup (never block). One version constant (`TOWER_VERSION`)
  now feeds the MCP server, the remote client, and `/health`.
- **Board:** task filter box, capacity labels in the roster/dropdown/map, rules panel.
- **Hardening:** per-IP rate limit on write endpoints (30/min), periodic sweep + cap on
  the throttle/limiter maps (rotating IPs can't grow memory), lockout-map bounds.
- Docs: keeping the worker alive (pm2 / Task Scheduler / NSSM / systemd), Render data
  persistence, capacity & budget, the demo-GIF production script; issue templates and
  launch assets (`launch/`).

## 0.6.1 — 2026-07-12

Security + correctness release from a full pre-launch audit (three independent review
passes: security, docs, code). Upgrade recommended for every 0.5/0.6 install.

- **SECURITY — custom `--cmd` runners no longer substitute `{{task}}`.** Splicing task
  text into a shell string let a hostile task body inject commands on the worker machine
  (the `claude`/`codex` runners were never affected). Every runner — including `--cmd` —
  now receives the prompt on **stdin**; templates still containing `{{task}}` are refused
  with an explanation. **Breaking** for `--cmd` users: read the prompt from stdin.
- **Fixed: 0.5.0 databases broke all delegation on upgrade.** The `tasks` table gained an
  `approval` column in 0.6.0 with no migration, so every `send_message kind:"task"` /
  `POST /api/task` failed on an existing DB file. The store now ALTERs old files in place
  (covered by an upgrade test).
- **Approval gate is now enforced, not advisory.** `accept_task` refuses pending and
  rejected tasks, so a human's Reject holds even against `--auto` workers on the same
  inbox; rejection is terminal (task → `failed`, delegator notified via `task_update`)
  instead of silently ignored forever; an already-decided task can't be re-parked.
- **Hosted-Tower DoS fixed.** Behind Render/nginx the throttle saw one shared IP —
  10 bad tokens from anyone locked out the whole instance. Now the real client IP is
  read through the proxy (`trust proxy`), and a **valid token always gets in** even
  when the bucket is locked. Typing the token by hand no longer trips the lockout
  either (the board saves on Enter/blur, not per keystroke).
- **No more stack-trace leakage.** Malformed requests previously returned Express's
  default error page — with absolute filesystem paths — unless `NODE_ENV=production`.
  A terminal error handler now always answers `{"error":"bad request"}`. JSON bodies
  capped at 256 KB.
- **Worker hardening.** Runner timeouts now kill the whole process tree on Windows
  (`taskkill /T` — previously the shell shim died but the agent kept editing, then
  every later task failed on a "dirty tree"); the kill switch documented since 0.5.0
  now exists (`touch .tower/STOP` stops the daemon before its next task); presence
  heartbeats on its own 15s timer so a worker no longer shows offline exactly while
  it's running your task; `--approve` values other than `remote` are rejected instead
  of silently ignored.
- **Board fixes.** `/board` sends clickjacking protection (`X-Frame-Options: DENY`,
  `frame-ancestors 'none'`); phone-delegated tasks use the **live worker's repo**
  instead of guessing (a fresh board no longer queues tasks to a placeholder repo
  nobody polls); Approve/Reject taps surface errors instead of failing silently;
  presence changes re-render immediately; a **sign out** button forgets the saved
  token; the Map shows rejected tasks as rejected; the board renders the newest 100
  tasks (matching the 50-message reply window) so a week of history can't bloat the DOM.
- 11 new regression tests (213 total), including a real-process spawn test for the
  stdin/tree-kill path and the 0.5.0→0.6.x DB upgrade.

## 0.6.0 — 2026-07-10..12

- **Live worker presence.** Workers call a new `heartbeat_worker` tool (17 tools total)
  every poll; the board shows which machines are **online and ready to run tasks** (30s
  window). The send box's recipient is now a **dropdown** — pick a live worker (runs now)
  or an offline one (queues), no typing an agent id.
- **Command Map view.** A second board tab: a command-flow tree — the repo at the root,
  each commander (incl. 📱 you) and the agents they've tasked, statuses, and replies with
  sha/PR. **Tap any agent to command it** (pre-fills the send box). Who-directs-whom at a
  glance. ([docs/map.png](docs/map.png))

- **Your phone is now a remote control.** The board (`/board`) has a send box that
  delegates a task (`POST /api/task`) and **Approve / Reject** buttons for parked tasks
  (`POST /api/approve`) — both behind the usual `TOWER_TOKEN`. Queue work for your agent
  and approve it from anywhere.
- **`tower work --approve remote`** — instead of asking the terminal, the worker parks each
  task for a human to approve on the board. New MCP tools: `request_approval`,
  `resolve_approval`; tasks carry an `approval` state (`pending → approved | rejected`).
- **Board rebuilt for clarity.** Plain English over ATC jargon: a **delegation tree**
  (who asked whom, the command, and the reply nested under it, with commit sha + PR link),
  **who's connected**, **editing right now**, and a chronological **activity log**.
  Renders correctly on a phone; only re-renders when data changes, so buttons stay tappable.
- **Board self-lockout fix.** The board polled `/api/board` every 2s even before a token
  was entered, and each tokenless poll counted as a failed auth — tripping the brute-force
  lockout and 429-ing the whole (shared) IP, so the board could never connect. Now a
  _missing_ Authorization header is never counted (only a present-but-wrong token is), and
  the board backs off to 6s while unauthed. Plus **one-tap auth**: open `/board#token=…`
  and it's stored with no mobile typing (the hash is stripped immediately).
- **Windows runner fix.** The `claude` / `codex` runners now spawn through the shell with
  the prompt on stdin — Node refuses to launch the Windows `.cmd` agent shims directly
  (CVE-2024-27980), which silently failed every task on a Windows worker. Verified with a
  real end-to-end run: a delegated task drove a headless `claude -p` to write a file and
  commit it on an isolated branch.

## 0.5.0 — 2026-07-08

- **Task lifecycle** — a `kind: "task"` message is now a first-class `DelegatedTask`
  (`open → accepted → done | failed`). New MCP tools (14 total): `accept_task`
  (**first-accept-wins** — a broadcast task runs exactly once), `complete_task`
  (result + commit sha + PR url; auto-notifies the delegator with a `task_update`),
  `list_tasks`. Finished tasks age out with the 7-day pruner; open work never dropped.
- **`tower work`** — the worker daemon ([docs/worker.md](docs/worker.md)): polls for
  delegated tasks, runs your local agent headlessly (`claude -p` / `codex exec` / custom
  `--cmd`), commits on an isolated `tower/task-<id>` branch, pushes and opens a PR via
  `gh` (best-effort), and completes the task with the sha/PR. Safety by default:
  per-task confirmation (`--auto` to go unattended), `--allow-from` sender allowlist,
  runtime kill switch, clean-tree preflight, never touches your current branch.
- **Board: TASKS lane** — delegation status chips (OPEN/ACCEPTED/DONE/FAILED), assignee,
  and PR links, live above the COMMS feed.

## 0.4.0 — 2026-07-07

- **`tower setup`** — one-command onboarding: writes/merges `.mcp.json` (local or team
  `--url`/`--token`), appends the claim-first + inbox rules to `CLAUDE.md`/`AGENTS.md`,
  installs git hooks with `--hooks`. Idempotent; never overwrites existing hooks.
- **Per-agent broadcast reads** — a `toAgentId: "*"` message now stays unread for every
  teammate until _they_ read it (new `message_reads` table; old DBs upgrade in place).
- **Auto-pruning** — non-active claims and messages older than 7 days are deleted
  automatically (hourly, opportunistic).
- Site: live-board section, two-terminal comms demo, Codex install tab.

## 0.3.x — 2026-07-07

- **Agent-to-agent messaging** — `send_message` / `fetch_messages` MCP tools (11 total):
  async messages, **task delegation** (`kind: "task"` → reply `task_update`), broadcasts.
  Every `claim_intent` response reports the caller's `unreadMessages` count.
- **COMMS panel** on `/board` — the live agent conversation next to the flight strips.
- **`tower send` / `tower inbox`** — interactive `send` asks only what it can't infer
  (identity + repo come from git); prompts never appear outside a TTY. (0.3.1)
- `guard` prints `✅ CLEAR` on success instead of silence. (0.2.x→0.3.1)

## 0.2.x — 2026-07-07

- **Live radar board** — `/board` on every HTTP Tower: flight strips per claim, pairwise
  collisions flashing red, TTL countdowns; `/api/board` JSON with shared auth.
- **GitHub Action** (`action/`) — comments on PRs that overlap other open PRs
  (line-range analysis) and shows live agent claims from a hosted Tower. Zero deps.
- **Universal git pre-commit guard** — enforcement for any editor/agent at commit time.
- **Actionable collision menu** — `tower next-task` (the `[d]` option) and
  `guard --force` (the `[f]` option) are real commands now. (0.2.2)
- Security: brute-force lockout on `/mcp` auth (10 fails/min/IP → 429), non-root Docker
  user, patched base image; `/` redirects to `/board`.

## 0.1.x — 2026-06

- Initial release: 9 MCP tools (claims, semantic tree-sitter collision detection,
  decisions memory, sequencer), stdio + Streamable HTTP transports, SQLite via
  `node:sqlite` (zero native deps), Claude Code PreToolUse enforcement hook, two-agent
  demo, Docker/Render deployment, timing-safe token auth + DNS-rebinding guard.
