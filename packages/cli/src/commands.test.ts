import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
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
  cmdSetup,
  resolveSymbols,
  resolvePort,
  localServeConflict,
  localModeWarning,
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
    const { out, lines } = collect();
    const blocked = await cmdGuard(dir, bob, out);
    expect(blocked).toBe(false);
    // says so out loud — silence looks like a failure
    expect(lines.join("\n")).toContain("CLEAR");
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

describe("cmdGuard --force", () => {
  it("proceeds past a hard collision, registers the claim, and says it was forced", async () => {
    await cmdGuard(dir, bob, () => {});
    const { out, lines } = collect();
    const { cmdGuard: guard } = await import("./commands.js");
    const blocked = await guard(dir, { ...bob, agentId: "claude-a", force: true }, out);
    expect(blocked).toBe(false);
    expect(lines.join("\n")).toContain("FORCED");
    const status = collect();
    await cmdStatus(dir, status.out);
    expect(status.lines.join("\n")).toContain("claude-a");
  });
});

describe("cmdNextTask", () => {
  it("suggests a module that is safe to start given active claims", async () => {
    mkdirSync(join(dir, ".tower"), { recursive: true });
    writeFileSync(
      join(dir, ".tower", "policy.yaml"),
      'modules:\n  auth: { path: "src/auth/**" }\n  api: { path: "src/api/**", depends_on: [auth] }\n  docs: { path: "docs/**" }\nlimits:\n  max_agents_per_module: 1\n',
    );
    // auth is busy → api is blocked (depends on auth), docs is free… but auth itself
    // is also busy, so the first clear module is docs.
    await cmdClaim(dir, { ...bob, files: ["src/auth/login.ts"], symbols: [] }, () => {});
    const { out, lines } = collect();
    const { cmdNextTask } = await import("./commands.js");
    await cmdNextTask(dir, { agentId: "claude-a", repo: "acme/app" }, out);
    const text = lines.join("\n");
    expect(text).toContain("docs");
  });

  it("explains itself when no policy modules exist", async () => {
    const { out, lines } = collect();
    const { cmdNextTask } = await import("./commands.js");
    await cmdNextTask(dir, { agentId: "claude-a", repo: "acme/app" }, out);
    expect(lines.join("\n").toLowerCase()).toContain("no candidate");
  });
});

describe("cmdSend / cmdInbox (agent comms)", () => {
  it("sends a task and the recipient reads it once", async () => {
    const { cmdSend, cmdInbox } = await import("./commands.js");
    const sent = collect();
    await cmdSend(
      dir,
      { from: "alice", to: "bob", repo: "team/app", body: "add rate limiting", task: true },
      sent.out,
    );
    expect(sent.lines.join("\n")).toContain("Sent task");

    const inbox = collect();
    await cmdInbox(dir, { agentId: "bob" }, inbox.out);
    const text = inbox.lines.join("\n");
    expect(text).toContain("alice");
    expect(text).toContain("add rate limiting");
    expect(text).toContain("TASK");

    const again = collect();
    await cmdInbox(dir, { agentId: "bob" }, again.out);
    expect(again.lines.join("\n")).toContain("empty");
  });

  it("nudge surfaces waiting work read-only, and stays silent when clear", async () => {
    const { cmdSend, cmdNudge } = await import("./commands.js");
    await cmdSend(
      dir,
      { from: "alice", to: "bob", repo: "team/app", body: "add rate limiting", task: true },
      collect().out,
    );
    await cmdSend(
      dir,
      { from: "alice", to: "bob", repo: "team/app", body: "heads up", task: false },
      collect().out,
    );

    // human-readable nudge: 2 unread (the task + the message), 1 is a delegated task
    const nudge = collect();
    await cmdNudge(dir, { agentId: "bob", repo: "team/app" }, nudge.out);
    const text = nudge.lines.join("\n");
    expect(text).toContain("🗼 Tower:");
    expect(text).toContain("2 unread");
    expect(text).toContain("1 delegated task");
    expect(text).toContain("bob");

    // read-only: json shows the same counts on a second call (nothing marked read)
    const json = collect();
    await cmdNudge(dir, { agentId: "bob", repo: "team/app", json: true }, json.out);
    expect(JSON.parse(json.lines.join(""))).toEqual({ unreadMessages: 2, openTasks: 1 });

    // nobody waiting → silent (prints nothing)
    const quiet = collect();
    await cmdNudge(dir, { agentId: "dana", repo: "team/app" }, quiet.out);
    expect(quiet.lines.join("")).toBe("");
  });
});

