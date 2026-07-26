import { describe, it, expect } from "vitest";
import { hushSqliteWarning } from "./hush.js";

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
