# The worker: autonomous cross-machine delegation

`tower work` is a small daemon that makes delegated tasks run **without anyone at the
keyboard**. It watches Tower for tasks addressed to you, runs a local coding agent
headlessly, commits the result on an isolated branch, opens a PR, and reports back to
whoever delegated — all with _your_ machine, _your_ tokens, _your_ git identity.

## The two-laptop story

1. **alice** (or her agent) delegates: `tower send --to bob --task --body "add rate
limiting to /login"` — or her agent calls `send_message` with `kind: "task"`.
2. **bob's machine wakes up.** His `tower work` daemon has been polling for open tasks;
   it sees this one, accepts it (the task flips `open → accepted` so nobody else grabs
   it), and launches a local agent headlessly with the task body as the prompt.
3. The agent does the work in bob's clone. The worker commits on a fresh branch
   (`tower/task-<id8>`), pushes, and opens a PR via `gh` (best-effort — no `gh`, no PR,
   still fine).
4. The task completes (`accepted → done`, or `failed`), and alice's agent receives a
   `task_update` with the commit sha and PR link on its next Tower contact. The whole
   exchange is visible on `/board` — the TASKS lane shows every task's status chip.

Bob never opened his editor. His editor doesn't even need to be installed — just a repo
clone, the agent CLI, and `tower work`.

## Quick start

On the machine that should pick up tasks (with `TOWER_URL` / `TOWER_TOKEN` pointing at
your team Tower, same as in [team.md](./team.md)):

```bash
npx -y tower-mcp work                    # confirm each task in this terminal (default)
npx -y tower-mcp work --approve remote   # approve from the board — including your phone
npx -y tower-mcp work --auto             # unattended: accept and run without prompting
```

