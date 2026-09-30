import type { Claim, Conflict, Severity, SymbolRef } from "@tower/shared";
import { resolveRepoKey } from "@tower/shared";
import { fingerprintDeclaration } from "./signature.js";

export interface CollisionInput {
  files: string[];
  symbols: SymbolRef[];
  /** Declarations this work was written against, carrying the `sig` read at the time.
   * Empty means the caller opted out and only write-write detection applies. */
  reads?: SymbolRef[];
  /** The agent making the incoming claim; its own active claims are ignored. */
  agentId?: string;
  /** Branch of the incoming intent. Overlaps on a *different* branch are real — they
   * still converge into one merge — but they are not immediate, so they cap at `soft`.
   * Omit to treat every candidate as same-branch. */
  branch?: string;
}

/** The partition a claim belongs to. Prefers the stored key, then the fork-proof
 * `repoId`, then the normalized URL — so rows written before 0.9.0 still compare. */
export function claimRepoKey(claim: Pick<Claim, "repo" | "repoId" | "repoKey">): string {
  return claim.repoKey ?? resolveRepoKey(claim.repoId, claim.repo);
}

export interface CollisionOptions {
  /** Enable dependency-based `info` conflicts. Stubbed off for the MVP. */
  enableInfo?: boolean;
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, soft: 1, hard: 2 };

/** Normalize a claim/input into concrete (file, symbol) targets. */
function toTargets(files: string[], symbols: SymbolRef[]): SymbolRef[] {
  const targets: SymbolRef[] = [...symbols];
  const filesWithSymbols = new Set(symbols.filter((s) => s.symbol !== "").map((s) => s.file));
  for (const file of files) {
    if (!filesWithSymbols.has(file)) targets.push({ file, symbol: "" });
  }
  return targets;
}

/** Severity of two targets that share a file. */
function pairSeverity(a: SymbolRef, b: SymbolRef): Severity | null {
  if (a.file !== b.file) return null;
  const aWhole = a.symbol === "";
  const bWhole = b.symbol === "";
  if (aWhole || bWhole) return "hard"; // a whole-file claim locks the entire file
  if (a.symbol === b.symbol) return "hard"; // same symbol
  return "soft"; // same file, different symbols → overlapping diffs
}

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/** Never report worse than `soft` for work happening on another branch. */
function capForBranch(severity: Severity, sameBranch: boolean): Severity {
  if (sameBranch) return severity;
  return SEVERITY_RANK[severity] > SEVERITY_RANK.soft ? "soft" : severity;
}

function reasonFor(severity: Severity, agentId: string, overlap: SymbolRef[]): string {
  const named = overlap.filter((s) => s.symbol !== "").map((s) => s.symbol);
  if (severity === "hard") {
    if (named.length) return `Overlaps ${named.join(", ")} — also claimed by ${agentId}`;
    const file = overlap[0]?.file ?? "the same file";
    return `Whole-file claim on ${file} conflicts with ${agentId}`;
  }
  const files = [...new Set(overlap.map((s) => s.file))];
  return `Editing the same file(s) (${files.join(", ")}) as ${agentId} — overlapping diffs likely`;
}

/**
 * Detects semantic collisions between an incoming edit intent and the currently
 * active claims. Pure and synchronous. One {@link Conflict} per conflicting claim,
 * carrying the highest severity found and the overlapping symbols.
 */
