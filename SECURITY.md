# Security Policy

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/Rohanxmalik/Tower/security/advisories/new)
— do not open a public issue for exploitable bugs. You'll get a response within 72 hours.

## Security model (what Tower does and doesn't protect)

Tower coordinates _cooperating_ agents; it is not a sandbox for malicious ones.

**What's in place:**

- **No native modules.** Uses Node's built-in `node:sqlite` and wasm tree-sitter grammars —
  nothing compiles on install.
- **Parameterized SQL everywhere** — no string-concatenated queries.
- **Zod validation at every MCP boundary** — all twenty tools validate input/output schemas.
- **Brute-force lockout** on the HTTP endpoint: 10 failed auth attempts per IP per minute
  → 429 until the window resets. A **valid token always gets in** — teammates behind a
  NAT or reverse proxy are never locked out by a stranger's failures on the shared
  address — and the real client IP is read through the proxy (`trust proxy`), so one
  attacker can't collapse everyone into a single lockout bucket.
- **HTTP transport hardening:**
  - Bearer-token auth with **constant-time comparison**.
  - **DNS-rebinding guard**: in token-less mode the server only accepts requests whose
    `Host` header is local (`localhost` / `127.0.0.1` / `[::1]`), so a malicious website
    cannot drive your local Tower from the browser.
  - **Generic error responses** — malformed requests get `{"error":"bad request"}`,
    never an Express stack trace with filesystem paths, regardless of `NODE_ENV`.
  - **Clickjacking protection on `/board`** (`X-Frame-Options: DENY`,
    `frame-ancestors 'none'`) — the page holds the token and one-tap Approve buttons.
  - JSON bodies capped at 256 KB.
  - Binds `127.0.0.1` by default; binding other interfaces requires an explicit `--host`,
    and hosted/team mode expects `TOWER_TOKEN` plus TLS termination in front (see
    [docs/team.md](docs/team.md)).
- **Delegated prompts travel on stdin.** Every worker runner — including custom
  `--cmd` commands — receives the task text on stdin, never spliced into a shell
  command line, so a hostile task body cannot shell-inject on a worker machine.
- **The Claude Code hooks fail open.** There are five: SessionStart (registers the
  session), UserPromptSubmit (the nudge: tasks or messages waiting for you), PreToolUse
  (blocks a hard-conflicting `Edit`/`Write`/`MultiEdit` by exiting 2), PostToolUse
  (presence on edits; on `Read` it records what was read and warns if someone is changing
  that code) and SessionEnd (releases your claims). A hook error never bricks your editor
  session — it allows the action and says so on stderr, so "checked and clear" and "never
  checked" stay distinguishable. The exit code is the verdict; no hook calls
  `process.exit()` directly.
- **What the hooks run.** They import the built CLI from your Tower clone
  (`packages/cli/dist`, plus `packages/server/dist` for symbol lookup) and shell out only to fixed git commands — `git rev-parse`,
  `git config --get remote.origin.url` and `git rev-list --max-parents=0 HEAD` — with no
  user input interpolated. Nothing is fetched from npm: the UserPromptSubmit nudge no
  longer falls back to `npx -y tower-mcp` (a registry lookup on every prompt); if the
  CLI isn't built it says so on stderr and lets the prompt through.
- **No telemetry.** Tower makes no network calls except the ones you configure. With
  `TOWER_URL` / `TOWER_TOKEN` set, the hooks talk to that hosted Tower; without them
  they read the local `.tower` store.

**Known limitations (by design, documented):**

- Claims are _advisory_ between cooperating agents. Enforcement is the PreToolUse hook
  (and the optional git pre-commit guard) on each machine that installs it; point those
  machines at one hosted Tower with `TOWER_URL` / `TOWER_TOKEN` and the block holds across
  machines. An agent without the hook, or a hostile local process, can bypass
  coordination — Tower is not an access-control system.
- Coordination is keyed by the repository's **root commit sha**, so every clone, fork and
  mirror of a repo shares one coordination space on a given Tower (the `origin` remote only
  supplies the readable label, or the key when there is no commit yet; a hand-set
  `projectId` overrides both). Anyone with the token and a copy of the repo's history
  lands in the same space.
- The bearer token is a shared team secret; rotate it by restarting the server with a new
  `TOWER_TOKEN`.
- **No per-agent identity:** any token holder can claim or send messages as any `agentId`
  (impersonation within the team is possible). Share the token only with people you'd
  give push access to. Per-user auth is planned for Tower Cloud.
- Agent messages (`send_message`) are free text between teammates' agents — treat inbound
  tasks with the same judgment as a teammate's Slack message; agents should confirm
  destructive or out-of-scope tasks with their human.
- **The worker is opt-in code execution within your team.** A machine running
  `tower work --auto` will execute delegated tasks from anyone holding the team token —
  that is the feature. Defaults that protect you: per-task confirmation unless `--auto`,
  `--allow-from` sender allowlist (advisory — sender ids are self-declared, see
  "no per-agent identity" above), a kill switch (create `.tower/STOP` in the worker's
  repo and the daemon stops before its next task), a max-runtime process-tree kill, and
  an isolated work branch (your current branch is never touched). Treat `TOWER_TOKEN`
  as execution rights on every machine running a worker; rotate it when someone leaves.
- **The approval gate is cooperative, not adversarial.** A rejected task is terminal
  (marked failed; no worker mode can ever accept it), and a pending one can't be
  accepted — but `resolve_approval` is callable by any token holder, agents included.
  It's a human-in-the-loop convenience inside the team trust boundary, not a defense
  against a malicious token holder.
- **The board can create and approve tasks** (`POST /api/task`, `POST /api/approve`) using
  the same token. That is what makes the phone a remote control — and it means anyone who
  can reach your board URL with the token can queue work for, and approve work on, any
  machine running `tower work`. Serve it over TLS and keep the token private.
- The CLI reads files you point it at (`--file`) with your own OS permissions.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.x     | ✅        |
