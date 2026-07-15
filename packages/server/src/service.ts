import type {
  ClaimIntentInput,
  ClaimIntentOutput,
  CheckCollisionInput,
  CheckCollisionOutput,
  HeartbeatInput,
  HeartbeatOutput,
  CompleteClaimInput,
  ReleaseClaimInput,
  OkOutput,
  ListClaimsInput,
  ListClaimsOutput,
  LogDecisionInput,
  LogDecisionOutput,
  GetDecisionsInput,
  GetDecisionsOutput,
  NextTaskInput,
  NextTaskOutput,
  SendMessageInput,
  SendMessageOutput,
  FetchMessagesInput,
  FetchMessagesOutput,
  AcceptTaskInput,
  AcceptTaskOutput,
  CompleteTaskInput,
  ListTasksInput,
  ListTasksOutput,
  CreateTaskInput,
  RequestApprovalInput,
  ResolveApprovalInput,
  HeartbeatWorkerInput,
} from "@tower/shared";
import type { Claim, Decision, DelegatedTask, Message, Worker } from "@tower/shared";

/** A worker is "online" if it heartbeated within this window. */
export const WORKER_ONLINE_MS = 30_000;
import { TowerStore } from "./store/sqlite.js";
import { detectCollisions, pairwiseCollisions, type PairConflict } from "./engine/collision.js";
import { nextTask, type Policy } from "./engine/sequencer.js";

/** What the live board renders: claims, the collisions between them, and the comms feed. */
export interface BoardSnapshot {
  claims: Claim[];
  conflicts: PairConflict[];
  /** Recent agent-to-agent messages, newest first. */
  messages: Message[];
  /** Delegated tasks, newest first (open/accepted/done/failed). */
  tasks: DelegatedTask[];
  /** Worker daemons currently online (heartbeated recently) — who can run a task now. */
  workers: Worker[];
  /** Pinned team rules (decisions tagged "rule") — every delegated prompt carries them. */
  rules: Decision[];
  /** Server clock (ms) so the board can render TTL countdowns without clock skew. */
  now: number;
}

const EMPTY_POLICY: Policy = { modules: [], maxAgentsPerModule: null };

export interface TowerServiceOptions {
  store?: TowerStore;
  policy?: Policy;
}

/**
 * The transport-agnostic core of Tower. Wires the store, collision engine and
 * sequencer into the seventeen operations exposed over MCP. Kept free of MCP/HTTP so
 * it can be unit-tested directly and reused by any transport.
 */
export class TowerService {
  readonly store: TowerStore;
  private policy: Policy;

  constructor(opts: TowerServiceOptions = {}) {
    this.store = opts.store ?? new TowerStore();
    this.policy = opts.policy ?? EMPTY_POLICY;
  }

  setPolicy(policy: Policy): void {
    this.policy = policy;
  }

  claimIntent(input: ClaimIntentInput): ClaimIntentOutput {
    const active = this.store.activeClaims(input.repo, input.branch);
    const conflicts = detectCollisions(
      { agentId: input.agentId, files: input.files, symbols: input.symbols },
      active,
    );
    const claim = this.store.createClaim({
      agentId: input.agentId,
      repo: input.repo,
      branch: input.branch,
      files: input.files,
      symbols: input.symbols,
      purpose: input.purpose,
      ...(input.etaMinutes != null ? { etaMinutes: input.etaMinutes } : {}),
    });
    // "You've got mail" rides along on every claim, so agents notice their inbox
    // without polling (MCP has no push channel).
    const unread = this.store.unreadCount(input.agentId);
    return { claimId: claim.id, conflicts, ...(unread > 0 ? { unreadMessages: unread } : {}) };
  }

  checkCollision(input: CheckCollisionInput): CheckCollisionOutput {
    const active = this.store.activeClaims(input.repo, input.branch);
    const conflicts = detectCollisions(
      {
        ...(input.agentId ? { agentId: input.agentId } : {}),
        files: input.files,
        symbols: input.symbols,
      },
      active,
    );
    return { conflicts };
  }

  heartbeat(input: HeartbeatInput): HeartbeatOutput {
    return this.store.heartbeat(input.claimId);
  }

  completeClaim(input: CompleteClaimInput): OkOutput {
    return { ok: this.store.completeClaim(input.claimId, input.commitSha) };
  }

  releaseClaim(input: ReleaseClaimInput): OkOutput {
    return { ok: this.store.releaseClaim(input.claimId) };
  }

  listClaims(input: ListClaimsInput): ListClaimsOutput {
    return { claims: this.store.listClaims(input) };
  }

  logDecision(input: LogDecisionInput): LogDecisionOutput {
    const d = this.store.logDecision(input);
    return { id: d.id };
  }

