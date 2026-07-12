import { z } from "zod";

/**
 * Tower protocol — the single source of truth for every wire type and MCP tool
 * contract. Zod schemas are the validation boundary; TypeScript types are inferred
 * from them so the two can never drift.
 */

// ---------------------------------------------------------------------------
// Core domain types
// ---------------------------------------------------------------------------

export const SymbolKind = z.enum(["function", "class", "method", "type", "file"]);
export type SymbolKind = z.infer<typeof SymbolKind>;

/** A reference to a code symbol an agent intends to touch. `symbol: ""` means the whole file. */
export const SymbolRef = z.object({
  file: z.string().min(1),
  symbol: z.string(),
  kind: SymbolKind.optional(),
});
export type SymbolRef = z.infer<typeof SymbolRef>;

export const ClaimStatus = z.enum(["active", "completed", "expired", "released"]);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

export const Claim = z.object({
  id: z.string(),
  agentId: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1),
  files: z.array(z.string()),
  symbols: z.array(SymbolRef),
  purpose: z.string(),
  status: ClaimStatus,
  etaMinutes: z.number().int().positive().optional(),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  commitSha: z.string().optional(),
});
export type Claim = z.infer<typeof Claim>;

export const Severity = z.enum(["hard", "soft", "info"]);
export type Severity = z.infer<typeof Severity>;

export const Conflict = z.object({
  claimId: z.string(),
  agentId: z.string(),
  severity: Severity,
  reason: z.string(),
  overlap: z.array(SymbolRef),
  etaMinutes: z.number().int().positive().optional(),
});
export type Conflict = z.infer<typeof Conflict>;

export const Decision = z.object({
  id: z.string(),
  title: z.string().min(1),
  body: z.string(),
  author: z.string().min(1),
  tags: z.array(z.string()),
  relatedFiles: z.array(z.string()),
  createdAt: z.number().int(),
});
export type Decision = z.infer<typeof Decision>;

export const Task = z.object({
  id: z.string().min(1),
  module: z.string().min(1),
  description: z.string().optional(),
});
export type Task = z.infer<typeof Task>;

/** Message kinds: chat, a task request for another agent, or a status update on one. */
export const MessageKind = z.enum(["message", "task", "task_update"]);
export type MessageKind = z.infer<typeof MessageKind>;

/** An async agent-to-agent message (the "Slack" in Slack-for-agents). */
export const Message = z.object({
  id: z.string(),
  repo: z.string().min(1),
  fromAgentId: z.string().min(1),
  /** Target agent id, or "*" to broadcast to everyone on the repo. */
  toAgentId: z.string().min(1),
  kind: MessageKind,
  body: z.string().min(1),
  /** Thread parent (e.g. a task_update pointing at the original task). */
  replyTo: z.string().optional(),
  createdAt: z.number().int(),
  readAt: z.number().int().optional(),
});
export type Message = z.infer<typeof Message>;

// ---------------------------------------------------------------------------
// MCP tool I/O contracts (17 tools)
// ---------------------------------------------------------------------------

export const ClaimIntentInput = z.object({
  agentId: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1),
  files: z.array(z.string()).default([]),
  symbols: z.array(SymbolRef).default([]),
  purpose: z.string().default(""),
  etaMinutes: z.number().int().positive().optional(),
});
export type ClaimIntentInput = z.infer<typeof ClaimIntentInput>;

export const ClaimIntentOutput = z.object({
  claimId: z.string(),
  conflicts: z.array(Conflict),
  /** Unread inbox count for the claiming agent — "you've got mail" on every claim. */
  unreadMessages: z.number().int().nonnegative().optional(),
});
export type ClaimIntentOutput = z.infer<typeof ClaimIntentOutput>;

export const CheckCollisionInput = z.object({
  repo: z.string().min(1),
  branch: z.string().min(1),
  files: z.array(z.string()).default([]),
  symbols: z.array(SymbolRef).default([]),
  agentId: z.string().optional(),
});
export type CheckCollisionInput = z.infer<typeof CheckCollisionInput>;

export const CheckCollisionOutput = z.object({ conflicts: z.array(Conflict) });
export type CheckCollisionOutput = z.infer<typeof CheckCollisionOutput>;