describe("interactive send (gatherSendArgs)", () => {
  it("fills from/repo from context and asks only for what's missing", async () => {
    const { gatherSendArgs } = await import("./commands.js");
    const asked: string[] = [];
    const answers: Record<string, string> = {
      "To (agent id, or * for everyone): ": "bob",
      "Message: ": "add rate limiting to /login",
      "Is this a task for them? [y/N]: ": "y",
    };
    const ask = async (q: string) => {
      asked.push(q);
      return answers[q] ?? "";
    };
    const args = await gatherSendArgs({}, { defaultFrom: "alice", defaultRepo: "team/app", ask });
    expect(args).toEqual({
      from: "alice",
      to: "bob",
      repo: "team/app",
      body: "add rate limiting to /login",
      task: true,
    });
    expect(asked).toHaveLength(3); // never asks for from/repo — they were derivable
  });

  it("asks nothing when everything is provided by flags", async () => {
    const { gatherSendArgs } = await import("./commands.js");
    const ask = async () => {
      throw new Error("should not ask");
    };
    const args = await gatherSendArgs(
      { from: "a", to: "b", repo: "r", body: "hi", task: false },
      { defaultFrom: "x", defaultRepo: "y", ask },
    );
    expect(args.from).toBe("a");
    expect(args.task).toBe(false);
  });

  it("re-asks until required answers are non-empty", async () => {
    const { gatherSendArgs } = await import("./commands.js");
    const replies = ["", "bob", "", "do it", "n"];
    const ask = async () => replies.shift() ?? "";
    const args = await gatherSendArgs({}, { defaultFrom: "alice", defaultRepo: "r", ask });
    expect(args.to).toBe("bob");
    expect(args.body).toBe("do it");
    expect(args.task).toBe(false);
  });
});

describe("git-derived defaults", () => {
  it("normalizes remote urls to host/owner/repo", async () => {
    const { normalizeRepoUrl } = await import("./commands.js");
    expect(normalizeRepoUrl("git@github.com:Acme/App.git")).toBe("github.com/acme/app");
    expect(normalizeRepoUrl("https://github.com/Acme/App.git")).toBe("github.com/acme/app");
    expect(normalizeRepoUrl("ssh://git@github.com/Acme/App")).toBe("github.com/acme/app");
  });
});

