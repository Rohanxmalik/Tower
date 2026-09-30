import type { Alternatives, Claim, Conflict, SymbolRef, Task } from "@tower/shared";
import { dependentsOf } from "./dependencies.js";
import { moduleForFile, nextTask, type Policy } from "./sequencer.js";

export interface AlternativesInput {
  /** The hard conflicts that refused the claim. */
  blocking: Conflict[];
  /** Active claims in the partition — where the blocking claims' full scope lives. */
  active: Claim[];
  /** Recent claims, active or finished, for inferring what depends on the held code. */
  history: Claim[];
  policy: Policy;
  agentId: string;
}

const key = (s: SymbolRef): string => `${s.file}::${s.symbol}`;

/**
 * Build the "then what?" for a refused claim.
 *
 * The avoid-list is everything the blocking claims hold — not just the symbol that
 * collided, because the holder is changing all of it — plus code inferred to depend on
 * that, so the agent does not step out of one conflict straight into the next.
 */
export function buildAlternatives(input: AlternativesInput): Alternatives {
  const blockingIds = new Set(input.blocking.map((c) => c.claimId));
  const holders = input.active.filter((c) => blockingIds.has(c.id));

  // The claim is the fuller source; the conflict's overlap is the floor, used when the
  // blocking claim is no longer in the active set by the time we look.
  const held: SymbolRef[] = [
    ...holders.flatMap((c) => c.symbols),
    ...input.blocking.flatMap((c) => c.overlap),
  ];
  const dependents = dependentsOf(held, [...input.active, ...input.history]);

  const seen = new Set<string>();
  const avoid: SymbolRef[] = [];
  for (const s of [...held, ...dependents]) {
    const bare = { file: s.file, symbol: s.symbol };
    if (seen.has(key(bare))) continue;
    seen.add(key(bare));
    avoid.push(bare);
  }

  // Only suggest modules that contain nothing on the avoid-list, so the sequencer cannot
  // hand the agent the module it was just refused in.
  const busyModules = new Set(
    avoid.map((s) => moduleForFile(input.policy, s.file)).filter((m): m is string => m !== null),
  );
  const candidates: Task[] = input.policy.modules
    .filter((m) => !busyModules.has(m.name))
    .map((m) => ({ id: m.name, module: m.name }));
  const picked = candidates.length
    ? nextTask(input.policy, candidates, input.active, input.agentId).task
    : null;

  return {
    avoid,
    nextTask: picked,
    notifyOnRelease: true,
    advice: adviceFor(input.blocking, avoid.length, picked),
  };
}

function adviceFor(blocking: Conflict[], avoiding: number, picked: Task | null): string {
  const byAgent = new Map<string, number | undefined>();
  for (const c of blocking) if (!byAgent.has(c.agentId)) byAgent.set(c.agentId, c.etaMinutes);
  const who = [...byAgent]
    .map(([agent, eta]) => (eta != null ? `${agent} (~${eta} min)` : agent))
    .join(", ");
  const next = picked ? ` The sequencer suggests module "${picked.module}".` : "";
  return (
    `Held by ${who}. Don't wait: work on anything outside the ${avoiding} ` +
    `symbol${avoiding === 1 ? "" : "s"} in \`avoid\`.${next} ` +
    `Tower will message you when it frees up — no need to retry.`
  );
}
