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
- **Zod validation at every MCP boundary** — all nine tools validate input/output schemas.
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
- The CLI reads files you point it at (`--file`) with your own OS permissions.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
