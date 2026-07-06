import { describe, it, expect } from "vitest";
import { formatAgo, renderConflicts, renderClaimsTable } from "./render.js";
import type { Claim, Conflict } from "@tower/shared";

function claim(over: Partial<Claim> = {}): Claim {
  return {
    id: "c1",
    agentId: "cursor-bob",
    repo: "r",
    branch: "main",
    files: ["src/auth.ts"],
    symbols: [{ file: "src/auth.ts", symbol: "AuthService.verify" }],
    purpose: "replace JWT",
    status: "active",
    etaMinutes: 6,
    createdAt: 0,
    expiresAt: 10,
    ...over,
  };
}

describe("formatAgo", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatAgo(5_000)).toBe("5s ago");
    expect(formatAgo(120_000)).toBe("2m ago");
    expect(formatAgo(3_600_000)).toBe("1h ago");
  });
});

describe("renderConflicts", () => {
  it("shows the safe message when there are no conflicts", () => {
    expect(renderConflicts([], () => undefined)).toContain("safe to proceed");
  });

  it("renders the hero hard-collision prompt with context", () => {
    const conflict: Conflict = {
      claimId: "c1",
      agentId: "cursor-bob",
      severity: "hard",
      reason: "Overlaps AuthService.verify",
      overlap: [{ file: "src/auth.ts", symbol: "AuthService.verify" }],
      etaMinutes: 6,
    };
    const out = renderConflicts([conflict], () => claim(), 120_000);
    expect(out).toContain("⛔ COLLISION — AuthService.verify");
    expect(out).toContain('Agent "cursor-bob"');
    expect(out).toContain("ETA ~6m");
    expect(out).toContain("purpose: replace JWT");
    expect(out).toContain("[b] branch");
  });

  it("renders a soft overlap with gentler options", () => {
    const conflict: Conflict = {
      claimId: "c1",
      agentId: "gem",
      severity: "soft",
      reason: "same file",
      overlap: [{ file: "src/auth.ts", symbol: "" }],
    };
    const out = renderConflicts([conflict], () => claim());
    expect(out).toContain("⚠️  OVERLAP");
    expect(out).toContain("[c] continue (careful)");
  });
});

describe("renderClaimsTable", () => {
  it("says when empty", () => {
    expect(renderClaimsTable([])).toBe("No active claims.");
  });

  it("lists claims with target and purpose", () => {
    const out = renderClaimsTable([claim()], 60_000);
    expect(out).toContain("Active claims (1)");
    expect(out).toContain("cursor-bob");
    expect(out).toContain("AuthService.verify");
    expect(out).toContain("replace JWT");
  });
});

describe("actionable options menu", () => {
  it("hard collisions point at the real commands", () => {
    const conflicts: Conflict[] = [
      {
        claimId: "c1",
        agentId: "cursor-bob",
        severity: "hard",
        reason: "same symbol",
        overlap: [{ file: "src/auth.ts", symbol: "AuthService.verify" }],
      },
    ];
    const outText = renderConflicts(conflicts, () => claim(), 1_000);
    expect(outText).toContain("tower next-task");
    expect(outText).toContain("--force");
    expect(outText).toContain("[w] wait");
  });
});
