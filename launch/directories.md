# MCP directory submissions — copy-paste sheet

Work through these before the Show HN post: approval is asynchronous, so listings land
during launch week. Every field below is ready to paste. Verify each site's exact flow
when you're there — directory UIs change.

## Canonical copy (use everywhere)

- **Name:** Tower
- **One-liner (140 chars):**
  `Air-traffic control for AI coding agents — collision prevention, agent-to-agent messaging, and cross-machine task delegation over MCP.`
- **Longer description:**
  Tower is an MCP server that coordinates multiple AI coding agents on one repo.
  Agents declare intent before editing and Tower detects semantic overlaps
  (tree-sitter symbols) before the collision happens — not at merge time. Agents
  message each other and delegate whole tasks across machines: type a task on your
  phone, a worker daemon runs a headless agent, commits on a branch, and opens a PR.
  17 tools, model-agnostic (Claude Code / Cursor / Codex), zero native deps, MIT.
- **Categories/tags:** developer-tools, collaboration, git, agents, coordination
- **Repo:** https://github.com/Rohanxmalik/Tower
- **Install (solo, stdio):**
  ```json
  { "mcpServers": { "tower": { "command": "npx", "args": ["-y", "tower-mcp", "serve"] } } }
  ```
- **Install (team server):**
  ```bash
  npx -y tower-mcp setup --url https://tower-xxxx.onrender.com/mcp --token <your-token>
  ```

## 1. Smithery — https://smithery.ai

The repo already ships `smithery.yaml`, so this is the easiest one.
Go to smithery.ai → sign in with GitHub → "Add server" → point it at the repo.
It reads the yaml; confirm the description matches the one-liner above.

## 2. mcp.so — https://mcp.so

"Submit" (top right) → paste the repo URL + one-liner. They typically pull the README
for the long description. Category: Developer Tools.

## 3. Glama — https://glama.ai/mcp/servers

Glama indexes public MCP repos automatically but accepts manual submissions:
glama.ai → MCP servers → "Submit a server" (or open an issue on their directory repo
if the form moved). Paste repo + description.

## 4. PulseMCP — https://www.pulsemcp.com

"Submit a server" in the site footer/navbar → repo URL, name, one-liner, category.

## 5. Official community list — PR to modelcontextprotocol/servers

The README of https://github.com/modelcontextprotocol/servers has a
"🤝 Community Servers" section, alphabetized. Fork, add one line in the T's:

```markdown
- **[Tower](https://github.com/Rohanxmalik/Tower)** - Coordination for multiple AI coding agents: collision prevention before edits, agent-to-agent messaging, and cross-machine task delegation with PR automation.
```

Then open the PR (their CONTRIBUTING.md asks for one server per PR). This one has the
longest review queue — submit it first.

## After each listing goes live

Add the badge/link to a "Listed on" line in the README, and reply to any reviewer
questions same-day — directory maintainers fast-track responsive submitters.
