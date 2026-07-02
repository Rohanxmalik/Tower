import { describe, it, expect, beforeEach } from "vitest";
import { TowerService } from "./service.js";
import { TowerStore } from "./store/sqlite.js";
import { parsePolicy } from "./engine/sequencer.js";

let clock = 1_000;
function makeService(): TowerService {
  clock = 1_000;
  const store = new TowerStore({ now: () => clock, ttlMs: 10_000 });
  const policy = parsePolicy(`
modules:
  auth: { path: "src/auth/**" }
  api: { path: "src/api/**", depends_on: [auth] }
limits:
  max_agents_per_module: 2
`);
  return new TowerService({ store, policy });
}

describe("TowerService.claimIntent", () => {
  let svc: TowerService;
  beforeEach(() => {
    svc = makeService();
  });

  it("registers a claim and reports no conflict when clear", () => {
    const res = svc.claimIntent({
      agentId: "claude-a",
      repo: "acme/app",
      branch: "main",
      files: [],
      symbols: [{ file: "src/auth/login.ts", symbol: "verify" }],
      purpose: "x",
    });
    expect(res.claimId).toBeTruthy();
    expect(res.conflicts).toEqual([]);
  });

  it("detects a hard collision with another agent's active claim", () => {
    svc.claimIntent({
      agentId: "cursor-bob",
      repo: "acme/app",
      branch: "main",
      files: [],
      symbols: [{ file: "src/auth/login.ts", symbol: "AuthService.verify" }],
      purpose: "replace JWT",
      etaMinutes: 6,
    });
    const res = svc.claimIntent({
      agentId: "claude-a",
      repo: "acme/app",
      branch: "main",
      files: [],
      symbols: [{ file: "src/auth/login.ts", symbol: "AuthService.verify" }],
      purpose: "y",
    });
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]!.severity).toBe("hard");
    expect(res.conflicts[0]!.agentId).toBe("cursor-bob");
  });

  it("does not collide with the agent's own claim", () => {
    const args = {
      agentId: "claude-a",
      repo: "acme/app",
      branch: "main",
      files: [],
      symbols: [{ file: "src/auth/login.ts", symbol: "verify" }],
      purpose: "",
    };
    svc.claimIntent(args);
    expect(svc.claimIntent(args).conflicts).toEqual([]);
  });
});

describe("TowerService — lifecycle", () => {
  let svc: TowerService;
  beforeEach(() => {
    svc = makeService();
  });

  function claim(): string {
    return svc.claimIntent({
      agentId: "a",
      repo: "r",
      branch: "main",
      files: ["src/x.ts"],
      symbols: [],
      purpose: "",
    }).claimId;
  }

  it("heartbeats, completes and lists", () => {
    const id = claim();
    expect(svc.heartbeat({ claimId: id }).ok).toBe(true);
    expect(svc.listClaims({ repo: "r", status: "active" }).claims).toHaveLength(1);
    expect(svc.completeClaim({ claimId: id, commitSha: "sha" }).ok).toBe(true);
    expect(svc.listClaims({ repo: "r", status: "active" }).claims).toHaveLength(0);
  });

  it("releases a claim", () => {
    const id = claim();
    expect(svc.releaseClaim({ claimId: id }).ok).toBe(true);
  });

  it("check_collision does not persist a claim", () => {
    svc.checkCollision({ repo: "r", branch: "main", files: ["src/x.ts"], symbols: [] });
    expect(svc.listClaims({ repo: "r" }).claims).toHaveLength(0);
  });
});

describe("TowerService — decisions & sequencer", () => {
  let svc: TowerService;
  beforeEach(() => {
    svc = makeService();
  });

  it("logs and recalls decisions", () => {
    const { id } = svc.logDecision({
      title: "Use Supabase Auth",
      body: "RLS",
      author: "claude+rohan",
      tags: ["auth"],
      relatedFiles: [],
    });
    expect(id).toBeTruthy();
    expect(svc.getDecisions({ query: "supabase" }).decisions).toHaveLength(1);
  });

  it("next_task withholds a task blocked by an active dependency", () => {
    svc.claimIntent({
      agentId: "a",
      repo: "acme/app",
      branch: "main",
      files: ["src/auth/login.ts"],
      symbols: [],
      purpose: "",
    });
    const res = svc.nextTask({
      agentId: "b",
      repo: "acme/app",
      candidates: [{ id: "t", module: "api" }],
    });
    expect(res.task).toBeNull();
  });
});
