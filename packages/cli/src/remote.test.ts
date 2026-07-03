import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { startHttp, TowerService } from "@tower/server";
import { remoteConfig } from "./remote.js";
import { cmdGuard, cmdClaim, cmdComplete, cmdStatus, type ClaimArgs } from "./commands.js";

let server: Server;
let dirA: string;
let dirB: string;

beforeAll(async () => {
  // One hosted Tower stands in for the shared team server.
  server = await startHttp(new TowerService(), { port: 0 });
  const port = (server.address() as AddressInfo).port;
  process.env.TOWER_URL = `http://127.0.0.1:${port}/mcp`;
  // Two working dirs stand in for two teammates' machines.
  dirA = mkdtempSync(join(tmpdir(), "tower-a-"));
  dirB = mkdtempSync(join(tmpdir(), "tower-b-"));
});

afterAll(async () => {
  delete process.env.TOWER_URL;
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

function args(agentId: string): ClaimArgs {
  return {
    agentId,
    repo: "github.com/team/app",
    branch: "main",
    files: [],
    symbols: ["src/auth.ts#AuthService.verify"],
    purpose: "replace JWT",
  };
}

describe("remoteConfig", () => {
  it("reads TOWER_URL/TOWER_TOKEN from the environment", () => {
    expect(remoteConfig({ TOWER_URL: "http://x/mcp" })).toEqual({ url: "http://x/mcp" });
    expect(remoteConfig({ TOWER_URL: "http://x/mcp", TOWER_TOKEN: "s" })).toEqual({
      url: "http://x/mcp",
      token: "s",
    });
    expect(remoteConfig({})).toBeNull();
  });
});

describe("cross-machine enforcement (hosted Tower)", () => {
  it("blocks teammate B when teammate A holds a claim on the shared server", async () => {
    // Teammate A (machine A) guards the file → clear, claims on the hosted Tower.
    const aOut: string[] = [];
    const aBlocked = await cmdGuard(dirA, args("alice"), (l) => aOut.push(l));
    expect(aBlocked).toBe(false);

    // Teammate B (a different machine/dir) guards the same symbol → BLOCKED by A's remote claim.
    const bOut: string[] = [];
    const bBlocked = await cmdGuard(dirB, args("bob"), (l) => bOut.push(l));
    expect(bBlocked).toBe(true);
    expect(bOut.join("\n")).toContain("⛔ COLLISION");
    expect(bOut.join("\n")).toContain("alice");
  });

  it("status reflects the shared server, and completing frees the claim for others", async () => {
    // Teammate carol claims a different symbol on the hosted Tower.
    await cmdClaim(dirA, { ...args("carol"), symbols: ["src/pay.ts#charge"] }, () => {});

    // Teammate B sees carol's claim via remote status.
    const sB: string[] = [];
    await cmdStatus(dirB, (l) => sB.push(l));
    expect(sB.join("\n")).toContain("carol");

    // Complete carol's claim (id was written to .tower/claim-id) on the shared server.
    const claimId = readFileSync(join(dirA, ".tower", "claim-id"), "utf8");
    expect(await cmdComplete(dirA, claimId, "sha1", () => {})).toBe(true);

    // Now B can claim src/pay.ts#charge with no hard conflict.
    const blocked = await cmdGuard(
      dirB,
      { ...args("bob"), symbols: ["src/pay.ts#charge"] },
      () => {},
    );
    expect(blocked).toBe(false);
  });
});
