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
      "tower": { "command": "npx", "args": ["-y", "tower-mcp", "serve"] }
    }
  }

Then add to your agent's rules (CLAUDE.md / .cursorrules):

  Before editing any file, call the "claim_intent" MCP tool with the files and
  symbols you will change. If a "hard" conflict is returned, stop and ask the user.
  If the response reports unreadMessages > 0, call "fetch_messages" — a teammate's
  agent may have sent you a message or delegated you a task; act on tasks and reply
  with a "task_update" via "send_message" when done.
`;

export const POST_COMMIT_HOOK = `#!/bin/sh
# Tower post-commit hook: release the current agent's claims on commit.
# Install: copy to .git/hooks/post-commit and chmod +x.
# (Wire your agentId/claimId as you prefer; this is a template.)
exit 0
`;

/** Verbatim copy of examples/git-hooks/pre-commit, embedded so "tower setup" can install it anywhere. */
export const PRE_COMMIT_HOOK = `#!/bin/sh
# Tower pre-commit guard — universal enforcement for ANY agent or editor.
#
# Claude Code gets real-time blocking via the PreToolUse hook; Cursor, Codex, Gemini CLI
# and plain humans get this: the commit itself is refused while another active agent
# holds a hard-conflicting claim on a staged file. Works locally and, with TOWER_URL set,
# against your team's hosted Tower.
#
# Install:
#   cp examples/git-hooks/pre-commit .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# Optional env: TOWER_AGENT (defaults to git user.name), TOWER_URL, TOWER_TOKEN.

FILES=$(git diff --cached --name-only --diff-filter=ACMR)
[ -z "$FILES" ] && exit 0

AGENT="\${TOWER_AGENT:-$(git config user.name || echo dev)}"
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)
# Stable repo id from origin (host/owner/repo), matching the enforcement hook.
ORIGIN=$(git config --get remote.origin.url 2>/dev/null)
if [ -n "$ORIGIN" ]; then
  REPO=$(printf '%s' "$ORIGIN" | sed -e 's#^git@\\([^:]*\\):#\\1/#' -e 's#^ssh://git@##' \\
    -e 's#^https\\{0,1\\}://##' -e 's#\\.git$##' | tr '[:upper:]' '[:lower:]')
else
  REPO=$(basename "$(git rev-parse --show-toplevel)")
fi

FILE_ARGS=""
for f in $FILES; do FILE_ARGS="$FILE_ARGS --file $f"; done

# guard exits 2 on a hard collision (block), 0 when clear (and registers a claim).
npx -y tower-mcp guard --agent "$AGENT" --repo "$REPO" --branch "$BRANCH" \\
  --purpose "commit by $AGENT" $FILE_ARGS
STATUS=$?

if [ "$STATUS" -eq 2 ]; then
  echo ""
  echo "⛔ Tower blocked this commit: another agent is mid-change on a staged file."
  echo "   Wait for them to commit, take a dependent task, or bypass with: git commit --no-verify"
  exit 1
fi
# Fail open on any other Tower error — coordination must never brick your commit.
exit 0
`;

/** Verbatim copy of examples/git-hooks/post-commit, embedded so "tower setup" can install it anywhere. */
export const POST_COMMIT_HOOK_SCRIPT = `#!/bin/sh
# Tower post-commit hook — release an agent's claim once work is committed.
#
# Install:
#   cp examples/git-hooks/post-commit .git/hooks/post-commit
#   chmod +x .git/hooks/post-commit
#
# How it works: your agent stores its active claim id (e.g. in .tower/claim-id
# after calling claim_intent). On commit we complete that claim so others see the
# file freed and the commit sha recorded.

CLAIM_FILE=".tower/claim-id"
if [ -f "$CLAIM_FILE" ]; then
  CLAIM_ID=$(cat "$CLAIM_FILE")
  SHA=$(git rev-parse HEAD)
  # Best-effort; never block a commit on Tower. \`tower claim\`/\`guard\` write .tower/claim-id.
  node packages/cli/dist/index.js complete --claim "$CLAIM_ID" --sha "$SHA" >/dev/null 2>&1 || true
  rm -f "$CLAIM_FILE"
fi
exit 0
`;
