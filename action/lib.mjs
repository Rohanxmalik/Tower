// Pure logic for the Tower PR-collision action — no deps, unit-tested in lib.test.mjs.

/**
 * Parse a unified-diff `patch` (as returned by the GitHub "list PR files" API) into the
 * line ranges the PR touches in the NEW version of the file. Range end is exclusive.
 * @param {string | undefined} patch
 * @returns {{ start: number; end: number }[]}
 */
export function parsePatchRanges(patch) {
  if (!patch) return [];
  const ranges = [];
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  for (let m = hunk.exec(patch); m; m = hunk.exec(patch)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    ranges.push({ start, end: start + count });
  }
  return ranges;
}

/**
 * Collide two PRs' touched files. Overlapping line ranges in the same file → `hard`
 * (a merge conflict in the making); same file, disjoint ranges → `soft`.
 * @param {Map<string, {start:number;end:number}[]>} mine
 * @param {Map<string, {start:number;end:number}[]>} theirs
 * @returns {{ file: string; severity: "hard"|"soft"; lines: {start:number;end:number}|null }[]}
 */
export function collidePRs(mine, theirs) {
  const hits = [];
  for (const [file, myRanges] of mine) {
    const theirRanges = theirs.get(file);
    if (!theirRanges) continue;
    let overlap = null;
    for (const a of myRanges) {
      for (const b of theirRanges) {
        const start = Math.max(a.start, b.start);
        const end = Math.min(a.end, b.end);
        if (start < end && (!overlap || start < overlap.start)) overlap = { start, end };
      }
    }
    hits.push(
      overlap
        ? { file, severity: "hard", lines: overlap }
        : { file, severity: "soft", lines: null },
    );
  }
  return hits.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "hard" ? -1 : 1));
}

export const MARKER = "<!-- tower-collision-report -->";

/**
 * Render the PR comment.
 * @param {{
 *   prCollisions: { number:number; title:string; url:string;
 *     hits:{file:string;severity:"hard"|"soft";lines:{start:number;end:number}|null}[] }[];
 *   liveClaims: { agentId:string; files:string[]; symbols:{file:string;symbol:string}[]; purpose:string }[];
 * }} input
 * @returns {string} markdown
 */
export function renderReport({ prCollisions, liveClaims }) {
  const lines = [MARKER, "## 🗼 Tower collision report", ""];
  if (!prCollisions.length && !liveClaims.length) {
    lines.push("✅ **No collisions** — no other open PR (or live agent) touches these files.");
  }
  for (const pr of prCollisions) {
    lines.push(`### ⚠️ Overlaps [#${pr.number} — ${pr.title}](${pr.url})`, "");
    for (const h of pr.hits) {
      lines.push(
        h.severity === "hard"
          ? `- ⛔ \`${h.file}\` — **overlapping lines ${h.lines.start}–${h.lines.end}** (merge conflict likely)`
          : `- △ \`${h.file}\` — same file, different regions`,
      );
    }
    lines.push("");
  }
  if (liveClaims.length) {
    lines.push("### 🔴 Live agents on these files right now", "");
    for (const c of liveClaims) {
      const what = c.symbols?.filter((s) => s.symbol).map((s) => s.symbol) ?? [];
      const scope = what.length ? what.join(", ") : (c.files ?? []).join(", ");
      lines.push(
        `- **${c.agentId}** is mid-change on \`${scope}\`${c.purpose ? ` — “${c.purpose}”` : ""}`,
      );
    }
    lines.push("");
  }
  lines.push(
    "",
    "<sub>Posted by [Tower](https://github.com/Rohanxmalik/Tower) — pre-flight collision detection for AI agents & teams.</sub>",
  );
  return lines.join("\n");
}
