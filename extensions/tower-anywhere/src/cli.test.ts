import { describe, expect, it } from "vitest";
import { parseClaimArgs, run } from "./cli.js";
import type { ToolCall } from "./client.js";

function collect(): { out: (l: string) => void; lines: string[]; text: () => string } {
  const lines: string[] = [];
  return { out: (l) => lines.push(l), lines, text: () => lines.join("\n") };
}

/** Runs the CLI against canned tool replies instead of a server. */
function connectWith(replies: Record<string, unknown>) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const call: ToolCall = async (tool, args) => {
    calls.push({ tool, args });
    return replies[tool] ?? {};
  };
  return { connect: <T>(fn: (c: ToolCall) => Promise<T>) => fn(call), calls };
}

describe("parseClaimArgs", () => {
  it("reads the artifact as a positional", () => {
    const args = parseClaimArgs(["Q3 Launch Brief", "--space", "acme"], {});
    expect(typeof args === "string" ? args : args.artifact).toBe("Q3 Launch Brief");
  });

  it("falls back to TOWER_SPACE and TOWER_WHO", () => {
    const args = parseClaimArgs(["Brief"], { TOWER_SPACE: "acme", TOWER_WHO: "ana" });
    if (typeof args === "string") throw new Error(args);
    expect(args.space).toBe("acme");
    expect(args.who).toBe("ana");
  });

  it("explains itself when the artifact is missing", () => {
    expect(parseClaimArgs(["--space", "acme"], {})).toContain("needs an artifact");
  });

  it("explains itself when no space is set anywhere", () => {
    expect(parseClaimArgs(["Brief"], {})).toContain("--space");
  });

  it("defaults who to something harmless", () => {
    const args = parseClaimArgs(["Brief"], { TOWER_SPACE: "acme" });
    if (typeof args === "string") throw new Error(args);
    expect(args.who).toBe("someone");
  });

  it("floors a fractional eta and ignores a non-numeric one", () => {
    const ok = parseClaimArgs(["Brief", "--eta", "30.7"], { TOWER_SPACE: "acme" });
    if (typeof ok === "string") throw new Error(ok);
    expect(ok.etaMinutes).toBe(30);
    const bad = parseClaimArgs(["Brief", "--eta", "soon"], { TOWER_SPACE: "acme" });
    if (typeof bad === "string") throw new Error(bad);
    expect(bad).not.toHaveProperty("etaMinutes");
  });
});

describe("run", () => {
  it("exits 0 on a clear claim", async () => {
    const { connect } = connectWith({
      claim_intent: { claimId: "abcdef1234", conflicts: [], blocking: false },
    });
    const { out } = collect();
    const code = await run(["claim", "Brief", "--space", "acme"], out, connect);
    expect(code).toBe(0);
  });

  it("exits 2 when guard hits a hard conflict", async () => {
    const { connect } = connectWith({
      check_collision: {
        conflicts: [
          {
            claimId: "c1",
            agentId: "bo",
            severity: "hard",
            reason: "same artifact",
            overlap: [{ file: "Brief", symbol: "" }],
          },
        ],
      },
    });
    const { out } = collect();
    const code = await run(["guard", "Brief", "--space", "acme"], out, connect);
    expect(code).toBe(2);
  });

  it("exits 1 with a usage error, without calling the server", async () => {
    const { connect, calls } = connectWith({});
    const { out, text } = collect();
    const code = await run(["claim", "--space", "acme"], out, connect);
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(text()).toContain("needs an artifact");
  });

  it("release maps to complete_claim", async () => {
    const { connect, calls } = connectWith({ complete_claim: { ok: true } });
    const { out, text } = collect();
    const code = await run(["release", "--claim", "abcdef1234"], out, connect);
    expect(code).toBe(0);
    expect(calls[0]?.tool).toBe("complete_claim");
    expect(text()).toContain("Released");
  });

  it("keepalive maps to heartbeat", async () => {
    const { connect, calls } = connectWith({ heartbeat: { ok: true } });
    const { out } = collect();
    expect(await run(["keepalive", "--claim", "abcdef1234"], out, connect)).toBe(0);
    expect(calls[0]?.tool).toBe("heartbeat");
  });

  it("reports a claim that already expired", async () => {
    const { connect } = connectWith({ heartbeat: { ok: false } });
    const { out, text } = collect();
    expect(await run(["keepalive", "--claim", "abcdef1234"], out, connect)).toBe(1);
    expect(text()).toContain("No active claim");
  });

  it("prints help for no command and exits 0", async () => {
    const { connect } = connectWith({});
    const { out, text } = collect();
    expect(await run([], out, connect)).toBe(0);
    expect(text()).toContain("tower-anywhere");
  });

  it("prints help and exits 1 for an unknown command", async () => {
    const { connect } = connectWith({});
    const { out } = collect();
    expect(await run(["frobnicate"], out, connect)).toBe(1);
  });
});
