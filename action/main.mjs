// Tower PR-collision action runner. Zero dependencies: global fetch + GitHub REST API.
// On every PR event it compares this PR's touched files/lines against every other open
// PR (and, optionally, live agent claims on a hosted Tower) and upserts one comment.
import { readFileSync } from "node:fs";
import { parsePatchRanges, collidePRs, renderReport, MARKER } from "./lib.mjs";

const API = process.env.GITHUB_API_URL || "https://api.github.com";
const MAX_OTHER_PRS = 30; // API-call budget: enough for small/medium teams

function input(name) {
  const v = process.env[`INPUT_${name.toUpperCase().replaceAll("-", "_")}`];
  return v?.trim() || undefined;
}

async function gh(token, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "tower-collision-action",
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} → ${res.status}`);
  return res.json();
}

/** All pages of a PR's files, as Map<filename, ranges>. */
async function prFiles(token, repo, number) {
  const map = new Map();
  for (let page = 1; page <= 10; page++) {
    const files = await gh(token, `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
    for (const f of files) map.set(f.filename, parsePatchRanges(f.patch));
    if (files.length < 100) break;
  }
  return map;
}

/** Live claims from a hosted Tower that touch any of the given files. Fail-open. */
async function liveClaimsFor(files) {
  const base = input("tower-url")
    ?.replace(/\/mcp\/?$/, "")
    .replace(/\/$/, "");
  if (!base) return [];
  try {
    const token = input("tower-token");
    const res = await fetch(`${base}/api/board`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return [];
    const { claims } = await res.json();
    const touched = new Set(files);
    return claims.filter(
      (c) =>
        (c.files ?? []).some((f) => touched.has(f)) ||
        (c.symbols ?? []).some((s) => touched.has(s.file)),
    );
  } catch {
    return []; // never fail the check because Tower is unreachable
  }
}

async function upsertComment(token, repo, number, body) {
  const comments = await gh(token, `/repos/${repo}/issues/${number}/comments?per_page=100`);
  const existing = comments.find((c) => c.body?.includes(MARKER));
  if (existing) {
    await gh(token, `/repos/${repo}/issues/comments/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
    return "updated";
  }
  await gh(token, `/repos/${repo}/issues/${number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  return "created";
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pr = event.pull_request;
  if (!pr) {
    console.log("Not a pull_request event — nothing to do.");
    return;
  }
  const repo = process.env.GITHUB_REPOSITORY;
  const token = input("github-token") ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error("github-token input (or GITHUB_TOKEN) is required");

  const mine = await prFiles(token, repo, pr.number);
  console.log(`PR #${pr.number} touches ${mine.size} file(s).`);

  const open = await gh(token, `/repos/${repo}/pulls?state=open&per_page=${MAX_OTHER_PRS}`);
  const others = open.filter((p) => p.number !== pr.number);

  const prCollisions = [];
  for (const other of others) {
    const theirs = await prFiles(token, repo, other.number);
    const hits = collidePRs(mine, theirs);
    if (hits.length) {
      prCollisions.push({ number: other.number, title: other.title, url: other.html_url, hits });
    }
  }

  const liveClaims = await liveClaimsFor([...mine.keys()]);
  const hasFindings = prCollisions.length > 0 || liveClaims.length > 0;
  console.log(`${prCollisions.length} colliding PR(s), ${liveClaims.length} live agent claim(s).`);

  // Don't spam clean PRs: only comment when there's something to say, or when a
  // previous report exists and needs to be flipped to all-clear.
  const comments = await gh(token, `/repos/${repo}/issues/${pr.number}/comments?per_page=100`);
  const hadReport = comments.some((c) => c.body?.includes(MARKER));
  if (!hasFindings && !hadReport) {
    console.log("No collisions and no prior report — staying quiet.");
    return;
  }
  const outcome = await upsertComment(
    token,
    repo,
    pr.number,
    renderReport({ prCollisions, liveClaims }),
  );
  console.log(`Report ${outcome}.`);

  if (prCollisions.some((p) => p.hits.some((h) => h.severity === "hard"))) {
    console.log("::warning::Tower found overlapping line ranges with another open PR.");
  }
}

main().catch((err) => {
  // Fail-open: a reporting bug must never block someone's PR.
  console.log(`::warning::tower-collision-action failed: ${err.message}`);
});
