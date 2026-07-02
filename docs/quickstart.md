# Quickstart

Tower needs **Node 22+** (it uses the built-in `node:sqlite` — no native modules to
compile). Install is just `npx`:

```bash
npx -y tower-mcp --help
```

For brevity below, `tower` = `npx -y tower-mcp`. (From source: `git clone` the repo,
`npm install && npm run build`, then `tower` = `node packages/cli/dist/index.js`.)

## 1. Initialize

```bash
tower init      # writes .tower/policy.yaml + prints MCP setup
```

## 2. Start the server

Local (one machine, powers the demo):

```bash
tower serve         # MCP over stdio
```

Shared (a whole team hits one Tower):

```bash
tower serve --http --port 4319 --token <shared-secret>
```

## 3. Point your agent at Tower

Add to your agent's MCP config (Claude Code `.mcp.json` shown):

```json
{
  "mcpServers": {
    "tower": { "command": "npx", "args": ["-y", "tower-mcp", "serve"] }
  }
}
```

Then add to your agent's rules file (`CLAUDE.md`, `.cursorrules`, …):

> Before editing any file, call the `claim_intent` MCP tool with the files and symbols
> you will change. If a `hard` conflict is returned, stop and ask the user.

## 4. See it work

```bash
tower status        # active claims
tower watch         # live view
```

Or run the packaged demo:

```bash
npm run demo
```

## Try it without an agent

```bash
tower claim --agent bob   --repo acme/app --symbol "src/auth.ts#AuthService.verify" --purpose "replace JWT" --eta 6
tower claim --agent alice --repo acme/app --symbol "src/auth.ts#AuthService.verify" --purpose "rate limit"
# → ⛔ COLLISION on AuthService.verify
```
