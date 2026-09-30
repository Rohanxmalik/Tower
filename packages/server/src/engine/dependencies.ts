import type { Claim, SymbolRef } from "@tower/shared";

/**
 * A dependency map inferred from what agents actually read — no policy file needed.
 *
 * Every claim records what it wrote and, since 0.11.0, what it read. A claim that wrote
 * `checkout()` having read `verify()` is direct evidence that `checkout()` was built
 * against `verify()`. Collected across recent claims, that is a usable map of "what
 * depends on what" that nobody had to write down — the thing `.tower/policy.yaml` asked
 * every team to hand-author at folder granularity, and almost none did.
 *
 * Deliberately one hop. It is advisory — it widens what a refused agent is told to stay
 * out of — so it must never manufacture a conflict, and a transitive closure over a
 * guessed graph would turn one hub symbol into "avoid the whole repo".
 */

/** Cap on how many dependents one lookup returns, so a hub symbol that half the codebase
 * read cannot turn a refusal into a wall of paths. */
export const MAX_DEPENDENTS = 50;

/** Whether a read touches a target. A whole-file target (symbol "") covers every
 * symbol read in that file. */
function reads(target: SymbolRef, read: SymbolRef): boolean {
  if (read.file !== target.file) return false;
  return target.symbol === "" || read.symbol === target.symbol;
}

/**
 * Symbols written by work that read any of `targets`, excluding the targets themselves.
 * Returned as bare `{file, symbol}` — the fingerprints belonged to one read at one moment
 * and mean nothing to whoever receives the list.
 */
export function dependentsOf(targets: SymbolRef[], claims: Claim[]): SymbolRef[] {
  const isTarget = (s: SymbolRef): boolean =>
    targets.some((t) => t.file === s.file && (t.symbol === "" || t.symbol === s.symbol));
  const seen = new Set<string>();
  const out: SymbolRef[] = [];

  for (const claim of claims) {
    const builtOnTarget = (claim.reads ?? []).some((r) => targets.some((t) => reads(t, r)));
    if (!builtOnTarget) continue;
    for (const written of claim.symbols) {
      if (isTarget(written)) continue;
      const key = `${written.file}::${written.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file: written.file, symbol: written.symbol });
      if (out.length >= MAX_DEPENDENTS) return out;
    }
  }
  return out;
}
