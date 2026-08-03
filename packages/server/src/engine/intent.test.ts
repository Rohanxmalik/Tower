import { describe, it, expect } from "vitest";
import type { Claim } from "@tower/shared";
import { tokenize, similarity, matchIntent, DEFAULT_INTENT_THRESHOLD } from "./intent.js";

function claim(over: Partial<Claim> = {}): Claim {
  return {
    id: "c1",
    agentId: "alice",
    repo: "acme/app",
    branch: "main",
    files: [],
    symbols: [],
    purpose: "",
    status: "active",
    createdAt: 1000,
    expiresAt: 99_000,
    ...over,
  };
}

describe("tokenize", () => {
  it("keeps the words a purpose is actually about", () => {
    expect([...tokenize("write a blog post about prompt injection")]).toEqual([
      "blog",
      "prompt",
      "injection",
    ]);
  });

  it("stems so plurals and gerunds match their root", () => {
    expect(tokenize("agents").has("agent")).toBe(true);
    expect(tokenize("caching")).toEqual(tokenize("cache"));
  });

  it("survives punctuation and slashes", () => {
    expect([...tokenize("AI agent security / prompt-injection!")]).toContain("injection");
  });

  it("returns nothing for a purpose made only of filler", () => {
    expect(tokenize("working on some of the new work").size).toBe(0);
  });
});

describe("similarity", () => {
  it("scores the observed duplicate above the threshold", () => {
    // The exact pair that cost a full research-and-write cycle in the live session.
    const score = similarity(
      "write a blog post about prompt injection",
      "AI agent security / prompt injection",
    );
    expect(score).toBeGreaterThanOrEqual(DEFAULT_INTENT_THRESHOLD);
  });

  it("scores unrelated work near zero", () => {
    expect(similarity("replace JWT with sessions", "update the pricing page copy")).toBe(0);
  });

  it("does not fire on a single incidental shared word", () => {
    expect(similarity("refactor the auth module for clarity", "auth")).toBeLessThan(
      DEFAULT_INTENT_THRESHOLD,
    );
  });

  it("is symmetric and self-identical", () => {
    const a = "rate limit the login endpoint";
    const b = "add rate limiting to login";
    expect(similarity(a, b)).toBe(similarity(b, a));
    expect(similarity(a, a)).toBe(1);
  });

  it("is zero when either side is empty", () => {
    expect(similarity("", "prompt injection")).toBe(0);
    expect(similarity("prompt injection", "   ")).toBe(0);
  });
});

describe("T7 — semantic duplicate is caught despite different file paths (DEV-01)", () => {
  it("flags the second agent before any file exists", () => {
    const held = claim({
      id: "held",
      agentId: "claude-code-rohan",
      purpose: "AI agent security / prompt injection",
      files: ["ai-agent-security-prompt-injection.mdx"],
    });

    const matches = matchIntent("write a blog post about prompt injection", [held], {
      agentId: "claude-mayank",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.agentId).toBe("claude-code-rohan");
    expect(matches[0]?.score).toBeGreaterThanOrEqual(DEFAULT_INTENT_THRESHOLD);
    // The point: the paths differ, so no file-level check would ever have fired.
    expect(matches[0]?.files).toEqual(["ai-agent-security-prompt-injection.mdx"]);
  });

  it("ignores the agent's own claims", () => {
    const mine = claim({ agentId: "me", purpose: "prompt injection research" });
    expect(matchIntent("prompt injection research", [mine], { agentId: "me" })).toEqual([]);
  });

  it("ignores claims with no stated purpose", () => {
    expect(matchIntent("prompt injection", [claim({ purpose: "" })])).toEqual([]);
  });

  it("returns nothing when the work is genuinely different", () => {
    const held = claim({ purpose: "migrate the database to postgres" });
    expect(matchIntent("write a blog post about prompt injection", [held])).toEqual([]);
  });

  it("ranks the strongest match first", () => {
    const weak = claim({ id: "weak", agentId: "a", purpose: "prompt injection basics guide" });
    const strong = claim({ id: "strong", agentId: "b", purpose: "prompt injection" });
    const matches = matchIntent("prompt injection", [weak, strong]);
    expect(matches[0]?.claimId).toBe("strong");
    expect(matches[0]!.score).toBeGreaterThan(matches[1]!.score);
  });

  it("honours a custom threshold", () => {
    const held = claim({ purpose: "refactor the auth module" });
    expect(matchIntent("auth", [held], { threshold: 0.9 })).toEqual([]);
    expect(matchIntent("refactor the auth module", [held], { threshold: 0.9 })).toHaveLength(1);
  });
});
