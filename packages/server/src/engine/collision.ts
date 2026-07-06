import type { Claim, Conflict, Severity, SymbolRef } from "@tower/shared";

export interface CollisionInput {
  files: string[];
  symbols: SymbolRef[];
  /** The agent making the incoming claim; its own active claims are ignored. */
  agentId?: string;
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

    conflicts.push({
      claimId: claim.id,
      agentId: claim.agentId,
      severity,
      reason: reasonFor(severity, claim.agentId, overlap),
      overlap: dedupeSymbols(overlap),
      ...(claim.etaMinutes != null ? { etaMinutes: claim.etaMinutes } : {}),
    });
  }

  // Most severe first.
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
 * Claims only collide within the same repo+branch, and never with the same agent.
 * Powers the live board.
 */
export function pairwiseCollisions(claims: Claim[]): PairConflict[] {
  const pairs: PairConflict[] = [];
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i]!;
      const b = claims[j]!;
      if (a.repo !== b.repo || a.branch !== b.branch) continue;
      const [conflict] = detectCollisions(
        { agentId: a.agentId, files: a.files, symbols: a.symbols },
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
