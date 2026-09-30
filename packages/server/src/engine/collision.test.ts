import { describe, it, expect } from "vitest";
import { detectCollisions, detectAntidependencies } from "./collision.js";
import { fingerprintDeclaration } from "./signature.js";
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

describe("pairwiseCollisions (board)", () => {
  it("finds hard pairs among active claims in the same repo/branch", async () => {
    const { pairwiseCollisions } = await import("./collision.js");
    const a = activeClaim({ id: "A", agentId: "alice" });
    const b = activeClaim({ id: "B", agentId: "bob" });
    const pairs = pairwiseCollisions([a, b]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.severity).toBe("hard");
    expect([pairs[0]!.aClaimId, pairs[0]!.bClaimId].sort()).toEqual(["A", "B"]);
    expect(pairs[0]!.aAgentId).not.toBe(pairs[0]!.bAgentId);
  });

  it("ignores other repos and same-agent pairs", async () => {
    const { pairwiseCollisions } = await import("./collision.js");
    const a = activeClaim({ id: "A", agentId: "alice" });
    const otherRepo = activeClaim({ id: "B", agentId: "bob", repo: "acme/other" });
    const sameAgent = activeClaim({ id: "D", agentId: "alice" });
    expect(pairwiseCollisions([a, otherRepo, sameAgent])).toHaveLength(0);
  });

  it("DOES report a cross-branch pair, as soft", async () => {
    // Changed in 0.9.0. Branch used to be part of the key, which disabled the board's
    // collision view in the common case — agents usually work on separate branches, and
    // two of them rewriting one function still converge into a single merge.
    const { pairwiseCollisions } = await import("./collision.js");
    const a = activeClaim({ id: "A", agentId: "alice" });
    const otherBranch = activeClaim({ id: "C", agentId: "bob", branch: "dev" });
    const pairs = pairwiseCollisions([a, otherBranch]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.severity).toBe("soft");
  });

  it("reports each conflicting pair once", async () => {
    const { pairwiseCollisions } = await import("./collision.js");
    const a = activeClaim({ id: "A", agentId: "alice" });
    const b = activeClaim({ id: "B", agentId: "bob" });
    const c = activeClaim({ id: "C", agentId: "carol" });
    expect(pairwiseCollisions([a, b, c])).toHaveLength(3); // AB, AC, BC
  });
});

