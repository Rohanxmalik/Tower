import { describe, it, expect } from "vitest";
import type { Claim } from "@tower/shared";
import { dependentsOf, MAX_DEPENDENTS } from "./dependencies.js";

const claim = (over: Partial<Claim>): Claim => ({
  id: "c",
  agentId: "bob",
  repo: "acme/app",
  branch: "main",
  files: [],
  symbols: [],
  purpose: "",
  status: "completed",
  createdAt: 0,
  expiresAt: 0,
  ...over,
});

const verify = { file: "src/auth.ts", symbol: "verify" };
const checkout = { file: "src/payments.ts", symbol: "checkout" };
const refund = { file: "src/payments.ts", symbol: "refund" };

describe("dependentsOf — a dependency map inferred from what agents read", () => {
  it("finds code that was written against the target", () => {
    const deps = dependentsOf([verify], [claim({ symbols: [checkout], reads: [verify] })]);
    expect(deps).toEqual([checkout]);
  });

  it("ignores work that never read the target", () => {
    expect(dependentsOf([verify], [claim({ symbols: [checkout], reads: [refund] })])).toEqual([]);
    expect(dependentsOf([verify], [claim({ symbols: [checkout] })])).toEqual([]);
  });

  it("never lists the target as its own dependent", () => {
    expect(
      dependentsOf([verify], [claim({ symbols: [verify, checkout], reads: [verify] })]),
    ).toEqual([checkout]);
  });

  it("treats a whole-file hold as covering every read in that file", () => {
    const deps = dependentsOf(
      [{ file: "src/auth.ts", symbol: "" }],
      [claim({ symbols: [checkout], reads: [verify] })],
    );
    expect(deps).toEqual([checkout]);
  });

  it("dedupes across claims and strips per-read fingerprints", () => {
    const deps = dependentsOf(
      [verify],
      [
        claim({ id: "a", symbols: [{ ...checkout, sig: "c1:x" }], reads: [verify] }),
        claim({ id: "b", symbols: [checkout, refund], reads: [{ ...verify, sig: "c1:y" }] }),
      ],
    );
    expect(deps).toEqual([checkout, refund]);
  });

  it("is capped, so a hub symbol cannot bloat a refusal", () => {
    const many = Array.from({ length: MAX_DEPENDENTS + 20 }, (_, i) =>
      claim({ id: `c${i}`, symbols: [{ file: "src/x.ts", symbol: `f${i}` }], reads: [verify] }),
    );
    expect(dependentsOf([verify], many)).toHaveLength(MAX_DEPENDENTS);
  });
});
