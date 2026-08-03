import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_SCHEMAS, TOWER_VERSION } from "@tower/shared";
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
  SendMessageInput,
  FetchMessagesInput,
  PendingInput,
  ProposeIntentInput,
  AcceptTaskInput,
  CompleteTaskInput,
  ListTasksInput,
  RequestApprovalInput,
  ResolveApprovalInput,
  HeartbeatWorkerInput,
} from "@tower/shared";
import { TowerService } from "./service.js";

// One source of truth for the release version — see TOWER_VERSION in @tower/shared.
const SERVER_INFO = { name: "tower", version: TOWER_VERSION } as const;

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
  propose_intent:
    "BEFORE you research or write anything: say in plain English what you plan to work on. Returns anyone already doing the same work, matched on meaning rather than file paths — so it catches a duplicate even when you would have picked a different filename. One call per task; it is the cheapest check Tower offers and the only one that fires before your tokens are spent.",
  send_message:
    "Send an async message or task to another agent (toAgentId, or '*' to broadcast). Delivered on their next Tower contact. kind 'task' delegates work; reply with kind 'task_update' (replyTo=the task id) when done.",
  fetch_messages:
    "Read your inbox (marks messages read). Call whenever claim_intent reports unreadMessages > 0.",
  pending:
    "Read-only count of unread messages + open tasks waiting for you. Marks nothing read — the interactive nudge; if it returns > 0, call fetch_messages / list_tasks.",
  accept_task:
    "Claim a delegated task before working on it (first accept wins — prevents two agents doing the same work).",
  complete_task:
    "Finish an accepted task: success or failure, with the result and optional commit sha / PR url. Auto-notifies the delegator.",
  list_tasks: "List delegated tasks by repo/status/recipient/assignee (the worker's poll).",
  request_approval:
    "Park a task for human approval before running it (remote-approve worker mode) — a person approves it from the board/phone.",
  resolve_approval: "Approve or reject a parked task (used by the board; also callable by tools).",
  heartbeat_worker:
    "Announce that this worker is online and ready to run tasks (call it every poll so the board shows live presence).",
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

/** Build an MCP server exposing Tower's 18 tools, delegating to the given service. */
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
    propose_intent: (a) => service.proposeIntent(a as ProposeIntentInput),
    send_message: (a) => service.sendMessage(a as SendMessageInput),
    fetch_messages: (a) => service.fetchMessages(a as FetchMessagesInput),
    pending: (a) => service.pending(a as PendingInput),
    accept_task: (a) => service.acceptTask(a as AcceptTaskInput),
    complete_task: (a) => service.completeTask(a as CompleteTaskInput),
    list_tasks: (a) => service.listTasks(a as ListTasksInput),
    request_approval: (a) => service.requestApproval(a as RequestApprovalInput),
    resolve_approval: (a) => service.resolveApproval(a as ResolveApprovalInput),
    heartbeat_worker: (a) => service.heartbeatWorker(a as HeartbeatWorkerInput),
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
