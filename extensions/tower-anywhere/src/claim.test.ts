import { describe, expect, it } from "vitest";
import { buildIntent, buildScope, claim, guard, renderConflicts, type ClaimArgs } from "./claim.js";
import type { Conflict, ToolCall } from "./client.js";

const base: ClaimArgs = {
  who: "ana",
  space: "acme-marketing",
  artifact: "Q3 Launch Brief",
  purpose: "rewriting the positioning",
};

function conflict(severity: Conflict["severity"], agentId = "bo"): Conflict {
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

  it("buildScope drops purpose so check_collision stays a dry run", () => {
    const scope = buildScope({ ...base, etaMinutes: 5 });
    expect(scope).not.toHaveProperty("purpose");
    expect(scope).not.toHaveProperty("etaMinutes");
    expect(scope.symbols).toEqual([{ file: "Q3 Launch Brief", symbol: "" }]);
  });
});

describe("renderConflicts", () => {
  it("says so when nothing overlaps", () => {
    expect(renderConflicts([])).toContain("No conflicts");
  });

  it("names the person and the artifact", () => {
    const text = renderConflicts([conflict("hard")]);
    expect(text).toContain("bo");
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
    c.reason = "Editing the same file(s) (Brief) as ana — overlapping diffs likely";
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
    expect(lines.join("\n")).toContain("registered for ana");
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

  it("does not block on a soft conflict", async () => {
    const { call } = fakeCall({
      claim_intent: { claimId: "abcdef1234", conflicts: [conflict("soft")], blocking: false },
    });
    const { out } = collect();
    expect(await claim(call, base, out)).toBe(false);
  });
});

describe("guard", () => {
  it("registers nothing when it blocks", async () => {
    const { call, calls } = fakeCall({ check_collision: { conflicts: [conflict("hard")] } });
    const { out, lines } = collect();
    expect(await guard(call, base, out)).toBe(true);
    expect(calls.map((c) => c.tool)).toEqual(["check_collision"]);
    expect(lines.join("\n")).toContain("BLOCKED");
  });

  it("claims through with force after a hard conflict", async () => {
    const { call, calls } = fakeCall({
      check_collision: { conflicts: [conflict("hard")] },
      claim_intent: { claimId: "abcdef1234", conflicts: [], blocking: false },
    });
    const { out, lines } = collect();
    expect(await guard(call, { ...base, force: true }, out)).toBe(false);
    expect(calls.map((c) => c.tool)).toEqual(["check_collision", "claim_intent"]);
    expect(calls[1]?.args.force).toBe(true);
    expect(lines.join("\n")).toContain("FORCED");
  });

  it("claims without force when clear", async () => {
    const { call, calls } = fakeCall({
      check_collision: { conflicts: [] },
      claim_intent: { claimId: "abcdef1234", conflicts: [], blocking: false },
    });
    const { out, lines } = collect();
    expect(await guard(call, base, out)).toBe(false);
    expect(calls[1]?.args).not.toHaveProperty("force");
    expect(lines.join("\n")).toContain("CLEAR");
  });

  it("proceeds on a soft conflict rather than blocking", async () => {
    const { call } = fakeCall({
      check_collision: { conflicts: [conflict("soft")] },
      claim_intent: { claimId: "abcdef1234", conflicts: [conflict("soft")], blocking: false },
    });
    const { out } = collect();
    expect(await guard(call, base, out)).toBe(false);
  });
});
