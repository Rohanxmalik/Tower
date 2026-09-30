import { createHash } from "node:crypto";

/**
 * Declaration fingerprints, with no parser attached.
 *
 * Split out of `symbols.ts` so the collision engine can fingerprint a *declared*
 * contract — the signature an agent says it is about to write — without loading the
 * tree-sitter WASM. There is exactly one normalization, here, used both for code parsed
 * off disk and for text an agent declares. Two copies would drift, and the first sign
 * of drift would be a correct reader warned that its contract moved.
 */

/** Scheme tag on every fingerprint. Bump it when the normalization below changes, so an
 * old `c1:` digest is never compared against a new one and read as "unchanged". */
export const SIG_SCHEME = "c1";

/** Cap on the stored declaration text. Long enough to read a signature back, short
 * enough that a pathological one cannot bloat every claim that touches it. */
export const SIG_TEXT_MAX = 240;

/** For display: collapse runs of whitespace, keep it readable. */
export function readableDeclaration(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * For comparison: drop whitespace entirely and the trailing comma prettier leaves when
 * it breaks a parameter list across lines. `verify(token: string)` and
 * `verify(\n  token: string,\n)` are the same contract, and a fingerprint that
 * disagreed would fire on every reformat — the fastest way to get the feature muted.
 *
 * A leading `export` / `export default` is dropped too. The parser fingerprints the
 * declaration node, which sits inside the export, so parsed text never carries the
 * keyword; an agent declaring a contract writes it naturally. It is visibility, not
 * contract. Parsed text never starts with it, so no stored `c1:` digest changes.
 */
export function canonicalDeclaration(text: string): string {
  return text
    .replace(/^\s*export\s+(default\s+)?/, "")
    .replace(/\s+/g, "")
    .replace(/,(?=[)\]}>])/g, "");
}

/**
 * Fingerprint declaration text. Returns the digest plus the readable form, so a
 * staleness report can show `verify(token)` → `verify(token, opts)` rather than sending
 * the agent back to re-read the file. `undefined` for text with nothing in it.
 */
export function fingerprintDeclaration(text: string): { sig: string; sigText: string } | undefined {
  const canonical = canonicalDeclaration(text);
  if (canonical === "") return undefined;
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return {
    sig: `${SIG_SCHEME}:${digest}`,
    sigText: readableDeclaration(text).slice(0, SIG_TEXT_MAX),
  };
}
