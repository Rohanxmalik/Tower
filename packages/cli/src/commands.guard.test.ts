import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdClaim,
  cmdGuard,
  cmdRecordReads,
  gitRepoId,
  resolveSymbols,
  type ClaimArgs,
} from "./commands.js";
import { buildService } from "./lib.js";

/**
 * `tower guard` is what the PreToolUse hook and the pre-commit guard run, so it is the
 * path most blocked edits take. In 0.12.0 it pre-checked with `check_collision` and
 * returned before `claim_intent` — so a hook-blocked agent was told "Tower messages you"
 * and never was: no waiter, no alternatives, and the collision never reached `tower stats`.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tower-guard-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const collect = () => {
  const lines: string[] = [];
  return { out: (l: string) => lines.push(l), text: () => lines.join("\n") };
};
const repo = "acme/app";
const args = (over: Partial<ClaimArgs>): ClaimArgs => ({
  agentId: "bob",
  repo,
  branch: "main",
  files: [],
  symbols: ["auth.ts#verify"],
  purpose: "",
  ...over,
});

describe("a guard-blocked edit gets what a refused claim gets", () => {
  it("prints what to do instead", async () => {
    await cmdGuard(dir, args({}), () => {});
    const { out, text } = collect();
    expect(await cmdGuard(dir, args({ agentId: "alice" }), out)).toBe(true);
    expect(text()).toContain("⛔ COLLISION");
    expect(text()).toContain("What to do instead");
  });

  it("messages the blocked agent when the holder completes — the [w] promise", async () => {
    await cmdGuard(dir, args({}), () => {});
    await cmdGuard(dir, args({ agentId: "alice" }), () => {});

    const svc = buildService(dir);
    const [held] = svc.store.listClaims({ status: "active" });
    svc.completeClaim({ claimId: held!.id });
    // The temp dir may sit inside a git repo; read from the partition guard wrote to.
    const repoId = gitRepoId(dir);
    const inbox = svc.fetchMessages({
      agentId: "alice",
      repo,
      ...(repoId ? { repoId } : {}),
    }).messages;
    svc.store.close();
    expect(inbox.map((m) => m.fromAgentId)).toContain("tower");
  });

  it("counts a hook retrying the same blocked edit once in tower stats", async () => {
    await cmdGuard(dir, args({}), () => {});
    for (let i = 0; i < 3; i++) await cmdGuard(dir, args({ agentId: "alice" }), () => {});
    const svc = buildService(dir);
    const { hard } = svc.store.conflictStats().bySeverity;
    svc.store.close();
    expect(hard).toBe(1);
  });

  it("still registers nothing for the blocked agent", async () => {
    await cmdGuard(dir, args({}), () => {});
    await cmdGuard(dir, args({ agentId: "alice" }), () => {});
    const svc = buildService(dir);
    const agents = svc.store.listClaims({ status: "active" }).map((c) => c.agentId);
    svc.store.close();
    expect(agents).toEqual(["bob"]);
  });
});

// The pre-check ignored the reads the agent had recorded, and a refusal from the claim
// that followed was dropped — so the edit went ahead with no claim held at all.
describe("guard honours a contract that moved under recorded reads", () => {
  it("blocks rather than letting the edit through unclaimed", async () => {
    writeFileSync(
      join(dir, "auth.ts"),
      "export function verify(token: string): boolean { return !!token; }\n",
    );
    await cmdRecordReads(dir, { agentId: "bob", repo, branch: "main", file: "auth.ts" });
    // alice changes the declaration bob read, and holds it
    writeFileSync(
      join(dir, "auth.ts"),
      "export function verify(token: string, opts: Opts): boolean { return !!token; }\n",
    );
    await cmdClaim(dir, args({ agentId: "alice", symbols: ["auth.ts#verify"] }), () => {});

    const { out, text } = collect();
    const blocked = await cmdGuard(dir, args({ symbols: ["pay.ts#charge"] }), out);
    const svc = buildService(dir);
    const bobHolds = svc.store.listClaims({ status: "active" }).some((c) => c.agentId === "bob");
    svc.store.close();
    expect(blocked || bobHolds).toBe(true); // never: allowed AND unclaimed
    expect(blocked).toBe(true);
    expect(text()).toContain("verify");
  });
});

// A claim made through the CLI or a hook named its symbols but carried no fingerprint, so
// nothing downstream could tell whether a declaration moved: no hard write_read, no
// heartbeat invalidation, no landed-signature notice on complete. Only MCP clients that
// sent `sig` themselves got any of it.
describe("resolveSymbols fingerprints named symbols from the working tree", () => {
  it("attaches sig and sigText when the declaration is on disk", async () => {
    writeFileSync(
      join(dir, "auth.ts"),
      "export function verify(token: string): boolean { return !!token; }\n",
    );
    const [verify] = await resolveSymbols(dir, [], ["auth.ts#verify"]);
    expect(verify?.sig).toMatch(/^c1:/);
    expect(verify?.sigText).toBe("function verify(token: string): boolean");
  });

  it("leaves a symbol it cannot find, or a whole-file entry, as named", async () => {
    writeFileSync(join(dir, "auth.ts"), "export const x = 1;\n");
    expect(await resolveSymbols(dir, [], ["auth.ts#nope", "auth.ts#", "gone.ts#f"])).toEqual([
      { file: "auth.ts", symbol: "nope" },
      { file: "auth.ts", symbol: "" },
      { file: "gone.ts", symbol: "f" },
    ]);
  });
});
