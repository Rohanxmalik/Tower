import { describe, it, expect, beforeEach } from "vitest";
import type { DelegatedTask } from "@tower/shared";
import { TowerService } from "./service.js";
import { TowerStore } from "./store/sqlite.js";
import { parsePolicy } from "./engine/sequencer.js";

let clock = 1_000;
function makeService(): TowerService {
  clock = 1_000;
  const store = new TowerStore({ now: () => clock, ttlMs: 10_000 });
  const policy = parsePolicy(`
modules:
  auth: { path: "src/auth/**" }
  api: { path: "src/api/**", depends_on: [auth] }
limits:
  max_agents_per_module: 2
`);
  return new TowerService({ store, policy });
}

describe("TowerService.claimIntent", () => {
  let svc: TowerService;
  beforeEach(() => {
    svc = makeService();
  });

  it("registers a claim and reports no conflict when clear", () => {
    const res = svc.claimIntent({
      agentId: "claude-a",
      repo: "acme/app",
      branch: "main",
      files: [],
      symbols: [{ file: "src/auth/login.ts", symbol: "verify" }],
      purpose: "x",
    });
    expect(res.claimId).toBeTruthy();
    expect(res.conflicts).toEqual([]);
  });

  it("detects a hard collision with another agent's active claim", () => {
    svc.claimIntent({
      agentId: "cursor-bob",
      repo: "acme/app",
      branch: "main",
      files: [],
      symbols: [{ file: "src/auth/login.ts", symbol: "AuthService.verify" }],
      purpose: "replace JWT",
      etaMinutes: 6,
    });
    const res = svc.claimIntent({
      agentId: "claude-a",
      repo: "acme/app",
      branch: "main",
      files: [],
      symbols: [{ file: "src/auth/login.ts", symbol: "AuthService.verify" }],
      purpose: "y",
    });
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]!.severity).toBe("hard");
    expect(res.conflicts[0]!.agentId).toBe("cursor-bob");
  });

  it("does not collide with the agent's own claim", () => {
    const args = {
      agentId: "claude-a",
      repo: "acme/app",
      branch: "main",
      files: [],
      symbols: [{ file: "src/auth/login.ts", symbol: "verify" }],
      purpose: "",
    };
    svc.claimIntent(args);
    expect(svc.claimIntent(args).conflicts).toEqual([]);
  });
});

describe("TowerService — lifecycle", () => {
  let svc: TowerService;
  beforeEach(() => {
    svc = makeService();
  });

  function claim(): string {
    return svc.claimIntent({
      agentId: "a",
      repo: "r",
      branch: "main",
      files: ["src/x.ts"],
      symbols: [],
      purpose: "",
    }).claimId;
  }

  it("heartbeats, completes and lists", () => {
    const id = claim();
    expect(svc.heartbeat({ claimId: id }).ok).toBe(true);
    expect(svc.listClaims({ repo: "r", status: "active" }).claims).toHaveLength(1);
    expect(svc.completeClaim({ claimId: id, commitSha: "sha" }).ok).toBe(true);
    expect(svc.listClaims({ repo: "r", status: "active" }).claims).toHaveLength(0);
  });

  it("releases a claim", () => {
    const id = claim();
    expect(svc.releaseClaim({ claimId: id }).ok).toBe(true);
  });

  it("check_collision does not persist a claim", () => {
    svc.checkCollision({ repo: "r", branch: "main", files: ["src/x.ts"], symbols: [] });
    expect(svc.listClaims({ repo: "r" }).claims).toHaveLength(0);
  });
});