describe("cmdSetup (one-command onboarding)", () => {
  const readJson = (path: string): { mcpServers: Record<string, unknown> } =>
    JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> };

  it("creates .mcp.json in local mode when absent and prints the next step", () => {
    const { out, lines } = collect();
    cmdSetup(dir, {}, out);
    const config = readJson(join(dir, ".mcp.json"));
    expect(config.mcpServers.tower).toEqual({
      command: "npx",
      args: ["-y", "tower-mcp", "serve"],
    });
    const text = lines.join("\n");
    expect(text).toContain(".mcp.json");
    expect(text).toContain("npx -y tower-mcp send");
  });

  it("gitignores .tower/ so the user never commits the local db", () => {
    cmdSetup(dir, {}, () => {});
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".tower/");
  });

  it("appends to an existing .gitignore without clobbering it, and only once", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    cmdSetup(dir, {}, () => {});
    cmdSetup(dir, {}, () => {}); // idempotent — running setup twice is normal
    const text = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(text).toContain("node_modules");
    expect(text.match(/^\.tower\/$/gm)).toHaveLength(1);
  });

  it("leaves .gitignore alone when .tower/ is already listed", () => {
    writeFileSync(join(dir, ".gitignore"), "a\n.tower\nb\n");
    cmdSetup(dir, {}, () => {});
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("a\n.tower\nb\n");
  });

  // 0.10.0: team mode runs the client locally instead of pointing the agent at the URL.
  // A direct `type: "http"` entry means nothing on this machine ever computes repoId, so
  // a fork and its upstream partition apart in silence — the bug a real two-agent session
  // hit. The local process is where identity comes from.
  it("writes team mode as a local proxy, not a direct http entry", () => {
    cmdSetup(dir, { url: "https://tower.example.com/mcp", token: "s3cret" }, () => {});
    const config = readJson(join(dir, ".mcp.json"));
    expect(config.mcpServers.tower).toEqual({
      command: "npx",
      args: ["-y", "tower-mcp", "serve", "--remote", "https://tower.example.com/mcp"],
      env: { TOWER_TOKEN: "s3cret" },
    });
  });

  it("keeps the token out of an Authorization header written to disk", () => {
    cmdSetup(dir, { url: "https://tower.example.com/mcp", token: "s3cret" }, () => {});
    const raw = readFileSync(join(dir, ".mcp.json"), "utf8");
    expect(raw).not.toContain("Authorization");
    expect(raw).not.toContain("Bearer");
  });

  // The token is out of the header but still in the file, and .mcp.json is the config
  // teams commit — Tower's own repo tracks it. Without this, following the documented
  // setup command publishes your team token.
  it("gitignores .mcp.json when it was given a token to write", () => {
    cmdSetup(dir, { url: "https://tower.example.com/mcp", token: "s3cret" }, () => {});
    const ignored = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(ignored).toContain(".mcp.json");
  });

  it("says out loud that .mcp.json now holds a secret, and how to untrack it", () => {
    const { out, lines } = collect();
    cmdSetup(dir, { url: "https://tower.example.com/mcp", token: "s3cret" }, out);
    const text = lines.join("\n");
    expect(text).toContain("secret");
    expect(text).toContain("git rm --cached .mcp.json");
  });

  it("leaves .mcp.json shareable when there is no token in it", () => {
    cmdSetup(dir, { url: "https://tower.example.com/mcp" }, () => {});
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).not.toContain(".mcp.json");
  });

  it("does not add .mcp.json twice when setup runs again", () => {
    cmdSetup(dir, { url: "https://tower.example.com/mcp", token: "s3cret" }, () => {});
    cmdSetup(dir, { url: "https://tower.example.com/mcp", token: "s3cret" }, () => {});
    const ignored = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(ignored.match(/^\.mcp\.json$/gm)?.length).toBe(1);
  });

  it("omits the env block in team mode when no token is given", () => {
    cmdSetup(dir, { url: "https://tower.example.com/mcp" }, () => {});
    const config = readJson(join(dir, ".mcp.json"));
    expect(config.mcpServers.tower).toEqual({
      command: "npx",
      args: ["-y", "tower-mcp", "serve", "--remote", "https://tower.example.com/mcp"],
    });
  });

  it("merges into an existing .mcp.json, preserving other servers", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "foo", args: ["bar"] } } }),
    );
    cmdSetup(dir, {}, () => {});
    const config = readJson(join(dir, ".mcp.json"));
    expect(config.mcpServers.other).toEqual({ command: "foo", args: ["bar"] });
    expect(config.mcpServers.tower).toEqual({
      command: "npx",
      args: ["-y", "tower-mcp", "serve"],
    });
  });

  it("refuses to touch an invalid-JSON .mcp.json and warns", () => {
    writeFileSync(join(dir, ".mcp.json"), "{ this is not json");
    const { out, lines } = collect();
    cmdSetup(dir, {}, out);
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe("{ this is not json");
    expect(lines.join("\n").toLowerCase()).toContain("invalid json");
  });

  it("creates CLAUDE.md with the claim-first rule and is idempotent on a second run", () => {
    cmdSetup(dir, {}, () => {});
    const content = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("## Tower (agent coordination)");
    expect(content).toContain("claim_intent");

    const second = collect();
    cmdSetup(dir, {}, second.out);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(content);
    expect(second.lines.join("\n").toLowerCase()).toContain("already");
  });

  it("appends the rule to AGENTS.md only when that file already exists", () => {
    cmdSetup(dir, {}, () => {});
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);

    writeFileSync(join(dir, "AGENTS.md"), "# Agents\n");
    cmdSetup(dir, {}, () => {});
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("# Agents");
    expect(agents).toContain("claim_intent");
  });

  it("installs pre-commit and post-commit hooks with --hooks when .git/hooks exists", () => {
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    const { out, lines } = collect();
    cmdSetup(dir, { hooks: true }, out);
    expect(readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf8")).toContain(
      "Tower pre-commit guard",
    );
    expect(readFileSync(join(dir, ".git", "hooks", "post-commit"), "utf8")).toContain(
      "Tower post-commit hook",
    );
    expect(lines.join("\n")).toContain("pre-commit");
  });

  it("never overwrites an existing hook — skips with a warning", () => {
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    const sentinel = "#!/bin/sh\n# my precious hook\n";
    writeFileSync(join(dir, ".git", "hooks", "pre-commit"), sentinel);
    const { out, lines } = collect();
    cmdSetup(dir, { hooks: true }, out);
    expect(readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf8")).toBe(sentinel);
    expect(readFileSync(join(dir, ".git", "hooks", "post-commit"), "utf8")).toContain(
      "Tower post-commit hook",
    );
    expect(lines.join("\n").toLowerCase()).toContain("skip");
  });

  it("skips git hooks with a warning when .git/hooks does not exist", () => {
    const { out, lines } = collect();
    cmdSetup(dir, { hooks: true }, out);
    expect(existsSync(join(dir, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(lines.join("\n").toLowerCase()).toContain("skip");
  });
});

describe("TWR-01 — stdio serve never writes locally in silence", () => {
  const REMOTE = "https://tower-abc.onrender.com/mcp";

  it("flags stdio serve when TOWER_URL is set, and stays quiet otherwise", () => {
    // The decision, without spinning up a server: only the stdio path can create the
    // silent split brain, because --http *is* the shared server.
    expect(localServeConflict({}, { TOWER_URL: REMOTE })).toBe(REMOTE);
    expect(localServeConflict({}, {})).toBeUndefined();
    expect(localServeConflict({}, { TOWER_URL: "  " })).toBeUndefined();
    expect(localServeConflict({ http: true }, { TOWER_URL: REMOTE })).toBeUndefined();
  });

  it("explains the problem and how to fix it", () => {
    const text = localModeWarning(REMOTE);
    expect(text).toContain("LOCAL server");
    expect(text).toContain(".tower/tower.db");
    expect(text).toContain(REMOTE);
    expect(text).toContain("tower-mcp setup --url");
  });

  // The warning used to recommend a direct type:"http" entry — the exact shape that
  // leaves no process on this machine to compute repoId, which is how a fork and its
  // upstream split in silence. Recommending the bug 0.10.0 fixed is worse than silence.
  it("recommends the local proxy, never a direct http entry", () => {
    const text = localModeWarning(REMOTE);
    expect(text).toContain("--remote");
    expect(text).not.toContain('"type": "http"');
    expect(text).not.toContain("Authorization");
  });

  it("refuses when nobody can be asked", async () => {
    const { out, lines } = collect();
    await expect(
      cmdServe(dir, {}, out, { env: { TOWER_URL: REMOTE }, isTTY: false }),
    ).rejects.toThrow(/refusing to start/i);
    expect(lines.join("\n")).toContain("LOCAL server");
  });

  it("asks first when there is a TTY, and honours a no", async () => {
    const { out } = collect();
    await expect(
      cmdServe(dir, {}, out, { env: { TOWER_URL: REMOTE }, isTTY: true, ask: async () => "n" }),
    ).rejects.toThrow(/cancelled/i);
  });
});

describe("T6 — tower init --hooks wires enforcement (REQ-D gap 3)", () => {
  /** A clone of Tower has the hook scripts; the npm package does not. */
  const withHookScripts = () => {
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(join(dir, "hooks", "pretooluse-tower.mjs"), "// stub");
  };

  // Run from the npm package there is no hooks/ directory, so every entry written
  // points at a file that does not exist. Nothing errors and the user is told
  // "installed" — including for the hook whose entire job is to block a conflicting
  // edit. Believing you are guarded is worse than knowing you are not.
  it("writes nothing when the hook scripts are not here, and says why", () => {
    const { out, lines } = collect();
    cmdInit(dir, out, { hooks: true });
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false);
    const text = lines.join("\n");
    expect(text).toContain("clone");
    expect(text).not.toContain("✔ .claude/settings.json");
  });

  // The old message told everyone to "run `npm run build` once" — in their own project,
  // where that script does not exist and npm errors with "Missing script: build".
  it("never says npm run build without saying which directory to run it in", () => {
    const { out, lines } = collect();
    cmdInit(dir, out, { hooks: true });
    const text = lines.join("\n");
    if (text.includes("npm run build")) expect(text).toContain("git clone");
  });

  it("writes all five hooks into .claude/settings.json", () => {
    withHookScripts();
    cmdInit(dir, () => {}, { hooks: true });
    const cfg = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")) as {
      hooks: Record<string, unknown>;
    };
    expect(Object.keys(cfg.hooks).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "UserPromptSubmit",
    ]);
  });

  it("does nothing without --hooks", () => {
    cmdInit(dir, () => {});
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false);
  });

  it("never clobbers a hook the user already wired up", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    withHookScripts();
    const mine = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "mine.mjs" }] }] } };
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(mine));

    cmdInit(dir, () => {}, { hooks: true });
    const cfg = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(cfg.hooks.PreToolUse![0]!.hooks[0]!.command).toBe("mine.mjs");
    expect(cfg.hooks.SessionStart).toBeDefined();
  });

  it("leaves invalid JSON untouched rather than destroying it", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), "{ not json");
    const { out, lines } = collect();
    withHookScripts();
    cmdInit(dir, out, { hooks: true });
    expect(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).toBe("{ not json");
    expect(lines.join("\n")).toContain("invalid JSON");
  });
});

