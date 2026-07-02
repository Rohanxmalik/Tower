# Tower — launch playbook

Everything to take Tower live. Steps marked **[you]** need your accounts/credentials;
the rest is already done in the repo.

## 0. Reality check

~20k GitHub stars in a day has basically never happened for a dev tool. A strong Show HN /
Product Hunt launch lands hundreds→low-thousands in the first days. This playbook maximizes
the shot; the ceiling is HN front page / trending. Ship it well, respond fast, and let it
compound.

---

## 1. Publish to npm — the install one-liner **[you]**

Everything is prepped as a single self-contained package `tower-mcp` (verified: a fresh
install runs the collision demo, tree-sitter and all).

```bash
npm run build              # produces the bundled packages/cli/dist
cd packages/cli
npm publish --dry-run      # sanity check the tarball contents
npm login                  # your npm account
npm publish                # ships tower-mcp@0.1.0 (public)
```

Then verify on a clean machine (or fresh dir):

```bash
npx -y tower-mcp serve --help
```

The README, website, and docs already point at `npx -y tower-mcp serve`, so nothing else
to change once it's live.

## 2. Website (GitHub Pages)

A deploy workflow (`.github/workflows/pages.yml`) ships `site/` to Pages on every push.
If Pages isn't enabled yet: **Settings → Pages → Source: GitHub Actions** **[you if the API
couldn't]**. Live at `https://rohanxmalik.github.io/Tower/`.

## 3. Optional but high-impact: real GIF **[you]**

```bash
vhs examples/two-agents-demo/demo.tape   # → docs/demo.gif
```

Then swap `docs/demo.svg` → `docs/demo.gif` in `README.md` and `site/index.html`. (The
animated SVG is a solid stand-in if you skip this.)

## 4. Submit to MCP directories (do this FIRST — approvals are async)

These are where MCP users actually discover servers; they drive real installs + stars.

- **Official list** — PR to `modelcontextprotocol/servers` (add Tower under community servers).
- **mcp.so** — https://mcp.so/submit
- **Smithery** — https://smithery.ai (add server)
- **Glama** — https://glama.ai/mcp/servers (submit)
- **PulseMCP** — https://www.pulsemcp.com (submit a server)
- **Cursor MCP directory** — https://docs.cursor.com/ (community MCP list)
- **Awesome MCP Servers** — PR to `punkpeye/awesome-mcp-servers`.

## 5. Launch posts **[you — your accounts]**

Post order on launch morning (US Pacific, ~7–9am): Show HN first, then X, then Reddit.
Respond to every comment in the first 2 hours — that decides HN ranking.

### Show HN

**Title:** `Show HN: Tower – stop two AI agents from editing the same code (MCP server)`

**Body:**

> I run several coding agents in parallel now (Claude Code, Cursor) and they kept colliding
> on the same files — I'd only find out at merge, after both had done the work.
>
> Tower is a small MCP server that fixes the write side. Before an agent edits, it declares
> the files/symbols it's about to change; Tower detects _semantic_ overlap (tree-sitter, so
> `AuthService.verify` conflicts even across different diff hunks) with other active agents
> and warns before the keystroke. There's a Claude Code PreToolUse hook that actually
> _blocks_ a conflicting edit, and a hosted mode so a team on different machines shares one
> Tower.
>
> Model-agnostic (it's just MCP), Node 22+, no native deps (uses node:sqlite). Install is
> `npx -y tower-mcp serve`. MIT.
>
> Repo: https://github.com/Rohanxmalik/Tower · Site: https://rohanxmalik.github.io/Tower/
>
> It's early — the honest gaps are in the README. Would love feedback on the collision
> model and whether the enforcement hook is the right call.

### X / Twitter thread

1. Two AI agents. One repo. They keep editing the same file and you only find out at merge.
   I built Tower to stop that — air-traffic control for your coding agents. 🗼 [demo gif]
2. Before an agent edits, it "claims" the files/symbols. Tower detects _semantic_ overlap
   (tree-sitter, not text) with other active agents and holds the second one — before the
   keystroke, not at merge.
3. It's an MCP server, so it works with Claude Code, Cursor, Codex — any model. A PreToolUse
   hook makes it _enforce_, not just suggest. Team mode: host one Tower, everyone connects.
4. `npx -y tower-mcp serve` · Node 22+, no native deps, MIT.
   ⭐ https://github.com/Rohanxmalik/Tower

### Reddit

- **r/ClaudeAI** and **r/mcp**: same hook as the X post; lead with the demo, link the repo.
- **r/LocalLLaMA**: frame around multi-agent orchestration + MCP; emphasize model-agnostic.
  Titles: "Tower: an MCP server that stops parallel AI agents from colliding on the same code".

### Product Hunt

- **Tagline:** "Air-traffic control for your AI coding agents."
- **First comment:** the Show HN body, trimmed, + a line asking for the biggest multi-agent
  pain people hit.

## 6. After launch

- Pin the demo, answer everything, and file the honest gaps as issues (predictive conflicts,
  cross-machine enforcement) so contributors have an on-ramp.
