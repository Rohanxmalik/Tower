// Shared helpers for the Tower hooks.
//
// These used to be copy-pasted per hook, which is how the hook path and the MCP path
// ended up normalizing the repo differently and landing in separate partitions. One
// implementation, imported by every hook.
import { execSync } from "node:child_process";
import { basename } from "node:path";

/** Run a git command in `cwd`, returning "" instead of throwing. */
function git(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

/**
 * Identify the repository the same way the server does.
 *
 * `repoId` is the root commit sha — identical across every clone, fork and mirror, so a
 * fork and its upstream share one coordination space. `repo` stays as the readable label.
 */
export function repoContext(cwd) {
  const origin = git("git config --get remote.origin.url", cwd);
  const repo = origin || basename(git("git rev-parse --show-toplevel", cwd) || cwd);
  const roots = git("git rev-list --max-parents=0 HEAD", cwd)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(l));
  // git lists newest-first; the last is the earliest, and the one forks share.
  const repoId = roots.length ? roots[roots.length - 1].toLowerCase() : undefined;
  const branch = git("git rev-parse --abbrev-ref HEAD", cwd) || "main";
  return { repo, repoId, branch };
}

/** A stable per-session agent id, so the board can tell two open editors apart. */
export function agentIdFor(input) {
  return process.env.TOWER_AGENT || `claude-${(input?.session_id ?? "code").slice(0, 8)}`;
}

/** How long a finished hook may linger before it is ended by force. */
const FINISH_GRACE_MS = 2000;

/**
 * End the hook with `code`. Every hook exits through here, never `process.exit()`.
 *
 * The exit code is the hook's whole verdict: PreToolUse blocks only by exiting 2, and
 * PostToolUse's JSON is read only on exit 0. On Windows, `process.exit()` while V8 is
 * still compiling tree-sitter's WebAssembly in the background aborts in libuv and the
 * process exits 127 — the block printed its reason and then let the edit through. So set
 * the code and let the event loop drain. The unref'd timer only fires if something else
 * holds the process open, by which time that compilation has long finished.
 */
export function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), FINISH_GRACE_MS).unref();
}

/** Import the built CLI's command module (hooks run from source, not from npm). */
export async function loadCommands(hookDir) {
  return import(new URL("../packages/cli/dist/commands.js", `file://${hookDir}/`).href);
}
