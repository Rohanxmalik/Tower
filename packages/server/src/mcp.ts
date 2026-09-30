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
  RecordReadsInput,
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
    "Register intent to edit code BEFORE editing. Returns any collisions with other active agents. Call this first, always. " +
    "Also pass `reads`: the declarations you consulted to write this — the functions, methods or types you are calling or implementing against. " +
    "Tower tells you when one of them changes under you, and shows the old and new signature so you can patch your call sites without re-reading the file. " +
    "If you are changing a symbol's signature, set `declares` on it to the new declaration as it will read in the source, up to the body (e.g. `function verify(token: string, opts: Opts): boolean`): " +
    "agents whose work reads it are handed that contract immediately and can code against it in parallel instead of waiting for you. " +
    "If the claim is refused, the response carries `alternatives`: what to avoid, and advice. Don't stop — work outside `avoid`; Tower messages you when it frees up.",
  check_collision: "Check for collisions without registering a claim (a dry run).",
  record_reads:
    "Record declarations you just read, so your next claim_intent knows what your work is built on. " +
    "Returns `conflicts` straight away when another agent is changing what you read — the cheapest moment to find out, before you plan against it. " +
    "Normally called by the PostToolUse hook, not by you.",
  heartbeat:
    "Keep an active claim alive; claims auto-expire without heartbeats. Returns `invalidations`: declarations your work read that have moved, " +
    "or that another agent has declared it is about to change — with the new signature, so you can adapt before it lands.",
  complete_claim:
    "Release a claim after committing (optionally record the commit sha). Pass `symbols` with their final `sig`/`sigText` and every agent whose " +
    "work reads a changed declaration is told what it landed as, and whether it matches what you declared.",
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
    const lines = conflicts.map((c) => {
      const head = `[${c.severity.toUpperCase()}] ${c.reason}${c.etaMinutes ? ` (ETA ~${c.etaMinutes}m)` : ""}`;
      // Ship the delta, never "go re-read the file". Two lines here replace pulling a
      // whole module back into context to discover one parameter moved.
      if (c.wasSigText && c.nowSigText) {
        return `${head}\n    was: ${c.wasSigText}\n    now: ${c.nowSigText}`;
      }
      return head;
    });
    return `${conflicts.length} collision(s):\n${lines.join("\n")}`;
  }
  return JSON.stringify(result);
}

/** Which identity fields a tool's schema will accept, computed from the zod shape. */
function identityFields(name: keyof typeof TOOL_SCHEMAS): string[] {
  const schema = TOOL_SCHEMAS[name].input as unknown as {
    shape?: Record<string, unknown>;
    _def?: { shape?: () => Record<string, unknown> };
  };
  const shape = schema.shape ?? schema._def?.shape?.() ?? {};
  return ["repoId", "projectId"].filter((f) => f in shape);
}

/**
 * Add the machine's project identity to a call, without overriding anything the caller
 * set deliberately. Only fields the tool actually accepts are added, so a tool that
 * takes no repo is left alone.
 */
export function withIdentity(
  name: keyof typeof TOOL_SCHEMAS,
  args: unknown,
  identity: { repoId?: string; projectId?: string },
): unknown {
  if (typeof args !== "object" || args === null) return args;
  const record = args as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const field of identityFields(name)) {
    const supplied = record[field];
    const value = identity[field as "repoId" | "projectId"];
    if (value && (supplied === undefined || supplied === "")) patch[field] = value;
  }
  return Object.keys(patch).length ? { ...record, ...patch } : args;
}

export type RemoteCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * An MCP server that forwards every tool to a hosted Tower, stamping this machine's
 * project identity onto each call first.
 *
 * This is the fix for the failure mode that split a real two-agent session: when
 * `.mcp.json` points a browser-style HTTP entry straight at the server, nothing on the
 * machine ever computes `repoId`, so a fork and its upstream partition apart in silence.
 * Running the client locally gives identity somewhere to come from, and the agent never
 * has to know the concept exists.
 */
export function buildProxyMcpServer(
  call: RemoteCall,
  identity: { repoId?: string; projectId?: string },
): McpServer {
  const server = new McpServer(SERVER_INFO);
  for (const name of Object.keys(TOOL_SCHEMAS) as (keyof typeof TOOL_SCHEMAS)[]) {
    const { input, output } = TOOL_SCHEMAS[name];
    server.registerTool(
      name,
      { description: TOOL_DESCRIPTIONS[name], inputSchema: input, outputSchema: output },
      async (args: unknown): Promise<CallToolResult> => {
        const result = await call(
          name,
          withIdentity(name, args, identity) as Record<string, unknown>,
        );
        return {
          structuredContent: result as Record<string, unknown>,
          content: [{ type: "text", text: summarize(name, result) }],
        };
      },
    );
  }
  return server;
}

/**
 * Any authenticated tool call is proof the agent is alive, so it refreshes presence.
 *
 * Before this, only the `tower work` daemon's `heartbeat_worker` did — meaning an agent
 * claiming and messaging all day read as "seen earlier" forever on the board, which is
 * exactly the signal a team lead needs and the one that was missing.
 */
function touchPresence(service: TowerService, args: unknown): void {
  if (typeof args !== "object" || args === null) return;
  const a = args as Record<string, unknown>;
  const agentId = typeof a.agentId === "string" ? a.agentId : (a.fromAgentId as string | undefined);
  const repo = typeof a.repo === "string" ? a.repo : undefined;
  if (typeof agentId !== "string" || !repo) return;
  service.store.touchAgent(
    agentId,
    repo,
    typeof a.repoId === "string" ? a.repoId : undefined,
    typeof a.projectId === "string" ? a.projectId : undefined,
  );
}

/** Build an MCP server exposing Tower's 20 tools, delegating to the given service. */
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
    record_reads: (a) => service.recordReads(a as RecordReadsInput),
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
        touchPresence(service, args);
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
