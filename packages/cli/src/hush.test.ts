import { describe, it, expect } from "vitest";
import { hushSqliteWarning, requireModernNode } from "./hush.js";

describe("requireModernNode", () => {
  it("accepts the versions where node:sqlite is unflagged", () => {
    for (const v of ["22.13.0", "22.20.1", "23.4.0", "24.13.1", "25.0.0"]) {
      expect(requireModernNode(v).ok).toBe(true);
    }
  });

  it("rejects the flagged window — the gap that shipped a raw stack trace to a real user", () => {
    // node:sqlite existed from 22.5 but stayed behind --experimental-sqlite
    // until 23.4 (backported to 22.13). A `>= 22.5` check passed these and then
    // died with ERR_UNKNOWN_BUILTIN_MODULE. 23.3.0 is the version that hit it.
    for (const v of ["22.5.0", "22.11.0", "22.12.0", "23.0.0", "23.3.0"]) {
      expect(requireModernNode(v).ok).toBe(false);
    }
  });

  it("rejects Node older than 22.5 too", () => {
    for (const v of ["20.11.0", "22.0.0", "22.4.1"]) {
      expect(requireModernNode(v).ok).toBe(false);
    }
  });

  it("names the version, the fix, and the flag escape hatch", () => {
    const result = requireModernNode("23.3.0");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("23.3.0");
      expect(result.message).toContain("22.13");
      expect(result.message).toContain("nodejs.org");
      expect(result.message).toContain("--experimental-sqlite");
    }
  });

  it("accepts a flagged Node when the user opted in via NODE_OPTIONS", () => {
    const before = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--experimental-sqlite";
    try {
      expect(requireModernNode("23.3.0").ok).toBe(true);
    } finally {
      if (before === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = before;
    }
  });
});
import { PRE_COMMIT_HOOK, POST_COMMIT_HOOK_SCRIPT } from "./lib.js";

describe("installed git hooks run outside this monorepo", () => {
  // `tower setup --hooks` writes these into a USER's repo, where a relative
  // path like packages/cli/dist/index.js resolves to nothing — and the hook
  // swallows its own errors, so the breakage is silent.
  for (const [name, hook] of [
    ["pre-commit", PRE_COMMIT_HOOK],
    ["post-commit", POST_COMMIT_HOOK_SCRIPT],
  ] as const) {
    it(`${name} invokes tower via npx, never a repo-relative path`, () => {
      expect(hook).toContain("npx -y tower-mcp");
      expect(hook).not.toContain("packages/cli/dist");
      expect(hook).not.toContain("node packages/");
    });
  }
});

/** A stand-in for `process` that records what would have been printed. */
function fakeProc() {
  const seen: string[] = [];
  const proc = {
    emitWarning: (warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === "string" ? warning : warning.message;
      seen.push(`${typeof warning === "string" ? String(rest[0] ?? "") : warning.name}: ${text}`);
    },
  };
  return { proc, seen };
}

describe("hushSqliteWarning", () => {
  it("swallows the node:sqlite experimental warning", () => {
    const { proc, seen } = fakeProc();
    hushSqliteWarning(proc);

    proc.emitWarning(
      "SQLite is an experimental feature and might change at any time",
      "ExperimentalWarning",
    );

    expect(seen).toEqual([]);
  });

  it("still lets every other warning through", () => {
    const { proc, seen } = fakeProc();
    hushSqliteWarning(proc);

    proc.emitWarning("something is deprecated", "DeprecationWarning");
    proc.emitWarning(
      Object.assign(new Error("fetch is experimental"), { name: "ExperimentalWarning" }),
    );

    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("something is deprecated");
    expect(seen[1]).toContain("fetch is experimental");
  });

  it("swallows the warning when it arrives as an Error object", () => {
    const { proc, seen } = fakeProc();
    hushSqliteWarning(proc);

    proc.emitWarning(
      Object.assign(new Error("SQLite is an experimental feature"), {
        name: "ExperimentalWarning",
      }),
    );

    expect(seen).toEqual([]);
  });
});
