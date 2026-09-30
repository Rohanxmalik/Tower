import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TOWER_VERSION } from "@tower/shared";

/**
 * The `tower` binary as a user runs it. `index.ts` runs on import, so it is exercised
 * through the build — the same artefact npm ships.
 */

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const tower = (...args: string[]) =>
  spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: 30_000 });

describe.skipIf(!existsSync(BIN))("tower --help / --version", { timeout: 30_000 }, () => {
  // docs/worker.md calls `tower work --help` the authoritative flag reference, and it
  // exited 1 with "Unknown option '--help'" — the one command a new user tries first.
  it.each(["work", "serve", "claim", "setup", "doctor"])(
    "%s --help prints usage, exit 0",
    (cmd) => {
      const res = tower(cmd, "--help");
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("Usage: tower");
    },
  );

  it.each([["--version"], ["-v"], ["version"]])("%s prints the version", (flag) => {
    const res = tower(flag);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(TOWER_VERSION);
  });

  it("documents every flag `tower work` accepts", () => {
    const help = tower("--help").stdout;
    for (const flag of [
      "--agent",
      "--repo",
      "--cmd",
      "--interval",
      "--max-minutes",
      "--no-push",
      "--no-pr",
    ]) {
      expect(help, flag).toContain(flag);
    }
    expect(help).toContain("--host");
  });
});
