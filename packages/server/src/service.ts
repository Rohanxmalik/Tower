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
  RecordReadsInput,
  RecordReadsOutput,
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
import type { Claim, Conflict, Decision, DelegatedTask, Message, Worker } from "@tower/shared";
import { resolveRepoKey, looksLikeForkSplit } from "@tower/shared";

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
import {
  claimRepoKey,
  detectCollisions,
  detectAntidependencies,
  pairwiseCollisions,
  type PairConflict,
} from "./engine/collision.js";

/** Most severe first, across both collision passes. */
const SEVERITY_ORDER = { info: 0, soft: 1, hard: 2 } as const;
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
    const repoKey = resolveRepoKey(input.repoId, input.repo, input.projectId);
    const active = this.store.activeClaims(repoKey);
    const scope = {
      agentId: input.agentId,
      files: input.files,
      symbols: input.symbols,
      branch: input.branch,
    };
    // The read set the caller sent, or — when it sent none — what the PostToolUse hook
    // watched this agent actually read. An agent that never learns to declare reads
    // still gets covered, which matters because agents are unreliable narrators.
    const reads = input.reads?.length ? input.reads : this.store.takeReads(input.agentId, repoKey);

    // Two passes over the same active set. The write-write pass cannot see an
    // antidependency — different file, different symbol, so it exits on its first
    // line — and the antidependency pass says nothing about overlapping writes.
    const conflicts = [
      ...detectCollisions(scope, active),
      ...detectAntidependencies({ ...scope, reads }, active),
    ].sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);

    // "You've got mail" rides along on every claim, so agents notice their inbox
    // without polling (MCP has no push channel).
    const unread = this.store.unreadCount(input.agentId);
    const mail = unread > 0 ? { unreadMessages: unread } : {};
    const split = this.forkSplitWarning(repoKey, input.repo);

    const hard = conflicts.find((c) => c.severity === "hard");
    // Counted whether or not the claim is granted — a refused claim is a collision that
    // happened, and forcing past one is the single most interesting event on the board.
    for (const c of conflicts) {
      this.store.recordConflict({
        repoKey,
        kind: c.kind,
        severity: c.severity,
        forced: Boolean(hard && input.force),
      });
    }

    if (hard && !input.force) {
      return {
        claimId: null,
        conflicts,
        blocking: true,
        recommendation: "stand_down",
        ...mail,
        ...split,
      };
    }

    const claim = this.store.createClaim({
      agentId: input.agentId,
      repo: input.repo,
      ...(input.repoId ? { repoId: input.repoId } : {}),
      // Must travel with the write, not just the lookup: a claim stored under a key the
      // reader never computes is invisible, which is the whole class of bug this fixes.
      ...(input.projectId ? { projectId: input.projectId } : {}),
      branch: input.branch,
      files: input.files,
      symbols: input.symbols,
      // Stored, not just used for the check above: heartbeat needs them to answer
      // "has anything I built on moved since?" — the case claim-time detection cannot
      // see, because at claim time nobody had touched it yet.
      ...(reads.length ? { reads } : {}),
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
      ...split,
    };
  }

  /**
   * Warn when another *active* agent is on a repo with the same name under a different
   * owner — a fork and its upstream, coordinating in separate spaces.
   *
   * Deliberately advisory, and deliberately not a partition rule: two unrelated teams
   * can both own a repo called `api`, so merging on name would be the same silent
   * failure pointed the other way. This only ever adds a sentence to the response.
   */
  private forkSplitWarning(repoKey: string, repo: string): { projectWarning?: string } {
    const others = this.store
      .listClaims({ status: "active" })
      .filter((c) => (c.repoKey ?? "") !== repoKey && looksLikeForkSplit(c.repo, repo));
    const other = others[0];
    if (!other) return {};
    return {
      projectWarning:
        `Possible fork split: ${other.agentId} is active on "${other.repo}" while you are on ` +
        `"${repo}". Same project under a different owner coordinates separately, so neither of ` +
        `you will see the other's claims. Fix it by setting "projectId: <name>" in ` +
        `.tower/policy.yaml on both machines, or by pointing both at the same remote.`,
    };
  }

  /**
   * Plan-time duplicate check (DEV-01). The waste this prevents happens *before* any
   * file exists — by the time an agent touches a claimable path the research tokens are
   * already spent, and if the two agents pick different filenames no file-level check
   * ever fires. One call per task, at the moment the agent decides what to do.
   */
  proposeIntent(input: ProposeIntentInput): ProposeIntentOutput {
    const repoKey = resolveRepoKey(input.repoId, input.repo, input.projectId);
    const cutoff = Date.now() - RECENT_INTENT_MS;
    const candidates = this.store
      .listClaims({ repo: input.repo })
      .filter((c) => (c.repoKey ?? repoKey) === repoKey)
      .filter((c) => c.status === "active" || c.createdAt >= cutoff);

    // Delegated work counts as work. A task already open or accepted is somebody's
    // stated plan just as much as a claim is — matching only against other *intents*
    // let propose_intent return "proceed" while the same job sat in the task queue.
    const taskClaims = this.store
      .listTasks({
        repo: input.repo,
        ...(input.repoId ? { repoId: input.repoId } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
      })
      .filter((t) => t.status === "open" || t.status === "accepted")
      .map((t): Claim => ({
        id: t.id,
        agentId: t.assigneeAgentId ?? t.toAgentId,
        repo: t.repo,
        branch: "",
        files: [],
        symbols: [],
        purpose: t.body,
        status: "active",
        createdAt: t.createdAt,
        expiresAt: t.updatedAt,
      }));

    const matches = matchIntent(input.purpose, [...candidates, ...taskClaims], {
      agentId: input.agentId,
    });
    return {
      matches,
      duplicate: matches.length > 0,
      recommendation: matches.length > 0 ? "stand_down" : "proceed",
    };
  }

  checkCollision(input: CheckCollisionInput): CheckCollisionOutput {
    const active = this.store.activeClaims(
      resolveRepoKey(input.repoId, input.repo, input.projectId),
    );
    const scope = {
      ...(input.agentId ? { agentId: input.agentId } : {}),
      files: input.files,
      symbols: input.symbols,
      branch: input.branch,
    };
    // `guard` runs this before claiming, so it has to see antidependencies too —
    // otherwise the enforcement path is blind to exactly the case the claim path warns
    // about, and a hook would wave through the edit a claim would have flagged.
    const conflicts = [
      ...detectCollisions(scope, active),
      ...detectAntidependencies(
        { ...scope, ...(input.reads ? { reads: input.reads } : {}) },
        active,
      ),
    ].sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);
    return { conflicts };
  }

  /** Record what an agent read, so its next claim carries a read set it never had to
   * remember. Fed by the PostToolUse hook watching Read. */
  recordReads(input: RecordReadsInput): RecordReadsOutput {
    const repoKey = resolveRepoKey(input.repoId, input.repo, input.projectId);
    const named = input.reads.filter((r) => r.symbol !== "");
    this.store.recordReads(input.agentId, repoKey, named);
    return { ok: true, recorded: named.length };
  }

  /**
   * Keep a claim alive, and answer the question the claim could not: has anything this
   * work was built on moved since?
   *
   * Detection at claim time only sees claims already open. When this agent claimed
   * first and someone changed a declaration afterwards, nothing would ever have told
   * it. Heartbeat is the one call an agent already makes on a timer, so the answer
   * rides along — no push channel required, no polling, no extra tokens.
   */
  heartbeat(input: HeartbeatInput): HeartbeatOutput {
    const beat = { ...this.store.heartbeat(input.claimId), invalidations: [] as Conflict[] };
    const claim = this.store.getClaim(input.claimId);
    if (!beat.ok || !claim || !claim.reads?.length) return beat;

    const repoKey = claimRepoKey(claim);
    const invalidations = detectAntidependencies(
      {
        agentId: claim.agentId,
        files: claim.files,
        symbols: claim.symbols,
        reads: claim.reads,
        branch: claim.branch,
      },
      this.store.activeClaims(repoKey),
    ).filter((c) => c.severity === "hard"); // only report a contract that actually moved

    return invalidations.length ? { ...beat, invalidations } : beat;
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
    // Sequencer reasons over all active claims regardless of branch. Identity has to
    // travel with the lookup: a claim registered with a repoId is invisible to a query
    // that only knows the repo string.
    const active = this.store.listClaims({
      repo: input.repo,
      ...(input.repoId ? { repoId: input.repoId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      status: "active",
    });
    return nextTask(this.policy, input.candidates, active, input.agentId);
  }
}
