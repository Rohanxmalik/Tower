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

  it("writes team mode (type http + Authorization header) when --url and --token are given", () => {
    cmdSetup(dir, { url: "https://tower.example.com/mcp", token: "s3cret" }, () => {});
    const config = readJson(join(dir, ".mcp.json"));
    expect(config.mcpServers.tower).toEqual({
      type: "http",
      url: "https://tower.example.com/mcp",
      headers: { Authorization: "Bearer s3cret" },
    });
  });

  it("omits headers in team mode when no token is given", () => {
    cmdSetup(dir, { url: "https://tower.example.com/mcp" }, () => {});
    const config = readJson(join(dir, ".mcp.json"));
    expect(config.mcpServers.tower).toEqual({
      type: "http",
      url: "https://tower.example.com/mcp",
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
