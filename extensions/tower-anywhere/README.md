# tower-anywhere

Claim before you edit — for work that isn't code.

Tower stops two AI agents from editing the same function at the same time. This is the
same mechanic for a marketing team: the same server, the same collision engine, the same
hard/soft severities. The only difference is what you claim. Instead of
`src/auth.ts#verify`, you claim `"Q3 Launch Brief"`.

```
$ tower-anywhere claim "Q3 Launch Brief" --who ana --purpose "rewriting the positioning" --eta 30
No conflicts — nobody else is on this.
Claim da615161 registered for ana.

$ tower-anywhere guard "Q3 Launch Brief" --who bo --purpose "adding the CTA"
1 conflict(s):
  [hard] ana already has all of Q3 Launch Brief (~30m left)
BLOCKED — 1 hard conflict(s). Wait, pick something else, or --force.
```

## Why there's no Figma/Notion/Google integration

There deliberately isn't one, and that's the design.

An integration exists to turn an artifact into stable IDs — Figma frame IDs, Notion block
IDs. Marketing work mostly doesn't have those. A campaign brief, a content calendar, a
launch checklist, a batch of ad copy: they have **names**, not IDs, and the names are
already what the team says out loud.

So the artifact is just a string you pick. That has three consequences worth knowing:

- **It works on anything.** A Google Doc URL, a Canva link, a Notion page, a campaign
  codename, a ticket number, a folder on a shared drive. Nothing to install per tool.
- **The same tool fits other teams.** Ops runbooks, support macros, sales collateral —
  none of them need per-platform ID extraction either.
- **Everyone has to spell it the same way.** `"Q3 Launch Brief"` and `"Q3 launch brief"`
  are two different artifacts to Tower. Pick names as a team, or paste URLs, which are
  self-consistent. This is the real cost of not having IDs, and it's why claiming a
  whole artifact (no `--section`) is the sane default.

## Setup

You need a Tower server. Someone on the team runs one:

```bash
npx tower-mcp serve --http --port 4319 --token our-team-token
```

Then everyone points at it:

```bash
export TOWER_URL=http://your-server:4319/mcp
export TOWER_TOKEN=our-team-token
export TOWER_SPACE=acme-marketing   # your team's shared board
export TOWER_WHO=ana                # your name
```

Install this CLI:

```bash
cd extensions/tower-anywhere
npm install && npm run build
npm link          # gives you `tower-anywhere` on your PATH
```

## Commands

| Command                  | What it does                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `claim <artifact>`       | Register intent, print conflicts. Exit 2 on a hard conflict, but the claim still registers.          |
| `guard <artifact>`       | Check first, claim only if clear. Exit 2 and register **nothing** when blocked. Use this in scripts. |
| `release --claim <id>`   | Done — frees the artifact for everyone else.                                                         |
| `keepalive --claim <id>` | Claims expire. Call this every ~60s on long work.                                                    |

Options: `--who`, `--space`, `--section`, `--purpose`, `--eta`, `--force`.

`claim` vs `guard`: `claim` tells you and proceeds — right for a person who can read the
warning and decide. `guard` refuses — right for an automation that can't.

## What counts as a conflict

Same rules the code side uses, with `--section` playing the part symbols play in a repo.

| You claim             | Someone else has       | Result                      |
| --------------------- | ---------------------- | --------------------------- |
| the whole artifact    | the whole artifact     | **hard** — blocked          |
| the whole artifact    | any section of it      | **hard** — blocked          |
| `--section "October"` | `--section "October"`  | **hard** — blocked          |
| `--section "October"` | `--section "November"` | **soft** — warned, proceeds |
| a different artifact  | anything               | no conflict                 |

Claims expire on their own (~15 min without a `keepalive`), so a forgotten claim never
permanently blocks the team.

`--space` partitions everything. Two spaces never see each other, so marketing and
support can share one server without sharing a board.

## Running the tests

```bash
npm install && npm test
```

The integration tests boot a real Tower server and run marketing-shaped claims through
the actual collision engine — a mock would only prove the mock agrees with itself. They
need the monorepo built (`npm run build` at the repo root) and skip cleanly without it.

## Relationship to the rest of the repo

This folder is standalone on purpose. It is **not** in the root npm workspaces, has its
own `package.json` and `tsconfig.json`, and imports nothing from `packages/` — it talks
to Tower over MCP-HTTP exactly the way any third-party client would. Copy the folder into
its own repository and it keeps working; only the integration tests notice, and they skip
rather than fail.
