import type { ClaimIntentOutput, CheckCollisionOutput, Conflict, ToolCall } from "./client.js";

export interface ClaimArgs {
  /** Who is working — a person or an agent. */
  who: string;
  /** The coordination space everyone on the team shares, e.g. "acme-marketing". */
  space: string;
  /** The artifact: a doc URL, a campaign name, an asset name — any stable string. */
  artifact: string;
  /** Optional part of the artifact, e.g. "hero headline". Empty means the whole thing. */
  section?: string;
  purpose: string;
  etaMinutes?: number;
  force?: boolean;
}

/**
 * Tower requires `repo` and `branch`, which a marketing team has neither of. `space`
 * fills both: it goes in as `projectId` — the team-wide override that partitions claims
 * without git — and is echoed into `repo` to satisfy the schema.
 */
export function buildIntent(args: ClaimArgs): Record<string, unknown> {
  const symbol = args.section?.trim() ?? "";
  return {
    agentId: args.who,
    repo: args.space,
    projectId: args.space,
    branch: "main",
    files: [args.artifact],
    symbols: [{ file: args.artifact, symbol }],
    purpose: args.purpose,
    ...(args.etaMinutes != null ? { etaMinutes: args.etaMinutes } : {}),
    ...(args.force ? { force: true } : {}),
  };
}

/** The scope-only shape `check_collision` takes — a dry run with no claim registered. */
export function buildScope(args: ClaimArgs): Record<string, unknown> {
  const { agentId, repo, projectId, branch, files, symbols } = buildIntent(args) as {
    agentId: string;
    repo: string;
    projectId: string;
    branch: string;
    files: string[];
    symbols: unknown[];
  };
  return { agentId, repo, projectId, branch, files, symbols };
}

/**
 * The server's own `reason` is written for developers ("whole-file claim",
 * "overlapping diffs"). Severity and overlap are all this needs, so it writes the
 * sentence itself rather than showing a marketer the word "file".
 */
export function describeConflict(c: Conflict): string {
  const named = c.overlap.filter((o) => o.symbol !== "");
  const artifacts = [...new Set(c.overlap.map((o) => o.file))].join(", ");
  const eta = c.etaMinutes != null ? ` (~${c.etaMinutes}m left)` : "";
  if (c.severity === "hard") {
    const what = named.length
      ? named.map((o) => `${o.file} › ${o.symbol}`).join(", ")
      : `all of ${artifacts}`;
    return `  [hard] ${c.agentId} already has ${what}${eta}`;
  }
  if (c.severity === "soft") {
    return `  [soft] ${c.agentId} is in ${artifacts} too, on a different part${eta}`;
  }
  return `  [info] ${c.agentId} is nearby in ${artifacts}${eta}`;
}

export function renderConflicts(conflicts: Conflict[]): string {
  if (conflicts.length === 0) return "No conflicts — nobody else is on this.";
  return [`${conflicts.length} conflict(s):`, ...conflicts.map(describeConflict)].join("\n");
}

export type Writer = (line: string) => void;

/**
 * Register intent and report collisions. Returns true when a hard conflict was hit —
 * the caller turns that into a non-zero exit.
 */
export async function claim(call: ToolCall, args: ClaimArgs, out: Writer): Promise<boolean> {
  const res = (await call("claim_intent", buildIntent(args))) as ClaimIntentOutput;
  out(renderConflicts(res.conflicts));
  if (res.claimId) {
    out(`Claim ${res.claimId.slice(0, 8)} registered for ${args.who}.`);
  } else {
    out(`Claim REFUSED — someone else holds this. Re-run with --force to override.`);
  }
  return res.blocking || res.conflicts.some((c) => c.severity === "hard");
}

/**
 * Check first, then claim only if clear — so a blocked caller never leaves a claim
 * behind. Returns true when blocked, for scripts that gate on the exit code.
 */
export async function guard(call: ToolCall, args: ClaimArgs, out: Writer): Promise<boolean> {
  const { conflicts } = (await call("check_collision", buildScope(args))) as CheckCollisionOutput;
  const hard = conflicts.filter((c) => c.severity === "hard");
  if (hard.length > 0) {
    out(renderConflicts(conflicts));
    if (!args.force) {
      out(`BLOCKED — ${hard.length} hard conflict(s). Wait, pick something else, or --force.`);
      return true;
    }
    out(`FORCED past ${hard.length} hard conflict(s) — you own the overwrite risk.`);
  }
  const res = (await call("claim_intent", {
    ...buildIntent(args),
    ...(hard.length > 0 ? { force: true } : {}),
  })) as ClaimIntentOutput;
  if (hard.length === 0) {
    out(renderConflicts(conflicts));
    if (res.claimId) out(`CLEAR — registered claim ${res.claimId.slice(0, 8)}.`);
  }
  return false;
}
