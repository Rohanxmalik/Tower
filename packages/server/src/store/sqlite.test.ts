import { describe, it, expect, beforeEach } from "vitest";
import { TowerStore, DEFAULT_PRUNE_MS } from "./sqlite.js";

let clock = 1_000;
const now = () => clock;

function makeStore(ttlMs = 10_000) {
  clock = 1_000;
  return new TowerStore({ now, ttlMs });
}

const baseClaim = {
  agentId: "claude-1",
  repo: "acme/app",
  branch: "main",
  files: ["src/auth.ts"],
  symbols: [{ file: "src/auth.ts", symbol: "verify" }],
  purpose: "replace JWT",
};

describe("TowerStore — claims", () => {
  let store: TowerStore;
  beforeEach(() => {
    store = makeStore();
  });

  it("creates a claim with generated id, timestamps and active status", () => {
    const c = store.createClaim(baseClaim);
    expect(c.id).toBeTruthy();
    expect(c.status).toBe("active");
    expect(c.createdAt).toBe(1_000);
    expect(c.expiresAt).toBe(11_000);
    expect(store.getClaim(c.id)).toMatchObject({ id: c.id, purpose: "replace JWT" });
  });

  it("persists symbols and files as structured data", () => {
    const c = store.createClaim(baseClaim);
    const got = store.getClaim(c.id)!;
    expect(got.symbols).toEqual([{ file: "src/auth.ts", symbol: "verify" }]);
    expect(got.files).toEqual(["src/auth.ts"]);
  });

  it("lists active claims in scope", () => {
    store.createClaim(baseClaim);
    store.createClaim({ ...baseClaim, agentId: "cursor-2" });
    expect(store.activeClaims("acme/app", "main")).toHaveLength(2);
    expect(store.activeClaims("acme/app", "other")).toHaveLength(0);
  });

  it("completes a claim and records commit sha", () => {
    const c = store.createClaim(baseClaim);
    expect(store.completeClaim(c.id, "abc123")).toBe(true);
    const got = store.getClaim(c.id)!;
    expect(got.status).toBe("completed");
    expect(got.commitSha).toBe("abc123");
    expect(store.activeClaims("acme/app", "main")).toHaveLength(0);
  });

  it("does not complete an already-completed claim", () => {
    const c = store.createClaim(baseClaim);
    store.completeClaim(c.id);
    expect(store.completeClaim(c.id)).toBe(false);
  });

  it("releases a claim", () => {
    const c = store.createClaim(baseClaim);
    expect(store.releaseClaim(c.id)).toBe(true);
    expect(store.getClaim(c.id)!.status).toBe("released");
  });

  it("supports many concurrent active claims", () => {
    for (let i = 0; i < 25; i++) store.createClaim({ ...baseClaim, agentId: `a${i}` });
    expect(store.activeClaims("acme/app", "main")).toHaveLength(25);
  });
});

describe("TowerStore — TTL & heartbeat", () => {
  it("expires an active claim once its TTL elapses", () => {
    const store = makeStore(10_000);
    const c = store.createClaim(baseClaim);
    clock = 5_000;
    expect(store.activeClaims("acme/app", "main")).toHaveLength(1);
    clock = 20_000; // past expiresAt (11_000)
    expect(store.activeClaims("acme/app", "main")).toHaveLength(0);
    expect(store.getClaim(c.id)!.status).toBe("expired");
  });

  it("heartbeat pushes out expiry and keeps the claim alive", () => {
    const store = makeStore(10_000);
    const c = store.createClaim(baseClaim);
    clock = 9_000;
    const hb = store.heartbeat(c.id);
    expect(hb.ok).toBe(true);
    expect(hb.expiresAt).toBe(19_000);
    clock = 15_000; // would have expired without heartbeat
    expect(store.activeClaims("acme/app", "main")).toHaveLength(1);
  });

  it("heartbeat on a non-active claim returns not-ok", () => {
    const store = makeStore();
    const c = store.createClaim(baseClaim);
    store.completeClaim(c.id);
    expect(store.heartbeat(c.id).ok).toBe(false);
  });

  it("sweepExpired reports how many it swept", () => {
    const store = makeStore(1_000);
    store.createClaim(baseClaim);
    store.createClaim({ ...baseClaim, agentId: "b" });
    clock = 5_000;
    expect(store.sweepExpired()).toBe(2);
  });
});

