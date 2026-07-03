# Team mode (hosted Tower)

For a single machine running multiple agents, the local server is enough. For a **team on
different machines** to see each other's claims, host one Tower over HTTP and point every
agent at it.

## Host it

With Docker Compose:

```bash
TOWER_TOKEN=your-shared-secret docker compose up -d
# Tower is now on http://<host>:4319/mcp (claims persist in the tower-data volume)
```

Or plain Docker:

```bash
docker build -t tower .
docker run -d -p 4319:4319 -e TOWER_TOKEN=your-shared-secret -v tower-data:/app/.tower tower
```

Put it behind TLS (a reverse proxy / your platform's HTTPS) before exposing it publicly —
the bearer token is sent in a header.

## Point each developer's agent at it

Tower speaks MCP over HTTP, so every agent connects directly — no per-dev install:

```jsonc
// .mcp.json (Claude Code)
{
  "mcpServers": {
    "tower": {
      "type": "http",
      "url": "https://tower.yourteam.dev/mcp",
      "headers": { "Authorization": "Bearer your-shared-secret" },
    },
  },
}
```

Now when Developer A's agent calls `claim_intent`, Developer B's agent sees the claim on
its next `check_collision` / `claim_intent`. This is the founding scenario: your Claude
tells your co-founder's Claude "don't touch auth until commit abc123."

## Enforce across machines

The PreToolUse hook ([enforcement.md](./enforcement.md)) can block edits based on a
**teammate's** claim on the hosted Tower. Point the CLI/hook at the server with two env
vars — when `TOWER_URL` is set, `guard` / `claim` / `complete` / `status` all talk to the
hosted Tower instead of the local file:

```bash
export TOWER_URL=https://tower.yourteam.dev/mcp
export TOWER_TOKEN=your-shared-secret        # if the server requires a token
```

Set those in the shell that launches your editor (so the hook inherits them), enable the
hook, and now Developer B's `Edit` is **blocked** while Developer A holds the file. Repo
identity comes from your git remote (`origin`), so it matches across everyone's clones
regardless of local folder name.

## Test it with your team (5 minutes)

You don't need to deploy anything to try it — expose one laptop's Tower with a tunnel:

```bash
# On the host machine:
npx -y tower-mcp serve --http --port 4319 --token demo-secret
# In another terminal, expose it (pick one):
npx --yes localtunnel --port 4319          # or: ngrok http 4319  / cloudflared tunnel --url http://localhost:4319
# → gives you a public https URL, e.g. https://abc.loca.lt
```

Each teammate (including the host) then:

```bash
export TOWER_URL=https://abc.loca.lt/mcp
export TOWER_TOKEN=demo-secret
```

Quick proof without editors — two teammates run, in the **same-named repo**:

```bash
# Teammate A:
npx -y tower-mcp claim  --agent alice --repo team/app --symbol "src/auth.ts#AuthService.verify" --purpose "replace JWT"
# Teammate B (blocked):
npx -y tower-mcp guard  --agent bob   --repo team/app --symbol "src/auth.ts#AuthService.verify"
# → ⛔ COLLISION — AuthService.verify (held by alice).  Exit code 2.

# Anyone can watch the shared board:
npx -y tower-mcp status
```

For the real thing, both enable the PreToolUse hook and open Claude Code in the repo — B's
agent is physically blocked from editing `auth.ts` while A is on it.

### What works cross-machine

- ✅ Shared claims, decisions, and collision detection across all connected agents.
- ✅ **Enforcement** — the hook blocks based on teammates' claims (with `TOWER_URL` set).
- ✅ `status` shows the whole team's live board.
- Put the server behind TLS and a strong `TOWER_TOKEN` before using it beyond a demo.

## Ops notes (early)

- Claims auto-expire via TTL (default 15 min) if an agent stops heartbeating.
- The SQLite DB grows with history; periodic pruning of old completed/expired claims is a
  TODO. Fine for small teams; revisit at scale.