describe("TowerService — decisions & sequencer", () => {
  let svc: TowerService;
  beforeEach(() => {
    svc = makeService();
  });

  it("logs and recalls decisions", () => {
    const { id } = svc.logDecision({
      title: "Use Supabase Auth",
      body: "RLS",
      author: "claude+alice",
      tags: ["auth"],
      relatedFiles: [],
    });
    expect(id).toBeTruthy();
    expect(svc.getDecisions({ query: "supabase" }).decisions).toHaveLength(1);
  });

  it("next_task withholds a task blocked by an active dependency", () => {
    svc.claimIntent({
      agentId: "a",
      repo: "acme/app",
      branch: "main",
      files: ["src/auth/login.ts"],
      symbols: [],
      purpose: "",
    });
    const res = svc.nextTask({
      agentId: "b",
      repo: "acme/app",
      candidates: [{ id: "t", module: "api" }],
    });
    expect(res.task).toBeNull();
  });
});

describe("messaging", () => {
  it("send + fetch roundtrip through the service", () => {
    const service = new TowerService();
    const { id } = service.sendMessage({
      fromAgentId: "alice",
      toAgentId: "bob",
      repo: "team/app",
      kind: "task",
      body: "add rate limiting",
    });
    expect(id).toBeTruthy();
    const { messages } = service.fetchMessages({ agentId: "bob", unreadOnly: true });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.fromAgentId).toBe("alice");
  });

  it("claim_intent reports the unread inbox count (you've got mail)", () => {
    const service = new TowerService();
    service.sendMessage({
      fromAgentId: "alice",
      toAgentId: "bob",
      repo: "team/app",
      kind: "message",
      body: "heads up",
    });
    const res = service.claimIntent({
      agentId: "bob",
      repo: "team/app",
      branch: "main",
      files: [],
      symbols: [{ file: "src/x.ts", symbol: "X" }],
      purpose: "work",
    });
    expect(res.unreadMessages).toBe(1);
  });

  it("boardSnapshot includes the recent message feed", () => {
    const service = new TowerService();
    service.sendMessage({
      fromAgentId: "alice",
      toAgentId: "*",
      repo: "team/app",
      kind: "message",
      body: "deploy at 5pm",
    });
    const snap = service.boardSnapshot();
    expect(snap.messages).toHaveLength(1);
    expect(snap.messages[0]!.body).toBe("deploy at 5pm");
  });
});

