import type { Claim } from "@tower/shared";
import { fingerprintDeclaration } from "./signature.js";

/**
 * The messages Tower sends on an agent's behalf. Kept here, as plain functions, so the
 * wording an agent acts on is tested like any other output — a vague notice costs the
 * reader a re-read, which is the token spend Tower exists to prevent.
 */

export type ReleaseKind = "completed" | "released" | "expired";

/** How many symbols a notice names before summarising the rest. */
const NAMED = 3;

function scopeOf(claim: Claim): string {
  const named = claim.symbols.filter((s) => s.symbol !== "").map((s) => `${s.symbol}()`);
  const items = named.length
    ? named
    : [...new Set([...claim.files, ...claim.symbols.map((s) => s.file)])];
  if (items.length <= NAMED) return items.join(", ");
  return `${items.slice(0, NAMED).join(", ")} and ${items.length - NAMED} more`;
}

/** Told to every agent refused on this claim, the moment it stops blocking them. */
export function releaseNotice(claim: Claim, how: ReleaseKind, commitSha?: string): string {
  const ended =
    how === "expired"
      ? `${claim.agentId}'s claim expired`
      : `${claim.agentId} ${how} their claim${commitSha ? ` (commit ${commitSha.slice(0, 7)})` : ""}`;
  return `${scopeOf(claim)} ${ended} and is free again. Claim it to carry on.`;
}

export interface ContractChange {
  holder: string;
  file: string;
  symbol: string;
  /** The declaration as it stands after the change. */
  landed: { sig: string; sigText: string };
  /** What the holder said it would be, if it declared anything. */
  declared?: string;
}

/**
 * Told to every agent whose work read a declaration that has now landed with a new
 * signature. Says whether it matches the declared contract, because that is the one
 * thing a reader who coded against the declaration needs to know.
 */
export function contractNotice(c: ContractChange): string {
  const head = `${c.holder}'s ${c.symbol}() in ${c.file} landed as \`${c.landed.sigText}\`.`;
  if (!c.declared) return `${head} Update any call sites built on the old signature.`;
  const asDeclared = fingerprintDeclaration(c.declared)?.sig === c.landed.sig;
  return asDeclared
    ? `${head} That is the contract as declared — code written against it is correct.`
    : `${head} That is not what was declared (\`${c.declared}\`) — ` +
        `update call sites you wrote against the declaration.`;
}
