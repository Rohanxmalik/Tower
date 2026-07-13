# 0.6.1 — the security-audit release

> Paste this as the GitHub Release notes for tag `v0.6.1`
> (Releases → Draft a new release → choose tag v0.6.1).

Three independent review passes (security, correctness, docs) ran against 0.6.0 before
launch; every finding was fixed, down to LOW severity. **Upgrade recommended for every
0.5/0.6 install** — `npx -y tower-mcp` users get it automatically.

## Security

- **Custom `--cmd` runners can no longer be shell-injected by task text.** Every runner
  now receives the prompt on **stdin**; task text never touches the command line.
  Templates still using `{{task}}` are refused with an explanation.
- **Hosted instances can't be locked out by strangers anymore.** Behind a reverse proxy
  (Render/nginx) all visitors shared one brute-force bucket — 10 bad tokens 429'd the
  whole team. Now the real client IP is used (`trust proxy`) and a **valid token always
  gets in**.
- Generic JSON errors everywhere (no stack traces / filesystem paths, regardless of
  NODE_ENV), clickjacking protection on `/board`, a 256 KB request-body cap, and the
  documented **runtime kill switch** now exists: `touch .tower/STOP`.

## Fixes

- **0.5.0 databases upgrade cleanly.** The `approval` column is now migrated in place —
  previously every delegation path broke after upgrading an existing install.
- **Reject means never.** Rejected tasks are terminal (`failed` + delegator notified);
  no worker mode — including `--auto` — can pick one up. Approved/decided tasks can't be
  re-parked back to pending.
- **Windows runner timeouts kill the whole process tree** — no more orphaned agents
  editing the repo after cleanup, then wedging every later task with "dirty tree".
- Worker presence no longer flickers offline during long tasks; phone-created tasks on a
  fresh board target the live worker's actual repo; typing the token by hand can't trip
  the lockout; Approve/Reject taps surface errors; sign-out button on the board.

## Verify

```
npm view tower-mcp version   # → 0.6.1
npx -y tower-mcp serve       # or: tower doctor (0.7+)
```

Full detail: [CHANGELOG.md](https://github.com/Rohanxmalik/Tower/blob/main/CHANGELOG.md)
