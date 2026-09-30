import { describe, it, expect, beforeEach } from "vitest";
import type { SymbolRef } from "@tower/shared";
import { TowerService } from "./service.js";
import { TowerStore } from "./store/sqlite.js";
import { parsePolicy } from "./engine/sequencer.js";
import { fingerprintDeclaration } from "./engine/signature.js";

/**
 * 0.12.0 — nobody waits. Four behaviours that turn a refusal from a stop into a detour,
 * and one (contract-first) that removes the refusal entirely for dependent work.
 */

let clock = 1_000;
const repo = "acme/app";
const branch = "main";

function makeService(policyYaml = ""): TowerService {
  clock = 1_000;
  const store = new TowerStore({ now: () => clock, ttlMs: 10_000 });
  return new TowerService({ store, ...(policyYaml ? { policy: parsePolicy(policyYaml) } : {}) });
}

const OLD = "function verify(token: string): boolean";
const NEW = "function verify(token: string, opts: Opts): boolean";
const sym = (decl: string, extra: Partial<SymbolRef> = {}): SymbolRef => ({
  file: "src/auth.ts",
  symbol: "verify",
  ...fingerprintDeclaration(decl)!,
  ...extra,
});
const checkout: SymbolRef = { file: "src/payments.ts", symbol: "checkout" };
const inbox = (svc: TowerService, agentId: string) => svc.fetchMessages({ agentId, repo }).messages;

/** The service is called directly here, so the defaults zod applies on the wire
 * (`files: []`, `purpose: ""`) have to be supplied by hand. */
type ClaimArgs = Omit<Parameters<TowerService["claimIntent"]>[0], "files" | "purpose"> &
  Partial<Pick<Parameters<TowerService["claimIntent"]>[0], "files" | "purpose">>;
const claimIn = (svc: TowerService, args: ClaimArgs) =>
  svc.claimIntent({ files: [], purpose: "", ...args });

describe("a refused claim says what to do instead", () => {
  let svc: TowerService;
  beforeEach(() => {
    svc = makeService();
    claimIn(svc, { agentId: "bob", repo, branch, symbols: [sym(OLD)], etaMinutes: 10 });
  });

  it("carries alternatives: what to avoid, a release promise, and one line of advice", () => {
    const res = claimIn(svc, { agentId: "alice", repo, branch, symbols: [sym(OLD)] });
    expect(res.blocking).toBe(true);
    expect(res.alternatives?.avoid).toContainEqual({ file: "src/auth.ts", symbol: "verify" });
    expect(res.alternatives?.notifyOnRelease).toBe(true);
    expect(res.alternatives?.advice).toContain("bob");
  });

  it("widens avoid with code inferred to depend on what is held", () => {
    // carol's finished work wrote checkout() having read verify(): that is the evidence.
    const done = claimIn(svc, {
      agentId: "carol",
      repo,
      branch,
      symbols: [checkout],
      reads: [sym(OLD)],
    });
    svc.completeClaim({ claimId: done.claimId! });
    const res = claimIn(svc, { agentId: "alice", repo, branch, symbols: [sym(OLD)] });
    expect(res.alternatives?.avoid).toContainEqual(checkout);
  });

  it("offers a sequencer task when a policy defines modules", () => {
    // Real globs: a bare "src/auth" matches only that exact path, never src/auth.ts.
    const withPolicy = makeService(
      'modules:\n  auth:\n    path: "src/auth*"\n  billing:\n    path: "src/billing/**"\n',
    );
    claimIn(withPolicy, { agentId: "bob", repo, branch, symbols: [sym(OLD)] });
    const res = claimIn(withPolicy, { agentId: "alice", repo, branch, symbols: [sym(OLD)] });
    expect(res.alternatives?.nextTask?.module).toBe("billing");
  });

  it("is not added to a granted claim, or to one forced past the refusal", () => {
    expect(
      claimIn(svc, { agentId: "alice", repo, branch, symbols: [checkout] }).alternatives,
    ).toBeUndefined();
    const forced = claimIn(svc, {
      agentId: "alice",
      repo,
      branch,
      symbols: [sym(OLD)],
      force: true,
    });
    expect(forced.claimId).not.toBeNull();
    expect(forced.alternatives).toBeUndefined();
  });
});

