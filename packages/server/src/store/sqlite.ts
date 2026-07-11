import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// Load node:sqlite via createRequire so bundlers (vite/vitest) don't try to
// resolve the newer builtin at transform time.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
import type {
  Claim,
  ClaimStatus,
  Decision,
  ApprovalState,
  DelegatedTask,
  ListClaimsInput,
  GetDecisionsInput,
  Message,
  MessageKind,
  SymbolRef,
  TaskStatus,
  Worker,
} from "@tower/shared";

/** Default time-to-live for a claim before it auto-expires (ms). Refreshed by heartbeat. */
export const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** Default retention window for `prune()`: rows older than this get deleted (ms). */
export const DEFAULT_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum gap between opportunistic prunes triggered by `sweepExpired()` (ms). */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const DDL = `
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, agentId TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL,
  files TEXT NOT NULL, symbols TEXT NOT NULL, purpose TEXT NOT NULL, status TEXT NOT NULL,
  etaMinutes INTEGER, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, commitSha TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_scope ON claims (repo, branch, status);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL,
  tags TEXT NOT NULL, relatedFiles TEXT NOT NULL, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, fromAgentId TEXT NOT NULL, toAgentId TEXT NOT NULL,
  kind TEXT NOT NULL, body TEXT NOT NULL, replyTo TEXT, createdAt INTEGER NOT NULL,
  readAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages (toAgentId, readAt);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, fromAgentId TEXT NOT NULL, toAgentId TEXT NOT NULL,
  body TEXT NOT NULL, status TEXT NOT NULL, assigneeAgentId TEXT, approval TEXT, commitSha TEXT, prUrl TEXT,
  result TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status, toAgentId);
CREATE TABLE IF NOT EXISTS message_reads (
  messageId TEXT NOT NULL, agentId TEXT NOT NULL, readAt INTEGER NOT NULL,
  PRIMARY KEY (messageId, agentId)
);
CREATE TABLE IF NOT EXISTS workers (
  agentId TEXT NOT NULL, repo TEXT NOT NULL, runner TEXT NOT NULL, lastSeen INTEGER NOT NULL,
  PRIMARY KEY (agentId, repo)
);
`;

export interface StoreOptions {
  /** File path, or ":memory:" (default) for an ephemeral DB. */
  path?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Claim TTL in ms. */
  ttlMs?: number;
}

export interface NewClaim {
  agentId: string;
  repo: string;
  branch: string;
  files: string[];
  symbols: SymbolRef[];
  purpose: string;
  etaMinutes?: number;
}

interface ClaimRow {
  id: string;
  agentId: string;
  repo: string;
  branch: string;
  files: string;
  symbols: string;
  purpose: string;
  status: string;
  etaMinutes: number | null;
  createdAt: number;
  expiresAt: number;
  commitSha: string | null;
}

// NOTE: the legacy `messages.readAt` column still exists in the schema for
// compatibility with old DB files, but read state now lives in `message_reads`
// (per-agent), so the column is neither read nor written anymore.
interface MessageRow {
  id: string;
  repo: string;
  fromAgentId: string;
  toAgentId: string;
  kind: string;
  body: string;
  replyTo: string | null;
  createdAt: number;
}

function rowToMessage(r: MessageRow): Message {
  return {
    id: r.id,
    repo: r.repo,
    fromAgentId: r.fromAgentId,
    toAgentId: r.toAgentId,
    kind: r.kind as MessageKind,
    body: r.body,
    ...(r.replyTo != null ? { replyTo: r.replyTo } : {}),
    createdAt: r.createdAt,
  };
}

interface TaskRow {
  id: string;
  repo: string;
  fromAgentId: string;
  toAgentId: string;
  body: string;
  status: string;
  assigneeAgentId: string | null;
  approval: string | null;
  commitSha: string | null;
  prUrl: string | null;
  result: string | null;
  createdAt: number;
  updatedAt: number;
}