describe("lazyRemote — the proxy must never take the MCP server down with it", () => {
  it("does not dial until the first call, so a cold server still serves tools", async () => {
    const { lazyRemote } = await import("./commands.js");
    // Constructing against a host that cannot resolve must not throw. Render's free tier
    // sleeps and takes ~50s to wake; dialling up front killed the process before it ever
    // spoke MCP, leaving the editor with a dead server and no Tower tools at all.
    const r = lazyRemote({ url: "https://unreachable.invalid/mcp" });
    expect(typeof r.call).toBe("function");
    await r.close();
  });

  it("surfaces an unreachable server as a loud error naming the url", async () => {
    const { lazyRemote } = await import("./commands.js");
    const r = lazyRemote({ url: "http://127.0.0.1:1/mcp" }, () => {});
    await expect(r.call("list_claims", {})).rejects.toThrow(/unreachable/i);
    await r.close();
  });

  it("says coordination was not enforced, rather than failing silently", async () => {
    const { lazyRemote } = await import("./commands.js");
    const r = lazyRemote({ url: "http://127.0.0.1:1/mcp" }, () => {});
    await expect(r.call("claim_intent", {})).rejects.toThrow(/NOT enforced/);
    await r.close();
  });

  it("closing before any call is a no-op, not a crash", async () => {
    const { lazyRemote } = await import("./commands.js");
    await expect(lazyRemote({ url: "http://127.0.0.1:1/mcp" }).close()).resolves.toBeUndefined();
  });
});

