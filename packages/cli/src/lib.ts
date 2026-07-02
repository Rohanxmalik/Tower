import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TowerService, TowerStore, parsePolicy, type Policy } from "@tower/server";

export function towerDir(cwd: string): string {
  return join(cwd, ".tower");
}
export function dbPath(cwd: string): string {
  return join(towerDir(cwd), "tower.db");
}
export function policyPath(cwd: string): string {
  return join(towerDir(cwd), "policy.yaml");
}
export function claimIdPath(cwd: string): string {
  return join(towerDir(cwd), "claim-id");
}

export function loadPolicy(cwd: string): Policy {
  const p = policyPath(cwd);
  if (!existsSync(p)) return { modules: [], maxAgentsPerModule: null };
  return parsePolicy(readFileSync(p, "utf8"));
}

export interface BuildOptions {
  /** Use an in-memory DB (tests). Otherwise a file-backed DB shared across CLI invocations. */
  memory?: boolean;
}

/**
 * Build a TowerService backed by the repo's `.tower/tower.db` so separate CLI
 * invocations (and a running server) all share the same claim state.
 */
export function buildService(cwd: string, opts: BuildOptions = {}): TowerService {
  const policy = loadPolicy(cwd);
  if (opts.memory) {
    return new TowerService({ store: new TowerStore(), policy });
  }
  mkdirSync(towerDir(cwd), { recursive: true });
  return new TowerService({ store: new TowerStore({ path: dbPath(cwd) }), policy });
}

export const EXAMPLE_POLICY = `# Tower policy — declare your modules so the sequencer can order agent work safely.
# Uncomment and adapt to your repo layout.
modules:
  # auth: { path: "src/auth/**" }
  # api: { path: "src/api/**", depends_on: [auth] }
  # dashboard: { path: "src/dashboard/**", depends_on: [api] }
limits:
  max_agents_per_module: 3
`;

export const MCP_SNIPPET = `Add Tower to your agent's MCP config, e.g. Claude Code (.mcp.json):

  {
    "mcpServers": {
      "tower": { "command": "node", "args": ["packages/cli/dist/index.js", "serve"] }
    }
  }

Then add to your agent's rules (CLAUDE.md / .cursorrules):

  Before editing any file, call the "claim_intent" MCP tool with the files and
  symbols you will change. If a "hard" conflict is returned, stop and ask the user.
`;

export const POST_COMMIT_HOOK = `#!/bin/sh
# Tower post-commit hook: release the current agent's claims on commit.
# Install: copy to .git/hooks/post-commit and chmod +x.
# (Wire your agentId/claimId as you prefer; this is a template.)
exit 0
`;