describe("TowerStore — decisions", () => {
  let store: TowerStore;
  beforeEach(() => {
    store = makeStore();
  });

  it("logs and lists a decision", () => {
    const d = store.logDecision({
      title: "Use Supabase Auth",
      body: "Better RLS support",
      author: "claude + rohan",
      tags: ["auth"],
      relatedFiles: ["src/auth.ts"],
    });
    expect(d.id).toBeTruthy();
    expect(store.getDecisions()).toHaveLength(1);
  });

  it("filters decisions by free-text query", () => {
    store.logDecision({
      title: "Use Supabase",
      body: "RLS",
      author: "a",
      tags: [],
      relatedFiles: [],
    });
    store.logDecision({
      title: "Use Redis",
      body: "cache",
      author: "a",
      tags: [],
      relatedFiles: [],
    });
    expect(store.getDecisions({ query: "redis" })).toHaveLength(1);
    expect(store.getDecisions({ query: "cache" })).toHaveLength(1);
  });

  it("filters by tag and related file", () => {
    store.logDecision({
      title: "A",
      body: "",
      author: "a",
      tags: ["db"],
      relatedFiles: ["src/db.ts"],
    });
    store.logDecision({
      title: "B",
      body: "",
      author: "a",
      tags: ["ui"],
      relatedFiles: ["src/ui.ts"],
    });
    expect(store.getDecisions({ tags: ["db"] })).toHaveLength(1);
    expect(store.getDecisions({ relatedFiles: ["src/ui.ts"] })).toHaveLength(1);
  });
});

describe("TowerStore — messages (agent inbox)", () => {
  let store: TowerStore;
  beforeEach(() => {
    store = new TowerStore({ now: () => 1000 });
  });

  const send = (over = {}) =>
    store.sendMessage({
      fromAgentId: "rohan",
      toAgentId: "cofounder",
      repo: "team/app",
      kind: "task",
      body: "add rate limiting to /login",
      ...over,
    });

  it("stores and fetches unread messages for an agent, marking them read", () => {
    send();
    expect(store.unreadCount("cofounder")).toBe(1);
    const msgs = store.fetchMessages({ agentId: "cofounder", unreadOnly: true });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.body).toContain("rate limiting");
    expect(msgs[0]!.kind).toBe("task");
    // fetched once → read; second unread fetch is empty
    expect(store.fetchMessages({ agentId: "cofounder", unreadOnly: true })).toHaveLength(0);
    expect(store.unreadCount("cofounder")).toBe(0);
  });

  it("delivers broadcasts (*) to any agent without marking read for others", () => {
    send({ toAgentId: "*", kind: "message", body: "deploy at 5pm" });
    expect(store.unreadCount("cofounder")).toBe(1);
    expect(store.unreadCount("alice")).toBe(1);
  });

  it("does not deliver an agent's own messages back to them", () => {
    send({ toAgentId: "*" });
    expect(store.unreadCount("rohan")).toBe(0);
  });

  it("keeps a broadcast unread for other agents after one fetches it", () => {
    send({ toAgentId: "*", kind: "message", body: "deploy at 5pm" });

    // cofounder fetches — read for cofounder only
    expect(store.fetchMessages({ agentId: "cofounder", unreadOnly: true })).toHaveLength(1);
    expect(store.fetchMessages({ agentId: "cofounder", unreadOnly: true })).toHaveLength(0);

    // alice STILL sees it unread and can fetch it herself
    expect(store.unreadCount("alice")).toBe(1);
    const aliceMsgs = store.fetchMessages({ agentId: "alice", unreadOnly: true });
    expect(aliceMsgs).toHaveLength(1);
    expect(aliceMsgs[0]!.body).toBe("deploy at 5pm");
  });

  it("counts drop to zero for every agent only after they each fetch a broadcast", () => {
    send({ toAgentId: "*", kind: "message", body: "standup notes" });
    store.fetchMessages({ agentId: "cofounder", unreadOnly: true });
    expect(store.unreadCount("cofounder")).toBe(0);
    expect(store.unreadCount("alice")).toBe(1);
    store.fetchMessages({ agentId: "alice", unreadOnly: true });
    expect(store.unreadCount("cofounder")).toBe(0);
    expect(store.unreadCount("alice")).toBe(0);
  });

  it("lists recent messages for the board feed regardless of read state", () => {
    send();
    send({ body: "second", kind: "message" });
    store.fetchMessages({ agentId: "cofounder", unreadOnly: true });
    expect(store.listMessages({ limit: 10 })).toHaveLength(2);
    expect(store.listMessages({ limit: 1 })).toHaveLength(1);
  });

  it("threads replies via replyTo", () => {
    const { id } = send();
    const reply = store.sendMessage({
      fromAgentId: "cofounder",
      toAgentId: "rohan",
      repo: "team/app",
      kind: "task_update",
      body: "done in abc123",
      replyTo: id,
    });
    expect(reply.replyTo).toBe(id);
  });
});