function rowToTask(r: TaskRow): DelegatedTask {
  return {
    id: r.id,
    repo: r.repo,
    fromAgentId: r.fromAgentId,
    toAgentId: r.toAgentId,
    body: r.body,
    status: r.status as TaskStatus,
    ...(r.assigneeAgentId != null ? { assigneeAgentId: r.assigneeAgentId } : {}),
    ...(r.approval != null ? { approval: r.approval as ApprovalState } : {}),
    ...(r.commitSha != null ? { commitSha: r.commitSha } : {}),
    ...(r.prUrl != null ? { prUrl: r.prUrl } : {}),
    ...(r.result != null ? { result: r.result } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

interface DecisionRow {
  id: string;
  title: string;
  body: string;
  author: string;
  tags: string;
  relatedFiles: string;
  createdAt: number;
}

function rowToClaim(r: ClaimRow): Claim {
  return {
    id: r.id,
    agentId: r.agentId,
    repo: r.repo,
    branch: r.branch,
    files: JSON.parse(r.files) as string[],
    symbols: JSON.parse(r.symbols) as SymbolRef[],
    purpose: r.purpose,
    status: r.status as ClaimStatus,
    ...(r.etaMinutes != null ? { etaMinutes: r.etaMinutes } : {}),
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    ...(r.commitSha != null ? { commitSha: r.commitSha } : {}),
  };
}

function rowToDecision(r: DecisionRow): Decision {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    author: r.author,
    tags: JSON.parse(r.tags) as string[],
    relatedFiles: JSON.parse(r.relatedFiles) as string[],
    createdAt: r.createdAt,
  };
}

/**
 * Synchronous SQLite-backed store for claims and decisions. Uses Node's built-in
 * `node:sqlite` so there is no native module to compile — `npx tower serve` just works.
 */
export class TowerStore {
  private readonly db: DatabaseSyncType;
  private readonly now: () => number;
  private readonly ttlMs: number;
  /** Clock time of the last opportunistic prune run by sweepExpired(). */
  private lastPruneAt = 0;

  constructor(opts: StoreOptions = {}) {
    this.db = new DatabaseSync(opts.path ?? ":memory:");
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.db.exec(DDL);
  }

  // -- claims ---------------------------------------------------------------

  createClaim(input: NewClaim): Claim {
    const createdAt = this.now();
    const claim: Claim = {
      id: randomUUID(),
      agentId: input.agentId,
      repo: input.repo,
      branch: input.branch,
      files: input.files,
      symbols: input.symbols,
      purpose: input.purpose,
      status: "active",
      ...(input.etaMinutes != null ? { etaMinutes: input.etaMinutes } : {}),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.db
      .prepare(
        `INSERT INTO claims (id,agentId,repo,branch,files,symbols,purpose,status,etaMinutes,createdAt,expiresAt,commitSha)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        claim.id,
        claim.agentId,
        claim.repo,
        claim.branch,
        JSON.stringify(claim.files),
        JSON.stringify(claim.symbols),
        claim.purpose,
        claim.status,
        claim.etaMinutes ?? null,
        claim.createdAt,
        claim.expiresAt,
        null,
      );
    return claim;
  }

  getClaim(id: string): Claim | undefined {
    const row = this.db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id) as unknown as
      ClaimRow | undefined;
    return row ? rowToClaim(row) : undefined;
  }

  /**
   * Marks any active claim whose TTL has elapsed as expired. Returns count swept.
   * Also prunes stale rows opportunistically, at most once per hour (see {@link prune}).
   */
  sweepExpired(): number {
    const now = this.now();
    const res = this.db
      .prepare(`UPDATE claims SET status = 'expired' WHERE status = 'active' AND expiresAt < ?`)
      .run(now);
    if (now - this.lastPruneAt >= PRUNE_INTERVAL_MS) {
      this.lastPruneAt = now;
      this.prune();
    }
    return Number(res.changes);
  }

  /**
   * Deletes stale rows so long-running servers don't accumulate history forever:
   * - claims: finished ones (status != 'active') created before the cutoff — an
   *   old but still-active claim is never pruned;
   * - messages: ALL messages created before the cutoff, regardless of read state.
   *   Deliberate simplification: after the retention window a message has no
   *   inbox or board value, so age alone decides;
   * - message_reads: receipts whose message no longer exists.
   *
   * Cutoff is `now - olderThanMs` (default {@link DEFAULT_PRUNE_MS}, 7 days).
   * Returns how many claims and messages were deleted.
   */
  prune(opts: { olderThanMs?: number } = {}): { claims: number; messages: number } {
    const cutoff = this.now() - (opts.olderThanMs ?? DEFAULT_PRUNE_MS);
    const claims = this.db
      .prepare(`DELETE FROM claims WHERE status != 'active' AND createdAt < ?`)
      .run(cutoff);
    const messages = this.db.prepare(`DELETE FROM messages WHERE createdAt < ?`).run(cutoff);
    this.db
      .prepare(`DELETE FROM message_reads WHERE messageId NOT IN (SELECT id FROM messages)`)
      .run();
    // Finished tasks age out; open/accepted work is never dropped.
    this.db
      .prepare(`DELETE FROM tasks WHERE status IN ('done','failed') AND createdAt < ?`)
      .run(cutoff);
    return { claims: Number(claims.changes), messages: Number(messages.changes) };
  }

  /** Active, non-expired claims in a repo/branch scope (sweeps first). */
  activeClaims(repo: string, branch: string): Claim[] {
    this.sweepExpired();
    const rows = this.db
      .prepare(`SELECT * FROM claims WHERE repo = ? AND branch = ? AND status = 'active'`)
      .all(repo, branch) as unknown as ClaimRow[];
    return rows.map(rowToClaim);
  }

  listClaims(filter: ListClaimsInput = {}): Claim[] {
    this.sweepExpired();
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.repo) {
      clauses.push("repo = ?");
      params.push(filter.repo);
    }
    if (filter.branch) {
      clauses.push("branch = ?");
      params.push(filter.branch);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM claims ${where} ORDER BY createdAt DESC`)
      .all(...params) as unknown as ClaimRow[];
    return rows.map(rowToClaim);
  }

  heartbeat(id: string): { ok: boolean; expiresAt: number } {
    const claim = this.getClaim(id);
    if (!claim || claim.status !== "active") return { ok: false, expiresAt: 0 };
    const expiresAt = this.now() + this.ttlMs;
    this.db.prepare(`UPDATE claims SET expiresAt = ? WHERE id = ?`).run(expiresAt, id);
    return { ok: true, expiresAt };
  }

  completeClaim(id: string, commitSha?: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE claims SET status = 'completed', commitSha = ? WHERE id = ? AND status = 'active'`,
      )
      .run(commitSha ?? null, id);
    return Number(res.changes) > 0;
  }

  releaseClaim(id: string): boolean {
    const res = this.db
      .prepare(`UPDATE claims SET status = 'released' WHERE id = ? AND status = 'active'`)
      .run(id);
    return Number(res.changes) > 0;
  }

  // -- messages (agent inbox) -------------------------------------------------

  sendMessage(input: {
    fromAgentId: string;
    toAgentId: string;
    repo: string;
    kind: MessageKind;
    body: string;
    replyTo?: string;
  }): Message {
    const msg: Message = {
      id: randomUUID(),
      repo: input.repo,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      kind: input.kind,
      body: input.body,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      createdAt: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id,repo,fromAgentId,toAgentId,kind,body,replyTo,createdAt)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        msg.id,
        msg.repo,
        msg.fromAgentId,
        msg.toAgentId,
        msg.kind,
        msg.body,
        msg.replyTo ?? null,
        msg.createdAt,
      );
    return msg;
  }

  /**
   * Unread messages addressed to the agent (directly or broadcast), excluding their own.
   * Read state is per-agent (message_reads), so a broadcast stays unread for each
   * teammate until they fetch it themselves.
   */
  unreadCount(agentId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m
         WHERE m.fromAgentId != ? AND (m.toAgentId = ? OR m.toAgentId = '*')
           AND NOT EXISTS (
             SELECT 1 FROM message_reads r WHERE r.messageId = m.id AND r.agentId = ?
           )`,
      )
      .get(agentId, agentId, agentId) as unknown as { n: number };
    return Number(row.n);
  }

  /**
   * The agent's inbox. `unreadOnly` (default) also marks the fetched messages read —
   * for this agent only, via a message_reads receipt — so a broadcast ("*") remains
   * unread for every other teammate until they fetch it too.
   */
  fetchMessages(filter: { agentId: string; repo?: string; unreadOnly?: boolean }): Message[] {
    const unreadOnly = filter.unreadOnly ?? true;
    const clauses = [`fromAgentId != ?`, `(toAgentId = ? OR toAgentId = '*')`];
    const params: (string | number)[] = [filter.agentId, filter.agentId];
    if (unreadOnly) {
      clauses.push(
        `NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.messageId = messages.id AND r.agentId = ?)`,
      );
      params.push(filter.agentId);
    }
    if (filter.repo) {
      clauses.push("repo = ?");
      params.push(filter.repo);
    }
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE ${clauses.join(" AND ")} ORDER BY createdAt ASC`)
      .all(...params) as unknown as MessageRow[];
    const messages = rows.map(rowToMessage);
    if (unreadOnly && messages.length) {
      const readAt = this.now();
      const mark = this.db.prepare(
        `INSERT OR IGNORE INTO message_reads (messageId, agentId, readAt) VALUES (?,?,?)`,
      );
      for (const m of messages) mark.run(m.id, filter.agentId, readAt);
    }
    return messages;
  }

  /** Recent messages across all agents, newest first — the board's comms feed. */
  listMessages(filter: { repo?: string; limit?: number } = {}): Message[] {
    const limit = filter.limit ?? 50;
    const rows = (filter.repo
      ? this.db
          .prepare(`SELECT * FROM messages WHERE repo = ? ORDER BY createdAt DESC LIMIT ?`)
          .all(filter.repo, limit)
      : this.db
          .prepare(`SELECT * FROM messages ORDER BY createdAt DESC LIMIT ?`)
          .all(limit)) as unknown as MessageRow[];
    return rows.map(rowToMessage);
  }

  // -- delegated tasks (lifecycle: open → accepted → done | failed) ----------

  createTask(input: {
    id: string;
    repo: string;
    fromAgentId: string;
    toAgentId: string;
    body: string;
  }): DelegatedTask {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO tasks (id,repo,fromAgentId,toAgentId,body,status,assigneeAgentId,approval,commitSha,prUrl,result,createdAt,updatedAt)
         VALUES (?,?,?,?,?,'open',NULL,NULL,NULL,NULL,NULL,?,?)`,
      )
      .run(input.id, input.repo, input.fromAgentId, input.toAgentId, input.body, now, now);
    return this.getTask(input.id)!;
  }

  getTask(id: string): DelegatedTask | undefined {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as unknown as
      TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  /** First accept wins: only an `open` task can be accepted, atomically. */
  acceptTask(id: string, agentId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE tasks SET status = 'accepted', assigneeAgentId = ?, updatedAt = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(agentId, this.now(), id);
    return Number(res.changes) > 0;
  }

  /** Park an open task for human approval (remote-approve worker mode). */
  requestApproval(id: string, agentId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE tasks SET approval = 'pending', assigneeAgentId = ?, updatedAt = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(agentId, this.now(), id);
    return Number(res.changes) > 0;
  }

  /** A human approves or rejects a pending task (from the board / mobile). */
  resolveApproval(id: string, approved: boolean): boolean {
    const res = this.db
      .prepare(`UPDATE tasks SET approval = ?, updatedAt = ? WHERE id = ? AND approval = 'pending'`)
      .run(approved ? "approved" : "rejected", this.now(), id);
    return Number(res.changes) > 0;
  }

  /** Only the assignee can finish its accepted task. */
  completeTask(
    id: string,
    agentId: string,
    outcome: { success: boolean; result: string; commitSha?: string; prUrl?: string },
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE tasks SET status = ?, result = ?, commitSha = ?, prUrl = ?, updatedAt = ?
         WHERE id = ? AND status = 'accepted' AND assigneeAgentId = ?`,
      )
      .run(
        outcome.success ? "done" : "failed",
        outcome.result,
        outcome.commitSha ?? null,
        outcome.prUrl ?? null,
        this.now(),
        id,
        agentId,
      );
    return Number(res.changes) > 0;
  }

  listTasks(
    filter: {
      repo?: string;
      status?: TaskStatus;
      /** Tasks addressed to this agent, including "*" broadcasts. */
      forAgentId?: string;
      assigneeAgentId?: string;
    } = {},
  ): DelegatedTask[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.repo) {
      clauses.push("repo = ?");
      params.push(filter.repo);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.forAgentId) {
      clauses.push("(toAgentId = ? OR toAgentId = '*')");
      params.push(filter.forAgentId);
    }
    if (filter.assigneeAgentId) {
      clauses.push("assigneeAgentId = ?");
      params.push(filter.assigneeAgentId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY createdAt DESC`)
      .all(...params) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  // -- worker presence ------------------------------------------------------

  /** Record that a worker is alive (upsert on agentId+repo). */
  heartbeatWorker(input: { agentId: string; repo: string; runner: string }): void {
    this.db
      .prepare(
        `INSERT INTO workers (agentId,repo,runner,lastSeen) VALUES (?,?,?,?)
         ON CONFLICT(agentId,repo) DO UPDATE SET runner=excluded.runner, lastSeen=excluded.lastSeen`,
      )
      .run(input.agentId, input.repo, input.runner, this.now());
  }

  /** Workers seen within `windowMs` (online), newest first. */
  listWorkers(windowMs: number): Worker[] {
    const cutoff = this.now() - windowMs;
    const rows = this.db
      .prepare(`SELECT * FROM workers WHERE lastSeen >= ? ORDER BY lastSeen DESC`)
      .all(cutoff) as unknown as Worker[];
    return rows.map((r) => ({
      agentId: r.agentId,
      repo: r.repo,
      runner: r.runner,
      lastSeen: r.lastSeen,
    }));
  }

  // -- decisions ------------------------------------------------------------

  logDecision(input: {
    title: string;
    body: string;
    author: string;
    tags: string[];
    relatedFiles: string[];
  }): Decision {
    const decision: Decision = {
      id: randomUUID(),
      title: input.title,
      body: input.body,
      author: input.author,
      tags: input.tags,
      relatedFiles: input.relatedFiles,
      createdAt: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO decisions (id,title,body,author,tags,relatedFiles,createdAt) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        decision.id,
        decision.title,
        decision.body,
        decision.author,
        JSON.stringify(decision.tags),
        JSON.stringify(decision.relatedFiles),
        decision.createdAt,
      );
    return decision;
  }

  getDecisions(filter: GetDecisionsInput = {}): Decision[] {
    const rows = this.db
      .prepare(`SELECT * FROM decisions ORDER BY createdAt DESC`)
      .all() as unknown as DecisionRow[];
    let decisions = rows.map(rowToDecision);
    if (filter.query) {
      const q = filter.query.toLowerCase();
      decisions = decisions.filter(
        (d) => d.title.toLowerCase().includes(q) || d.body.toLowerCase().includes(q),
      );
    }
    if (filter.tags && filter.tags.length) {
      decisions = decisions.filter((d) => filter.tags!.some((t) => d.tags.includes(t)));
    }
    if (filter.relatedFiles && filter.relatedFiles.length) {
      decisions = decisions.filter((d) =>
        filter.relatedFiles!.some((f) => d.relatedFiles.includes(f)),
      );
    }
    return decisions;
  }

  close(): void {
    this.db.close();
  }
}
