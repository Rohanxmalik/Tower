import { describe, it, expect } from "vitest";
import type { Claim } from "@tower/shared";
import { releaseNotice, contractNotice } from "./notices.js";
import { fingerprintDeclaration } from "./signature.js";

const held = (symbols: Claim["symbols"], files: string[] = []): Claim => ({
  id: "c-bob",
  agentId: "bob",
  repo: "acme/app",
  branch: "main",
  files,
  symbols,
  purpose: "",
  status: "completed",
  createdAt: 0,
  expiresAt: 0,
});

describe("releaseNotice — what a waiting agent is told when the blocker ends", () => {
  it("names what freed up, who held it, how it ended, and what to do", () => {
    const n = releaseNotice(
      held([{ file: "src/auth.ts", symbol: "verify" }]),
      "completed",
      "abc1234def",
    );
    expect(n).toContain("verify");
    expect(n).toContain("bob");
    expect(n).toContain("completed");
    expect(n).toContain("abc1234");
    expect(n).not.toContain("abc1234def"); // short sha — the agent does not need forty characters
    expect(n).toMatch(/claim/i);
  });

  it("covers releases and expiry, which free the code just the same", () => {
    const c = held([{ file: "src/auth.ts", symbol: "verify" }]);
    expect(releaseNotice(c, "released")).toContain("released");
    expect(releaseNotice(c, "expired")).toContain("expired");
  });

  it("falls back to file names for whole-file claims", () => {
    expect(releaseNotice(held([], ["src/auth.ts"]), "released")).toContain("src/auth.ts");
  });

  it("stays short when a claim held many symbols", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ file: "a.ts", symbol: `f${i}` }));
    const n = releaseNotice(held(many), "completed");
    expect(n).toContain("and 6 more");
    expect(n).not.toContain("f8");
  });
});

describe("contractNotice — the signature a reader built on has landed", () => {
  const landed = fingerprintDeclaration("function verify(token: string, opts: Opts): boolean")!;
  const base = { holder: "alice", file: "src/auth.ts", symbol: "verify", landed };

  it("confirms when the code landed exactly as declared", () => {
    const n = contractNotice({
      ...base,
      declared: "export function verify(token: string, opts: Opts): boolean",
    });
    expect(n).toContain(landed.sigText);
    expect(n).toMatch(/as declared/i);
  });

  it("flags a contract that landed differently from what was promised", () => {
    const n = contractNotice({ ...base, declared: "function verify(token: string): boolean" });
    expect(n).toContain(landed.sigText);
    expect(n).toContain("function verify(token: string): boolean");
    expect(n).toMatch(/not what was declared/i);
  });

  it("still reports a change nobody declared", () => {
    const n = contractNotice(base);
    expect(n).toContain(landed.sigText);
    expect(n).toMatch(/call sites/i);
  });
});
