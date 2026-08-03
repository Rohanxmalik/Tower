import type { Claim } from "@tower/shared";

/**
 * Intent matching — catching duplicated *work*, not duplicated *files*.
 *
 * The failure this exists for, observed live: two agents independently researched and
 * wrote the same article. They chose different filenames —
 *
 *     ai-agent-security-prompt-injection.mdx     agent A
 *     prompt-injection-agent-security.mdx        agent B
 *
 * — so git merged them cleanly and no file-level check could ever have fired. The cost
 * was two full research-and-write cycles for one deliverable, and the duplication was
 * plainly visible in both `purpose` strings: each said "prompt injection".
 *
 * Crucially the waste happened **before either agent touched a claimable path**. By the
 * time a file existed the tokens were already spent, which is why this is checked at
 * plan time rather than at write time.
 *
 * Deliberately lexical: no model, no embeddings, no network call. Tower promises it
 * makes no network calls you didn't configure, and a matcher that phones an API would
 * break that and send your work descriptions to a third party. Lexical overlap is
 * deterministic, unit-testable, instant, and catches the observed class of duplicate.
 */

/** Words too common to carry meaning about *what* someone is working on. */
const STOPWORDS = new Set([
  "a",
  "about",
  "add",
  "adding",
  "after",
  "all",
  "also",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "between",
  "both",
  "but",
  "by",
  "can",
  "do",
  "does",
  "doing",
  "done",
  "for",
  "from",
  "further",
  "had",
  "has",
  "have",
  "having",
  "here",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "make",
  "making",
  "me",
  "more",
  "most",
  "my",
  "new",
  "no",
  "nor",
  "not",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "our",
  "out",
  "over",
  "own",
  "post",
  "same",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "up",
  "use",
  "using",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "work",
  "working",
  "would",
  "write",
  "writing",
  "you",
  "your",
]);

/**
 * Crude English stemmer — enough to make `agents`/`agent` and `injecting`/`inject` match
 * without pulling in a stemming dependency. Only touches suffixes on longer words so it
 * can't mangle short technical terms.
 */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  // "cache" → "cach" so it meets "caching" → "cach".
  if (word.length > 3 && word.endsWith("e")) return word.slice(0, -1);
  return word;
}

/** Split a purpose string into the meaningful terms it's actually about. */
export function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem)
    .filter((w) => !STOPWORDS.has(w));
  return new Set(words);
}

/**
 * Sørensen–Dice coefficient over the two token sets: `2·|A∩B| / (|A|+|B|)`.
 * Ranges 0 (nothing in common) to 1 (identical). Preferred over raw intersection size
 * because it doesn't reward one side simply being verbose.
 */
export function similarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

/**
 * Default threshold. The observed duplicate — "write a blog post about prompt injection"
 * vs "AI agent security / prompt injection" — shares 2 of {3,5} tokens and scores 0.5.
 * A single incidental shared word tops out at 0.4 (e.g. "auth" against a four-word
 * purpose), so 0.45 separates them with margin.
 */
export const DEFAULT_INTENT_THRESHOLD = 0.45;

export interface IntentMatch {
  claimId: string;
  agentId: string;
  purpose: string;
  /** 0–1. Higher means the two descriptions are more alike. */
  score: number;
  since: number;
  files: string[];
}

export interface MatchIntentOptions {
  /** Minimum score to report. Defaults to {@link DEFAULT_INTENT_THRESHOLD}. */
  threshold?: number;
  /** Ignore this agent's own claims — you don't collide with yourself. */
  agentId?: string;
}

/**
 * Find claims whose stated purpose describes the same work as `purpose`.
 *
 * Pass completed-but-recent claims too: work finished twenty minutes ago is still done,
 * and starting it again is the same waste as starting it in parallel.
 */
export function matchIntent(
  purpose: string,
  claims: Claim[],
  opts: MatchIntentOptions = {},
): IntentMatch[] {
  const threshold = opts.threshold ?? DEFAULT_INTENT_THRESHOLD;
  const matches: IntentMatch[] = [];

  for (const claim of claims) {
    if (opts.agentId && claim.agentId === opts.agentId) continue;
    if (claim.purpose.trim() === "") continue;
    const score = similarity(purpose, claim.purpose);
    if (score < threshold) continue;
    matches.push({
      claimId: claim.id,
      agentId: claim.agentId,
      purpose: claim.purpose,
      score: Math.round(score * 100) / 100,
      since: claim.createdAt,
      files: claim.files,
    });
  }

  return matches.sort((a, b) => b.score - a.score);
}