export const HeartbeatInput = z.object({ claimId: z.string().min(1) });
export type HeartbeatInput = z.infer<typeof HeartbeatInput>;

export const HeartbeatOutput = z.object({ ok: z.boolean(), expiresAt: z.number().int() });
export type HeartbeatOutput = z.infer<typeof HeartbeatOutput>;

export const CompleteClaimInput = z.object({
  claimId: z.string().min(1),
  commitSha: z.string().optional(),
});
export type CompleteClaimInput = z.infer<typeof CompleteClaimInput>;

export const ReleaseClaimInput = z.object({ claimId: z.string().min(1) });
export type ReleaseClaimInput = z.infer<typeof ReleaseClaimInput>;

export const OkOutput = z.object({ ok: z.boolean() });
export type OkOutput = z.infer<typeof OkOutput>;

export const ListClaimsInput = z.object({
  repo: z.string().optional(),
  branch: z.string().optional(),
  status: ClaimStatus.optional(),
});
export type ListClaimsInput = z.infer<typeof ListClaimsInput>;

export const ListClaimsOutput = z.object({ claims: z.array(Claim) });
export type ListClaimsOutput = z.infer<typeof ListClaimsOutput>;

export const LogDecisionInput = z.object({
  title: z.string().min(1),
  body: z.string().default(""),
  author: z.string().min(1),
  tags: z.array(z.string()).default([]),
  relatedFiles: z.array(z.string()).default([]),
});
export type LogDecisionInput = z.infer<typeof LogDecisionInput>;

export const LogDecisionOutput = z.object({ id: z.string() });
export type LogDecisionOutput = z.infer<typeof LogDecisionOutput>;

export const GetDecisionsInput = z.object({
  query: z.string().optional(),
  tags: z.array(z.string()).optional(),
  relatedFiles: z.array(z.string()).optional(),
});
export type GetDecisionsInput = z.infer<typeof GetDecisionsInput>;

export const GetDecisionsOutput = z.object({ decisions: z.array(Decision) });
export type GetDecisionsOutput = z.infer<typeof GetDecisionsOutput>;

export const NextTaskInput = z.object({
  agentId: z.string().min(1),
  repo: z.string().min(1),
  candidates: z.array(Task).default([]),
});
export type NextTaskInput = z.infer<typeof NextTaskInput>;

export const NextTaskOutput = z.object({
  task: Task.nullable(),
  reason: z.string(),
});
export type NextTaskOutput = z.infer<typeof NextTaskOutput>;

/** Lifecycle of a delegated task: open → accepted → done | failed. */
export const TaskStatus = z.enum(["open", "accepted", "done", "failed"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Human-in-the-loop gate: a worker can park a task until someone approves it (e.g. from a phone). */
export const ApprovalState = z.enum(["pending", "approved", "rejected"]);
export type ApprovalState = z.infer<typeof ApprovalState>;

/** A delegated unit of work between agents (id doubles as the originating message id). */
export const DelegatedTask = z.object({
  id: z.string(),
  repo: z.string().min(1),
  fromAgentId: z.string().min(1),
  /** Direct assignee, or "*" — open to whoever accepts first. */
  toAgentId: z.string().min(1),
  body: z.string().min(1),
  status: TaskStatus,
  assigneeAgentId: z.string().optional(),
  /** Set when a worker is waiting on human approval before running (remote-approve mode). */
  approval: ApprovalState.optional(),
  commitSha: z.string().optional(),
  prUrl: z.string().optional(),
  result: z.string().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type DelegatedTask = z.infer<typeof DelegatedTask>;

/** Create a delegated task directly (used by the board's mobile send box). */
export const CreateTaskInput = z.object({
  repo: z.string().min(1),
  body: z.string().min(1),
  fromAgentId: z.string().min(1).default("board"),
  toAgentId: z.string().min(1).default("*"),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

/** A worker parks a task for human approval before running it. */
export const RequestApprovalInput = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
});
export type RequestApprovalInput = z.infer<typeof RequestApprovalInput>;

/** A human approves/rejects a parked task (from the board, incl. mobile). */
export const ResolveApprovalInput = z.object({
  taskId: z.string().min(1),
  approved: z.boolean(),
});
export type ResolveApprovalInput = z.infer<typeof ResolveApprovalInput>;

export const AcceptTaskInput = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
});
export type AcceptTaskInput = z.infer<typeof AcceptTaskInput>;

export const AcceptTaskOutput = z.object({
  ok: z.boolean(),
  task: DelegatedTask.nullable(),
});
export type AcceptTaskOutput = z.infer<typeof AcceptTaskOutput>;

export const CompleteTaskInput = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  success: z.boolean().default(true),
  result: z.string().default(""),
  commitSha: z.string().optional(),
  prUrl: z.string().optional(),
});
export type CompleteTaskInput = z.infer<typeof CompleteTaskInput>;

