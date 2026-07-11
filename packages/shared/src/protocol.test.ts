import { describe, it, expect } from "vitest";
import {
  SymbolRef,
  Claim,
  Conflict,
  ClaimIntentInput,
  ClaimIntentOutput,
  CheckCollisionInput,
  LogDecisionInput,
  NextTaskInput,
  TOOL_SCHEMAS,
} from "./protocol.js";

describe("SymbolRef", () => {
  it("accepts a valid symbol", () => {
    const r = SymbolRef.parse({ file: "src/auth.ts", symbol: "verify", kind: "method" });
    expect(r.symbol).toBe("verify");
  });

  it("allows empty symbol (whole-file claim)", () => {
    expect(SymbolRef.parse({ file: "src/auth.ts", symbol: "" }).symbol).toBe("");
  });

  it("rejects empty file path", () => {
    expect(() => SymbolRef.parse({ file: "", symbol: "x" })).toThrow();
  });

  it("rejects unknown kind", () => {
    expect(() => SymbolRef.parse({ file: "a.ts", symbol: "x", kind: "widget" })).toThrow();
  });
});

describe("ClaimIntentInput", () => {
  it("applies defaults for optional arrays", () => {
    const parsed = ClaimIntentInput.parse({ agentId: "a1", repo: "r", branch: "main" });
    expect(parsed.files).toEqual([]);
    expect(parsed.symbols).toEqual([]);
    expect(parsed.purpose).toBe("");
  });

  it("rejects missing agentId", () => {
    expect(() => ClaimIntentInput.parse({ repo: "r", branch: "main" })).toThrow();
  });

  it("rejects non-positive etaMinutes", () => {
    expect(() =>
      ClaimIntentInput.parse({ agentId: "a", repo: "r", branch: "b", etaMinutes: 0 }),
    ).toThrow();
  });
});

describe("Conflict / severity", () => {
  it("accepts hard/soft/info severities", () => {
    for (const severity of ["hard", "soft", "info"] as const) {
      const c = Conflict.parse({
        claimId: "c1",
        agentId: "a2",
        severity,
        reason: "overlap",
        overlap: [{ file: "a.ts", symbol: "x" }],
      });
      expect(c.severity).toBe(severity);
    }
  });

  it("rejects an invalid severity", () => {
    expect(() =>
      Conflict.parse({ claimId: "c", agentId: "a", severity: "boom", reason: "", overlap: [] }),
    ).toThrow();
  });
});

describe("Claim", () => {
  it("round-trips a full claim", () => {
    const claim = {
      id: "id1",
      agentId: "a1",
      repo: "r",
      branch: "main",
      files: ["a.ts"],
      symbols: [{ file: "a.ts", symbol: "f" }],
      purpose: "refactor",
      status: "active" as const,
      createdAt: 1,
      expiresAt: 2,
    };
    expect(Claim.parse(claim)).toMatchObject({ id: "id1", status: "active" });
  });

  it("rejects an unknown status", () => {
    expect(() =>
      Claim.parse({
        id: "x",
        agentId: "a",
        repo: "r",
        branch: "b",
        files: [],
        symbols: [],
        purpose: "",
        status: "zombie",
        createdAt: 1,
        expiresAt: 2,
      }),
    ).toThrow();
  });
});

describe("other tool inputs", () => {
  it("CheckCollisionInput defaults arrays", () => {
    const p = CheckCollisionInput.parse({ repo: "r", branch: "b" });
    expect(p.files).toEqual([]);
  });

  it("LogDecisionInput requires title + author", () => {
    expect(() => LogDecisionInput.parse({ body: "b" })).toThrow();
    const ok = LogDecisionInput.parse({ title: "t", author: "me" });
    expect(ok.tags).toEqual([]);
  });

  it("NextTaskInput defaults candidates", () => {
    expect(NextTaskInput.parse({ agentId: "a", repo: "r" }).candidates).toEqual([]);
  });
});

describe("TOOL_SCHEMAS registry", () => {
  it("exposes exactly the 17 tools", () => {
    expect(Object.keys(TOOL_SCHEMAS).sort()).toEqual(
      [
        "check_collision",
        "claim_intent",
        "complete_claim",
        "get_decisions",
        "heartbeat",
        "list_claims",
        "log_decision",
        "next_task",
        "release_claim",
        "send_message",
        "accept_task",
        "complete_task",
        "list_tasks",
        "request_approval",
        "resolve_approval",
        "heartbeat_worker",
        "fetch_messages",
      ].sort(),
    );
  });

  it("every entry has input + output schemas", () => {
    for (const { input, output } of Object.values(TOOL_SCHEMAS)) {
      expect(typeof input.parse).toBe("function");
      expect(typeof output.parse).toBe("function");
    }
  });

  it("ClaimIntentOutput validates a conflict list", () => {
    const out = ClaimIntentOutput.parse({ claimId: "c1", conflicts: [] });
    expect(out.conflicts).toEqual([]);
  });
});
