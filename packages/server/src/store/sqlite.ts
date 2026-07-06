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
  ListClaimsInput,
  GetDecisionsInput,
  Message,
  MessageKind,
  SymbolRef,
} from "@tower/shared";

/** Default time-to-live for a claim before it auto-expires (ms). Refreshed by heartbeat. */
export const DEFAULT_TTL_MS = 15 * 60 * 1000;

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

interface MessageRow {
  id: string;
  repo: string;
  fromAgentId: string;
  toAgentId: string;
  kind: string;
  body: string;
  replyTo: string | null;
  createdAt: number;
  readAt: number | null;
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
    ...(r.readAt != null ? { readAt: r.readAt } : {}),
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

  /** Marks any active claim whose TTL has elapsed as expired. Returns count swept. */
  sweepExpired(): number {
    const res = this.db
      .prepare(`UPDATE claims SET status = 'expired' WHERE status = 'active' AND expiresAt < ?`)
      .run(this.now());
    return Number(res.changes);
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
        `INSERT INTO messages (id,repo,fromAgentId,toAgentId,kind,body,replyTo,createdAt,readAt)
         VALUES (?,?,?,?,?,?,?,?,NULL)`,
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

  /** Unread messages addressed to the agent (directly or broadcast), excluding their own. */
  unreadCount(agentId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
         WHERE readAt IS NULL AND fromAgentId != ? AND (toAgentId = ? OR toAgentId = '*')`,
      )
      .get(agentId, agentId) as unknown as { n: number };
    return Number(row.n);
  }

  /**
   * The agent's inbox. `unreadOnly` (default) also marks the fetched messages read.
   * v1 tradeoff: a broadcast ("*") is marked read by its first reader.
   */
  fetchMessages(filter: { agentId: string; repo?: string; unreadOnly?: boolean }): Message[] {
    const unreadOnly = filter.unreadOnly ?? true;
    const clauses = [`fromAgentId != ?`, `(toAgentId = ? OR toAgentId = '*')`];
    const params: (string | number)[] = [filter.agentId, filter.agentId];
    if (unreadOnly) clauses.push("readAt IS NULL");
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
      const mark = this.db.prepare(`UPDATE messages SET readAt = ? WHERE id = ?`);
      for (const m of messages) mark.run(readAt, m.id);
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