describe("TowerStore — prune", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;

  const sendOld = (store: TowerStore, body = "stale") =>
    store.sendMessage({
      fromAgentId: "rohan",
      toAgentId: "cofounder",
      repo: "team/app",
      kind: "message",
      body,
    });

  it("exports a 7-day default retention window", () => {
    expect(DEFAULT_PRUNE_MS).toBe(7 * DAY);
  });

  it("deletes old finished claims and old messages but keeps active and recent rows", () => {
    const store = makeStore(); // clock = 1_000
    const oldDone = store.createClaim(baseClaim);
    store.completeClaim(oldDone.id);
    const oldActive = store.createClaim({ ...baseClaim, agentId: "keeper" });
    sendOld(store, "old news");
    store.fetchMessages({ agentId: "cofounder", unreadOnly: true }); // creates a read receipt

    clock = 1_000 + 8 * DAY;
    const recentDone = store.createClaim({ ...baseClaim, agentId: "recent" });
    store.completeClaim(recentDone.id);
    sendOld(store, "fresh");

    const res = store.prune();
    expect(res).toEqual({ claims: 1, messages: 1 });
    expect(store.getClaim(oldDone.id)).toBeUndefined();
    expect(store.getClaim(oldActive.id)).toBeDefined(); // active claims are never pruned
    expect(store.getClaim(recentDone.id)).toBeDefined();
    const remaining = store.listMessages();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.body).toBe("fresh");
  });

  it("honors a custom olderThanMs", () => {
    const store = makeStore();
    sendOld(store, "two days old");
    clock = 1_000 + 2 * DAY;
    expect(store.prune({ olderThanMs: 3 * DAY })).toEqual({ claims: 0, messages: 0 });
    expect(store.prune({ olderThanMs: 1 * DAY })).toEqual({ claims: 0, messages: 1 });
    expect(store.listMessages()).toHaveLength(0);
  });

  it("sweepExpired prunes opportunistically, at most once per hour", () => {
    const store = makeStore();
    const done = store.createClaim(baseClaim);
    store.completeClaim(done.id);
    sendOld(store);

    clock = 1_000 + 8 * DAY;
    store.sweepExpired(); // past the cutoff → opportunistic prune fires
    expect(store.getClaim(done.id)).toBeUndefined();
    expect(store.listMessages()).toHaveLength(0);

    // rewind the injectable clock to plant fresh "old" rows
    clock = 1_000;
    const done2 = store.createClaim({ ...baseClaim, agentId: "b" });
    store.completeClaim(done2.id);
    sendOld(store, "stale again");

    clock = 1_000 + 8 * DAY + 30 * 60 * 1000; // 30 min after last prune → throttled
    store.sweepExpired();
    expect(store.getClaim(done2.id)).toBeDefined();
    expect(store.listMessages()).toHaveLength(1);

    clock = 1_000 + 8 * DAY + 2 * HOUR; // over an hour later → prunes again
    store.sweepExpired();
    expect(store.getClaim(done2.id)).toBeUndefined();
    expect(store.listMessages()).toHaveLength(0);
  });
});
