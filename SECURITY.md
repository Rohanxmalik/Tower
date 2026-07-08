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
- **Zod validation at every MCP boundary** — all eleven tools validate input/output schemas.
- **Brute-force lockout** on the HTTP endpoint: 10 failed auth attempts per IP per minute
  → 429 until the window resets (correct tokens never count).
- **HTTP transport hardening:**
  - Bearer-token auth with **constant-time comparison**.
  - **DNS-rebinding guard**: in token-less mode the server only accepts requests whose
    `Host` header is local (`localhost` / `127.0.0.1` / `[::1]`), so a malicious website
    cannot drive your local Tower from the browser.
  - Binds `127.0.0.1` by default; binding other interfaces requires an explicit `--host`,
    and hosted/team mode expects `TOWER_TOKEN` plus TLS termination in front (see
    [docs/team.md](docs/team.md)).
- **The Claude Code hook fails open** — a hook error can never brick your editor session —
  and shells out only to fixed `git rev-parse` commands (no user input interpolated).
- **No telemetry.** Tower makes no network calls except the ones you configure.

**Known limitations (by design, documented):**

- Claims are _advisory_ between cooperating agents; enforcement exists on a single machine
  via the PreToolUse hook. A hostile local process can bypass coordination — Tower is not
  an access-control system.
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
  `--allow-from` sender allowlist, a runtime kill switch, and an isolated work branch
  (your current branch is never touched). Treat `TOWER_TOKEN` as execution rights on
  every machine running a worker; rotate it when someone leaves.
- The CLI reads files you point it at (`--file`) with your own OS permissions.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.x     | ✅        |