describe("task lifecycle (service)", () => {
  it("send_message kind task creates a lifecycle task with the message id", () => {
    const service = new TowerService();
    const { id } = service.sendMessage({
      fromAgentId: "alice",
      toAgentId: "bob",
      repo: "team/app",
      kind: "task",
      body: "add rate limiting",
    });
    const { tasks } = service.listTasks({ status: "open" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe(id);
  });

  it("plain messages do not create tasks", () => {
    const service = new TowerService();
    service.sendMessage({
      fromAgentId: "alice",
      toAgentId: "bob",
      repo: "team/app",
      kind: "message",
      body: "hi",
    });
    expect(service.listTasks({}).tasks).toHaveLength(0);
  });

  it("acceptTask returns the task; completeTask replies with a task_update message", () => {
    const service = new TowerService();
    const { id } = service.sendMessage({
      fromAgentId: "alice",
      toAgentId: "bob",
      repo: "team/app",
      kind: "task",
      body: "add rate limiting",
    });
    const acc = service.acceptTask({ taskId: id, agentId: "bob" });
    expect(acc.ok).toBe(true);
    expect(acc.task!.assigneeAgentId).toBe("bob");
    const res = service.completeTask({
      taskId: id,
      agentId: "bob",
      success: true,
      result: "merged",
      commitSha: "ab12f3",
    });
    expect(res.ok).toBe(true);
    // alice hears about it on her next contact
    const inbox = service.fetchMessages({ agentId: "alice", unreadOnly: true });
    const update = inbox.messages.find((m) => m.kind === "task_update");
    expect(update).toBeDefined();
    expect(update!.replyTo).toBe(id);
    expect(update!.body).toContain("ab12f3");
  });

  it("boardSnapshot carries tasks", () => {
    const service = new TowerService();
    service.sendMessage({
      fromAgentId: "alice",
      toAgentId: "*",
      repo: "team/app",
      kind: "task",
      body: "docs pass",
    });
    expect(service.boardSnapshot().tasks).toHaveLength(1);
  });
});

describe("task approval + create (mobile control)", () => {
  it("createTask makes an open delegated task", () => {
    const service = new TowerService();
    const { id } = service.createTask({
      repo: "team/app",
      body: "add a health endpoint",
      fromAgentId: "board",
      toAgentId: "*",
    });
    const { tasks } = service.listTasks({ status: "open" });
    expect(tasks[0]!.id).toBe(id);
    expect(tasks[0]!.fromAgentId).toBe("board");
  });

  it("request then resolve approval flips the task's approval state", () => {
    const service = new TowerService();
    const { id } = service.createTask({ repo: "r", body: "x", fromAgentId: "a", toAgentId: "*" });
    expect(service.requestApproval({ taskId: id, agentId: "bob" }).ok).toBe(true);
    expect(service.listTasks({}).tasks[0]!.approval).toBe("pending");
    expect(service.resolveApproval({ taskId: id, approved: true }).ok).toBe(true);
    expect(service.listTasks({}).tasks[0]!.approval).toBe("approved");
  });

  it("rejecting a parked task fails it and notifies the delegator", () => {
    const service = new TowerService();
    const { id } = service.createTask({
      repo: "r",
      body: "risky change",
      fromAgentId: "alice",
      toAgentId: "*",
    });
    service.requestApproval({ taskId: id, agentId: "bob" });
    expect(service.resolveApproval({ taskId: id, approved: false }).ok).toBe(true);
    const task = service.listTasks({}).tasks[0]!;
    expect(task.approval).toBe("rejected");
    expect(task.status).toBe("failed"); // terminal — no worker mode can run it
    expect(service.acceptTask({ taskId: id, agentId: "dana" }).ok).toBe(false);
    // The delegator hears about the rejection instead of waiting forever.
    const { messages } = service.fetchMessages({ agentId: "alice", unreadOnly: true });
    const update = messages.find((m) => m.kind === "task_update" && m.replyTo === id);
    expect(update).toBeDefined();
    expect(update!.body).toMatch(/rejected/i);
  });
});

describe("worker presence (service)", () => {
  it("heartbeat_worker shows up as an online worker on the board", () => {
    const service = new TowerService();
    service.heartbeatWorker({ agentId: "bob", repo: "team/app", runner: "claude" });
    const snap = service.boardSnapshot();
    expect(snap.workers.map((w) => w.agentId)).toEqual(["bob"]);
    expect(snap.workers[0]!.runner).toBe("claude");
  });
});

describe("onTaskCompleted hook (web-push wiring point)", () => {
  it("fires once with the finished task", () => {
    const service = new TowerService();
    const seen: DelegatedTask[] = [];
    service.onTaskCompleted = (t) => seen.push(t);
    const { id } = service.sendMessage({
      fromAgentId: "alice",
      toAgentId: "bob",
      repo: "team/app",
      kind: "task",
      body: "add rate limiting",
    });
    service.acceptTask({ taskId: id, agentId: "bob" });
    service.completeTask({
      taskId: id,
      agentId: "bob",
      success: true,
      result: "done",
      commitSha: "ab12f3d",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.status).toBe("done");
    expect(seen[0]!.commitSha).toBe("ab12f3d");
  });

  it("does not fire when completion is refused (wrong assignee)", () => {
    const service = new TowerService();
    let fired = 0;
    service.onTaskCompleted = () => {
      fired += 1;
    };
    const { id } = service.sendMessage({
      fromAgentId: "alice",
      toAgentId: "bob",
      repo: "team/app",
      kind: "task",
      body: "x",
    });
    service.acceptTask({ taskId: id, agentId: "bob" });
    service.completeTask({ taskId: id, agentId: "mallory", success: true, result: "nope" });
    expect(fired).toBe(0);
  });
});
