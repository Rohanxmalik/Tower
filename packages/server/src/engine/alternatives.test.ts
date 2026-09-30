import { describe, it, expect } from "vitest";
import type { Claim, Conflict } from "@tower/shared";
import { buildAlternatives } from "./alternatives.js";
import { parsePolicy } from "./sequencer.js";

const EMPTY = { modules: [], maxAgentsPerModule: null };
const verify = { file: "src/auth.ts", symbol: "verify" };
const login = { file: "src/auth.ts", symbol: "login" };
const checkout = { file: "src/payments.ts", symbol: "checkout" };

const bobClaim: Claim = {
  id: "c-bob",
  agentId: "bob",
  repo: "acme/app",
  branch: "main",
  files: ["src/auth.ts"],
  symbols: [verify, login],
  purpose: "rework auth",
  status: "active",
  etaMinutes: 10,
  createdAt: 0,
  expiresAt: Date.now() + 60_000,
};
const refusal: Conflict = {
  claimId: "c-bob",
  agentId: "bob",
  severity: "hard",
  kind: "write_write",
  reason: "same symbol",
  overlap: [verify],
  etaMinutes: 10,
};
const history: Claim[] = [
  {
    ...bobClaim,
    id: "old",
    agentId: "carol",
    status: "completed",
    symbols: [checkout],
    reads: [verify],
  },
];

describe("buildAlternatives — what a refused agent does instead of waiting", () => {
  const base = {
    blocking: [refusal],
    active: [bobClaim],
    history,
    policy: EMPTY,
    agentId: "alice",
  };

  it("tells the agent to avoid everything the holder is changing, not just the overlap", () => {
    const alt = buildAlternatives(base);
    expect(alt.avoid).toEqual(expect.arrayContaining([verify, login]));
  });

  it("adds code inferred to depend on it, so the agent does not wander into it next", () => {
    expect(buildAlternatives(base).avoid).toContainEqual(checkout);
  });

  it("lists nothing twice", () => {
    const alt = buildAlternatives({
      ...base,
      history: [...history, { ...history[0]!, id: "again" }],
    });
    const keys = alt.avoid.map((s) => `${s.file}::${s.symbol}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("promises a release notification, and says so in the advice", () => {
    const alt = buildAlternatives(base);
    expect(alt.notifyOnRelease).toBe(true);
    expect(alt.advice).toContain("bob");
    expect(alt.advice).toContain("10 min");
    expect(alt.advice).toMatch(/message you/i);
  });

  it("has no sequencer pick without a policy, and a clear one with it", () => {
    expect(buildAlternatives(base).nextTask).toBeNull();
    // Globs, as real policies use them. A bare "src/auth" matches only that exact path,
    // so the held file would sit in no module — and this test once passed that way,
    // asserting only that *some* module came back while it handed back the busy one.
    const policy = parsePolicy(
      'modules:\n  auth:\n    path: "src/auth*"\n  billing:\n    path: "src/billing/**"\n',
    );
    const alt = buildAlternatives({ ...base, policy });
    expect(alt.nextTask?.module).toBe("billing"); // never "auth": that is what bob holds
    expect(alt.advice).toContain("billing");
  });

  it("suggests nothing when every module holds something to avoid", () => {
    const policy = parsePolicy(
      'modules:\n  auth:\n    path: "src/auth*"\n  pay:\n    path: "src/payments*"\n',
    );
    expect(buildAlternatives({ ...base, policy }).nextTask).toBeNull();
  });

  it("falls back to the reported overlap when the blocking claim is no longer listed", () => {
    const alt = buildAlternatives({ ...base, active: [] });
    expect(alt.avoid).toContainEqual(verify);
  });

  it("names every holder when more than one claim blocks", () => {
    const carol: Claim = { ...bobClaim, id: "c-carol", agentId: "carol", symbols: [verify] };
    delete (carol as Partial<Claim>).etaMinutes;
    const alt = buildAlternatives({
      ...base,
      blocking: [
        refusal,
        { ...refusal, claimId: "c-carol", agentId: "carol", etaMinutes: undefined },
      ],
      active: [bobClaim, carol],
    });
    expect(alt.advice).toContain("bob");
    expect(alt.advice).toContain("carol");
  });
});
