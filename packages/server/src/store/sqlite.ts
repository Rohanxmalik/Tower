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
  ConflictKind,
  Severity,
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
  AcceptFailure,
} from "@tower/shared";
import { normalizeRepoUrl, resolveRepoKey } from "@tower/shared";
import { releaseNotice, type ReleaseKind } from "../engine/notices.js";

/** Default time-to-live for a claim before it auto-expires (ms). Refreshed by heartbeat. */
export const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** Default retention window for `prune()`: rows older than this get deleted (ms). */
export const DEFAULT_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum gap between opportunistic prunes triggered by `sweepExpired()` (ms). */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const DDL = `
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, agentId TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL,
  repoId TEXT, repoKey TEXT,
  files TEXT NOT NULL, symbols TEXT NOT NULL, purpose TEXT NOT NULL, status TEXT NOT NULL,
  etaMinutes INTEGER, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, commitSha TEXT,
  forced INTEGER
);
-- Claims are looked up by repoKey + status; branch is deliberately NOT in the key, so
-- agents on different branches still see each other (they still produce one merge).
CREATE INDEX IF NOT EXISTS idx_claims_scope ON claims (repoKey, status);
-- Every collision Tower reports, as counts only. No file names, no symbol names, no
-- code — nothing that could leak a private repo's shape if this file were shared.
-- Exists because Tower detected collisions for four versions and forgot every one, so
-- "how often does this actually happen, and which kind" had no answer.
CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY, repoKey TEXT, kind TEXT NOT NULL, severity TEXT NOT NULL,
  forced INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conflicts_scope ON conflicts (repoKey, createdAt);
-- What an agent read, recorded by the PostToolUse hook as it reads. Consumed by the
-- next claim_intent from that agent, so a read set costs the agent no extra call and
-- no extra tokens — it never has to remember what it looked at.
CREATE TABLE IF NOT EXISTS reads (
  id TEXT PRIMARY KEY, agentId TEXT NOT NULL, repoKey TEXT, file TEXT NOT NULL,
  symbol TEXT NOT NULL, sig TEXT, sigText TEXT, createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reads_agent ON reads (agentId, repoKey);
-- Agents refused by a claim, told when it stops blocking them. Before 0.12.0 a refused
-- agent learned nothing until it retried, so "wait" meant "poll". Rows are transient:
-- deleted the moment the notice is sent. Keyed per (agent, claim) so a retry storm
-- still produces one message.
CREATE TABLE IF NOT EXISTS waiters (
  agentId TEXT NOT NULL, claimId TEXT NOT NULL, repo TEXT NOT NULL, repoKey TEXT,
  createdAt INTEGER NOT NULL, PRIMARY KEY (agentId, claimId)
);
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
  body TEXT NOT NULL, status TEXT NOT NULL, assigneeAgentId TEXT, approval TEXT, size TEXT,
  commitSha TEXT, prUrl TEXT,
  result TEXT, filesChanged INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status, toAgentId);
CREATE TABLE IF NOT EXISTS message_reads (
  messageId TEXT NOT NULL, agentId TEXT NOT NULL, readAt INTEGER NOT NULL,
  PRIMARY KEY (messageId, agentId)
);
CREATE TABLE IF NOT EXISTS workers (
  agentId TEXT NOT NULL, repo TEXT NOT NULL, runner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok', lastSeen INTEGER NOT NULL,
  PRIMARY KEY (agentId, repo)
);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY, sub TEXT NOT NULL, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY, v TEXT NOT NULL
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

/** Identity every repo-scoped write carries, resolved through `resolveRepoKey`. */
export interface RepoScope {
  repo: string;
  /** Root commit sha — identical across clones and forks. */
  repoId?: string;
  /** Hand-set team override from `.tower/policy.yaml`; beats `repoId`. */
  projectId?: string;
}

export interface NewClaim {
  /** Declarations this work was written against, as read. */
  reads?: SymbolRef[];
  agentId: string;
  repo: string;
  /** Root commit sha, when the caller could derive one. */
  repoId?: string;
  branch: string;
  files: string[];
  symbols: SymbolRef[];
  purpose: string;
  etaMinutes?: number;
  /** Hand-set team override from `.tower/policy.yaml`; beats `repoId`. */
  projectId?: string;
  /** Registered despite a hard conflict, via `force`. */
  forced?: boolean;
}

interface ClaimRow {
  id: string;
  agentId: string;
  repo: string;
  repoId: string | null;
  repoKey: string | null;
  branch: string;
  files: string;
  symbols: string;
  reads: string | null;
  purpose: string;
  status: string;
  etaMinutes: number | null;
  createdAt: number;
  expiresAt: number;
  commitSha: string | null;
  forced: number | null;
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
  size: string | null;
  commitSha: string | null;
  prUrl: string | null;
  result: string | null;
  filesChanged: number | null;
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
    ...(r.size != null ? { size: r.size as DelegatedTask["size"] } : {}),
    ...(r.commitSha != null ? { commitSha: r.commitSha } : {}),
    ...(r.prUrl != null ? { prUrl: r.prUrl } : {}),
    ...(r.result != null ? { result: r.result } : {}),
    ...(r.filesChanged != null ? { filesChanged: r.filesChanged } : {}),
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
    ...(r.repoId != null ? { repoId: r.repoId } : {}),
    ...(r.repoKey != null ? { repoKey: r.repoKey } : {}),
    branch: r.branch,
    files: JSON.parse(r.files) as string[],
    symbols: JSON.parse(r.symbols) as SymbolRef[],
    ...(r.reads ? { reads: JSON.parse(r.reads) as SymbolRef[] } : {}),
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
    this.migrate();
  }

  /** In-place upgrades for DB files created by older versions (CREATE TABLE IF NOT
   * EXISTS never touches an existing table, so new columns must be ALTERed in). */
  private migrate(): void {
    const addColumn = (table: string, column: string, ddl: string): void => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
        name: string;
      }[];
      if (cols.length > 0 && !cols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      }
    };
    addColumn("tasks", "approval", "approval TEXT"); // 0.5.0 → 0.6.x
    addColumn("tasks", "size", "size TEXT"); // 0.6.x → 0.7.0
    addColumn("workers", "status", "status TEXT NOT NULL DEFAULT 'ok'"); // 0.6.x → 0.7.0
    addColumn("tasks", "filesChanged", "filesChanged INTEGER"); // 0.7.1 → 0.8.0
    // 0.8.0 → 0.9.0 — repository identity. repoKey is the partition claims are compared
    // on; repoId is the fork-proof root commit when the caller supplied one.
    addColumn("claims", "repoId", "repoId TEXT");
    addColumn("claims", "repoKey", "repoKey TEXT");
    addColumn("claims", "forced", "forced INTEGER");
    // 0.9.0 partitioned claims but left messages, tasks, workers and decisions keyed
    // on the raw repo string — so a fork split coordination in half even when claims
    // matched. Every repo-scoped table now carries the same key. (0.10.0)
    for (const table of ["messages", "tasks", "workers", "decisions"]) {
      addColumn(table, "repoKey", "repoKey TEXT");
    }
    addColumn("decisions", "repo", "repo TEXT");
    // 0.10.x → version-aware claims: what an agent read, and what it was written
    // against, so a moved declaration can be reported to the reader.
    addColumn("claims", "reads", "reads TEXT");
    this.backfillRepoKeys();
  }

  /**
   * Give rows written before their table had a repoKey one now, so history partitions
   * alongside new writes instead of becoming invisible. Uses the same normalizer every
   * other path uses. Decisions predate repo scoping entirely and may have no repo at
   * all — those stay global, which is what they were.
   */
  private backfillRepoKeys(): void {
    for (const table of ["claims", "messages", "tasks", "workers", "decisions"]) {
      const hasRepo = (
        this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
      ).some((c) => c.name === "repo");
      if (!hasRepo) continue;
      const rows = this.db
        .prepare(
          `SELECT rowid AS rid, repo FROM ${table} WHERE repoKey IS NULL AND repo IS NOT NULL`,
        )
        .all() as unknown as { rid: number; repo: string }[];
      if (rows.length === 0) continue;
      const update = this.db.prepare(`UPDATE ${table} SET repoKey = ? WHERE rowid = ?`);
      for (const row of rows) update.run(normalizeRepoUrl(row.repo), row.rid);
    }
  }

  // -- claims ---------------------------------------------------------------

  createClaim(input: NewClaim): Claim {
    const createdAt = this.now();
    const claim: Claim = {
      id: randomUUID(),
      agentId: input.agentId,
      repo: input.repo,
      ...(input.repoId ? { repoId: input.repoId } : {}),
      repoKey: resolveRepoKey(input.repoId, input.repo, input.projectId),
      branch: input.branch,
      files: input.files,
      symbols: input.symbols,
      ...(input.reads?.length ? { reads: input.reads } : {}),
      purpose: input.purpose,
      status: "active",
      ...(input.etaMinutes != null ? { etaMinutes: input.etaMinutes } : {}),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.db
      .prepare(
        `INSERT INTO claims (id,agentId,repo,repoId,repoKey,branch,files,symbols,reads,purpose,status,etaMinutes,createdAt,expiresAt,commitSha,forced)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        claim.id,
        claim.agentId,
        claim.repo,
        claim.repoId ?? null,
        claim.repoKey ?? null,
        claim.branch,
        JSON.stringify(claim.files),
        JSON.stringify(claim.symbols),
        claim.reads ? JSON.stringify(claim.reads) : null,
        claim.purpose,
        claim.status,
        claim.etaMinutes ?? null,
        claim.createdAt,
        claim.expiresAt,
        null,
        input.forced ? 1 : null,
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
    // Collected before the update so their waiters can be told. Expiry is the release
    // nobody calls anything for, which is exactly why it has to notify from here.
    const expiring = (
      this.db
        .prepare(`SELECT id FROM claims WHERE status = 'active' AND expiresAt < ?`)
        .all(now) as unknown as { id: string }[]
    ).map((r) => r.id);
    const res = this.db
      .prepare(`UPDATE claims SET status = 'expired' WHERE status = 'active' AND expiresAt < ?`)
      .run(now);
    for (const id of expiring) this.notifyWaiters(id, "expired");
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
    // A waiter is only meaningful while its claim is live; anything else is residue.
    this.db
      .prepare(
        `DELETE FROM waiters WHERE claimId NOT IN (SELECT id FROM claims WHERE status = 'active')`,
      )
      .run();
    // Finished tasks age out; open/accepted work is never dropped.
    this.db
      .prepare(`DELETE FROM tasks WHERE status IN ('done','failed') AND createdAt < ?`)
      .run(cutoff);
    return { claims: Number(claims.changes), messages: Number(messages.changes) };
  }

  /** Active, non-expired claims in a repo/branch scope (sweeps first). */
  /**
   * Every active claim in the repository, **across all branches**.
   *
   * Branch is deliberately not part of the key: agents normally work on separate feature
   * branches, so filtering by it disabled detection in exactly the case Tower exists for.
   * Two agents rewriting one function on two branches still produce one merge conflict.
   * The engine downgrades cross-branch overlaps to `soft` rather than hiding them.
   */
  activeClaims(repoKey: string): Claim[] {
    this.sweepExpired();
    const rows = this.db
      .prepare(`SELECT * FROM claims WHERE repoKey = ? AND status = 'active'`)
      .all(repoKey) as unknown as ClaimRow[];
    return rows.map(rowToClaim);
  }

  listClaims(filter: ListClaimsInput = {}): Claim[] {
    this.sweepExpired();
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.repo) {
      clauses.push("repoKey = ?");
      params.push(resolveRepoKey(filter.repoId, filter.repo, filter.projectId));
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
    const changed = Number(res.changes) > 0;
    if (changed) this.notifyWaiters(id, "completed", commitSha);
    return changed;
  }

  releaseClaim(id: string): boolean {
    const res = this.db
      .prepare(`UPDATE claims SET status = 'released' WHERE id = ? AND status = 'active'`)
      .run(id);
    const changed = Number(res.changes) > 0;
    if (changed) this.notifyWaiters(id, "released");
    return changed;
  }

  // -- waiters (refused agents, told when the blocker ends) -------------------

  /** Register an agent refused by `claimId`. Idempotent per (agent, claim). */
  /** Returns false when this agent was already waiting on this claim — a retry. */
  addWaiter(input: { agentId: string; claimId: string; repo: string; repoKey?: string }): boolean {
    const { changes } = this.db
      .prepare(
        `INSERT OR IGNORE INTO waiters (agentId, claimId, repo, repoKey, createdAt) VALUES (?,?,?,?,?)`,
      )
      .run(input.agentId, input.claimId, input.repo, input.repoKey ?? null, this.now());
    return Number(changes) > 0;
  }

  /** Agents still waiting on a claim — inspection and tests. */
  waitersFor(claimId: string): string[] {
    return (
      this.db.prepare(`SELECT agentId FROM waiters WHERE claimId = ?`).all(claimId) as unknown as {
        agentId: string;
      }[]
    ).map((r) => r.agentId);
  }

  /**
   * Tell everyone refused by this claim that it no longer blocks them, then forget them.
   * Sent from `tower`, in the claim's own partition — recomputing the key from the repo
   * string would file a projectId-keyed claim's notice somewhere its reader never looks.
   */
  private notifyWaiters(claimId: string, how: ReleaseKind, commitSha?: string): void {
    const waiters = this.db
      .prepare(`SELECT agentId, repo, repoKey FROM waiters WHERE claimId = ?`)
      .all(claimId) as unknown as { agentId: string; repo: string; repoKey: string | null }[];
    if (waiters.length === 0) return;
    const claim = this.getClaim(claimId);
    this.db.prepare(`DELETE FROM waiters WHERE claimId = ?`).run(claimId);
    if (!claim) return;
    const body = releaseNotice(claim, how, commitSha);
    for (const w of waiters) {
      this.sendMessage({
        fromAgentId: "tower",
        toAgentId: w.agentId,
        repo: w.repo,
        ...(w.repoKey ? { repoKey: w.repoKey } : {}),
        kind: "message",
        body,
      });
    }
  }

  /**
   * Every claim in a partition created within the last `windowMs`, whatever its status.
   * The dependency map is inferred from this: finished claims still record what their
   * work read and wrote, which is the evidence. Measured on the store's own clock, not
   * the caller's, so an injected test clock and a real one cannot disagree about "recent".
   * Bounded in practice by `prune()`.
   */
  recentClaims(repoKey: string, windowMs: number): Claim[] {
    const rows = this.db
      .prepare(`SELECT * FROM claims WHERE repoKey = ? AND createdAt >= ? ORDER BY createdAt DESC`)
      .all(repoKey, this.now() - windowMs) as unknown as ClaimRow[];
    return rows.map(rowToClaim);
  }

  // -- messages (agent inbox) -------------------------------------------------

  sendMessage(input: {
    fromAgentId: string;
    toAgentId: string;
    repo: string;
    repoId?: string;
    projectId?: string;
    /** Store-internal: file the message under this partition as-is. Not reachable from
     * the wire — `SendMessageInput` has no such field and zod strips unknown keys. */
    repoKey?: string;
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
        `INSERT INTO messages (id,repo,repoKey,fromAgentId,toAgentId,kind,body,replyTo,createdAt)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        msg.id,
        msg.repo,
        input.repoKey ?? resolveRepoKey(input.repoId, input.repo, input.projectId),
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
  fetchMessages(filter: {
    agentId: string;
    repo?: string;
    repoId?: string;
    projectId?: string;
    unreadOnly?: boolean;
  }): Message[] {
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
      clauses.push("repoKey = ?");
      params.push(resolveRepoKey(filter.repoId, filter.repo, filter.projectId));
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
  listMessages(
    filter: { repo?: string; repoId?: string; projectId?: string; limit?: number } = {},
  ): Message[] {
    const limit = filter.limit ?? 50;
    const rows = (filter.repo
      ? this.db
          .prepare(`SELECT * FROM messages WHERE repoKey = ? ORDER BY createdAt DESC LIMIT ?`)
          .all(resolveRepoKey(filter.repoId, filter.repo, filter.projectId), limit)
      : this.db
          .prepare(`SELECT * FROM messages ORDER BY createdAt DESC LIMIT ?`)
          .all(limit)) as unknown as MessageRow[];
    return rows.map(rowToMessage);
  }

  // -- delegated tasks (lifecycle: open → accepted → done | failed) ----------

  createTask(input: {
    id: string;
    repo: string;
    repoId?: string;
    projectId?: string;
    fromAgentId: string;
    toAgentId: string;
    body: string;
    size?: DelegatedTask["size"];
  }): DelegatedTask {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO tasks (id,repo,repoKey,fromAgentId,toAgentId,body,status,assigneeAgentId,approval,size,commitSha,prUrl,result,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,'open',NULL,NULL,?,NULL,NULL,NULL,?,?)`,
      )
      .run(
        input.id,
        input.repo,
        resolveRepoKey(input.repoId, input.repo, input.projectId),
        input.fromAgentId,
        input.toAgentId,
        input.body,
        input.size ?? null,
        now,
        now,
      );
    return this.getTask(input.id)!;
  }

  getTask(id: string): DelegatedTask | undefined {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as unknown as
      TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  /** First accept wins: only an `open` task can be accepted, atomically. A task that
   * was parked for approval can only be accepted once approved — so a human's Reject
   * (or a still-pending gate) holds even against `--auto` workers on the same inbox. */
  /**
   * Resolve a task id, accepting a unique **prefix** — the CLI and board both print ids
   * truncated to 8 characters, so an agent copying what it sees should not get
   * `not_found`. Ambiguous prefixes resolve to nothing rather than guessing.
   */
  resolveTaskId(idOrPrefix: string): string | undefined {
    const exact = this.db
      .prepare(`SELECT id FROM tasks WHERE id = ?`)
      .get(idOrPrefix) as unknown as { id: string } | undefined;
    if (exact) return exact.id;
    const matches = this.db
      .prepare(`SELECT id FROM tasks WHERE id LIKE ? LIMIT 2`)
      .all(`${idOrPrefix}%`) as unknown as { id: string }[];
    return matches.length === 1 ? matches[0]!.id : undefined;
  }

  /**
   * First-accept-wins, atomically. Returns why it failed rather than a bare `false`:
   * "already taken by someone else" is the *normal* outcome of a broadcast and must be
   * distinguishable from a bad id (TWR-10).
   */
  acceptTask(id: string, agentId: string): { ok: boolean; reason?: AcceptFailure } {
    const resolved = this.resolveTaskId(id);
    if (!resolved) return { ok: false, reason: "not_found" };
    const res = this.db
      .prepare(
        `UPDATE tasks SET status = 'accepted', assigneeAgentId = ?, updatedAt = ?
         WHERE id = ? AND status = 'open' AND (approval IS NULL OR approval = 'approved')`,
      )
      .run(agentId, this.now(), resolved);
    if (Number(res.changes) > 0) return { ok: true };

    // The update matched nothing — say which of the three reasons it was.
    const row = this.db
      .prepare(`SELECT status, approval FROM tasks WHERE id = ?`)
      .get(resolved) as unknown as { status: string; approval: string | null } | undefined;
    if (!row) return { ok: false, reason: "not_found" };
    if (row.approval === "pending") return { ok: false, reason: "awaiting_approval" };
    if (row.approval === "rejected") return { ok: false, reason: "rejected" };
    return { ok: false, reason: "already_accepted" };
  }

  /** Park an open task for human approval (remote-approve worker mode). Only an
   * ungated task can be parked — re-parking must never reset a human's decision. */
  requestApproval(id: string, agentId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE tasks SET approval = 'pending', assigneeAgentId = ?, updatedAt = ?
         WHERE id = ? AND status = 'open' AND approval IS NULL`,
      )
      .run(agentId, this.now(), id);
    return Number(res.changes) > 0;
  }

  /** A human approves or rejects a pending task (from the board / mobile).
   * Reject is terminal: the task is marked failed so no worker mode ever runs it
   * and the 7-day pruner can age it out. */
  resolveApproval(id: string, approved: boolean): boolean {
    const res = approved
      ? this.db
          .prepare(
            `UPDATE tasks SET approval = 'approved', updatedAt = ? WHERE id = ? AND approval = 'pending'`,
          )
          .run(this.now(), id)
      : this.db
          .prepare(
            `UPDATE tasks SET approval = 'rejected', status = 'failed',
               result = 'rejected by a human on the board', updatedAt = ?
             WHERE id = ? AND approval = 'pending'`,
          )
          .run(this.now(), id);
    return Number(res.changes) > 0;
  }

  /** Only the assignee can finish its accepted task. */
  completeTask(
    id: string,
    agentId: string,
    outcome: {
      success: boolean;
      result: string;
      commitSha?: string;
      prUrl?: string;
      filesChanged?: number;
    },
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE tasks SET status = ?, result = ?, commitSha = ?, prUrl = ?, filesChanged = ?, updatedAt = ?
         WHERE id = ? AND status = 'accepted' AND assigneeAgentId = ?`,
      )
      .run(
        outcome.success ? "done" : "failed",
        outcome.result,
        outcome.commitSha ?? null,
        outcome.prUrl ?? null,
        outcome.filesChanged ?? null,
        this.now(),
        id,
        agentId,
      );
    return Number(res.changes) > 0;
  }

  listTasks(
    filter: {
      repo?: string;
      repoId?: string;
      projectId?: string;
      status?: TaskStatus;
      /** Tasks addressed to this agent, including "*" broadcasts. */
      forAgentId?: string;
      assigneeAgentId?: string;
      /** Cap the result set (newest first) — the board uses this. */
      limit?: number;
    } = {},
  ): DelegatedTask[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.repo) {
      clauses.push("repoKey = ?");
      params.push(resolveRepoKey(filter.repoId, filter.repo, filter.projectId));
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
    const limitSql = filter.limit != null ? ` LIMIT ?` : "";
    if (filter.limit != null) params.push(filter.limit);
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY createdAt DESC${limitSql}`)
      .all(...params) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  // -- worker presence ------------------------------------------------------

  /** Record that a worker is alive (upsert on agentId+repo), with self-reported capacity. */
  /**
   * Record that an agent was active, without it having to run a worker daemon.
   *
   * Presence used to come only from `heartbeat_worker`, which the `tower work` daemon
   * calls and an ordinary agent session never does — so someone claiming and messaging
   * all day showed as "seen earlier" forever, indistinguishable from someone who left.
   * Any authenticated tool call is proof of life.
   */
  touchAgent(agentId: string, repo: string, repoId?: string, projectId?: string): void {
    if (!agentId || !repo) return;
    this.db
      .prepare(
        `INSERT INTO workers (agentId,repo,repoKey,runner,status,lastSeen) VALUES (?,?,?,'',?,?)
         ON CONFLICT(agentId,repo) DO UPDATE SET lastSeen=excluded.lastSeen,
           repoKey=excluded.repoKey`,
      )
      .run(agentId, repo, resolveRepoKey(repoId, repo, projectId), "ok", this.now());
  }

  heartbeatWorker(input: {
    agentId: string;
    repo: string;
    repoId?: string;
    projectId?: string;
    runner: string;
    status?: Worker["status"];
  }): void {
    this.db
      .prepare(
        `INSERT INTO workers (agentId,repo,repoKey,runner,status,lastSeen) VALUES (?,?,?,?,?,?)
         ON CONFLICT(agentId,repo) DO UPDATE SET runner=excluded.runner,
           status=excluded.status, lastSeen=excluded.lastSeen`,
      )
      .run(
        input.agentId,
        input.repo,
        resolveRepoKey(input.repoId, input.repo, input.projectId),
        input.runner,
        input.status ?? "ok",
        this.now(),
      );
  }

  /** Workers seen within `windowMs` (online), newest first. */
  /**
   * Everyone seen inside `connectedMs`, each labelled `working` or `idle` depending on
   * whether they were active inside the shorter `workingMs` window, and joined to the
   * claims they currently hold.
   *
   * Anyone past `connectedMs` is simply absent from the list — that is `offline`.
   */
  listWorkers(connectedMs: number, workingMs = connectedMs): Worker[] {
    const now = this.now();
    const rows = this.db
      .prepare(`SELECT * FROM workers WHERE lastSeen >= ? ORDER BY lastSeen DESC`)
      .all(now - connectedMs) as unknown as Worker[];

    // One query for every live claim, then grouped in memory — the roster is small and
    // this keeps it to two statements regardless of how many agents are connected.
    const claimRows = this.db
      .prepare(
        `SELECT id, agentId, purpose, files FROM claims WHERE status = 'active' AND expiresAt > ?`,
      )
      .all(now) as unknown as { id: string; agentId: string; purpose: string; files: string }[];
    const byAgent = new Map<string, Worker["claims"]>();
    for (const c of claimRows) {
      const list = byAgent.get(c.agentId) ?? [];
      list.push({ claimId: c.id, purpose: c.purpose, files: JSON.parse(c.files) as string[] });
      byAgent.set(c.agentId, list);
    }

    return rows.map((r) => {
      const claims = byAgent.get(r.agentId) ?? [];
      // Holding a live claim counts as working even if the heartbeat is a little stale —
      // an agent mid-edit is demonstrably not idle.
      const working = r.lastSeen >= now - workingMs || claims.length > 0;
      return {
        agentId: r.agentId,
        repo: r.repo,
        runner: r.runner,
        status: r.status === "low" ? "low" : "ok",
        lastSeen: r.lastSeen,
        presence: working ? ("working" as const) : ("idle" as const),
        claims,
      };
    });
  }

  /**
   * Extend every active claim held by an agent that is demonstrably alive (TWR-11).
   * Claims used to expire on wall-clock TTL alone, so a live agent on a slow task could
   * have its claim lapse underneath it while a crashed agent kept blocking a file.
   */
  touchClaimsFor(agentId: string): number {
    const res = this.db
      .prepare(`UPDATE claims SET expiresAt = ? WHERE agentId = ? AND status = 'active'`)
      .run(this.now() + this.ttlMs, agentId);
    return Number(res.changes ?? 0);
  }

  // -- push subscriptions & small kv (web push) ------------------------------

  /** Save a browser push subscription (upsert by endpoint). */
  addPushSub(endpoint: string, subJson: string): void {
    this.db
      .prepare(
        `INSERT INTO push_subs (endpoint, sub, createdAt) VALUES (?,?,?)
         ON CONFLICT(endpoint) DO UPDATE SET sub=excluded.sub`,
      )
      .run(endpoint, subJson, this.now());
  }

  listPushSubs(): { endpoint: string; sub: string }[] {
    return this.db.prepare(`SELECT endpoint, sub FROM push_subs`).all() as unknown as {
      endpoint: string;
      sub: string;
    }[];
  }

  /** Drop a subscription the push service says is gone (410/404). */
  deletePushSub(endpoint: string): void {
    this.db.prepare(`DELETE FROM push_subs WHERE endpoint = ?`).run(endpoint);
  }

  getKv(key: string): string | undefined {
    const row = this.db.prepare(`SELECT v FROM kv WHERE k = ?`).get(key) as unknown as
      { v: string } | undefined;
    return row?.v;
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`)
      .run(key, value);
  }

  // -- decisions ------------------------------------------------------------

  logDecision(input: {
    title: string;
    body: string;
    author: string;
    tags: string[];
    relatedFiles: string[];
    repo?: string;
    repoId?: string;
    projectId?: string;
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
        `INSERT INTO decisions (id,title,body,author,tags,relatedFiles,createdAt,repo,repoKey)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        decision.id,
        decision.title,
        decision.body,
        decision.author,
        JSON.stringify(decision.tags),
        JSON.stringify(decision.relatedFiles),
        decision.createdAt,
        input.repo ?? null,
        input.repo ? resolveRepoKey(input.repoId, input.repo, input.projectId) : null,
      );
    return decision;
  }

  getDecisions(filter: GetDecisionsInput = {}): Decision[] {
    // Scope to the caller's project when they name one. Decisions used to be global on a
    // shared server, so one team's architecture notes surfaced in another team's recall —
    // the same silent cross-partition leak 0.10.0 fixed for claims, one table over.
    // Rows written before scoping existed have no repoKey and stay visible to everyone,
    // which is what they already were.
    const rows = (filter.repo
      ? this.db
          .prepare(
            `SELECT * FROM decisions WHERE repoKey = ? OR repoKey IS NULL ORDER BY createdAt DESC`,
          )
          .all(resolveRepoKey(filter.repoId, filter.repo, filter.projectId))
      : this.db
          .prepare(`SELECT * FROM decisions ORDER BY createdAt DESC`)
          .all()) as unknown as DecisionRow[];
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

  /**
   * Record that a collision was reported. Counts only — kind, severity, whether it was
   * forced. Never a file, a symbol or a line of code, so this table stays safe to share
   * even from a private repo.
   *
   * Tower detected collisions for four versions and forgot every one, which is why
   * "which kind actually happens, and how often" has never had an answer. It is the one
   * question only a coordination layer can answer, because it sits where it happens.
   */
  recordConflict(input: {
    repoKey?: string;
    kind: ConflictKind;
    severity: Severity;
    forced: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO conflicts (id, repoKey, kind, severity, forced, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.repoKey ?? null,
        input.kind,
        input.severity,
        input.forced ? 1 : 0,
        Date.now(),
      );
  }

  /** Counts of every collision reported, optionally for one repo. */
  conflictStats(repoKey?: string): ConflictStats {
    const rows = (repoKey
      ? this.db
          .prepare(`SELECT kind, severity, forced FROM conflicts WHERE repoKey = ?`)
          .all(repoKey)
      : this.db.prepare(`SELECT kind, severity, forced FROM conflicts`).all()) as unknown as {
      kind: string;
      severity: string;
      forced: number;
    }[];

    const stats: ConflictStats = {
      total: rows.length,
      byKind: { write_write: 0, write_read: 0 },
      bySeverity: { hard: 0, soft: 0, info: 0 },
      forced: 0,
    };
    for (const r of rows) {
      if (r.kind === "write_read") stats.byKind.write_read++;
      else if (r.kind === "write_write") stats.byKind.write_write++;
      if (r.severity === "hard") stats.bySeverity.hard++;
      else if (r.severity === "soft") stats.bySeverity.soft++;
      else if (r.severity === "info") stats.bySeverity.info++;
      if (r.forced) stats.forced++;
    }
    return stats;
  }

  /**
   * Record declarations an agent has read. Upserted per (agent, repo, file, symbol), so
   * re-reading a file replaces rather than accumulates — the latest read is the version
   * the agent is actually working from.
   */
  recordReads(agentId: string, repoKey: string | undefined, reads: SymbolRef[]): void {
    const del = this.db.prepare(
      `DELETE FROM reads WHERE agentId = ? AND ifnull(repoKey,'') = ifnull(?,'')
         AND file = ? AND symbol = ?`,
    );
    const ins = this.db.prepare(
      `INSERT INTO reads (id, agentId, repoKey, file, symbol, sig, sigText, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    for (const r of reads) {
      if (r.symbol === "") continue; // file granularity is too coarse to be worth a row
      del.run(agentId, repoKey ?? null, r.file, r.symbol);
      ins.run(
        randomUUID(),
        agentId,
        repoKey ?? null,
        r.file,
        r.symbol,
        r.sig ?? null,
        r.sigText ?? null,
        now,
      );
    }
  }

  /** The declarations this agent has read in this repo. */
  takeReads(agentId: string, repoKey?: string): SymbolRef[] {
    const rows = this.db
      .prepare(
        `SELECT file, symbol, sig, sigText FROM reads
         WHERE agentId = ? AND ifnull(repoKey,'') = ifnull(?,'')`,
      )
      .all(agentId, repoKey ?? null) as unknown as {
      file: string;
      symbol: string;
      sig: string | null;
      sigText: string | null;
    }[];
    return rows.map((r) => ({
      file: r.file,
      symbol: r.symbol,
      ...(r.sig ? { sig: r.sig } : {}),
      ...(r.sigText ? { sigText: r.sigText } : {}),
    }));
  }

  close(): void {
    this.db.close();
  }
}

export interface ConflictStats {
  total: number;
  byKind: Record<ConflictKind, number>;
  bySeverity: Record<Severity, number>;
  forced: number;
}
