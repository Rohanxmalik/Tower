# Team mode (whole team, different machines)

For a single machine running multiple agents, the local server is enough. For a **team**
to see each other's claims, run **one** Tower that everyone's agents point at. Two ways,
pick by how your team is set up:

| Your situation                               | Use                                                           | Setup time |
| -------------------------------------------- | ------------------------------------------------------------- | ---------- |
| Same office / same WiFi (or living together) | **Same-network mode** — one laptop hosts, no deploy           | 2 min      |
| Remote / different networks                  | **Host it online** (Render/Railway/Fly) — permanent HTTPS URL | ~5 min     |

> Tunnels (ngrok/localtunnel) are fine for a quick 5-minute test, but they drop and change
> URLs — don't use them for real work. Use one of the two options below instead.

---

## Same office / same WiFi (simplest — no deploy, no tunnel)

If your team sits on the **same network** — same office, same house, same WiFi — you don't
need to deploy anything or use a tunnel. One person's laptop is the Tower; everyone else
points at its local network address.

**Step 1 — Host machine: start Tower on all interfaces.**

```bash
npx -y tower-mcp serve --http --host 0.0.0.0 --port 4319 --token team-secret
```

`--host 0.0.0.0` is the important part: it makes Tower reachable by other machines on the
WiFi (not just `localhost`). Pick any `--token` — it's the shared password.

**Step 2 — Host machine: find your local IP.**

- **macOS:** `ipconfig getifaddr en0`
- **Windows:** `ipconfig` → look for **IPv4 Address** (starts `192.168.` or `10.`)
- **Linux:** `hostname -I` → take the first address

You'll get something like `192.168.1.42`. That plus the port is your team URL:
`http://192.168.1.42:4319/mcp`.

**Step 3 — Everyone (including the host): point your agent at it.**

```jsonc
// .mcp.json (Claude Code)
{
  "mcpServers": {
    "tower": {
      "type": "http",
      "url": "http://192.168.1.42:4319/mcp",
      "headers": { "Authorization": "Bearer team-secret" },
    },
  },
}
```

That's it — you're all on one board. Notes:

- The host laptop must stay awake and on the WiFi (it's the server).
- If a teammate can't connect, the host's **firewall** is usually blocking port 4319 —
  allow it (macOS: System Settings → Network → Firewall; Windows: allow Node through
  Windows Defender Firewall when prompted).
- This works only while everyone is on the **same** network. Going remote? Host it online
  (next section).

---

## Host it online — one click (for remote teams)

Deploy your own Tower to a cheap always-on host and get a permanent HTTPS URL. **Render has
a free tier and is the easiest — here's every click:**

### Render, step by step (~5 min, beginner-friendly)

1. **Fork Tower** to your own GitHub (top-right **Fork** on
   [github.com/Rohanxmalik/Tower](https://github.com/Rohanxmalik/Tower)). Render deploys
   from a repo you own.
2. Go to **[render.com](https://render.com)** and sign up / log in **with GitHub** (so
   Render can see your fork).
3. Click **New +** (top right) → **Blueprint**.
4. Pick your **Tower** fork from the list and click **Connect**. Render reads
   [`render.yaml`](../render.yaml) from the repo — you don't configure anything by hand.
5. It shows one service (`tower`) and auto-generates a **`TOWER_TOKEN`** for you. Click
   **Apply** / **Create**.
6. Wait for the build to finish (green **Live** badge — first build is a few minutes).
7. **Copy your token:** open the `tower` service → **Environment** tab → reveal
   **`TOWER_TOKEN`**. This is your shared team secret.
8. **Copy your URL:** it's at the top of the service page, like
   `https://tower-xxxx.onrender.com`. Your MCP endpoint is that **+ `/mcp`**:
   `https://tower-xxxx.onrender.com/mcp`.
9. Give the **URL** and **token** to your teammates and jump to
   [Point each developer's agent at it](#point-each-developers-agent-at-it).

> **Free-tier note:** Render's free service sleeps after ~15 min idle and the first request
> wakes it (a few seconds). Fine for trying it out; upgrade to a paid instance ($7/mo) to
> keep it always-on for daily use.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Rohanxmalik/Tower)

### Other hosts

- **Railway:** New Project → **Deploy from GitHub repo** → pick your Tower fork. Railway
  auto-detects the `Dockerfile`. Add a `TOWER_TOKEN` variable. It gives you a public URL;
  append `/mcp`.
- **Fly.io:** from a clone, `fly launch` (it detects the `Dockerfile`), then
  `fly secrets set TOWER_TOKEN=your-secret`.

All three read `$PORT` automatically. Set `TOWER_TOKEN` and you're done — that's your
shared team secret.

## Host it — Docker (self-managed)

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