describe("antidependencies — the contract moved under you", () => {
  const claim = (over: Partial<Claim>): Claim => ({
    id: "c-1",
    agentId: "alice",
    repo: "acme/app",
    branch: "main",
    files: [],
    symbols: [],
    purpose: "",
    status: "active",
    createdAt: 0,
    expiresAt: Date.now() + 60_000,
    ...over,
  });

  const OLD = {
    file: "src/auth.ts",
    symbol: "AuthService.verify",
    sig: "c1:aaaa",
    sigText: "verify(token: string)",
  };
  const NEW = {
    file: "src/auth.ts",
    symbol: "AuthService.verify",
    sig: "c1:bbbb",
    sigText: "verify(token: string, opts: Opts)",
  };

  // The case the whole feature exists for. Bob writes payments.ts; alice writes auth.ts.
  // No shared file, no shared symbol — the write-write pass returns nothing.
  it("fires when someone is editing a declaration you read, in another file", () => {
    const conflicts = detectAntidependencies(
      {
        files: ["src/payments.ts"],
        symbols: [{ file: "src/payments.ts", symbol: "charge" }],
        reads: [OLD],
        agentId: "bob",
        branch: "main",
      },
      [claim({ symbols: [{ file: "src/auth.ts", symbol: "AuthService.verify" }] })],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe("write_read");
    expect(conflicts[0]?.agentId).toBe("alice");
  });

  it("the write-write pass really is blind to it — this is not a redundant check", () => {
    expect(
      detectCollisions(
        {
          files: ["src/payments.ts"],
          symbols: [{ file: "src/payments.ts", symbol: "charge" }],
          agentId: "bob",
        },
        [claim({ symbols: [{ file: "src/auth.ts", symbol: "AuthService.verify" }] })],
      ),
    ).toHaveLength(0);
  });

  it("is hard when the signature already moved, and carries the delta", () => {
    const conflicts = detectAntidependencies(
      { files: [], symbols: [], reads: [OLD], agentId: "bob", branch: "main" },
      [claim({ symbols: [NEW] })],
    );
    expect(conflicts[0]?.severity).toBe("hard");
    expect(conflicts[0]?.wasSigText).toBe("verify(token: string)");
    expect(conflicts[0]?.nowSigText).toBe("verify(token: string, opts: Opts)");
  });

  // Precision is the whole game: a warning that fires on a reformat gets muted.
  it("stays quiet when the declaration is untouched", () => {
    const conflicts = detectAntidependencies(
      { files: [], symbols: [], reads: [OLD], agentId: "bob", branch: "main" },
      [claim({ symbols: [{ ...OLD }] })],
    );
    expect(conflicts[0]?.severity).toBe("soft");
    expect(conflicts[0]?.reason).toMatch(/editing|in flight|right now/i);
  });

  it("never reports an agent against itself", () => {
    expect(
      detectAntidependencies(
        { files: [], symbols: [], reads: [OLD], agentId: "alice", branch: "main" },
        [claim({ agentId: "alice", symbols: [NEW] })],
      ),
    ).toHaveLength(0);
  });

  it("ignores reads nobody is touching", () => {
    expect(
      detectAntidependencies(
        {
          files: [],
          symbols: [],
          reads: [{ file: "src/other.ts", symbol: "unrelated", sig: "c1:zzzz" }],
          agentId: "bob",
        },
        [claim({ symbols: [NEW] })],
      ),
    ).toHaveLength(0);
  });

  it("ignores a read with no signature — too coarse to be worth a warning", () => {
    expect(
      detectAntidependencies(
        {
          files: [],
          symbols: [],
          reads: [{ file: "src/auth.ts", symbol: "AuthService.verify" }],
          agentId: "bob",
        },
        [claim({ symbols: [NEW] })],
      ),
    ).toHaveLength(0);
  });

  it("caps at soft across branches, like the write-write pass", () => {
    const conflicts = detectAntidependencies(
      { files: [], symbols: [], reads: [OLD], agentId: "bob", branch: "feature" },
      [claim({ branch: "main", symbols: [NEW] })],
    );
    expect(conflicts[0]?.severity).toBe("soft");
  });

  it("skips claims that are no longer active", () => {
    expect(
      detectAntidependencies({ files: [], symbols: [], reads: [OLD], agentId: "bob" }, [
        claim({ status: "completed", symbols: [NEW] }),
      ]),
    ).toHaveLength(0);
  });

  it("returns nothing when the agent declared no reads — today's behaviour, unchanged", () => {
    expect(
      detectAntidependencies({ files: [], symbols: [], reads: [], agentId: "bob" }, [
        claim({ symbols: [NEW] }),
      ]),
    ).toHaveLength(0);
  });
});

describe("contract-first — the holder declared its new signature", () => {
  // The point of declaring: nobody waits. A reader handed the future contract can write
  // against it immediately, so the conflict must never be `hard` — a hard conflict would
  // put the reader straight back into the wait this exists to remove.
  const holder = (symbols: Claim["symbols"]): Claim => ({
    id: "c-alice",
    agentId: "alice",
    repo: "acme/app",
    branch: "main",
    files: [],
    symbols,
    purpose: "",
    status: "active",
    createdAt: 0,
    expiresAt: Date.now() + 60_000,
  });
  const DECLARED = "function verify(token: string, opts: Opts): boolean";
  const current = {
    file: "src/auth.ts",
    symbol: "verify",
    sig: fingerprintDeclaration("function verify(token: string): boolean")!.sig,
    sigText: "function verify(token: string): boolean",
  };
  const reader = (read: Claim["symbols"][number]) => ({
    agentId: "bob",
    files: [],
    symbols: [],
    reads: [read],
    branch: "main",
  });

  it("hands a reader of the current version the declared contract, as soft", () => {
    const [c] = detectAntidependencies(reader(current), [
      holder([{ ...current, declares: DECLARED }]),
    ]);
    expect(c?.severity).toBe("soft");
    expect(c?.kind).toBe("write_read");
    expect(c?.declaredSigText).toBe(DECLARED);
    expect(c?.reason).toContain(DECLARED);
  });

  it("stays soft even when the reader's copy is stale — it has the contract to move to", () => {
    const stale = { ...current, sig: "c1:0000000000000000", sigText: "function verify()" };
    const [c] = detectAntidependencies(reader(stale), [
      holder([{ ...current, declares: DECLARED }]),
    ]);
    expect(c?.severity).toBe("soft");
    expect(c?.declaredSigText).toBe(DECLARED);
  });

  it("says nothing to a reader already on the declared contract", () => {
    const onNew = { ...current, ...fingerprintDeclaration(DECLARED)! };
    expect(
      detectAntidependencies(reader(onNew), [holder([{ ...current, declares: DECLARED }])]),
    ).toEqual([]);
  });

  it("recognises the declared contract even when the holder wrote `export`", () => {
    const onNew = { ...current, ...fingerprintDeclaration(DECLARED)! };
    const declaredWithExport = `export ${DECLARED}`;
    expect(
      detectAntidependencies(reader(onNew), [
        holder([{ ...current, declares: declaredWithExport }]),
      ]),
    ).toEqual([]);
  });

  it("leaves undeclared symbols exactly as 0.11.0 behaved", () => {
    const moved = { ...current, sig: "c1:ffffffffffffffff", sigText: "function verify(x)" };
    const [c] = detectAntidependencies(reader(current), [holder([moved])]);
    expect(c?.severity).toBe("hard");
    expect(c?.declaredSigText).toBeUndefined();
  });
});
