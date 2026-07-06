import { describe, it, expect } from "vitest";
import { parsePatchRanges, collidePRs, renderReport } from "./lib.mjs";

describe("parsePatchRanges", () => {
  it("extracts new-file line ranges from hunk headers", () => {
    const patch = `@@ -10,4 +12,6 @@ function x() {\n context\n+added\n@@ -40,0 +50,3 @@\n+more`;
    expect(parsePatchRanges(patch)).toEqual([
      { start: 12, end: 18 },
      { start: 50, end: 53 },
    ]);
  });

  it("handles single-line hunks (no comma) and missing patches", () => {
    expect(parsePatchRanges("@@ -1 +1 @@\n-x\n+y")).toEqual([{ start: 1, end: 2 }]);
    expect(parsePatchRanges(undefined)).toEqual([]);
  });
});

describe("collidePRs", () => {
  const mine = new Map([
    ["src/auth.ts", [{ start: 10, end: 30 }]],
    ["src/db.ts", [{ start: 1, end: 5 }]],
  ]);

  it("flags overlapping line ranges in the same file as hard", () => {
    const theirs = new Map([["src/auth.ts", [{ start: 25, end: 40 }]]]);
    const hits = collidePRs(mine, theirs);
    expect(hits).toEqual([
      { file: "src/auth.ts", severity: "hard", lines: { start: 25, end: 30 } },
    ]);
  });

  it("flags same file with disjoint ranges as soft", () => {
    const theirs = new Map([["src/db.ts", [{ start: 100, end: 110 }]]]);
    expect(collidePRs(mine, theirs)).toEqual([
      { file: "src/db.ts", severity: "soft", lines: null },
    ]);
  });

  it("returns nothing for disjoint files", () => {
    const theirs = new Map([["README.md", [{ start: 1, end: 2 }]]]);
    expect(collidePRs(mine, theirs)).toEqual([]);
  });
});

describe("renderReport", () => {
  it("renders collisions per PR plus live agent claims, with the upsert marker", () => {
    const md = renderReport({
      prCollisions: [
        {
          number: 12,
          title: "Refactor auth",
          url: "https://github.com/x/y/pull/12",
          hits: [{ file: "src/auth.ts", severity: "hard", lines: { start: 25, end: 30 } }],
        },
      ],
      liveClaims: [
        { agentId: "claude-ab", files: ["src/auth.ts"], symbols: [], purpose: "replace JWT" },
      ],
    });
    expect(md).toContain("<!-- tower-collision-report -->");
    expect(md).toContain("#12");
    expect(md).toContain("src/auth.ts");
    expect(md).toContain("25–30");
    expect(md).toContain("claude-ab");
  });

  it("renders an all-clear when nothing collides", () => {
    const md = renderReport({ prCollisions: [], liveClaims: [] });
    expect(md).toContain("No collisions");
  });
});
