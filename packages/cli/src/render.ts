import type { Claim, Conflict } from "@tower/shared";

/** Human-friendly "2m ago" style relative time. */
export function formatAgo(deltaMs: number): string {
  const s = Math.max(0, Math.round(deltaMs / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function targetLabel(conflict: Conflict): string {
  const named = conflict.overlap.filter((o) => o.symbol !== "").map((o) => o.symbol);
  if (named.length) return named.join(", ");
  return conflict.overlap[0]?.file ?? "shared file";
}

/**
 * Renders the hero output: the pre-flight collision prompt an agent sees before
 * it starts editing. `lookup` resolves the conflicting claim for extra context.
 */
export function renderConflicts(
  conflicts: Conflict[],
  lookup: (claimId: string) => Claim | undefined,
  now: number = Date.now(),
): string {
  if (conflicts.length === 0) return "✅ No collisions — safe to proceed.";

  const blocks = conflicts.map((c) => {
    const claim = lookup(c.claimId);
    const started = claim ? formatAgo(now - claim.createdAt) : "recently";
    const eta = c.etaMinutes ? `, ETA ~${c.etaMinutes}m` : "";
    const purpose = claim?.purpose ? `, purpose: ${claim.purpose}` : "";
    const context = `   Agent "${c.agentId}" is mid-change (started ${started}${eta}${purpose}).`;

    if (c.severity === "hard") {
      return [
        `⛔ COLLISION — ${targetLabel(c)}`,
        context,
        `   Options:  [w] wait   [d] take dependent task   [b] branch from their WIP   [f] force`,
      ].join("\n");
    }
    if (c.severity === "soft") {
      return [
        `⚠️  OVERLAP — ${targetLabel(c)}`,
        context,
        `   Options:  [c] continue (careful)   [w] wait`,
      ].join("\n");
    }
    return `ℹ️  RELATED — ${c.reason}`;
  });

  return blocks.join("\n\n");
}

/** Compact table of active claims for `tower status`. */
export function renderClaimsTable(claims: Claim[], now: number = Date.now()): string {
  if (claims.length === 0) return "No active claims.";
  const rows = claims.map((c) => {
    const target = c.symbols.find((s) => s.symbol !== "")?.symbol ?? c.files[0] ?? "(files)";
    return `  ${c.agentId.padEnd(14)} ${target.padEnd(28)} ${formatAgo(now - c.createdAt).padEnd(9)} ${c.purpose}`;
  });
  const header = `  ${"AGENT".padEnd(14)} ${"TARGET".padEnd(28)} ${"AGE".padEnd(9)} PURPOSE`;
  return [`Active claims (${claims.length}):`, header, ...rows].join("\n");
}
