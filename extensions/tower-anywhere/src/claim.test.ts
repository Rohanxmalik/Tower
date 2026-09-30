import { describe, expect, it } from "vitest";
import {
  buildIntent,
  claim,
  guard,
  renderAlternatives,
  renderConflicts,
  type ClaimArgs,
} from "./claim.js";
import type { Alternatives, Conflict, ToolCall } from "./client.js";

const base: ClaimArgs = {
  who: "alice",
  space: "acme-marketing",
  artifact: "Q3 Launch Brief",
  purpose: "rewriting the positioning",
};

function conflict(severity: Conflict["severity"], agentId = "bob"): Conflict {
  return {
    claimId: "c-1",
    agentId,
    severity,
    reason: "same artifact",
    overlap: [{ file: base.artifact, symbol: "" }],
  };
}

/** Records every tool call and replies with canned results. */
function fakeCall(replies: Record<string, unknown>): {
  call: ToolCall;
  calls: { tool: string; args: Record<string, unknown> }[];
} {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const call: ToolCall = async (tool, args) => {
    calls.push({ tool, args });
    return replies[tool] ?? {};
  };
  return { call, calls };
}

function collect(): { out: (l: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { out: (l) => lines.push(l), lines };
}

describe("buildIntent", () => {
  it("maps a bare artifact to a whole-artifact symbol", () => {
    const intent = buildIntent(base);
    expect(intent.files).toEqual(["Q3 Launch Brief"]);
    expect(intent.symbols).toEqual([{ file: "Q3 Launch Brief", symbol: "" }]);
  });

  it("uses the space as both projectId and repo so claims partition without git", () => {
    const intent = buildIntent(base);
    expect(intent.projectId).toBe("acme-marketing");
    expect(intent.repo).toBe("acme-marketing");
  });

  it("puts --section in the symbol slot", () => {
    const intent = buildIntent({ ...base, section: "hero headline" });
    expect(intent.symbols).toEqual([{ file: "Q3 Launch Brief", symbol: "hero headline" }]);
  });

  it("omits eta and force unless asked", () => {
    expect(buildIntent(base)).not.toHaveProperty("etaMinutes");
    expect(buildIntent(base)).not.toHaveProperty("force");
    const loud = buildIntent({ ...base, etaMinutes: 30, force: true });
    expect(loud.etaMinutes).toBe(30);
    expect(loud.force).toBe(true);
  });
});

describe("renderConflicts", () => {
  it("says so when nothing overlaps", () => {
    expect(renderConflicts([])).toContain("No conflicts");
  });

  it("names the person and the artifact", () => {
    const text = renderConflicts([conflict("hard")]);
    expect(text).toContain("bob");
    expect(text).toContain("Q3 Launch Brief");
    expect(text).toContain("[hard]");
  });

  it("shows the section when one is claimed", () => {
    const c = conflict("hard");
    c.overlap = [{ file: "Content Calendar", symbol: "October" }];
    expect(renderConflicts([c])).toContain("Content Calendar › October");
  });

  it("never shows the developer wording the server sends", () => {
    const c = conflict("soft");
    c.reason = "Editing the same file(s) (Brief) as alice — overlapping diffs likely";
    const text = renderConflicts([c]);
    expect(text).not.toContain("file");
    expect(text).not.toContain("diffs");
    expect(text).not.toContain("Whole-file");
  });

  it("includes an eta when the other person gave one", () => {
    const c = conflict("hard");
    c.etaMinutes = 30;
    expect(renderConflicts([c])).toContain("~30m left");
  });
});

describe("claim", () => {
  it("reports a registered claim and does not block when clear", async () => {
    const { call } = fakeCall({
      claim_intent: { claimId: "abcdef1234", conflicts: [], blocking: false },
    });
    const { out, lines } = collect();
    expect(await claim(call, base, out)).toBe(false);
    expect(lines.join("\n")).toContain("registered for alice");
  });

  it("blocks and explains the override when the claim is refused", async () => {
    const { call } = fakeCall({
      claim_intent: { claimId: null, conflicts: [conflict("hard")], blocking: true },
    });
    const { out, lines } = collect();
    expect(await claim(call, base, out)).toBe(true);
    expect(lines.join("\n")).toContain("REFUSED");
    expect(lines.join("\n")).toContain("--force");
  });

  it("prints what to do instead under a refusal", async () => {
    const { call } = fakeCall({
      claim_intent: {
        claimId: null,
        conflicts: [conflict("hard")],
        blocking: true,
        alternatives: {
          avoid: [{ file: "Q3 Launch Brief", symbol: "" }],
          nextTask: null,
          notifyOnRelease: true,
          advice: "Held by bob.",
        },
      },
    });
    const { out, lines } = collect();
    expect(await claim(call, base, out)).toBe(true);
    expect(lines.join("\n")).toContain("What to do instead");
    expect(lines.join("\n")).toContain("Tower will message you");
  });

  it("does not block on a soft conflict", async () => {
    const { call } = fakeCall({
      claim_intent: { claimId: "abcdef1234", conflicts: [conflict("soft")], blocking: false },
    });
    const { out } = collect();
    expect(await claim(call, base, out)).toBe(false);
  });
});

/** What a 0.12+ server sends with a refusal. */
const alternatives: Alternatives = {
  avoid: [
    { file: "Q3 Launch Brief", symbol: "" },
    { file: "Content Calendar", symbol: "October" },
  ],
  nextTask: null,
  notifyOnRelease: true,
  advice: "Held by bob (~10 min). Don't wait: work on anything outside the 2 symbols in `avoid`.",
};

const refused = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  claimId: null,
  conflicts: [conflict("hard")],
  blocking: true,
  recommendation: "stand_down",
  ...extra,
});

