import { describe, it, expect, beforeEach } from "vitest";
import { TowerService } from "./service.js";
import { TowerStore } from "./store/sqlite.js";

/**
 * Acceptance tests for the defects found in the 2 Aug 2026 live two-agent session,
 * where **every** collision check returned `conflicts: []`. Each test here failed
 * before 0.9.0.
 */

let svc: TowerService;
beforeEach(() => {
  svc = new TowerService({ store: new TowerStore({ ttlMs: 60_000 }) });
});

const SYMBOL = { file: "src/auth.ts", symbol: "AuthService.verify" };
/** The real root sha from the session — a fork and its upstream share it exactly. */
const ROOT = "caaa8780f2853aec824905cc3278402fc26caa0a";

describe("T1 — a fork and its upstream share one coordination space (REQ-C / TWR-03)", () => {
  it("collides across two repo names that have nothing in common", () => {
    // Exactly the observed failure: these two agents were mutually invisible.
    const upstream = svc.claimIntent({
      agentId: "claude-code-rohan",
      repo: "github.com/Rohanxmalik/genos-ai",
      repoId: ROOT,
      branch: "main",
      files: [],
      symbols: [SYMBOL],
      purpose: "replace JWT",
    });
    expect(upstream.claimId).not.toBeNull();

    const fork = svc.claimIntent({
      agentId: "claude-mayank",
      repo: "github.com/mayank-9031/genos-ai", // a fork — different owner entirely
      repoId: ROOT,
      branch: "main",
      files: [],
      symbols: [SYMBOL],
      purpose: "add rate limiting",
    });

    expect(fork.conflicts).toHaveLength(1);
    expect(fork.conflicts[0]?.severity).toBe("hard");
    expect(fork.conflicts[0]?.agentId).toBe("claude-code-rohan");
  });

  it("still isolates genuinely different projects", () => {
    svc.claimIntent({
      agentId: "a",
      repo: "github.com/acme/one",
      repoId: "a".repeat(40),
      branch: "main",
      files: [],
      symbols: [SYMBOL],
      purpose: "x",
    });
    const other = svc.claimIntent({
      agentId: "b",
      repo: "github.com/acme/two",
      repoId: "b".repeat(40),
      branch: "main",
      files: [],
      symbols: [SYMBOL],
      purpose: "y",
    });
    expect(other.conflicts).toHaveLength(0);
  });
});

describe("T2 — cross-branch overlap is detected, not hidden (TWR-04)", () => {
  it("reports a soft conflict for the same symbol on another branch", () => {
    // Agents normally work on separate feature branches, so this was detection being
    // disabled by default in exactly the situation it exists for.
    svc.claimIntent({
      agentId: "alice",
      repo: "acme/app",
      branch: "main",
      files: [],
      symbols: [SYMBOL],
      purpose: "replace JWT",
    });
    const other = svc.claimIntent({
      agentId: "bob",
      repo: "acme/app",
      branch: "feature/rate-limit",
      files: [],
      symbols: [SYMBOL],
      purpose: "add rate limiting",
    });

    expect(other.conflicts).toHaveLength(1);
    expect(other.conflicts[0]?.severity).toBe("soft");
    expect(other.conflicts[0]?.reason).toContain("main");
    // Soft never blocks — you're told, and you proceed.
    expect(other.blocking).toBe(false);
    expect(other.claimId).not.toBeNull();
  });

  it("keeps same-branch same-symbol at hard", () => {
    svc.claimIntent({
      agentId: "alice",
      repo: "acme/app",
      branch: "main",
      files: [],
      symbols: [SYMBOL],
      purpose: "replace JWT",
    });
    const other = svc.claimIntent({
      agentId: "bob",
      repo: "acme/app",
      branch: "main",
      files: [],
      symbols: [SYMBOL],
      purpose: "add rate limiting",
    });
    expect(other.conflicts[0]?.severity).toBe("hard");
  });
});

describe("T3 — repo string variants collapse to one partition (TWR-02)", () => {
  it("sees agents that spelled the same remote differently", () => {
    const spellings = [
      "git@github.com:Acme/App.git",
      "https://github.com/acme/app",
      "github.com/ACME/APP",
    ];
    spellings.forEach((repo, i) => {
      svc.claimIntent({
        agentId: `agent-${i}`,
        repo,
        branch: "main",
        files: [],
        symbols: [SYMBOL],
        purpose: "same work",
        force: true, // each one after the first is a real hard conflict
      });
    });

    // All three landed in one partition, so the board sees them colliding.
    const { claims } = svc.listClaims({ status: "active" });
    expect(claims).toHaveLength(3);
    expect(new Set(claims.map((c) => c.repoKey)).size).toBe(1);
    expect(svc.boardSnapshot().conflicts.length).toBeGreaterThan(0);
  });
});

describe("T4 — a hard conflict is refused (TWR-05)", () => {
  it("does not register the claim and says stand_down", () => {
    svc.claimIntent({
      agentId: "alice",
      repo: "acme/app",
      branch: "main",
      files: [],
      symbols: [SYMBOL],
      purpose: "replace JWT",
    });

    const blocked = svc.claimIntent({
      agentId: "bob",
      repo: "acme/app",
      branch: "main",
      files: [],
      symbols: [SYMBOL],
      purpose: "add rate limiting",
    });

    expect(blocked.blocking).toBe(true);
    expect(blocked.recommendation).toBe("stand_down");
    expect(blocked.claimId).toBeNull();
    // The important half: nothing was written.
    expect(svc.listClaims({ status: "active" }).claims).toHaveLength(1);
  });

  it("registers when forced, and records the override", () => {
    svc.claimIntent({
      agentId: "alice",
      repo: "acme/app",
      branch: "main",
      files: [],
      symbols: [SYMBOL],
      purpose: "replace JWT",
    });
    const forced = svc.claimIntent({
      agentId: "bob",
      repo: "acme/app",
      branch: "main",
      files: [],
      symbols: [SYMBOL],
      purpose: "add rate limiting",
      force: true,
    });

    expect(forced.blocking).toBe(false);
    expect(forced.claimId).not.toBeNull();
    expect(svc.listClaims({ status: "active" }).claims).toHaveLength(2);
  });

  it("never blocks on a soft conflict", () => {
    svc.claimIntent({
      agentId: "alice",
      repo: "acme/app",
      branch: "main",
      files: [],
      symbols: [{ file: "src/auth.ts", symbol: "login" }],
      purpose: "x",
    });
    const soft = svc.claimIntent({
      agentId: "bob",
      repo: "acme/app",
      branch: "main",
      files: [],
      symbols: [{ file: "src/auth.ts", symbol: "logout" }],
      purpose: "y",
    });
    expect(soft.conflicts[0]?.severity).toBe("soft");
    expect(soft.blocking).toBe(false);
    expect(soft.claimId).not.toBeNull();
  });
});

describe("clean path still works", () => {
  it("registers with no conflicts and recommends proceed", () => {
    const ok = svc.claimIntent({
      agentId: "alice",
      repo: "acme/app",
      branch: "main",
      files: [],
      symbols: [SYMBOL],
      purpose: "replace JWT",
    });
    expect(ok.conflicts).toHaveLength(0);
    expect(ok.blocking).toBe(false);
    expect(ok.recommendation).toBe("proceed");
    expect(ok.claimId).not.toBeNull();
  });
});
