# Tower — launch playbook

Everything to take Tower live. Steps marked **[you]** need your accounts/credentials;
the rest is already done in the repo.

## 0. Reality check

~20k GitHub stars in a day has basically never happened for a dev tool. A strong Show HN /
Product Hunt launch lands hundreds→low-thousands in the first days. This playbook maximizes
the shot; the ceiling is HN front page / trending. Ship it well, respond fast, and let it
compound.

---

## 1. npm — ✅ DONE

`tower-mcp` is live on npm (v0.4.x): one self-contained package, `npx -y tower-mcp setup`
onboards a repo in one command. To ship a new version: bump `packages/cli/package.json`
(+ the version strings in `packages/server/src/mcp.ts` and `packages/cli/src/remote.ts`),
`npm run build && npm test`, then `npm publish` from `packages/cli`.

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

## 4. Submit to MCP directories (do this FIRST — approvals are async) **[you]**

These are where MCP users actually discover servers; they drive real installs + stars.
Copy-paste content is below — each takes ~3 minutes.

**One-line description (use everywhere):**

> Air-traffic control for AI agents editing a shared repo — semantic pre-flight collision
> detection over MCP. Model-agnostic (Claude Code, Cursor, Codex).

- **Official list** — fork `modelcontextprotocol/servers`, add this line alphabetically to
  the community section of `README.md`, open a PR:

  ```markdown
  - **[Tower](https://github.com/Rohanxmalik/Tower)** - Stops parallel AI agents from colliding on the same code: agents claim files/symbols before editing and get semantic (tree-sitter) collision warnings before a token is spent.
  ```

- **Awesome MCP Servers** — fork `punkpeye/awesome-mcp-servers`, add under _Developer
  Tools_ (same line as above, their format: `[Rohanxmalik/Tower](...) 🏎️ ☁️ 🖥️ - ...`).
- **mcp.so** — https://mcp.so → Submit → paste the GitHub URL (it auto-imports).
- **Smithery** — https://smithery.ai → Add server → point at the repo
  (`smithery.yaml` is already in the repo root, so it lists cleanly).
- **Glama** — https://glama.ai/mcp/servers — it indexes npm/GitHub automatically; claim
  the listing by signing in with GitHub.
- **PulseMCP** — https://www.pulsemcp.com → Submit a server.
- **Cursor directory** — https://cursor.directory/mcp → submit (Tower works in Cursor
  via `.cursor/mcp.json`, same npx command).

## 5. Launch posts **[you — your accounts]**

Post order on launch morning (US Pacific, ~7–9am): Show HN first, then X, then Reddit.
Respond to every comment in the first 2 hours — that decides HN ranking.

### Show HN

**Title:** `Show HN: Tower – my Claude delegates tasks to my co-founder's Codex (MCP)`

**Body:**

> My co-founder and I both run coding agents on the same repo (me Claude Code, him Codex).
> Two problems: the agents kept colliding on the same files — discovered at merge, after
> both had burned the tokens — and they had no way to hand work to each other.
>
> Tower is a small MCP server both agents connect to. My agent can now send his a **task**
> ("you own auth — add rate limiting to /login"); his picks it up on its next Tower
> contact, does the work on his machine with his account, commits, and replies with the
> sha. No API keys cross machines — delivery is inbox-style (MCP has no push), so it works
> across editors and vendors today.
>
> The same claims that power delegation also prevent collisions: agents declare the
> files/symbols they're about to change, and Tower detects _semantic_ overlap
> (tree-sitter, so `AuthService.verify` conflicts even across different diff hunks) before
> a token is spent. Three enforcement layers — MCP rules, a Claude Code hook that
> physically _blocks_ conflicting edits, a git pre-commit guard for everything else — plus
> a live radar board (`/board`) showing every claim and the agents' conversation, and a
> GitHub Action that flags overlapping open PRs.
>
> Model-agnostic (it's just MCP), Node 22+, no native deps (uses node:sqlite). Setup is
> one command — `npx -y tower-mcp setup`; team mode is one click on Render. MIT.
>
> Repo: https://github.com/Rohanxmalik/Tower · Site: https://rohanxmalik.github.io/Tower/
>
> It's early — the honest gaps are in the README. Would love feedback on the collision
> model and whether hard-blocking is the right default.

**Objection cheatsheet (reply fast, concede honestly):**

| They'll say                                   | You say                                                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| "Just use git branches/worktrees"             | Branches don't stop wasted work — both agents still do the task, you pay twice and merge once. Tower stops the second agent _before it starts_. |
| "Locking is what databases did in the 90s"    | Fair — it's advisory intent, not a lock. Soft conflicts only warn; hard blocks are opt-in via the hook, with a `--no-verify` escape everywhere. |
| "Agents should just coordinate via the model" | They can't see each other across editors/machines/vendors. MCP is the only surface they all share today — that's why Tower is an MCP server.    |
| "This should be an editor feature"            | Probably will be, someday, per-editor. Tower is cross-editor and cross-vendor now, and MIT — editors are welcome to absorb the idea.            |
| "tree-sitter isn't semantic enough"           | Agreed, it's symbol-level, not type-aware. It catches the 80% (same function/class); the README roadmap has the honest gaps.                    |

### X / Twitter thread

1. Two AI agents. One repo. They keep editing the same file and you only find out at merge.
   I built Tower to stop that — air-traffic control for your coding agents. 🗼 [demo gif]
2. Before an agent edits, it "claims" the files/symbols. Tower detects _semantic_ overlap
   (tree-sitter, not text) with other active agents and holds the second one — before the
   keystroke, not at merge.
3. It's an MCP server, so it works with Claude Code, Cursor, Codex — any model. A PreToolUse
   hook makes it _enforce_, not just suggest. Team mode: host one Tower, everyone connects.
4. `npx -y tower-mcp setup` — 30 seconds, any MCP editor · Node 22+, no native deps, MIT.
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