describe("guard", () => {
  // A refused claim_intent registers nothing, so guard needs no check_collision
  // pre-check — and the pre-check could not register a waiter or return alternatives.
  it("goes straight through claim_intent, never check_collision", async () => {
    const { call, calls } = fakeCall({ claim_intent: refused() });
    const { out, lines } = collect();
    expect(await guard(call, base, out)).toBe(true);
    expect(calls.map((c) => c.tool)).toEqual(["claim_intent"]);
    expect(calls[0]?.args).not.toHaveProperty("force");
    expect(lines.join("\n")).toContain("BLOCKED");
    expect(lines.join("\n")).toContain("bob");
  });

  it("prints what to do instead when the server offers alternatives", async () => {
    const { call } = fakeCall({ claim_intent: refused({ alternatives }) });
    const { out, lines } = collect();
    expect(await guard(call, base, out)).toBe(true);
    const text = lines.join("\n");
    expect(text).toContain("What to do instead");
    expect(text).toContain("Don't wait");
    // The server writes its advice for developers ("symbols"); this CLI speaks artifacts.
    expect(text).not.toContain("symbol");
    expect(text).toContain("Avoid for now: Q3 Launch Brief, Content Calendar › October");
  });

  it("still blocks cleanly against a server that sends no alternatives", async () => {
    const { call } = fakeCall({ claim_intent: refused() });
    const { out, lines } = collect();
    expect(await guard(call, base, out)).toBe(true);
    expect(lines.join("\n")).not.toContain("What to do instead");
  });

  it("claims through with force past a hard conflict", async () => {
    const { call, calls } = fakeCall({
      claim_intent: { claimId: "abcdef1234", conflicts: [conflict("hard")], blocking: false },
    });
    const { out, lines } = collect();
    expect(await guard(call, { ...base, force: true }, out)).toBe(false);
    expect(calls.map((c) => c.tool)).toEqual(["claim_intent"]);
    expect(calls[0]?.args.force).toBe(true);
    expect(lines.join("\n")).toContain("FORCED");
  });

  it("claims without force when clear", async () => {
    const { call, calls } = fakeCall({
      claim_intent: { claimId: "abcdef1234", conflicts: [], blocking: false },
    });
    const { out, lines } = collect();
    expect(await guard(call, base, out)).toBe(false);
    expect(calls[0]?.args).not.toHaveProperty("force");
    expect(lines.join("\n")).toContain("CLEAR");
  });

  it("proceeds on a soft conflict rather than blocking", async () => {
    const { call } = fakeCall({
      claim_intent: { claimId: "abcdef1234", conflicts: [conflict("soft")], blocking: false },
    });
    const { out, lines } = collect();
    expect(await guard(call, base, out)).toBe(false);
    expect(lines.join("\n")).toContain("[soft]");
  });
});

describe("renderAlternatives", () => {
  it("is empty when there is nothing to offer", () => {
    expect(renderAlternatives(undefined)).toBe("");
  });

  it("caps a long avoid list", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ file: `Asset ${i}`, symbol: "" }));
    const text = renderAlternatives({ ...alternatives, avoid: many });
    expect(text).toContain("Asset 0");
    expect(text).not.toContain("Asset 8");
    expect(text).toContain("and 4 more");
  });

  it("names a suggested next task when the server picked one", () => {
    const text = renderAlternatives({ ...alternatives, nextTask: { module: "emails" } });
    expect(text).toContain('Suggested next: "emails"');
  });
});
