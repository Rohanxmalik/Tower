import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  cmdClaim,
  cmdGuard,
  cmdStatus,
  cmdInit,
  cmdComplete,
  cmdServe,
  cmdWatch,
  resolveSymbols,
  resolvePort,
  type ClaimArgs,
} from "./commands.js";
import { buildService } from "./lib.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tower-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function collect(): { out: (l: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { out: (l) => lines.push(l), lines };
}

const bob: ClaimArgs = {
  agentId: "cursor-bob",
  repo: "acme/app",
  branch: "main",
  files: [],
  symbols: ["src/auth.ts#AuthService.verify"],
  purpose: "replace JWT",
  etaMinutes: 6,
};

describe("cmdClaim", () => {
  it("registers a first claim with no collision", async () => {
    const { out, lines } = collect();
    const hard = await cmdClaim(dir, bob, out);
    expect(hard).toBe(false);
    expect(lines.join("\n")).toContain("safe to proceed");
  });

  it("detects a hard collision when a second agent claims the same symbol", async () => {
    await cmdClaim(dir, bob, () => {});
    const { out, lines } = collect();
    const hard = await cmdClaim(
      dir,
      { ...bob, agentId: "claude-a", purpose: "add rate limit" },
      out,
    );
    expect(hard).toBe(true);
    const text = lines.join("\n");
    expect(text).toContain("⛔ COLLISION — AuthService.verify");
    expect(text).toContain('Agent "cursor-bob"');
  });

  it("shares state across invocations via the file-backed store", async () => {
    await cmdClaim(dir, bob, () => {});
    const { out, lines } = collect();
    await cmdStatus(dir, out);
    expect(lines.join("\n")).toContain("cursor-bob");
  });

  it("writes .tower/claim-id for the git post-commit hook", async () => {
    await cmdClaim(dir, bob, () => {});
    expect(existsSync(join(dir, ".tower", "claim-id"))).toBe(true);
  });
});

describe("cmdGuard (enforcement)", () => {
  it("allows and claims when the file is clear", async () => {
    const { out } = collect();
    const blocked = await cmdGuard(dir, bob, out);
    expect(blocked).toBe(false);
    // registered a claim
    const status = collect();
    await cmdStatus(dir, status.out);
    expect(status.lines.join("\n")).toContain("cursor-bob");
  });

  it("blocks a second agent on a hard collision WITHOUT registering a new claim", async () => {
    await cmdGuard(dir, bob, () => {});
    const { out, lines } = collect();
    const blocked = await cmdGuard(dir, { ...bob, agentId: "claude-a" }, out);
    expect(blocked).toBe(true);
    expect(lines.join("\n")).toContain("⛔ COLLISION");

    // only cursor-bob's claim exists; the blocked edit did not create one
    const status = collect();
    await cmdStatus(dir, status.out);
    const table = status.lines.join("\n");
    expect(table).toContain("cursor-bob");
    expect(table).not.toContain("claude-a");
  });
});

describe("resolveSymbols (auto-extraction)", () => {
  it("returns explicit symbols verbatim", async () => {
    const syms = await resolveSymbols(dir, [], ["src/auth.ts#AuthService.verify"]);
    expect(syms).toEqual([{ file: "src/auth.ts", symbol: "AuthService.verify" }]);
  });

  it("extracts symbols from a real file on disk via tree-sitter", async () => {
    writeFileSync(join(dir, "svc.ts"), "export class AuthService { verify() { return true; } }");
    const syms = await resolveSymbols(dir, ["svc.ts"], []);
    const names = syms.map((s) => s.symbol);
    expect(names).toContain("AuthService");
    expect(names).toContain("AuthService.verify");
  });

  it("falls back to a file-level symbol when the file is missing", async () => {
    const syms = await resolveSymbols(dir, ["nope.ts"], []);
    expect(syms).toEqual([{ file: "nope.ts", symbol: "" }]);
  });
});

describe("cmdComplete", () => {
  it("completes an active claim and clears it from status", async () => {
    const svc = buildService(dir);
    const { claimId } = svc.claimIntent({
      agentId: "a",
      repo: "r",
      branch: "main",
      files: ["src/x.ts"],
      symbols: [],
      purpose: "",
    });
    svc.store.close();

    const { out, lines } = collect();
    expect(await cmdComplete(dir, claimId, "deadbeef", out)).toBe(true);
    expect(lines.join("\n")).toContain("Completed claim");

    const status = collect();
    await cmdStatus(dir, status.out);
    expect(status.lines.join("\n")).toContain("No active claims");
  });

  it("reports when there is no matching active claim", async () => {
    const { out, lines } = collect();
    expect(await cmdComplete(dir, "does-not-exist", undefined, out)).toBe(false);
    expect(lines.join("\n")).toContain("No active claim");
  });
});

describe("resolvePort", () => {
  it("prefers an explicit port", () => {
    expect(resolvePort(5000, { PORT: "3000" })).toBe(5000);
  });
  it("falls back to the PORT env (Render/Railway/Fly)", () => {
    expect(resolvePort(undefined, { PORT: "10000" })).toBe(10000);
  });
  it("defaults to 4319 when neither is set", () => {
    expect(resolvePort(undefined, {})).toBe(4319);
  });
});

describe("cmdServe", () => {
  it("starts an HTTP server that answers /health", async () => {
    const { out, lines } = collect();
    const server = await cmdServe(dir, { http: true, port: 0 }, out);
    expect(server).toBeDefined();
    try {
      const port = (server!.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect((await res.json()).ok).toBe(true);
      expect(lines.join("\n")).toContain("listening");
    } finally {
      await new Promise<void>((r) => server!.close(() => r()));
    }
  });
});

describe("cmdWatch", () => {
  it("polls the claims table for the requested number of ticks", async () => {
    await cmdClaim(dir, bob, () => {});
    const { out, lines } = collect();
    await cmdWatch(dir, out, { intervalMs: 1, ticks: 2 });
    const printed = lines.filter((l) => l.includes("Active claims"));
    expect(printed).toHaveLength(2);
  });
});

describe("cmdInit", () => {
  it("writes an example policy and prints MCP setup", () => {
    const { out, lines } = collect();
    cmdInit(dir, out);
    expect(existsSync(join(dir, ".tower", "policy.yaml"))).toBe(true);
    expect(lines.join("\n")).toContain("mcpServers");
  });

  it("respects an existing policy file", () => {
    mkdirSync(join(dir, ".tower"), { recursive: true });
    writeFileSync(join(dir, ".tower", "policy.yaml"), "modules: {}\n");
    const { out, lines } = collect();
    cmdInit(dir, out);
    expect(lines.join("\n")).toContain("already exists");
  });
});