By default the worker **asks you before running each task** — you see who sent it and
what it says, and approve or skip. `--auto` removes the prompt for fully unattended
operation; read the [Security](#security--read-this-before---auto) section first.

### Approve from your phone (`--approve remote`)

With `--approve remote` the worker never asks the terminal. It **parks** each task and
waits: the task appears under **"needs your OK"** on the board (`/board`) with **Approve**
and **Reject** buttons. Open that URL on your phone, tap Approve, and the worker on your
laptop accepts the task and runs it. Reject, and it never runs — rejection is enforced in
the store (the task is marked `failed` and can never be accepted), so it holds even if
another worker on the same inbox is running `--auto`. The delegator gets a `task_update`
about the rejection instead of waiting forever.

The board doubles as a **remote control**: its send box delegates a new task
(`POST /api/task`), so you can queue work for your own agent from the couch and approve it
in the same tap. Both endpoints use the same `TOWER_TOKEN` as everything else — anyone who
can open your board can drive your worker, so treat the token accordingly.

> The flags below describe the shipped behavior at a high level; the exact, current CLI
> surface is always `tower work --help`.

## The task lifecycle

```
                 accept_task            complete_task
                 (first accept wins)    (success)
   open ────────────► accepted ────────────► done
                          │
                          │ complete_task (failure) / max-runtime kill
                          ▼
                        failed
```

- A `kind: "task"` message **is** the task — same id, tracked as a `DelegatedTask`.
- **First-accept-wins:** `accept_task` atomically flips `open → accepted` and records
  the assignee. A task broadcast to `*` can be seen by every worker on the team, but
  only one wins the accept — a broadcast task runs **exactly once**.
- On completion the server auto-sends a `task_update` back to the delegator with the
  result, commit sha, and PR URL, threaded to the original task.

## Runners

The worker runs whatever local agent you point it at:

| Runner   | Command it drives                         | Notes                              |
| -------- | ----------------------------------------- | ---------------------------------- |
| `claude` | `claude -p --permission-mode acceptEdits` | Claude Code headless mode          |
| `codex`  | `codex exec --full-auto`                  | Codex CLI non-interactive mode     |
| `cmd`    | your own command (`--cmd "..."`)          | Reads the task prompt on **stdin** |

The task body becomes the prompt, and **every runner receives it on stdin** — task text
is never substituted into the shell command line, so a hostile task body can't inject
shell commands on the worker machine. (`--cmd` templates with the old `{{task}}`
placeholder are refused with an explanation.) Whatever the runner is allowed to do on
your machine, a delegated task can do — that's the point, and it's why the safety
defaults below exist.

## The git flow

The worker never touches the branch you have checked out:

1. **Preflight:** refuses to start unless the working tree is clean — your half-finished
   work is never mixed into a task's commit.
2. Creates a branch **`tower/task-<id8>`** (the first 8 chars of the task id) and runs
   the agent there.
3. Commits the changes, **pushes** the branch, and tries `gh pr create` (best-effort:
   if `gh` isn't installed or authenticated, you still get the pushed branch).
4. Calls `complete_task` with the commit sha and PR URL — the delegator's agent gets the
   `task_update`, and the board's TASKS lane flips the chip to `DONE`.

If the run fails or exceeds the max runtime, the task is completed as `failed` with the
error as the result — the delegator hears about failures too, not just successes.

## Keeping the worker alive

`tower work` is a foreground process: close the terminal (or drop the SSH session) and
the worker dies with it. A machine that should pick up tasks around the clock needs a
supervisor that restarts the worker on crash and starts it at boot.

**One rule for every recipe below:** a supervised worker has no terminal to confirm on,
so it must run with `--approve remote` (a human taps Approve on the board) or `--auto`
(fully unattended — read [Security](#security--read-this-before---auto) first). A plain
`tower work` without a TTY prints a hint and exits.

Two things every recipe has to carry: the **environment** (`TOWER_URL` / `TOWER_TOKEN`)
and the **working directory** (the repo clone the worker runs tasks in).

### pm2 (macOS / Linux / Windows)

```bash
npm i -g pm2 tower-mcp
cd /path/to/your/clone                 # the repo the worker works in
export TOWER_URL=https://tower-xxxx.onrender.com/mcp
export TOWER_TOKEN=<your-token>
pm2 start "tower work --approve remote" --name tower-worker
pm2 save                               # remember the process list across reboots
pm2 startup                            # prints ONE command — run it so pm2 itself starts at boot
```

Useful afterwards: `pm2 logs tower-worker` (tail output), `pm2 restart tower-worker`
(after an upgrade). pm2 snapshots the environment at `pm2 start` — if you rotate the
token, `pm2 restart tower-worker --update-env` from a shell with the new value.

### Windows without pm2

**Task Scheduler** (built in) — one line, starts the worker at logon:

```powershell
schtasks /Create /TN TowerWorker /SC ONLOGON /TR "cmd /c cd /d C:\code\app && npx -y tower-mcp work --approve remote"
```

Set the env first, at the user level, because scheduled tasks don't inherit your open
terminal: `setx TOWER_URL https://tower-xxxx.onrender.com/mcp` and
`setx TOWER_TOKEN <your-token>`. Remove with `schtasks /Delete /TN TowerWorker /F`.
Note a logon task starts the worker but won't restart it if it crashes mid-day.

**NSSM** (a real Windows service, restarts on crash, runs before anyone logs in —
`choco install nssm` or [nssm.cc](https://nssm.cc)):

```powershell
nssm install TowerWorker "C:\Program Files\nodejs\npx.cmd" -y tower-mcp work --approve remote
nssm set TowerWorker AppDirectory C:\code\app
nssm set TowerWorker AppEnvironmentExtra TOWER_URL=https://tower-xxxx.onrender.com/mcp TOWER_TOKEN=<your-token>
nssm start TowerWorker
```

### Linux: systemd

```ini
# /etc/systemd/system/tower-worker.service
[Unit]
Description=Tower worker (delegated-task daemon)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=alice
WorkingDirectory=/home/alice/code/app
Environment=TOWER_URL=https://tower-xxxx.onrender.com/mcp
Environment=TOWER_TOKEN=<your-token>
ExecStart=/usr/bin/npx -y tower-mcp work --approve remote
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tower-worker
journalctl -u tower-worker -f          # tail the worker's log
```

The kill switch still works under every supervisor: create `.tower/STOP` in the repo and
the worker exits **cleanly**, so `Restart=on-failure` (and pm2/NSSM equivalents) won't
resurrect it. Delete the file and restart the service to resume.

## Capacity & budget

New in 0.7.0. Delegation only works if the receiving machine actually has tokens to
spend — so the worker now notices when it doesn't, and lets you cap how much it will.

**Rate-limit cooldown.** When a task run fails with a rate-limit-looking error — an HTTP
429, or output containing "rate limit", "quota", or "usage limit" — the worker assumes
the local agent is out of tokens and enters a **10-minute cooldown**: it reports status
`low` in its heartbeats, the board shows the machine as **low capacity**, and it accepts
no new tasks until the cooldown ends. Nothing is lost — open tasks stay open, and get
picked up when capacity returns (or by another worker on the same inbox).

**`--budget <n>`** caps how many tasks this worker will **start** in a rolling 24 hours:

```bash
tower work --auto --budget 20     # at most 20 task starts per rolling 24 h
```

The counter is in-memory — restarting the worker resets it. Use it to keep an `--auto`
worker from burning a whole subscription overnight.

**Size tags.** A task can carry an advisory size (`s` / `m` / `l`) so senders can signal
weight — big tasks prefer workers with capacity. It's advisory only; nothing enforces it.

Why this matters: **delegating costs the sender approximately nothing** — the tokens are
spent on the machine that runs the task. An out-of-tokens teammate can still push work to
a machine with budget left: alice's rate-limited agent hands the actual work to bob's
fresh one. Capacity is self-reported (agent vendors expose no "tokens remaining" API), so
treat `low` as a strong hint, not a guarantee.

## Version handshake

New in 0.7.0. On startup, a worker pointed at a team server (`TOWER_URL` set) compares
its own version with the server's `/health` version and **warns** when the major.minor
differs — e.g. a 0.7 worker against a 0.6 server. It never blocks: a drifted worker
still polls and runs tasks. The warning is your cue to `npm i -g tower-mcp@latest` on
the worker machine, or redeploy the server, whichever is behind. (`npx -y tower-mcp`
users get the latest automatically.)

## Team rules ride every task

New in 0.7.0. Decisions tagged **`rule`** are prepended to every delegated task prompt —
the runner sees your team's standing orders before it sees the task body.

Two ways to set them:

- **From the board** — the **Team-rules** panel pins a rule in a couple of taps. That
  makes guardrails **phone-editable**: change a rule from the couch and the very next
  delegated task obeys it. No git commit, no redeploy, no editor.
- **From an agent** — call `log_decision` with the tag:

  ```jsonc
  log_decision {
    "title": "All new endpoints need a rate limit.",
    "author": "alice",
    "tags": ["rule"]
  }
  ```

Keep rules short and imperative ("Never commit directly to main.", "New code ships with
tests."). They're instructions to the running agent — the same trust level as the task
body itself, and visible to everyone on the board.

## Security — read this before `--auto`

**Running a worker means teammates who hold the `TOWER_TOKEN` can execute code on your
machine.** That is the feature — delegation _is_ remote code execution within your
team's trust boundary. Treat the token accordingly: it's not just push access anymore,
it's "run an agent on every machine with a worker".

Defaults that protect you:

- **Confirm-per-task** unless you explicitly pass `--auto` — you review sender and body
  before anything runs.
- **`--allow-from`** — an allowlist of sender agent ids; tasks from anyone else are
  ignored. Use it even with confirm mode, and especially with `--auto`. Note: agent ids
  are self-declared, so any token holder can send as an allow-listed name — this filters
  accidents and noise, not malice. The token itself is the security boundary.
- **Kill switch** — create a file at **`.tower/STOP`** in the worker's repo and the
  daemon stops before its next task (delete the file to run again). Works from any
  editor or SSH session while the worker is mid-run.
- **Max runtime** — a runaway agent is killed (the whole process tree, including the
  Windows shell shims), and the task marked `failed`.
- **Prompt on stdin** — task text never touches the runner's command line, so a task
  body can't shell-inject on your machine.
- **Branch isolation** — the worker only ever commits to `tower/task-<id8>` branches,
  never to the branch you're on, and refuses to run on a dirty tree.

Advice for unattended use:

- Run the worker in a **dedicated clone** (or a separate machine/VM), not your daily
  working copy.
- **Review the PRs before merging** — the worker opens PRs precisely so a human gate
  stays in the loop; don't wire it to auto-merge.
- **Rotate `TOWER_TOKEN` when someone leaves the team** — restart the server with a new
  token. Old token = old teammate can still queue tasks for your workers.
- **`/board#token=…` links carry the token.** One-tap auth is convenient, but pasting
  that link into a chat or email exposes the token to that channel's history — share it
  the way you'd share the token itself.

More on the shared-token trust model: [SECURITY.md](../SECURITY.md).
