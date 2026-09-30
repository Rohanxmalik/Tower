import { describe, it, expect } from "vitest";
import type { Alternatives, Conflict } from "@tower/shared";
import { readWarning, hookContext, renderAlternatives, towerRule } from "./nobody-waits.js";

const editing: Conflict = {
  claimId: "c1",
  agentId: "bob",
  severity: "soft",
  kind: "write_read",
  reason: "bob is editing verify right now, which you read",
  overlap: [{ file: "src/auth.ts", symbol: "verify" }],
};

describe("readWarning — what the agent sees right after reading", () => {
  it("is null when there is nothing to say, so the hook stays silent", () => {
    expect(readWarning([])).toBeNull();
  });

  it("names who, what and where in one line per conflict", () => {
    const w = readWarning([editing])!;
    expect(w).toContain("bob");
    expect(w).toContain("verify");
    expect(w).toContain("src/auth.ts");
  });

  it("carries the old and new signature, so the agent patches instead of re-reading", () => {
    const w = readWarning([
      {
        ...editing,
        severity: "hard",
        wasSigText: "verify(token)",
        nowSigText: "verify(token, opts)",
      },
    ])!;
    expect(w).toContain("verify(token)");
    expect(w).toContain("verify(token, opts)");
  });

  it("stays short however many conflicts arrive", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      ...editing,
      claimId: `c${i}`,
      agentId: `a${i}`,
    }));
    const w = readWarning(many)!;
    expect(w).toContain("and 4 more");
    expect(w.split("\n").length).toBeLessThanOrEqual(7);
  });
});

describe("hookContext — the only shape Claude Code shows the agent from PostToolUse", () => {
  // Plain stdout from a PostToolUse hook goes to the debug log, never to the model. The
  // warning has to be this exact JSON or it is written, and read by nobody.
  it("wraps text as hookSpecificOutput.additionalContext for PostToolUse", () => {
    const parsed = JSON.parse(hookContext("hello")) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toBe("hello");
  });

  it("is a single JSON object, start to end, so it is parsed rather than logged", () => {
    const out = hookContext('line one\nline "two"');
    expect(out.startsWith("{")).toBe(true);
    expect(out.endsWith("}")).toBe(true);
  });
});

describe("renderAlternatives — the CLI's 'then what?' after a refusal", () => {
  const alt: Alternatives = {
    avoid: [
      { file: "src/auth.ts", symbol: "verify" },
      { file: "src/payments.ts", symbol: "checkout" },
    ],
    nextTask: { id: "billing", module: "billing" },
    notifyOnRelease: true,
    advice: "Held by bob (~10 min). Don't wait.",
  };

  it("prints the advice, what to avoid, and the suggested module", () => {
    const text = renderAlternatives(alt);
    expect(text).toContain("Held by bob");
    expect(text).toContain("verify");
    expect(text).toContain("src/payments.ts");
    expect(text).toContain("billing");
  });

  it("prints nothing for a claim that was not refused", () => {
    expect(renderAlternatives(undefined)).toBe("");
  });

  it("summarises a long avoid-list", () => {
    const long = {
      ...alt,
      avoid: Array.from({ length: 14 }, (_, i) => ({ file: "a.ts", symbol: `f${i}` })),
    };
    expect(renderAlternatives(long)).toContain("and 6 more");
  });
});

describe("towerRule — the instructions `tower setup` writes into CLAUDE.md", () => {
  it("defaults to stopping on a hard conflict, and points at the alternatives", () => {
    const rule = towerRule();
    expect(rule).toContain("claim_intent"); // setup's idempotency check keys on this
    expect(rule).toMatch(/stop and ask the\s+user/);
    expect(rule).toContain("alternatives");
    expect(rule).toContain("declares");
  });

  it("with keep-going, tells the agent to carry on and only ask when nothing is safe", () => {
    const rule = towerRule({ keepGoing: true });
    expect(rule).toContain("claim_intent");
    expect(rule).not.toMatch(/stop and ask the\s+user/);
    expect(rule).toContain("alternatives.avoid");
    expect(rule).toMatch(/only ask the user if nothing/i);
  });
});
