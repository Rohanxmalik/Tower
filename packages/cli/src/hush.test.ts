import { describe, it, expect } from "vitest";
import { hushSqliteWarning, requireModernNode } from "./hush.js";

describe("requireModernNode", () => {
  it("accepts 22.5 and newer", () => {
    for (const v of ["22.5.0", "22.11.0", "23.0.0", "24.13.1"]) {
      expect(requireModernNode(v).ok).toBe(true);
    }
  });

  it("rejects Node older than 22.5 with an actionable message, not a stack trace", () => {
    // node:sqlite landed in 22.5 — 22.0–22.4 fail the same way as Node 20.
    for (const v of ["20.11.0", "22.0.0", "22.4.1"]) {
      const result = requireModernNode(v);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("22.5");
        expect(result.message).toContain(v);
        expect(result.message).toContain("nodejs.org");
      }
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
