import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  TOWER_VERSION,
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
  it("exposes exactly the 20 tools", () => {
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
        "propose_intent",
        "record_reads",
        "fetch_messages",
        "pending",
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

describe("version and tool count cannot drift from what users are told", () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const read = (p: string): string => readFileSync(join(root, p), "utf8");

  // Three times in one release cycle a published number went stale: the tool count in
  // six docs, the test count on the landing page, and the README status line — twice.
  // Every one was caught by a human reading carefully, which is not a control.
  it("TOWER_VERSION matches the published package", () => {
    const pkg = JSON.parse(read("packages/cli/package.json")) as { version: string };
    expect(TOWER_VERSION).toBe(pkg.version);
  });

  it("the root package.json agrees too", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(TOWER_VERSION).toBe(pkg.version);
  });

  it("the README status line names the shipped version", () => {
    const status = /^> Status: \*\*v(\d+\.\d+\.\d+)/m.exec(read("README.md"));
    expect(status, "README has no `> Status: **vX.Y.Z` line to check").not.toBeNull();
    expect(status?.[1]).toBe(TOWER_VERSION);
  });

  it("every doc that states a tool count states the real one", () => {
    const actual = Object.keys(TOOL_SCHEMAS).length;
    const words: Record<number, string> = {
      18: "eighteen",
      19: "nineteen",
      20: "twenty",
      21: "twenty-one",
      22: "twenty-two",
    };
    for (const f of [
      "README.md",
      "docs/protocol.md",
      "SECURITY.md",
      "CLAUDE.md",
      "site/index.html",
    ]) {
      const text = read(f);
      // A wrong count is worse than no count, so only flag numbers that claim to be one.
      for (const m of text.matchAll(/(\d+) (?:MCP )?tools/g)) {
        expect(Number(m[1]), `${f} claims "${m[0]}" but there are ${actual}`).toBe(actual);
      }
      // Plain substring checks, not a built regex: a `\b` written into a template
      // literal is a backspace character, not a word boundary, and the guard silently
      // matches nothing. That exact bug was in the first version of this test.
      const lower = text.toLowerCase();
      for (const [n, word] of Object.entries(words)) {
        if (Number(n) === actual) continue;
        for (const phrase of [`${word} tools`, `${word} mcp tools`]) {
          expect(
            lower.includes(phrase),
            `${f} spells out "${phrase}" but there are ${actual} tools`,
          ).toBe(false);
        }
      }
    }
  });

  // server.json is a fourth place the version lives, and the one with the widest blast
  // radius: the MCP Registry publishes from it and Glama, PulseMCP and mcp.so sync from
  // the registry. A stale version here advertises a release users cannot install, in
  // several directories at once, and nothing in the build would have noticed.
  it("server.json agrees with the published package", () => {
    const server = JSON.parse(read("server.json")) as {
      name: string;
      description: string;
      version: string;
      packages?: { registryType: string; identifier: string; version: string }[];
    };
    expect(server.version).toBe(TOWER_VERSION);

    // Reverse-DNS, exactly one slash — the registry rejects anything else.
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);

    // The registry caps description at 100 characters and rejects the whole submission
    // over it — which is why this is not the same string as the README one-liner.
    expect(server.description.length).toBeLessThanOrEqual(100);

    const npm = server.packages?.find((p) => p.registryType === "npm");
    expect(npm, "server.json declares no npm package").toBeDefined();
    const pkg = JSON.parse(read("packages/cli/package.json")) as { name: string };
    expect(npm?.identifier).toBe(pkg.name);
    expect(npm?.version).toBe(TOWER_VERSION);
  });
});
