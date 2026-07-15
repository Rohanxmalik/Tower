# 0.7.0 — remote control, complete

> Paste this as the GitHub Release notes for tag `v0.7.0`
> (Releases → Draft a new release → choose tag v0.7.0).

The release that finishes the phone story and makes workers capacity-aware.
Try it with zero setup: `npx -y tower-mcp demo`.

## New

- **`tower demo`** — one command boots an in-memory Tower, stages two agents into a
  hard collision plus a delegated task with its reply, and opens the live board.
  Nothing touches disk.
- **`tower doctor`** — one-command diagnostics: Node ≥22, git + clean tree,
  `claude`/`codex`/`gh` on PATH, server reachability, token, version drift.
- **Push notifications** — tap 🔔 on the board once; your phone buzzes whenever a task
  parks for approval. No open tab needed.
- **Team rules on every prompt** — pin a rule from the board (or `log_decision` with
  tag `rule`); workers prepend it to every delegated task. Phone-editable guardrails.
- **Capacity-aware workers** — a rate-limit failure triggers a 10-min cooldown
  (board shows _low capacity_, worker accepts nothing, recovers alone);
  `--budget <n>` caps task starts per rolling 24 h; tasks can carry a size tag.
- **Version handshake** — `/health` reports the server version; workers warn on
  major.minor drift at startup.
- **Board**: task filter, capacity labels, Team-rules panel.

## Hardening

- Per-IP rate limit on write endpoints (30/min); throttle/limiter maps swept and
  capped so rotating IPs can't grow memory.
- Fixed: bundling `web-push` crashed `serve` at startup (Render deploys were failing).

## Upgrade

`npx -y tower-mcp …` always gets the latest. Global installs: `npm i -g tower-mcp@latest`.
Old databases upgrade in place. Full detail:
[CHANGELOG.md](https://github.com/Rohanxmalik/Tower/blob/main/CHANGELOG.md)
