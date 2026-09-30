import type { Alternatives, ClaimIntentOutput, Conflict, SymbolRef, ToolCall } from "./client.js";

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
    const instead = renderAlternatives(res.alternatives);
    if (instead) out(instead);
  }
  return res.blocking || res.conflicts.some((c) => c.severity === "hard");
}

/** How many avoided items to name before summarising the rest. */
const AVOID_SHOWN = 5;

const itemName = (s: SymbolRef): string => (s.symbol ? `${s.file} › ${s.symbol}` : s.file);

/**
 * The "then what?" a refusal carries. Empty for a server too old to send it. Built from
 * the structured fields rather than the server's `advice`, which is written for
 * developers ("symbols") — the same reason conflicts get their own sentence above.
 */
export function renderAlternatives(alt: Alternatives | undefined): string {
  if (!alt) return "";
  const lines = [
    "What to do instead:",
    `  Don't wait: work on anything not listed here.${
      alt.notifyOnRelease ? " Tower will message you when it frees up." : ""
    }`,
  ];
  if (alt.avoid.length) {
    const named = alt.avoid.slice(0, AVOID_SHOWN).map(itemName).join(", ");
    const rest = alt.avoid.length - AVOID_SHOWN;
    lines.push(`  Avoid for now: ${named}${rest > 0 ? ` and ${rest} more` : ""}`);
  }
  if (alt.nextTask) lines.push(`  Suggested next: "${alt.nextTask.module}"`);
  return lines.join("\n");
}

/**
 * Claim only if clear — a blocked caller never leaves a claim behind. Returns true when
 * blocked, for scripts that gate on the exit code.
 *
 * One `claim_intent` call: a refusal registers nothing, so the `check_collision`
 * pre-check this used to make bought nothing — and it cost the blocked caller the
 * alternatives and the message Tower sends when the blocking claim ends.
 */
export async function guard(call: ToolCall, args: ClaimArgs, out: Writer): Promise<boolean> {
  const res = (await call("claim_intent", buildIntent(args))) as ClaimIntentOutput;
  const hard = res.conflicts.filter((c) => c.severity === "hard");
  out(renderConflicts(res.conflicts));
  if (!res.claimId) {
    out(`BLOCKED — ${hard.length} hard conflict(s). Wait, pick something else, or --force.`);
    const instead = renderAlternatives(res.alternatives);
    if (instead) out(instead);
    return true;
  }
  out(
    hard.length > 0
      ? `FORCED past ${hard.length} hard conflict(s) — you own the overwrite risk.`
      : `CLEAR — registered claim ${res.claimId.slice(0, 8)}.`,
  );
  return false;
}