export function detectCollisions(
  incoming: CollisionInput,
  active: Claim[],
  _opts: CollisionOptions = {},
): Conflict[] {
  const incomingTargets = toTargets(incoming.files, incoming.symbols);
  const conflicts: Conflict[] = [];

  for (const claim of active) {
    if (claim.status !== "active") continue;
    if (incoming.agentId && claim.agentId === incoming.agentId) continue;

    const claimTargets = toTargets(claim.files, claim.symbols);
    const overlap: SymbolRef[] = [];
    let severity: Severity | null = null;

    for (const it of incomingTargets) {
      for (const ct of claimTargets) {
        const s = pairSeverity(it, ct);
        if (!s) continue;
        overlap.push(it.symbol !== "" ? it : ct);
        severity = severity ? maxSeverity(severity, s) : s;
      }
    }

    if (!severity) continue;

    const sameBranch = incoming.branch === undefined || incoming.branch === claim.branch;
    severity = capForBranch(severity, sameBranch);

    conflicts.push({
      claimId: claim.id,
      agentId: claim.agentId,
      severity,
      kind: "write_write",
      reason:
        reasonFor(severity, claim.agentId, overlap) +
        (sameBranch ? "" : ` (on branch ${claim.branch})`),
      overlap: dedupeSymbols(overlap),
      ...(claim.etaMinutes != null ? { etaMinutes: claim.etaMinutes } : {}),
    });
  }

  // Most severe first.
  return conflicts.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/**
 * Antidependencies: someone is writing a declaration this agent *read*.
 *
 * `detectCollisions` compares write sets, so it is structurally blind to the common
 * case — A moves `AuthService.verify` in auth.ts while B, having read the old
 * signature, writes a caller in payments.ts. No shared file, no shared symbol,
 * `pairSeverity` returns null on its first line, and B finds out at CI.
 *
 * Severity here is evidence-graded, and that asymmetry is what keeps the signal
 * trustworthy enough to leave switched on:
 *   - the other agent holds the symbol but its declaration still matches what you read
 *     → `soft`. They may only be touching the body, and most edits are.
 *   - the declaration has already moved → `hard`, carrying both forms so the agent can
 *     patch from the delta instead of pulling the file back into context.
 *
 * A read with no `sig` is skipped: file-granularity is too coarse to be worth a warning,
 * and a warning nobody trusts is worse than silence.
 */
export function detectAntidependencies(incoming: CollisionInput, active: Claim[]): Conflict[] {
  const reads = (incoming.reads ?? []).filter((r) => r.symbol !== "" && r.sig);
  if (reads.length === 0) return [];
  const conflicts: Conflict[] = [];

  for (const claim of active) {
    if (claim.status !== "active") continue;
    if (incoming.agentId && claim.agentId === incoming.agentId) continue;

    const overlap: SymbolRef[] = [];
    let moved: { read: SymbolRef; now: SymbolRef } | null = null;
    let declared: string | undefined;

    for (const read of reads) {
      for (const written of claim.symbols) {
        if (written.file !== read.file || written.symbol !== read.symbol) continue;
        if (written.declares) {
          // Contract-first. The holder has said what the declaration will become, so the
          // reader has what it needs to carry on: never `hard`, which would put it back
          // into the wait this exists to remove. A reader whose copy already matches the
          // declared contract is on the new version — there is nothing to tell it.
          if (read.sig && fingerprintDeclaration(written.declares)?.sig === read.sig) continue;
          declared ??= written.declares;
          overlap.push(read);
          continue;
        }
        overlap.push(read);
        if (written.sig && written.sig !== read.sig) moved ??= { read, now: written };
      }
    }
    if (overlap.length === 0) continue;

    const sameBranch = incoming.branch === undefined || incoming.branch === claim.branch;
    const severity = capForBranch(moved ? "hard" : "soft", sameBranch);
    const where = dedupeSymbols(overlap)
      .map((s) => s.symbol)
      .join(", ");
    const onBranch = sameBranch ? "" : ` (on branch ${claim.branch})`;

    conflicts.push({
      claimId: claim.id,
      agentId: claim.agentId,
      severity,
      kind: "write_read",
      reason: moved
        ? `${where} moved under you — ${claim.agentId} changed the declaration you read${onBranch}`
        : declared
          ? `${claim.agentId} is changing ${where} to \`${declared}\` — code against that; ` +
            `no need to wait${onBranch}`
          : `${claim.agentId} is editing ${where} right now, which you read${onBranch}`,
      ...(declared ? { declaredSigText: declared } : {}),
      overlap: dedupeSymbols(overlap),
      ...(claim.etaMinutes != null ? { etaMinutes: claim.etaMinutes } : {}),
      ...(moved?.read.sigText ? { wasSigText: moved.read.sigText } : {}),
      ...(moved?.now.sigText ? { nowSigText: moved.now.sigText } : {}),
    });
  }

  return conflicts.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/** A collision between two live claims, as shown on the board. */
export interface PairConflict {
  aClaimId: string;
  aAgentId: string;
  bClaimId: string;
  bAgentId: string;
  severity: Severity;
  reason: string;
  overlap: SymbolRef[];
}

/**
 * All collisions among a set of active claims, one entry per conflicting pair.
 * Claims collide within one repository **partition** regardless of branch (cross-branch
 * pairs report as `soft`), and never with the same agent. Powers the live board.
 */
export function pairwiseCollisions(claims: Claim[]): PairConflict[] {
  const pairs: PairConflict[] = [];
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i]!;
      const b = claims[j]!;
      if (claimRepoKey(a) !== claimRepoKey(b)) continue;
      const [conflict] = detectCollisions(
        { agentId: a.agentId, files: a.files, symbols: a.symbols, branch: a.branch },
        [b],
      );
      if (!conflict) continue;
      pairs.push({
        aClaimId: a.id,
        aAgentId: a.agentId,
        bClaimId: b.id,
        bAgentId: b.agentId,
        severity: conflict.severity,
        reason: conflict.reason,
        overlap: conflict.overlap,
      });
    }
  }
  return pairs.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

function dedupeSymbols(symbols: SymbolRef[]): SymbolRef[] {
  const seen = new Set<string>();
  const out: SymbolRef[] = [];
  for (const s of symbols) {
    const key = `${s.file}::${s.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
