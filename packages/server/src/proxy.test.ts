import { describe, it, expect } from "vitest";
import { withIdentity } from "./mcp.js";

const ID = { repoId: "a".repeat(40), projectId: "nimbus" };

describe("withIdentity — the proxy's whole job", () => {
  it("stamps repoId and projectId onto a tool that accepts them", () => {
    const out = withIdentity(
      "claim_intent",
      { agentId: "a", repo: "github.com/o/r" },
      ID,
    ) as Record<string, unknown>;
    expect(out.repoId).toBe(ID.repoId);
    expect(out.projectId).toBe("nimbus");
  });

  it("stamps the messaging tools too — the half 0.9.0 left keyed on a raw string", () => {
    for (const tool of [
      "send_message",
      "fetch_messages",
      "pending",
      "list_tasks",
      "next_task",
    ] as const) {
      const out = withIdentity(tool, { agentId: "a", repo: "r" }, ID) as Record<string, unknown>;
      expect(out.repoId, tool).toBe(ID.repoId);
    }
  });

  it("never overrides an identity the caller set deliberately", () => {
    const out = withIdentity("claim_intent", { repo: "r", repoId: "explicit" }, ID) as Record<
      string,
      unknown
    >;
    expect(out.repoId).toBe("explicit");
  });

  it("leaves tools that take no repo untouched", () => {
    const args = { claimId: "c1" };
    expect(withIdentity("heartbeat", args, ID)).toBe(args);
  });

  it("adds nothing when the machine has no identity — a non-git directory still works", () => {
    const args = { agentId: "a", repo: "r" };
    expect(withIdentity("claim_intent", args, {})).toBe(args);
  });

  it("survives a non-object argument rather than throwing", () => {
    expect(withIdentity("claim_intent", null, ID)).toBe(null);
  });
});
