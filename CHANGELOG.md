# Changelog

All notable changes to `tower-mcp`. Follows [Keep a Changelog](https://keepachangelog.com);
versions are [semver](https://semver.org) (0.x — expect movement).

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
