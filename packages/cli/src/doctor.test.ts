import { describe, it, expect } from "vitest";
import {
  runChecks,
  cmdDoctor,
  shellSafeExec,
  type CheckExec,
  type CheckResult,
  type DoctorDeps,
} from "./doctor.js";

describe("shellSafeExec (DEP0190 — no scary warning on first run)", () => {
  it("folds args into the command when a shell is used", () => {
    // Passing a separate args array alongside shell:true makes Node print
    // "can lead to security vulnerabilities" — the first thing a new user sees.
    expect(shellSafeExec("claude", ["--version"], true)).toEqual({
      file: "claude --version",
      args: [],
    });
  });

  it("passes args through untouched without a shell", () => {
    expect(shellSafeExec("git", ["status", "--porcelain"], false)).toEqual({
      file: "git",
      args: ["status", "--porcelain"],
    });
    expect(shellSafeExec("git", ["rev-parse"])).toEqual({
      file: "git",
      args: ["rev-parse"],
    });
  });

  it("handles a shell command that takes no args", () => {
    expect(shellSafeExec("gh", [], true)).toEqual({ file: "gh", args: [] });
  });
});

/** Everything installed and healthy; `git status --porcelain` is clean (empty). */
const okExec: CheckExec = (cmd, args) =>
  Promise.resolve(
    args.join(" ") === "status --porcelain"
      ? { code: 0, out: "" }
      : { code: 0, out: `${cmd} 1.0.0` },
  );

/** fetch stub answering /health with a version and /api/board with a status. */
function fakeFetch(version: string | undefined, boardStatus = 200): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, ...(version ? { version } : {}) }), {
          status: 200,
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: boardStatus }));
  }) as typeof fetch;
}

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    exec: okExec,
    fetchImpl: fakeFetch("0.7.0"),
    nodeVersion: "v22.3.0",
    env: {},
    ...over,
  };
}

const byName = (rs: CheckResult[], n: string): CheckResult | undefined =>
  rs.find((r) => r.name === n);

describe("runChecks", () => {
  it("reports all green on a healthy machine with a matching server", async () => {
    const rs = await runChecks({ url: "http://tower.example", token: "t" }, deps());
    for (const name of ["node", "git", "worktree", "claude", "gh", "server", "token"]) {
      expect(byName(rs, name)?.level, name).toBe("ok");
    }
  });

  it("fails on Node older than 22", async () => {
    const rs = await runChecks({}, deps({ nodeVersion: "v18.19.0" }));
    expect(byName(rs, "node")?.level).toBe("fail");
    expect(byName(rs, "node")?.detail).toContain("22");
  });

  it("fails when not inside a git repository", async () => {
    const exec: CheckExec = (cmd, args) =>
      cmd === "git" && args[0] === "rev-parse"
        ? Promise.resolve({ code: 128, out: "not a git repository" })
        : okExec(cmd, args);
    const rs = await runChecks({}, deps({ exec }));
    expect(byName(rs, "git")?.level).toBe("fail");
  });

  it("warns on a dirty working tree (the worker refuses tasks on it)", async () => {
    const exec: CheckExec = (cmd, args) =>
      args.join(" ") === "status --porcelain"
        ? Promise.resolve({ code: 0, out: " M src/app.ts" })
        : okExec(cmd, args);
    const rs = await runChecks({}, deps({ exec }));
    expect(byName(rs, "worktree")?.level).toBe("warn");
  });

  it("warns (not fails) when the claude runner is missing", async () => {
    const exec: CheckExec = (cmd, args) =>
      cmd === "claude" ? Promise.resolve({ code: 1, out: "" }) : okExec(cmd, args);
    const rs = await runChecks({}, deps({ exec }));
    expect(byName(rs, "claude")?.level).toBe("warn");
    expect(byName(rs, "claude")?.detail).toContain("PATH");
  });

  it("warns on server version drift", async () => {
    const rs = await runChecks(
      { url: "http://tower.example" },
      deps({ fetchImpl: fakeFetch("0.6.1") }),
    );
    expect(byName(rs, "server")?.level).toBe("warn");
    expect(byName(rs, "server")?.detail).toContain("0.6.1");
  });

  it("accepts a pre-0.7 server that reports no version", async () => {
    const rs = await runChecks(
      { url: "http://tower.example" },
      deps({ fetchImpl: fakeFetch(undefined) }),
    );
    expect(byName(rs, "server")?.level).toBe("ok");
  });

  it("fails on a rejected token and warns on a lockout", async () => {
    const rejected = await runChecks(
      { url: "http://tower.example", token: "wrong" },
      deps({ fetchImpl: fakeFetch("0.7.0", 401) }),
    );
    expect(byName(rejected, "token")?.level).toBe("fail");

    const locked = await runChecks(
      { url: "http://tower.example", token: "t" },
      deps({ fetchImpl: fakeFetch("0.7.0", 429) }),
    );
    expect(byName(locked, "token")?.level).toBe("warn");
  });

  it("fails when the server is unreachable", async () => {
    const boom = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const rs = await runChecks({ url: "http://tower.example" }, deps({ fetchImpl: boom }));
    expect(byName(rs, "server")?.level).toBe("fail");
  });

  it("reads TOWER_URL/TOWER_TOKEN from the environment when no flags are given", async () => {
    const rs = await runChecks(
      {},
      deps({ env: { TOWER_URL: "http://tower.example", TOWER_TOKEN: "t" } }),
    );
    expect(byName(rs, "server")?.level).toBe("ok");
    expect(byName(rs, "token")?.level).toBe("ok");
  });
});

describe("cmdDoctor", () => {
  it("exits 0 when nothing blocking failed", async () => {
    const lines: string[] = [];
    const code = await cmdDoctor({}, (l) => lines.push(l), deps());
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("ready");
  });

  it("exits 1 when a required check fails", async () => {
    const lines: string[] = [];
    const code = await cmdDoctor({}, (l) => lines.push(l), deps({ nodeVersion: "v20.0.0" }));
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("blocking");
  });
});
