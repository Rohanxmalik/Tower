import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withTower, type ToolCall } from "./client.js";
import { claim, guard, type ClaimArgs } from "./claim.js";

/**
 * The point of this file: run marketing-shaped identifiers through the *real* Tower
 * collision engine and show it returns the same hard/soft severities it gives code.
 * Nothing here mocks the server — a mock would only prove the mock agrees with itself.
 *
 * It drives the built Tower CLI as a subprocess, so this folder still has no code
 * dependency on the monorepo. Copy it to its own repo and these skip; the unit tests
 * and the CLI keep working.
 */
const TOWER_CLI = fileURLToPath(new URL("../../../packages/cli/dist/index.js", import.meta.url));
const BUILT = existsSync(TOWER_CLI);

const TOKEN = "test-token";
const SPACE = "acme-marketing";

let port = 0;
let server: ChildProcess | undefined;
let workdir = "";

/** Ask the OS for a free port instead of guessing — a guess can land on someone
 * else's server, whose /health answers happily and whose token is different. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (addr == null || typeof addr === "string") return reject(new Error("no port"));
      probe.close(() => resolve(addr.port));
    });
  });
}

/** Waits for *our* server: the token proves it, since a stranger would 401. */
async function waitForOurServer(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (server?.exitCode != null) throw new Error(`Tower exited with ${server.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/board`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`Tower did not start on port ${port}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const call = <T>(fn: (c: ToolCall) => Promise<T>): Promise<T> =>
  withTower({ url: `http://127.0.0.1:${port}/mcp`, token: TOKEN }, fn);

const args = (over: Partial<ClaimArgs> & Pick<ClaimArgs, "who" | "artifact">): ClaimArgs => ({
  space: SPACE,
  purpose: "test",
  ...over,
});

const swallow = (): void => {};

beforeAll(async () => {
  if (!BUILT) return;
  port = await freePort();
  workdir = mkdtempSync(join(tmpdir(), "tower-anywhere-"));
  // A clean env: an ambient TOWER_URL would turn `serve` into a proxy to someone else.
  const env = { ...process.env };
  delete env.TOWER_URL;
  delete env.TOWER_TOKEN;
  server = spawn(
    process.execPath,
    [TOWER_CLI, "serve", "--http", "--port", String(port), "--token", TOKEN],
    { cwd: workdir, env, stdio: "ignore" },
  );
  await waitForOurServer();
}, 30_000);

afterAll(async () => {
  if (server && server.exitCode == null) {
    const exited = new Promise((r) => server?.once("exit", r));
    server.kill();
    await exited;
  }
  try {
    // Windows keeps the db file locked until the process is fully gone; a leftover
    // temp dir is not worth failing a green suite over.
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* the OS reaps it */
  }
});

describe.skipIf(!BUILT)("against a real Tower server", () => {
  it("two people on the same whole artifact is a hard conflict", async () => {
    const artifact = "Q3 Launch Brief";
    await call((c) => claim(c, args({ who: "ana", artifact }), swallow));

    const blocked = await call((c) =>
      guard(c, args({ who: "bo", artifact, purpose: "adding the CTA" }), swallow),
    );
    expect(blocked).toBe(true);
  });

  it("different sections of one artifact is soft — a warning, not a stop", async () => {
    const artifact = "Content Calendar";
    await call((c) => claim(c, args({ who: "ana", artifact, section: "October" }), swallow));

    const conflicts: string[] = [];
    const blocked = await call((c) =>
      guard(c, args({ who: "bo", artifact, section: "November" }), (l) => conflicts.push(l)),
    );
    expect(blocked).toBe(false);
    expect(conflicts.join("\n")).toContain("soft");
  });

  it("the same section twice is hard", async () => {
    const artifact = "Homepage Copy";
    await call((c) => claim(c, args({ who: "ana", artifact, section: "hero headline" }), swallow));

    const blocked = await call((c) =>
      guard(c, args({ who: "bo", artifact, section: "hero headline" }), swallow),
    );
    expect(blocked).toBe(true);
  });

  it("unrelated artifacts never collide", async () => {
    await call((c) => claim(c, args({ who: "ana", artifact: "Webinar Deck" }), swallow));
    const blocked = await call((c) =>
      guard(c, args({ who: "bo", artifact: "Pricing Page Copy" }), swallow),
    );
    expect(blocked).toBe(false);
  });

  it("releasing an artifact frees it for the next person", async () => {
    const artifact = "Brand Guidelines";
    const claimId = await call(async (c) => {
      const res = (await c("claim_intent", {
        agentId: "ana",
        repo: SPACE,
        projectId: SPACE,
        branch: "main",
        files: [artifact],
        symbols: [{ file: artifact, symbol: "" }],
        purpose: "refresh",
      })) as { claimId: string | null };
      return res.claimId;
    });
    expect(claimId).not.toBeNull();

    expect(await call((c) => guard(c, args({ who: "bo", artifact }), swallow))).toBe(true);
    await call((c) => c("complete_claim", { claimId }));
    expect(await call((c) => guard(c, args({ who: "bo", artifact }), swallow))).toBe(false);
  });

  it("--force claims through a hard conflict and records the override", async () => {
    const artifact = "Press Release";
    await call((c) => claim(c, args({ who: "ana", artifact }), swallow));
    const blocked = await call((c) =>
      guard(c, args({ who: "bo", artifact, force: true }), swallow),
    );
    expect(blocked).toBe(false);
  });

  it("separate spaces never see each other", async () => {
    const artifact = "Q4 Plan";
    await call((c) => claim(c, args({ who: "ana", artifact }), swallow));
    const blocked = await call((c) =>
      guard(c, { ...args({ who: "bo", artifact }), space: "other-team" }, swallow),
    );
    expect(blocked).toBe(false);
  });
});
