# Seed issues for launch week

Post these as GitHub issues (label: `good first issue`) before the HN post — arriving
contributors need somewhere to land. Each is genuinely small (<2 h for a newcomer).

---

## 1. Worker: make the capacity cooldown duration configurable

**Labels:** good first issue, worker

The worker enters a fixed **10-minute** cooldown after a rate-limit failure
(`COOLDOWN_MS` in `packages/cli/src/worker.ts`). Different plans recover at different
speeds — make it a flag.

**Acceptance criteria**

- `tower work --cooldown <minutes>` overrides the default 10.
- Validated like `--budget` (positive number → clear error otherwise) in
  `packages/cli/src/index.ts`; help text updated.
- A test in `worker.test.ts` proves a custom cooldown is honored (inject `now`).
- `docs/worker.md` "Capacity & budget" mentions the flag.

---

## 2. `tower doctor`: detect a process supervisor (pm2 / nssm / systemd)

**Labels:** good first issue, cli

`docs/worker.md` tells people to keep the worker alive with pm2/NSSM/systemd.
`tower doctor` (`packages/cli/src/doctor.ts`) could check whether any supervisor is
available and hint at the docs.

**Acceptance criteria**

- New `info`-level check: pm2 on PATH (all platforms), nssm on PATH (win32),
  systemctl on PATH (linux). Missing everywhere → info with a link to
  `docs/worker.md#keeping-the-worker-alive`.
- Pure function + tests with the injected `CheckExec`, like the existing checks.

---

## 3. Board: "/" keyboard shortcut focuses the send box

**Labels:** good first issue, board

On desktop, pressing `/` should focus the task textarea (like GitHub's search) —
`packages/server/src/board.ts`, inside the inline script.

**Acceptance criteria**

- `/` focuses `#body` unless an input/textarea/select already has focus.
- No interference with typing `/` inside fields.
- Keep the board's conventions: plain ES5-style JS, no innerHTML with data.

---

## 4. Docs: Hindi (or French) translation of the quickstart

**Labels:** good first issue, docs

`docs/quickstart.md` is short and self-contained — a great first translation target.

**Acceptance criteria**

- `docs/quickstart.hi.md` (or `.fr.md`) translating the current quickstart.
- A language link at the top of both files.
- Keep code blocks/commands untranslated; personas stay alice/bob.

---

## 5. GitHub Action: configurable line-context width for overlap comments

**Labels:** good first issue, action

The PR-overlap comment in `action/` uses a fixed line-range window when deciding that
two PRs touch neighbouring code. Make the window configurable.

**Acceptance criteria**

- New optional input `context-lines` (default: current behavior) in `action/action.yml`,
  read in `action/main.mjs` / `lib.mjs`.
- The action README table documents it.
- A unit test in the action's test file covers a custom width changing the verdict.
