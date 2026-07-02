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

## What works cross-machine today

- ✅ Shared claims, decisions, and collision detection across all connected agents.
- ✅ Cooperative coordination: agents that call `claim_intent` see each other.
- ⚠️ Hook-level **blocking** across machines is not wired yet — the PreToolUse hook
  ([enforcement.md](./enforcement.md)) currently checks the local store. Cross-machine
  enforcement (hook → hosted Tower) is the next milestone.

## Ops notes (early)

- Claims auto-expire via TTL (default 15 min) if an agent stops heartbeating.
- The SQLite DB grows with history; periodic pruning of old completed/expired claims is a
  TODO. Fine for small teams; revisit at scale.