export const ListTasksInput = z.object({
  repo: z.string().optional(),
  status: TaskStatus.optional(),
  /** Tasks addressed to this agent (including "*" broadcasts). */
  forAgentId: z.string().optional(),
  assigneeAgentId: z.string().optional(),
});
export type ListTasksInput = z.infer<typeof ListTasksInput>;

export const ListTasksOutput = z.object({ tasks: z.array(DelegatedTask) });
export type ListTasksOutput = z.infer<typeof ListTasksOutput>;

/** A worker daemon announcing it is online and ready to run delegated tasks. */
export const Worker = z.object({
  agentId: z.string().min(1),
  repo: z.string().min(1),
  /** Which local agent it runs: "claude" | "codex" | "cmd" (free-form for forward-compat). */
  runner: z.string().default(""),
  lastSeen: z.number().int(),
});
export type Worker = z.infer<typeof Worker>;

export const HeartbeatWorkerInput = z.object({
  agentId: z.string().min(1),
  repo: z.string().min(1),
  runner: z.string().default(""),
});
export type HeartbeatWorkerInput = z.infer<typeof HeartbeatWorkerInput>;

export const SendMessageInput = z.object({
  fromAgentId: z.string().min(1),
  toAgentId: z.string().min(1),
  repo: z.string().min(1),
  body: z.string().min(1),
  kind: MessageKind.default("message"),
  replyTo: z.string().optional(),
});
export type SendMessageInput = z.infer<typeof SendMessageInput>;

export const SendMessageOutput = z.object({ id: z.string() });
export type SendMessageOutput = z.infer<typeof SendMessageOutput>;

export const FetchMessagesInput = z.object({
  agentId: z.string().min(1),
  repo: z.string().optional(),
  /** Default true: only unread; fetching marks them read. */
  unreadOnly: z.boolean().default(true),
});
export type FetchMessagesInput = z.infer<typeof FetchMessagesInput>;

export const FetchMessagesOutput = z.object({ messages: z.array(Message) });
export type FetchMessagesOutput = z.infer<typeof FetchMessagesOutput>;

/** Registry consumed by the MCP server to declare tools. */
export const TOOL_SCHEMAS = {
  claim_intent: { input: ClaimIntentInput, output: ClaimIntentOutput },
  check_collision: { input: CheckCollisionInput, output: CheckCollisionOutput },
  heartbeat: { input: HeartbeatInput, output: HeartbeatOutput },
  complete_claim: { input: CompleteClaimInput, output: OkOutput },
  release_claim: { input: ReleaseClaimInput, output: OkOutput },
  list_claims: { input: ListClaimsInput, output: ListClaimsOutput },
  log_decision: { input: LogDecisionInput, output: LogDecisionOutput },
  get_decisions: { input: GetDecisionsInput, output: GetDecisionsOutput },
  next_task: { input: NextTaskInput, output: NextTaskOutput },
  send_message: { input: SendMessageInput, output: SendMessageOutput },
  fetch_messages: { input: FetchMessagesInput, output: FetchMessagesOutput },
  accept_task: { input: AcceptTaskInput, output: AcceptTaskOutput },
  complete_task: { input: CompleteTaskInput, output: OkOutput },
  list_tasks: { input: ListTasksInput, output: ListTasksOutput },
  request_approval: { input: RequestApprovalInput, output: OkOutput },
  resolve_approval: { input: ResolveApprovalInput, output: OkOutput },
  heartbeat_worker: { input: HeartbeatWorkerInput, output: OkOutput },
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
