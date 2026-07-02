// Tower two-agent collision demo — the hero scenario.
// Run: npm run demo   (builds packages, then executes this against a temp repo)
//
// Shows two AI agents about to edit the SAME symbol. The second one is warned
// BEFORE it writes a single line — not at merge time.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdClaim, cmdStatus } from "../../packages/cli/dist/commands.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s = "") => process.stdout.write(s + "\n");
const dir = mkdtempSync(join(tmpdir(), "tower-demo-"));

const repo = "acme/app";
const target = "src/auth/service.ts#AuthService.verify";

try {
  log("\n\x1b[1m🗼 Tower — two agents, one repo\x1b[0m\n");
  await sleep(600);

  log("\x1b[36m▶ cursor-bob starts refactoring AuthService.verify (replace JWT)\x1b[0m");
  await sleep(400);
  await cmdClaim(dir, {
    agentId: "cursor-bob",
    repo,
    branch: "main",
    files: [],
    symbols: [target],
    purpose: "replace JWT",
    etaMinutes: 6,
  });
  await sleep(1400);

  log(
    "\n\x1b[36m▶ claude-a is asked to add rate-limiting — and reaches for the same symbol\x1b[0m",
  );
  await sleep(400);
  await cmdClaim(dir, {
    agentId: "claude-a",
    repo,
    branch: "main",
    files: [],
    symbols: [target],
    purpose: "add rate limiting",
  });
  await sleep(1400);

  log("\n\x1b[2m— live claim state —\x1b[0m");
  cmdStatus(dir);
  log("\n\x1b[32mNo merge conflict. No wasted work. Caught before the first keystroke.\x1b[0m\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