describe("the refused agent is told when the blocker ends", () => {
  it("messages it on completion — no retry loop needed", () => {
    const svc = makeService();
    const bob = claimIn(svc, { agentId: "bob", repo, branch, symbols: [sym(OLD)] });
    claimIn(svc, { agentId: "alice", repo, branch, symbols: [sym(OLD)] });
    svc.completeClaim({ claimId: bob.claimId!, commitSha: "abc1234def" });
    const [notice] = inbox(svc, "alice");
    expect(notice?.fromAgentId).toBe("tower");
    expect(notice?.body).toContain("verify");
  });

  it("does not register a waiter for a claim that was forced through", () => {
    const svc = makeService();
    const bob = claimIn(svc, { agentId: "bob", repo, branch, symbols: [sym(OLD)] });
    claimIn(svc, { agentId: "alice", repo, branch, symbols: [sym(OLD)], force: true });
    svc.completeClaim({ claimId: bob.claimId! });
    expect(inbox(svc, "alice")).toHaveLength(0);
  });
});

describe("reading is warned at the moment of reading", () => {
  let svc: TowerService;
  beforeEach(() => {
    svc = makeService();
  });

  it("warns a reader that someone is editing what it just read", () => {
    claimIn(svc, { agentId: "bob", repo, branch, symbols: [sym(OLD)] });
    const res = svc.recordReads({ agentId: "alice", repo, branch, reads: [sym(OLD)] });
    expect(res.recorded).toBe(1);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]?.kind).toBe("write_read");
    expect(res.conflicts[0]?.agentId).toBe("bob");
  });

  it("hands the reader the declared contract when the holder declared one", () => {
    claimIn(svc, { agentId: "bob", repo, branch, symbols: [sym(OLD, { declares: NEW })] });
    const res = svc.recordReads({ agentId: "alice", repo, branch, reads: [sym(OLD)] });
    expect(res.conflicts[0]?.severity).toBe("soft");
    expect(res.conflicts[0]?.declaredSigText).toBe(NEW);
  });

  it("stays quiet for nobody's code, and for the reader's own claim", () => {
    expect(
      svc.recordReads({ agentId: "alice", repo, branch, reads: [sym(OLD)] }).conflicts,
    ).toEqual([]);
    claimIn(svc, { agentId: "alice", repo, branch, symbols: [sym(OLD)] });
    expect(
      svc.recordReads({ agentId: "alice", repo, branch, reads: [sym(OLD)] }).conflicts,
    ).toEqual([]);
  });

  it("downgrades a read of work on another branch to soft", () => {
    claimIn(svc, { agentId: "bob", repo, branch: "feature", symbols: [sym(NEW)] });
    const res = svc.recordReads({ agentId: "alice", repo, branch, reads: [sym(OLD)] });
    expect(res.conflicts[0]?.severity).toBe("soft");
  });
});

describe("heartbeat delivers a declared contract to work already in flight", () => {
  it("tells a reader that claimed first what the symbol is about to become", () => {
    const svc = makeService();
    const alice = claimIn(svc, {
      agentId: "alice",
      repo,
      branch,
      symbols: [checkout],
      reads: [sym(OLD)],
    });
    claimIn(svc, { agentId: "bob", repo, branch, symbols: [sym(OLD, { declares: NEW })] });
    const beat = svc.heartbeat({ claimId: alice.claimId! });
    expect(beat.invalidations).toHaveLength(1);
    expect(beat.invalidations[0]?.declaredSigText).toBe(NEW);
  });
});

