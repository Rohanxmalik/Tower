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
laptop accepts the task and runs it. Reject, and it never runs.

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

| Runner   | Command it drives                         | Notes                                  |
| -------- | ----------------------------------------- | -------------------------------------- |
| `claude` | `claude -p --permission-mode acceptEdits` | Claude Code headless mode              |
| `codex`  | `codex exec --full-auto`                  | Codex CLI non-interactive mode         |
| `cmd`    | your own command template                 | Any tool that takes a prompt and edits |

The task body becomes the prompt. Whatever the runner is allowed to do on your machine,
a delegated task can do — that's the point, and it's why the safety defaults below exist.

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

## Security — read this before `--auto`

**Running a worker means teammates who hold the `TOWER_TOKEN` can execute code on your
machine.** That is the feature — delegation _is_ remote code execution within your
team's trust boundary. Treat the token accordingly: it's not just push access anymore,
it's "run an agent on every machine with a worker".

Defaults that protect you:

- **Confirm-per-task** unless you explicitly pass `--auto` — you review sender and body
  before anything runs.
- **`--allow-from`** — an allowlist of sender agent ids; tasks from anyone else are
  ignored. Use it even with confirm mode, and especially with `--auto`.
- **Max runtime** — a runaway agent is killed, and the task marked `failed`.
- **Branch isolation** — the worker only ever commits to `tower/task-<id8>` branches,
  never to the branch you're on, and refuses to run on a dirty tree.

Advice for unattended use:

- Run the worker in a **dedicated clone** (or a separate machine/VM), not your daily
  working copy.
- **Review the PRs before merging** — the worker opens PRs precisely so a human gate
  stays in the loop; don't wire it to auto-merge.
- **Rotate `TOWER_TOKEN` when someone leaves the team** — restart the server with a new
  token. Old token = old teammate can still queue tasks for your workers.

More on the shared-token trust model: [SECURITY.md](../SECURITY.md).
