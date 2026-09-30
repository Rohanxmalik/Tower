import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  cmdClaim,
  cmdComplete,
  cmdInit,
  cmdRecordReads,
  cmdSetup,
  hookRecordReads,
  type ClaimArgs,
} from "./commands.js";
import { buildService } from "./lib.js";
import { towerRule } from "./nobody-waits.js";

/** 0.12.0 through the CLI and hooks — the path users actually run. */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tower-nw-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const collect = () => {
  const lines: string[] = [];
  return { out: (l: string) => lines.push(l), text: () => lines.join("\n") };
};
const repo = "acme/app";
const OLD = `export class AuthService {\n  verify(token: string): boolean { return !!token; }\n}\n`;
const NEW = `export class AuthService {\n  verify(token: string, opts: Opts): boolean { return !!token; }\n}\n`;
const claimArgs = (over: Partial<ClaimArgs>): ClaimArgs => ({
  agentId: "bob",
  repo,
  branch: "main",
  files: [],
  symbols: [],
  purpose: "",
  ...over,
});

describe("cmdRecordReads returns the read-time warning to the hook", () => {
  it("reports another agent editing what was just read", async () => {
    writeFileSync(join(dir, "auth.ts"), OLD);
    await cmdClaim(
      dir,
      claimArgs({ agentId: "alice", symbols: ["auth.ts#AuthService.verify"] }),
      () => {},
    );
    const warned = await cmdRecordReads(dir, {
      agentId: "bob",
      repo,
      branch: "main",
      file: "auth.ts",
    });
    expect(warned).toHaveLength(1);
    expect(warned[0]?.agentId).toBe("alice");
  });

  // Regression: cmdClaim derived repoId from the root commit, cmdRecordReads did not, so a
  // caller that omitted repoId put reads and claims in different partitions and nothing
  // ever matched. It was only visible when the working dir was inside a git repo — so this
  // test makes one, rather than depending on where the temp dir happens to live.
  it("partitions a read exactly like a claim when repoId is left to be derived", async () => {
    const git = (cmd: string) =>
      execSync(`git ${cmd}`, {
        cwd: dir,
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    git("init -q");
    writeFileSync(join(dir, "auth.ts"), OLD);
    git("add auth.ts");
    git("commit -q -m root");

    await cmdClaim(
      dir,
      claimArgs({ agentId: "alice", symbols: ["auth.ts#AuthService.verify"] }),
      () => {},
    );
    const warned = await cmdRecordReads(dir, {
      agentId: "bob",
      repo,
      branch: "main",
      file: "auth.ts",
    });
    expect(warned.map((c) => c.agentId)).toEqual(["alice"]);
  });

  it("returns nothing when nobody holds what was read", async () => {
    writeFileSync(join(dir, "auth.ts"), OLD);
    expect(await cmdRecordReads(dir, { agentId: "bob", repo, file: "auth.ts" })).toEqual([]);
  });

  it("returns nothing for a file that is not there", async () => {
    expect(await cmdRecordReads(dir, { agentId: "bob", repo, file: "missing.ts" })).toEqual([]);
  });
});

describe("hookRecordReads — exactly what the PostToolUse hook prints", () => {
  it("prints nothing at all when the read is uncontested", async () => {
    writeFileSync(join(dir, "auth.ts"), OLD);
    expect(await hookRecordReads(dir, { agentId: "bob", repo, file: "auth.ts" })).toBeNull();
  });

  it("prints additionalContext JSON naming the holder, so the agent actually sees it", async () => {
    writeFileSync(join(dir, "auth.ts"), OLD);
    await cmdClaim(
      dir,
      claimArgs({ agentId: "alice", symbols: ["auth.ts#AuthService.verify"] }),
      () => {},
    );
    const printed = await hookRecordReads(dir, {
      agentId: "bob",
      repo,
      branch: "main",
      file: "auth.ts",
    });
    const parsed = JSON.parse(printed!) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("alice");
  });
});

describe("cmdClaim prints what to do instead of a bare refusal", () => {
  it("shows the alternatives after REFUSED", async () => {
    await cmdClaim(dir, claimArgs({ symbols: ["auth.ts#verify"] }), () => {});
    const { out, text } = collect();
    const hard = await cmdClaim(
      dir,
      claimArgs({ agentId: "alice", symbols: ["auth.ts#verify"] }),
      out,
    );
    expect(hard).toBe(true);
    expect(text()).toContain("REFUSED");
    expect(text()).toContain("What to do instead");
    expect(text()).toContain("verify");
  });

  it("prints no alternatives for a granted claim", async () => {
    const { out, text } = collect();
    await cmdClaim(dir, claimArgs({ symbols: ["auth.ts#verify"] }), out);
    expect(text()).not.toContain("What to do instead");
  });
});

describe("cmdComplete reads the final declarations from the working tree", () => {
  it("tells readers what landed, end to end through the CLI", async () => {
    writeFileSync(join(dir, "auth.ts"), OLD);
    // bob claims the file (fingerprints extracted from disk) and declares the new contract.
    const svc = buildService(dir);
    const extracted = (await import("@tower/server")).SymbolExtractor;
    const [verify] = (await new extracted().extract("auth.ts", OLD)).filter(
      (s) => s.symbol === "AuthService.verify",
    );
    const bob = svc.claimIntent({
      agentId: "bob",
      repo,
      branch: "main",
      files: [],
      symbols: [{ ...verify!, declares: "verify(token: string, opts: Opts): boolean" }],
      purpose: "",
    });
    // alice's work reads verify().
    svc.claimIntent({
      agentId: "alice",
      repo,
      branch: "main",
      files: [],
      symbols: [{ file: "pay.ts", symbol: "checkout" }],
      reads: [verify!],
      purpose: "",
    });
    svc.store.close();

    writeFileSync(join(dir, "auth.ts"), NEW); // bob's change lands
    const { out, text } = collect();
    expect(await cmdComplete(dir, bob.claimId!, "abc1234", out)).toBe(true);
    expect(text()).toMatch(/told 1 agent/i);

    const after = buildService(dir);
    const [notice] = after.fetchMessages({ agentId: "alice", repo }).messages;
    after.store.close();
    expect(notice?.body).toMatch(/as declared/i);
  });

  it("still completes a claim with nothing to fingerprint", async () => {
    const svc = buildService(dir);
    const { claimId } = svc.claimIntent({
      agentId: "a",
      repo,
      branch: "main",
      files: ["gone.ts"],
      symbols: [],
      purpose: "",
    });
    svc.store.close();
    const { out, text } = collect();
    expect(await cmdComplete(dir, claimId!, undefined, out)).toBe(true);
    expect(text()).toContain("Completed claim");
    expect(text()).not.toMatch(/told/);
  });
});

// `tower init` printed a hand-copied rule from before 0.12 — no `alternatives`, no
// `declares` — so the two onboarding commands taught agents two different protocols.
describe("cmdInit prints the rule setup writes", () => {
  it("includes the 0.12 rule text, verbatim", () => {
    const { out, text } = collect();
    cmdInit(dir, out);
    for (const line of towerRule().trim().split("\n")) expect(text()).toContain(line.trim());
  });
});

describe("cmdSetup --keep-going", () => {
  it("writes the keep-going rule instead of stop-and-ask", () => {
    cmdSetup(dir, { keepGoing: true }, () => {});
    const rule = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(rule).toContain("alternatives.avoid");
    expect(rule).not.toMatch(/stop and ask the\s+user/);
  });

  it("keeps stop-and-ask as the default", () => {
    cmdSetup(dir, {}, () => {});
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toMatch(/stop and ask the\s+user/);
  });
});
