import { describe, it, expect } from "vitest";
import {
  parsePolicy,
  moduleForFile,
  nextTask,
  activeModuleLoad,
  PolicyError,
} from "./sequencer.js";
import type { Claim } from "@tower/shared";

const YAML = `
modules:
  auth: { path: "src/auth/**" }
  api: { path: "src/api/**", depends_on: [auth] }
  dashboard: { path: "src/dashboard/**", depends_on: [api] }
limits:
  max_agents_per_module: 2
`;

function claimIn(file: string, agentId = "a"): Claim {
  return {
    id: `c-${file}-${agentId}`,
    agentId,
    repo: "r",
    branch: "main",
    files: [file],
    symbols: [],
    purpose: "",
    status: "active",
    createdAt: 1,
    expiresAt: 999,
  };
}

describe("parsePolicy", () => {
  it("parses modules, deps and limits", () => {
    const p = parsePolicy(YAML);
    expect(p.modules.map((m) => m.name)).toEqual(["auth", "api", "dashboard"]);
    expect(p.modules.find((m) => m.name === "api")!.dependsOn).toEqual(["auth"]);
    expect(p.maxAgentsPerModule).toBe(2);
  });

  it("throws on a dependency on an unknown module", () => {
    expect(() => parsePolicy(`modules:\n  api: { path: "x", depends_on: [ghost] }`)).toThrow(
      PolicyError,
    );
  });

  it("throws on a dependency cycle", () => {
    const cyclic = `
modules:
  a: { path: "a/**", depends_on: [b] }
  b: { path: "b/**", depends_on: [a] }
`;
    expect(() => parsePolicy(cyclic)).toThrow(/cycle/i);
  });

  it("handles empty policy", () => {
    expect(parsePolicy("").modules).toEqual([]);
  });
});

describe("moduleForFile", () => {
  const policy = parsePolicy(YAML);
  it("matches files to modules by glob", () => {
    expect(moduleForFile(policy, "src/auth/login.ts")).toBe("auth");
    expect(moduleForFile(policy, "src/api/routes.ts")).toBe("api");
    expect(moduleForFile(policy, "src/unknown/x.ts")).toBeNull();
  });
});

describe("activeModuleLoad", () => {
  const policy = parsePolicy(YAML);
  it("counts active claims per module", () => {
    const load = activeModuleLoad(policy, [
      claimIn("src/auth/a.ts", "x"),
      claimIn("src/auth/b.ts", "y"),
    ]);
    expect(load.get("auth")).toBe(2);
  });
});

describe("nextTask", () => {
  const policy = parsePolicy(YAML);

  it("hands out a task whose dependencies are idle", () => {
    const res = nextTask(policy, [{ id: "t1", module: "auth" }], [], "agent");
    expect(res.task?.module).toBe("auth");
  });

  it("withholds a task whose dependency has active work", () => {
    const res = nextTask(
      policy,
      [{ id: "t1", module: "api" }],
      [claimIn("src/auth/login.ts")],
      "agent",
    );
    expect(res.task).toBeNull();
    expect(res.reason).toMatch(/blocked/i);
  });

  it("skips a blocked candidate and returns the next clear one", () => {
    const res = nextTask(
      policy,
      [
        { id: "t1", module: "api" }, // blocked (auth active)
        { id: "t2", module: "auth" }, // clear
      ],
      [claimIn("src/auth/login.ts")],
      "agent",
    );
    expect(res.task?.id).toBe("t2");
  });

  it("enforces the per-module agent limit", () => {
    const res = nextTask(
      policy,
      [{ id: "t1", module: "auth" }],
      [claimIn("src/auth/a.ts", "x"), claimIn("src/auth/b.ts", "y")], // 2 == limit
      "agent",
    );
    expect(res.task).toBeNull();
  });

  it("synthesizes candidates from modules when none supplied", () => {
    const res = nextTask(policy, [], [], "agent");
    expect(res.task?.module).toBe("auth");
  });
});
