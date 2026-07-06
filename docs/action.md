# Tower GitHub Action — PR collision reports

Get a comment on every pull request that touches the same files as **another open PR**
(with overlapping line ranges flagged as merge-conflicts-in-the-making), and — if you run
a hosted Tower — files that **an AI agent is editing right now**.

No install, no server required for the PR-vs-PR part. Add one workflow file:

```yaml
# .github/workflows/tower-collisions.yml
name: PR collisions
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: Rohanxmalik/Tower/action@main
```

What you get on a colliding PR:

> ## 🗼 Tower collision report
>
> ### ⚠️ Overlaps [#12 — Refactor auth](…)
>
> - ⛔ `src/auth.ts` — **overlapping lines 25–30** (merge conflict likely)
> - △ `src/db.ts` — same file, different regions

The action posts **one** comment and keeps updating it (no spam); clean PRs get no
comment at all. It never fails your build — reporting bugs warn instead of block.

## Include live agents (hosted Tower)

If your team runs a [hosted Tower](./team.md), the report also shows claims that are
active _at review time_:

```yaml
- uses: Rohanxmalik/Tower/action@main
  with:
    tower-url: https://tower-xxxx.onrender.com
    tower-token: ${{ secrets.TOWER_TOKEN }}
```

> ### 🔴 Live agents on these files right now
>
> - **claude-ab12** is mid-change on `AuthService.verify` — "replace JWT"

## Inputs

| Input          | Default               | Purpose                                     |
| -------------- | --------------------- | ------------------------------------------- |
| `github-token` | `${{ github.token }}` | Reads PRs, posts the comment                |
| `tower-url`    | —                     | Hosted Tower base URL for live agent claims |
| `tower-token`  | —                     | `TOWER_TOKEN` of that server                |

Scope notes: compares against the 30 most recent open PRs; line ranges come from diff
hunks (symbol-level naming via tree-sitter is on the roadmap).
