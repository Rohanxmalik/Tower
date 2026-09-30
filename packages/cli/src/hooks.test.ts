import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdClaim, gitRepoId } from "./commands.js";

/**
 * The Claude Code hooks, run as Claude Code runs them: a fresh `node` process, a JSON
 * payload on stdin, and the exit code as the verdict.
 *
 * The exit code is the whole contract. PreToolUse blocks an edit only by exiting 2, and
 * PostToolUse's `additionalContext` is read only on exit 0 — any other code is reported
 * as a hook error and the output is dropped. On Windows, `process.exit()` called while
 * V8 is still compiling tree-sitter's WebAssembly in the background aborts in libuv
 * (`!(handle->flags & UV_HANDLE_CLOSING)`) and the process exits 127 instead. The block
 * printed its reason and then let the edit through.
 */

const HOOKS = fileURLToPath(new URL("../../../hooks/", import.meta.url));
const built = existsSync(fileURLToPath(new URL("../dist/commands.js", import.meta.url)));

describe("hook exit codes survive the process ending", () => {
  it("no hook calls process.exit directly — they finish() through the shared lib", () => {
    const offenders = readdirSync(HOOKS)
      .filter((f) => f.endsWith(".mjs") && f !== "_tower-lib.mjs")
      .filter((f) => /process\.exit\s*\(/.test(readFileSync(join(HOOKS, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("finish() sets the exit code and lets the process end on its own", () => {
    const lib = readFileSync(join(HOOKS, "_tower-lib.mjs"), "utf8");
    expect(lib).toMatch(/export function finish\(/);
    expect(lib).toMatch(/process\.exitCode\s*=/);
    // The backstop must never be what keeps the process alive.
    expect(lib).toMatch(/\.unref\(\)/);
  });
});

describe.skipIf(!built)("the hooks, spawned against the built CLI", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tower-hooks-"));
    writeFileSync(
      join(dir, "auth.ts"),
      "export function verify(token: string): boolean {\n  return !!token;\n}\n",
    );
    const git = (c: string) => execSync(c, { cwd: dir, stdio: "ignore" });
    git("git init -q");
    git("git add auth.ts");
    git("git -c user.name=t -c user.email=t@t commit -q -m root");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const aliceHoldsVerify = () =>
    cmdClaim(
      dir,
      {
        agentId: "alice",
        repo: basename(dir), // what the hooks derive for a repo with no origin
        ...(gitRepoId(dir) ? { repoId: gitRepoId(dir)! } : {}),
        branch: execSync("git rev-parse --abbrev-ref HEAD", { cwd: dir }).toString().trim(),
        files: [],
        symbols: ["auth.ts#verify"],
        purpose: "change verify",
      },
      () => {},
    );

  const runHook = (hook: string, payload: object, agent = "bob") =>
    spawnSync(process.execPath, [join(HOOKS, hook)], {
      input: JSON.stringify({ cwd: dir, session_id: `${agent}-session`, ...payload }),
      env: { ...process.env, TOWER_AGENT: agent },
      encoding: "utf8",
      timeout: 30_000,
    });

  it("PreToolUse blocks a conflicting edit with exit 2", async () => {
    await aliceHoldsVerify();
    const res = runHook("pretooluse-tower.mjs", {
      tool_name: "Edit",
      tool_input: { file_path: "auth.ts", old_string: "return !!token;", new_string: "x" },
    });
    expect(res.stderr).toContain("Do not edit");
    expect(res.status).toBe(2);
  });

  it("PostToolUse on a Read hands the agent the warning as additionalContext, exit 0", async () => {
    await aliceHoldsVerify();
    const res = runHook("posttooluse-tower.mjs", {
      tool_name: "Read",
      tool_input: { file_path: "auth.ts" },
    });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("alice");
  });

  it("PostToolUse stays silent and exits 0 when nobody holds what was read", () => {
    const res = runHook("posttooluse-tower.mjs", {
      tool_name: "Read",
      tool_input: { file_path: "auth.ts" },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
  });
});