  getDecisions(input: GetDecisionsInput): GetDecisionsOutput {
    return { decisions: this.store.getDecisions(input) };
  }

  boardSnapshot(): BoardSnapshot {
    const claims = this.store.listClaims({ status: "active" });
    return {
      claims,
      conflicts: pairwiseCollisions(claims),
      messages: this.store.listMessages({ limit: 50 }),
      // Newest 100 — matches the 50-message reply window and keeps the DOM bounded.
      tasks: this.store.listTasks({ limit: 100 }),
      workers: this.store.listWorkers(WORKER_ONLINE_MS),
      rules: this.store.getDecisions({ tags: ["rule"] }).slice(0, 20),
      now: Date.now(),
    };
  }

  heartbeatWorker(input: HeartbeatWorkerInput): OkOutput {
    this.store.heartbeatWorker(input);
    return { ok: true };
  }

  sendMessage(input: SendMessageInput): SendMessageOutput {
    const msg = this.store.sendMessage(input);
    // A task message is also a lifecycle object (same id) the worker can accept/complete.
    if (input.kind === "task") {
      this.store.createTask({
        id: msg.id,
        repo: input.repo,
        fromAgentId: input.fromAgentId,
        toAgentId: input.toAgentId,
        body: input.body,
        ...(input.size ? { size: input.size } : {}),
      });
    }
    return { id: msg.id };
  }

  fetchMessages(input: FetchMessagesInput): FetchMessagesOutput {
    return { messages: this.store.fetchMessages(input) };
  }

  acceptTask(input: AcceptTaskInput): AcceptTaskOutput {
    const ok = this.store.acceptTask(input.taskId, input.agentId);
    return { ok, task: ok ? (this.store.getTask(input.taskId) ?? null) : null };
  }

  /** Optional hook fired when a task finishes (done or failed) — the HTTP transport
   * wires web push here so the delegator's phone hears the outcome. */
  onTaskCompleted?: (task: DelegatedTask) => void;

  completeTask(input: CompleteTaskInput): OkOutput {
    const ok = this.store.completeTask(input.taskId, input.agentId, {
      success: input.success,
      result: input.result,
      ...(input.commitSha ? { commitSha: input.commitSha } : {}),
      ...(input.prUrl ? { prUrl: input.prUrl } : {}),
    });
    if (ok) {
      // Close the loop on the COMMS channel so the delegator hears the outcome.
      const task = this.store.getTask(input.taskId)!;
      const outcome = input.success ? "done" : "FAILED";
      const refs = [input.commitSha, input.prUrl].filter(Boolean).join(" · ");
      this.store.sendMessage({
        fromAgentId: input.agentId,
        toAgentId: task.fromAgentId,
        repo: task.repo,
        kind: "task_update",
        body: `[${outcome}] ${input.result || task.body}${refs ? ` (${refs})` : ""}`,
        replyTo: task.id,
      });
      this.onTaskCompleted?.(task);
    }
    return { ok };
  }

  listTasks(input: ListTasksInput): ListTasksOutput {
    return { tasks: this.store.listTasks(input) };
  }

  /** Create a delegated task directly (the board's mobile send box). */
  createTask(input: CreateTaskInput): SendMessageOutput {
    return this.sendMessage({
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      repo: input.repo,
      kind: "task",
      body: input.body,
      ...(input.size ? { size: input.size } : {}),
    });
  }

  /** Optional hook fired when a worker parks a task for human approval — the HTTP
   * transport wires web push here so a phone buzzes without the board being open. */
  onApprovalRequested?: (task: DelegatedTask) => void;

  requestApproval(input: RequestApprovalInput): OkOutput {
    const ok = this.store.requestApproval(input.taskId, input.agentId);
    if (ok) this.onApprovalRequested?.(this.store.getTask(input.taskId)!);
    return { ok };
  }

  resolveApproval(input: ResolveApprovalInput): OkOutput {
    const ok = this.store.resolveApproval(input.taskId, input.approved);
    if (ok && !input.approved) {
      // Rejection is terminal (the store marks the task failed) — tell the delegator
      // instead of leaving them waiting on a task that will never run.
      const task = this.store.getTask(input.taskId)!;
      this.store.sendMessage({
        fromAgentId: task.assigneeAgentId ?? "board",
        toAgentId: task.fromAgentId,
        repo: task.repo,
        kind: "task_update",
        body: `[FAILED] rejected by a human on the board — ${task.body.slice(0, 120)}`,
        replyTo: task.id,
      });
    }
    return { ok };
  }

  nextTask(input: NextTaskInput): NextTaskOutput {
    // Sequencer reasons over all active claims regardless of branch.
    const active = this.store.listClaims({ repo: input.repo, status: "active" });
    return nextTask(this.policy, input.candidates, active, input.agentId);
  }
}
