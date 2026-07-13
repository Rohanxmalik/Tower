import { execFile } from "node:child_process";
import { TOWER_VERSION } from "@tower/shared";
import type { Writer } from "./commands.js";

/**
 * `tower doctor` — setup diagnostics. Answers "why doesn't delegation work on this
 * machine?" in one command: Node, git, runners on PATH, gh auth, and (when a server
 * is configured) reachability + token + version drift.
 */

export type Level = "ok" | "warn" | "fail" | "info";

export interface CheckResult {
  name: string;
  level: Level;
  detail: string;
}

/** Minimal exec for checks; injectable so every ✅/❌ path is unit-testable. */
export type CheckExec = (
  cmd: string,
  args: string[],
  shell?: boolean,
) => Promise<{ code: number; out: string }>;

export const realExec: CheckExec = (cmd, args, shell) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      // shell:true lets the Windows .cmd shims (claude/codex/gh) spawn at all.
      { ...(shell ? { shell: true } : {}), timeout: 15_000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
      },
    );
  });

export interface DoctorDeps {
  exec: CheckExec;
  fetchImpl: typeof fetch;
  /** e.g. process.version — "v22.3.0" */
  nodeVersion: string;
  env: Record<string, string | undefined>;
}

export async function runChecks(
  opts: { url?: string; token?: string },
  deps: DoctorDeps,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Node ≥ 22 — tower runs on the built-in node:sqlite.
  const major = Number(/^v?(\d+)/.exec(deps.nodeVersion)?.[1] ?? 0);
  results.push(
    major >= 22
      ? { name: "node", level: "ok", detail: `${deps.nodeVersion} (needs ≥22)` }
      : {
          name: "node",
          level: "fail",
          detail: `${deps.nodeVersion} — Tower needs Node 22+ (built-in SQLite). https://nodejs.org`,
        },
  );

  // git present + inside a repo + clean tree (the worker refuses dirty trees).
  const inTree = await deps.exec("git", ["rev-parse", "--is-inside-work-tree"]);
  if (inTree.code !== 0) {
    results.push({
      name: "git",
      level: "fail",
      detail: "not inside a git repository (or git missing) — run tower from your repo",
    });
  } else {
    results.push({ name: "git", level: "ok", detail: "inside a work tree" });
    const dirty = await deps.exec("git", ["status", "--porcelain"]);
    results.push(
      dirty.out.trim()
        ? {
            name: "worktree",
            level: "warn",
            detail: "dirty — the worker refuses tasks until it's clean (commit or stash)",
          }
        : { name: "worktree", level: "ok", detail: "clean" },
    );
  }

  // Runners + gh on PATH (via shell for the Windows .cmd shims).
  const probe = async (name: string, missLevel: Level, hint: string): Promise<void> => {
    const p = await deps.exec(name, ["--version"], true);
    results.push(
      p.code === 0
        ? { name, level: "ok", detail: (p.out.split("\n")[0] ?? "").trim() || "found" }
        : { name, level: missLevel, detail: hint },
    );
  };
  await probe(
    "claude",
    "warn",
    "not on PATH — the default runner won't work (npm i -g @anthropic-ai/claude-code)",
  );
  await probe("codex", "info", "not on PATH — only needed for --runner codex");
  const gh = await deps.exec("gh", ["auth", "status"], true);
  results.push(
    gh.code === 0
      ? { name: "gh", level: "ok", detail: "authenticated — workers can open PRs" }
      : {
          name: "gh",
          level: "warn",
          detail: "missing/unauthenticated — branches push but no PRs (run: gh auth login)",
        },
  );

  // Team server: reachable, version-aligned, token accepted.
  const url = opts.url ?? deps.env.TOWER_URL;
  const token = opts.token ?? deps.env.TOWER_TOKEN;
  if (!url) {
    results.push({
      name: "server",
      level: "info",
      detail: "no TOWER_URL set — local mode (nothing to check)",
    });
    return results;
  }
  try {
    const origin = new URL(url).origin;
    const health = await deps.fetchImpl(origin + "/health");
    if (!health.ok) {
      results.push({
        name: "server",
        level: "fail",
        detail: `${origin}/health → ${health.status}`,
      });
    } else {
      const v = ((await health.json()) as { version?: string }).version;
      const mm = (s: string) => s.split(".").slice(0, 2).join(".");
      results.push(
        v && mm(v) !== mm(TOWER_VERSION)
          ? {
              name: "server",
              level: "warn",
              detail: `reachable, but server is ${v} and this CLI ${TOWER_VERSION} — upgrade the older side`,
            }
          : { name: "server", level: "ok", detail: `reachable${v ? ` (v${v})` : ""}` },
      );
    }
    if (!token) {
      results.push({
        name: "token",
        level: "info",
        detail: "no TOWER_TOKEN set — skipping auth check",
      });
    } else {
      const board = await deps.fetchImpl(origin + "/api/board", {
        headers: { authorization: `Bearer ${token}` },
      });
      results.push(
        board.status === 200
          ? { name: "token", level: "ok", detail: "accepted" }
          : board.status === 401
            ? { name: "token", level: "fail", detail: "rejected (401) — wrong TOWER_TOKEN" }
            : board.status === 429
              ? {
                  name: "token",
                  level: "warn",
                  detail: "locked out (429) — too many failed attempts from this IP; wait ~1 min",
                }
              : { name: "token", level: "warn", detail: `unexpected status ${board.status}` },
      );
    }
  } catch {
    results.push({
      name: "server",
      level: "fail",
      detail: `cannot reach ${url} — is the server up? (TOWER_URL)`,
    });
  }
  return results;
}

const ICON: Record<Level, string> = { ok: "✅", warn: "⚠️ ", fail: "❌", info: "ℹ️ " };

/** Prints every check and returns the exit code (1 when anything blocking failed). */
export async function cmdDoctor(
  opts: { url?: string; token?: string },
  out: Writer,
  deps: Partial<DoctorDeps> = {},
): Promise<number> {
  const d: DoctorDeps = {
    exec: deps.exec ?? realExec,
    fetchImpl: deps.fetchImpl ?? fetch,
    nodeVersion: deps.nodeVersion ?? process.version,
    env: deps.env ?? process.env,
  };
  out("tower doctor — is this machine ready to run delegated work?");
  out("");
  const results = await runChecks(opts, d);
  for (const c of results) out(`${ICON[c.level]} ${c.name.padEnd(9)} ${c.detail}`);
  const fails = results.filter((c) => c.level === "fail").length;
  out("");
  out(
    fails
      ? `❌ ${fails} blocking issue(s) — fix the ❌ lines above.`
      : "✅ ready — this machine can run `tower work`.",
  );
  return fails ? 1 : 0;
}
