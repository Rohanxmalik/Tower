import { describe, it, expect } from "vitest";
import { detectCollisions } from "./collision.js";
import type { Claim } from "@tower/shared";

function activeClaim(over: Partial<Claim> = {}): Claim {
  return {
    id: "claim-b",
    agentId: "cursor-bob",
    repo: "acme/app",
    branch: "main",
    files: ["src/auth.ts"],
    symbols: [{ file: "src/auth.ts", symbol: "AuthService.verify" }],
    purpose: "replace JWT",
    status: "active",
    etaMinutes: 6,
    createdAt: 1,
    expiresAt: 999,
    ...over,
  };
}

describe("detectCollisions — hard", () => {
  it("flags the same file+symbol as hard", () => {
    const conflicts = detectCollisions(
      {
        agentId: "claude-a",
        files: [],
        symbols: [{ file: "src/auth.ts", symbol: "AuthService.verify" }],
      },
      [activeClaim()],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.severity).toBe("hard");
    expect(conflicts[0]!.agentId).toBe("cursor-bob");
    expect(conflicts[0]!.etaMinutes).toBe(6);
    expect(conflicts[0]!.reason).toContain("AuthService.verify");
  });

  it("treats a whole-file claim as hard against any symbol in that file", () => {
    const conflicts = detectCollisions(
      { agentId: "claude-a", files: ["src/auth.ts"], symbols: [] },
      [activeClaim()],
    );
    expect(conflicts[0]!.severity).toBe("hard");
  });

  it("treats an incoming symbol as hard against a whole-file active claim", () => {
    const conflicts = detectCollisions(
      { agentId: "claude-a", files: [], symbols: [{ file: "src/auth.ts", symbol: "login" }] },
      [activeClaim({ files: ["src/auth.ts"], symbols: [] })],
    );
    expect(conflicts[0]!.severity).toBe("hard");
  });
});

describe("detectCollisions — soft", () => {
  it("flags same file, different symbols as soft", () => {
    const conflicts = detectCollisions(
      {
        agentId: "claude-a",
        files: [],
        symbols: [{ file: "src/auth.ts", symbol: "AuthService.refresh" }],
      },
      [activeClaim()],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.severity).toBe("soft");
    expect(conflicts[0]!.reason).toContain("same file");
  });
});

describe("detectCollisions — no conflict", () => {
  it("returns nothing for disjoint files", () => {
    const conflicts = detectCollisions(
      { agentId: "claude-a", files: [], symbols: [{ file: "src/dashboard.ts", symbol: "render" }] },
      [activeClaim()],
    );
    expect(conflicts).toEqual([]);
  });

  it("ignores the agent's own active claims", () => {
    const conflicts = detectCollisions(
      {
        agentId: "cursor-bob",
        files: [],
        symbols: [{ file: "src/auth.ts", symbol: "AuthService.verify" }],
      },
      [activeClaim()],
    );
    expect(conflicts).toEqual([]);
  });

  it("ignores non-active claims", () => {
    const conflicts = detectCollisions(
      {
        agentId: "claude-a",
        files: [],
        symbols: [{ file: "src/auth.ts", symbol: "AuthService.verify" }],
      },
      [activeClaim({ status: "completed" })],
    );
    expect(conflicts).toEqual([]);
  });
});

describe("detectCollisions — multiple claims & ranking", () => {
  it("returns one conflict per claim, most severe first", () => {
    const soft = activeClaim({
      id: "soft-claim",
      agentId: "gemini-c",
      symbols: [{ file: "src/auth.ts", symbol: "AuthService.refresh" }],
    });
    const hard = activeClaim({
      id: "hard-claim",
      agentId: "cursor-bob",
      symbols: [{ file: "src/auth.ts", symbol: "AuthService.verify" }],
    });
    const conflicts = detectCollisions(
      {
        agentId: "claude-a",
        files: [],
        symbols: [{ file: "src/auth.ts", symbol: "AuthService.verify" }],
      },
      [soft, hard],
    );
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0]!.severity).toBe("hard");
    expect(conflicts[0]!.claimId).toBe("hard-claim");
    expect(conflicts[1]!.severity).toBe("soft");
  });

  it("escalates to hard when a claim overlaps on multiple symbols incl. an exact match", () => {
    const conflicts = detectCollisions(
      {
        agentId: "claude-a",
        files: [],
        symbols: [
          { file: "src/auth.ts", symbol: "AuthService.refresh" },
          { file: "src/auth.ts", symbol: "AuthService.verify" },
        ],
      },
      [activeClaim()],
    );
    expect(conflicts[0]!.severity).toBe("hard");
  });
});
