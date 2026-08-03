/**
 * Repository identity.
 *
 * Claims are partitioned by repository, so the partition key decides whether two
 * agents can see each other at all. Two failure modes were observed in the field:
 *
 * 1. The same repo spelled differently (`git@…` vs `https://…`, trailing `.git`,
 *    different casing) split one team into isolated groups.
 * 2. A **fork** (`mayank-9031/genos-ai`) and its upstream (`Rohanxmalik/genos-ai`)
 *    were treated as unrelated projects, even though they share a codebase and
 *    target the same branch by pull request. No amount of string normalization
 *    fixes that — the names have nothing in common.
 *
 * So there are two keys here, in order of preference:
 *
 * - **`repoId`** — the repository's **root commit SHA**. Identical across every
 *   clone, fork and mirror; survives renames and transfers; needs no API call and
 *   no authentication; works for non-GitHub remotes. Derived by the CLI and hooks
 *   with `git rev-list --max-parents=0 HEAD`.
 * - **`normalizeRepoUrl(repo)`** — the fallback for callers that don't send a
 *   `repoId`, and the human-readable label on the board either way.
 */

/**
 * Normalize a git remote URL to a stable `host/owner/repo` id.
 *
 * ```
 * git@github.com:Acme/App.git      → github.com/acme/app
 * https://github.com/Acme/App.git  → github.com/acme/app
 * ssh://git@github.com/Acme/App    → github.com/acme/app
 * ```
 */
export function normalizeRepoUrl(url: string): string {
  return url
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^ssh:\/\/git@/, "")
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * The partition key every server read and write must agree on.
 *
 * Prefers `repoId` (root commit SHA — fork-proof) and falls back to the normalized
 * remote URL, so older clients that don't send a `repoId` still converge with each
 * other instead of splitting on spelling.
 *
 * This is the single chokepoint: if a code path touches claims, messages, tasks or
 * decisions, it resolves its key here rather than comparing raw strings.
 */
export function resolveRepoKey(repoId: string | undefined, repo: string): string {
  const id = (repoId ?? "").trim();
  if (id !== "") return id.toLowerCase();
  return normalizeRepoUrl(repo);
}

/** A 40-char hex SHA-1, or the 64-char SHA-256 git is moving to. */
const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;

/** True if a string looks like a git object id — used to sanity-check a supplied `repoId`. */
export function isRepoId(value: string): boolean {
  return SHA_RE.test(value.trim());
}

/**
 * Pick the repository id from the output of `git rev-list --max-parents=0 HEAD`.
 *
 * Most repos have exactly one root commit. Repos assembled from merged histories can
 * have several; git lists them newest-first, so the **last** line is the earliest
 * commit and the one every fork shares. Returns `undefined` when the output holds no
 * usable sha, so callers fall back to the URL rather than keying on garbage.
 */
export function pickRootCommit(revListOutput: string): string | undefined {
  const shas = revListOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => isRepoId(l));
  const earliest = shas[shas.length - 1];
  return earliest ? earliest.toLowerCase() : undefined;
}