describe("symbol-level blocking — two agents in one file, different functions (0.10.0)", () => {
  const CODE = "function alpha() {\n  return 1;\n}\n\nfunction beta() {\n  return 2;\n}\n";
  const FILE = "svc.js";
  const base = { repo: "acme/app", branch: "main", files: [FILE], purpose: "edit" };

  async function symbolFor(anchor: string): Promise<string> {
    const { SymbolExtractor, symbolAt } = await import("@tower/server");
    const ranges = await new SymbolExtractor().extractRanges(FILE, CODE);
    return `${FILE}#${symbolAt(ranges, CODE.indexOf(anchor))!.symbol}`;
  }

  beforeEach(() => writeFileSync(join(dir, FILE), CODE));

  it("lets a second agent edit a DIFFERENT function in the same file", async () => {
    const alpha = await symbolFor("return 1;");
    const beta = await symbolFor("return 2;");
    expect(await cmdGuard(dir, { ...base, agentId: "alice", symbols: [alpha] }, () => {})).toBe(
      false,
    );
    // The whole point: file-granular blocking refused this correct edit.
    expect(await cmdGuard(dir, { ...base, agentId: "bob", symbols: [beta] }, () => {})).toBe(false);
  });

  it("still blocks a second agent on the SAME function", async () => {
    const alpha = await symbolFor("return 1;");
    await cmdGuard(dir, { ...base, agentId: "alice", symbols: [alpha] }, () => {});
    expect(await cmdGuard(dir, { ...base, agentId: "carol", symbols: [alpha] }, () => {})).toBe(
      true,
    );
  });

  it("a whole-file claim still blocks everyone — the safe fallback", async () => {
    await cmdGuard(dir, { ...base, agentId: "alice", symbols: [`${FILE}#`] }, () => {});
    const beta = await symbolFor("return 2;");
    expect(await cmdGuard(dir, { ...base, agentId: "bob", symbols: [beta] }, () => {})).toBe(true);
  });
});
