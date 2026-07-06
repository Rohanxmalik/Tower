import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_SCHEMAS } from "@tower/shared";
import type {
  Conflict,
  ClaimIntentInput,
  CheckCollisionInput,
  HeartbeatInput,
  CompleteClaimInput,
  ReleaseClaimInput,
  ListClaimsInput,
  LogDecisionInput,
  GetDecisionsInput,
  NextTaskInput,
} from "@tower/shared";
import { TowerService } from "./service.js";

const SERVER_INFO = { name: "tower", version: "0.2.2" } as const;

const TOOL_DESCRIPTIONS: Record<keyof typeof TOOL_SCHEMAS, string> = {
  claim_intent:
    "Register intent to edit code BEFORE editing. Returns any collisions with other active agents. Call this first, always.",
  check_collision: "Check for collisions without registering a claim (a dry run).",
  heartbeat: "Keep an active claim alive; claims auto-expire without heartbeats.",
  complete_claim: "Release a claim after committing (optionally record the commit sha).",
  release_claim: "Abandon a claim without committing.",
  list_claims: "List claims, optionally filtered by repo/branch/status.",
  log_decision:
    "Record an architecture decision and WHY it was made, for the team's shared memory.",
  get_decisions: "Recall past architecture decisions before acting.",
  next_task: "Ask the sequencer for a task whose module is safe to start right now.",
};

function summarize(tool: string, result: unknown): string {
  if (tool === "claim_intent" || tool === "check_collision") {
    const conflicts = (result as { conflicts: Conflict[] }).conflicts;
    if (!conflicts.length) return "No collisions — safe to proceed.";
    const lines = conflicts.map(
      (c) =>
        `[${c.severity.toUpperCase()}] ${c.reason}${c.etaMinutes ? ` (ETA ~${c.etaMinutes}m)` : ""}`,
    );
    return `${conflicts.length} collision(s):\n${lines.join("\n")}`;
  }
  return JSON.stringify(result);
}

/** Build an MCP server exposing Tower's 9 tools, delegating to the given service. */
export function buildMcpServer(service: TowerService): McpServer {
  const server = new McpServer(SERVER_INFO);

  // Each handler receives args already validated by the SDK against the tool's
  // inputSchema, so the cast to the parsed input type is safe.
  const handlers: Record<keyof typeof TOOL_SCHEMAS, (args: unknown) => unknown> = {
    claim_intent: (a) => service.claimIntent(a as ClaimIntentInput),
    check_collision: (a) => service.checkCollision(a as CheckCollisionInput),
    heartbeat: (a) => service.heartbeat(a as HeartbeatInput),
    complete_claim: (a) => service.completeClaim(a as CompleteClaimInput),
    release_claim: (a) => service.releaseClaim(a as ReleaseClaimInput),
    list_claims: (a) => service.listClaims(a as ListClaimsInput),
    log_decision: (a) => service.logDecision(a as LogDecisionInput),
    get_decisions: (a) => service.getDecisions(a as GetDecisionsInput),
    next_task: (a) => service.nextTask(a as NextTaskInput),
  };

  for (const name of Object.keys(TOOL_SCHEMAS) as (keyof typeof TOOL_SCHEMAS)[]) {
    const { input, output } = TOOL_SCHEMAS[name];
    server.registerTool(
      name,
      {
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: input,
        outputSchema: output,
      },
      (args: unknown): CallToolResult => {
        const result = handlers[name](args);
        return {
          structuredContent: result as Record<string, unknown>,
          content: [{ type: "text", text: summarize(name, result) }],
        };
      },
    );
  }

  return server;
}
