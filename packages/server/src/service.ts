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
  PendingInput,
  PendingOutput,
  ProposeIntentInput,
  ProposeIntentOutput,
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
import { resolveRepoKey } from "@tower/shared";

/**
 * "Actively doing something." Short on purpose — it answers a different question from
 * "is this agent still here", which is {@link WORKER_CONNECTED_MS}.
 */
export const WORKER_ONLINE_MS = 30_000;

/**
 * "Still here." A session that made a tool call two minutes ago is plainly still
 * present; a 30-second window made the board report zero agents in the middle of active
 * multi-agent work, which was the single most misleading thing on it.
 */
export const WORKER_CONNECTED_MS = 15 * 60 * 1000;

/** Work completed inside this window still counts as done — redoing it is the same
 * waste as doing it in parallel. */
export const RECENT_INTENT_MS = 6 * 60 * 60 * 1000;
import { TowerStore } from "./store/sqlite.js";
import { detectCollisions, pairwiseCollisions, type PairConflict } from "./engine/collision.js";
import { matchIntent } from "./engine/intent.js";
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
 * sequencer into the eighteen operations exposed over MCP. Kept free of MCP/HTTP so
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

  /**
   * Register an edit intent — and **refuse it** on a hard conflict unless forced.
   *
   * Before 0.9.0 this returned conflicts and registered the claim anyway, which made
   * severity decorative: an agent that ignored the response behaved exactly like one
   * that never checked. Now a hard conflict is a real stop, and forcing past it is
   * recorded so the board can show who did.
   */
  claimIntent(input: ClaimIntentInput): ClaimIntentOutput {
    const repoKey = resolveRepoKey(input.repoId, input.repo);
    const active = this.store.activeClaims(repoKey);
    const conflicts = detectCollisions(
      {
        agentId: input.agentId,
        files: input.files,
        symbols: input.symbols,
        branch: input.branch,
      },
      active,
    );

    // "You've got mail" rides along on every claim, so agents notice their inbox
    // without polling (MCP has no push channel).
    const unread = this.store.unreadCount(input.agentId);
    const mail = unread > 0 ? { unreadMessages: unread } : {};

    const hard = conflicts.find((c) => c.severity === "hard");
    if (hard && !input.force) {
      return {
        claimId: null,
        conflicts,
        blocking: true,
        recommendation: "stand_down",
        ...mail,
      };
    }

    const claim = this.store.createClaim({
      agentId: input.agentId,
      repo: input.repo,
      ...(input.repoId ? { repoId: input.repoId } : {}),
      branch: input.branch,
      files: input.files,
      symbols: input.symbols,
      purpose: input.purpose,
      ...(input.etaMinutes != null ? { etaMinutes: input.etaMinutes } : {}),
      ...(hard && input.force ? { forced: true } : {}),
    });
    return {
      claimId: claim.id,
      conflicts,
      blocking: false,
      recommendation: "proceed",
      ...mail,
    };
  }

  /**
   * Plan-time duplicate check (DEV-01). The waste this prevents happens *before* any
   * file exists — by the time an agent touches a claimable path the research tokens are
   * already spent, and if the two agents pick different filenames no file-level check
   * ever fires. One call per task, at the moment the agent decides what to do.
   */
  proposeIntent(input: ProposeIntentInput): ProposeIntentOutput {
    const repoKey = resolveRepoKey(input.repoId, input.repo);
    const cutoff = Date.now() - RECENT_INTENT_MS;
    const candidates = this.store
      .listClaims({ repo: input.repo })
      .filter((c) => (c.repoKey ?? repoKey) === repoKey)
      .filter((c) => c.status === "active" || c.createdAt >= cutoff);

    const matches = matchIntent(input.purpose, candidates, { agentId: input.agentId });
    return {
      matches,
      duplicate: matches.length > 0,
      recommendation: matches.length > 0 ? "stand_down" : "proceed",
    };
  }

  checkCollision(input: CheckCollisionInput): CheckCollisionOutput {
    const active = this.store.activeClaims(resolveRepoKey(input.repoId, input.repo));
    const conflicts = detectCollisions(
      {
        ...(input.agentId ? { agentId: input.agentId } : {}),
        files: input.files,
        symbols: input.symbols,
        branch: input.branch,
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
      workers: this.store.listWorkers(WORKER_CONNECTED_MS, WORKER_ONLINE_MS),
      rules: this.store.getDecisions({ tags: ["rule"] }).slice(0, 20),
      now: Date.now(),
    };
  }

  heartbeatWorker(input: HeartbeatWorkerInput): OkOutput {
    this.store.heartbeatWorker(input);
    // A live heartbeat is proof the owner is alive, so its claims should not lapse
    // underneath it (TWR-11).
    this.store.touchClaimsFor(input.agentId);
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

  /** Read-only count of what's waiting for an agent: unread messages + open tasks
   * addressed to it (or "*"). Marks nothing read — this is the interactive nudge. */
  pending(input: PendingInput): PendingOutput {
    const unreadMessages = this.store.unreadCount(input.agentId);
    const openTasks = this.store.listTasks({
      ...(input.repo ? { repo: input.repo } : {}),
      forAgentId: input.agentId,
      status: "open",
    }).length;
    return { unreadMessages, openTasks };
  }

  acceptTask(input: AcceptTaskInput): AcceptTaskOutput {
    const result = this.store.acceptTask(input.taskId, input.agentId);
    if (!result.ok) {
      return { ok: false, task: null, ...(result.reason ? { reason: result.reason } : {}) };
    }
    const id = this.store.resolveTaskId(input.taskId) ?? input.taskId;
    return { ok: true, task: this.store.getTask(id) ?? null };
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
      ...(input.filesChanged != null ? { filesChanged: input.filesChanged } : {}),
    });
    if (ok) {
      // Close the loop on the COMMS channel so the delegator hears the outcome.
      const task = this.store.getTask(input.taskId)!;
      // A "done" run that changed nothing isn't really a success — call it out so the
      // delegator doesn't read a green update as "work landed".
      const outcome = !input.success
        ? "FAILED"
        : input.filesChanged === 0
          ? "done · no changes"
          : "done";
      const refs = [input.commitSha, input.prUrl].filter(Boolean).join(" · ");
      const files =
        input.filesChanged != null && input.filesChanged > 0
          ? ` · ${input.filesChanged} file${input.filesChanged === 1 ? "" : "s"} changed`
          : "";
      this.store.sendMessage({
        fromAgentId: input.agentId,
        toAgentId: task.fromAgentId,
        repo: task.repo,
        kind: "task_update",
        body: `[${outcome}] ${input.result || task.body}${refs ? ` (${refs})` : ""}${files}`,
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
