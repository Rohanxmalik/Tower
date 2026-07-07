# Changelog

All notable changes to `tower-mcp`. Follows [Keep a Changelog](https://keepachangelog.com);
versions are [semver](https://semver.org) (0.x — expect movement).

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