describe("completing a claim reports a contract that landed", () => {
  let svc: TowerService;
  let bobClaim: string;
  beforeEach(() => {
    svc = makeService();
    bobClaim = claimIn(svc, {
      agentId: "bob",
      repo,
      branch,
      symbols: [sym(OLD, { declares: NEW })],
    }).claimId!;
    claimIn(svc, { agentId: "alice", repo, branch, symbols: [checkout], reads: [sym(OLD)] });
  });

  it("messages every reader the new signature, and confirms it matches the declaration", () => {
    const res = svc.completeClaim({ claimId: bobClaim, symbols: [sym(NEW)] });
    expect(res).toEqual({ ok: true, notified: 1 });
    const [notice] = inbox(svc, "alice");
    expect(notice?.body).toContain("opts: Opts");
    expect(notice?.body).toMatch(/as declared/i);
  });

  it("flags a signature that landed differently from the declaration", () => {
    svc.completeClaim({ claimId: bobClaim, symbols: [sym("function verify(ctx: Ctx): boolean")] });
    expect(inbox(svc, "alice")[0]?.body).toMatch(/not what was declared/i);
  });

  // A declared change that never happened is the worst case, not a non-event: alice was
  // handed verify(token, opts) and coded against it. If bob lands the old signature
  // unchanged, her code is now wrong — silence here would be the bug.
  it("flags a declared change that never happened, because readers coded against it", () => {
    svc.completeClaim({ claimId: bobClaim, symbols: [sym(OLD)] });
    expect(inbox(svc, "alice")[0]?.body).toMatch(/not what was declared/i);
  });

  it("says nothing when an undeclared declaration did not move", () => {
    const quiet = makeService();
    const b = claimIn(quiet, { agentId: "bob", repo, branch, symbols: [sym(OLD)] }).claimId!;
    claimIn(quiet, { agentId: "alice", repo, branch, symbols: [checkout], reads: [sym(OLD)] });
    expect(quiet.completeClaim({ claimId: b, symbols: [sym(OLD)] })).toEqual({
      ok: true,
      notified: 0,
    });
    expect(inbox(quiet, "alice")).toHaveLength(0);
  });

  it("behaves exactly as 0.11 when no final symbols are sent", () => {
    expect(svc.completeClaim({ claimId: bobClaim })).toEqual({ ok: true, notified: 0 });
  });

  it("never messages the holder about its own change", () => {
    svc.completeClaim({ claimId: bobClaim, symbols: [sym(NEW)] });
    expect(inbox(svc, "bob").filter((m) => m.fromAgentId === "tower")).toHaveLength(0);
  });
});

describe("contract-first, end to end: dependent work in parallel, nobody waits", () => {
  it("lets bob build against alice's declared signature while she is still writing it", () => {
    const svc = makeService();
    // alice is changing verify() and says up front what it will become.
    const alice = claimIn(svc, {
      agentId: "alice",
      repo,
      branch,
      purpose: "add opts to verify",
      symbols: [sym(OLD, { declares: NEW })],
    });
    expect(alice.blocking).toBe(false);

    // bob reads verify() on his way to writing checkout(), and is handed the contract.
    const read = svc.recordReads({ agentId: "bob", repo, branch, reads: [sym(OLD)] });
    expect(read.conflicts[0]?.declaredSigText).toBe(NEW);

    // bob claims checkout(): not refused, because he has what he needs to proceed.
    const bob = claimIn(svc, { agentId: "bob", repo, branch, symbols: [checkout] });
    expect(bob.blocking).toBe(false);
    expect(bob.conflicts.every((c) => c.severity !== "hard")).toBe(true);

    // alice lands exactly what she declared; bob is told his code is correct.
    expect(svc.completeClaim({ claimId: alice.claimId!, symbols: [sym(NEW)] }).notified).toBe(1);
    expect(inbox(svc, "bob")[0]?.body).toMatch(/as declared/i);
  });
});
