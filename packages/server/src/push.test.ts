import { describe, it, expect } from "vitest";
import { TowerStore } from "./store/sqlite.js";
import { ensureVapidKeys, sendApprovalPush, sendTaskDonePush, type PushKeys } from "./push.js";
import type { DelegatedTask } from "@tower/shared";

const KEYS: PushKeys = { publicKey: "pub-key", privateKey: "priv-key" };

const task: DelegatedTask = {
  id: "t1",
  repo: "acme/app",
  fromAgentId: "alice",
  toAgentId: "bob",
  body: "add rate limiting to /login",
  status: "open",
  approval: "pending",
  createdAt: 1,
  updatedAt: 1,
};

describe("ensureVapidKeys", () => {
  it("generates once and persists across store reuse", () => {
    const store = new TowerStore();
    let calls = 0;
    const gen = (): PushKeys => {
      calls += 1;
      return KEYS;
    };
    expect(ensureVapidKeys(store, gen)).toEqual(KEYS);
    expect(ensureVapidKeys(store, gen)).toEqual(KEYS);
    expect(calls).toBe(1);
  });
});

describe("sendApprovalPush", () => {
  it("sends one payload to every subscription", async () => {
    const store = new TowerStore();
    store.addPushSub("https://push.example/e1", JSON.stringify({ endpoint: "e1" }));
    store.addPushSub("https://push.example/e2", JSON.stringify({ endpoint: "e2" }));
    const sent: { sub: string; payload: string }[] = [];
    await sendApprovalPush(store, KEYS, task, async (sub, payload) => {
      sent.push({ sub, payload });
    });
    expect(sent).toHaveLength(2);
    const payload = JSON.parse(sent[0]!.payload) as { title: string; body: string; tag: string };
    expect(payload.tag).toBe("t1");
    expect(payload.body).toContain("add rate limiting");
    expect(payload.body).toContain("alice");
  });

  it("drops a subscription whose endpoint is gone (410)", async () => {
    const store = new TowerStore();
    store.addPushSub("https://push.example/dead", JSON.stringify({ endpoint: "dead" }));
    store.addPushSub("https://push.example/live", JSON.stringify({ endpoint: "live" }));
    await sendApprovalPush(store, KEYS, task, async (sub) => {
      if (sub.includes("dead")) throw Object.assign(new Error("gone"), { statusCode: 410 });
    });
    const left = store.listPushSubs();
    expect(left).toHaveLength(1);
    expect(left[0]!.endpoint).toContain("live");
  });

  it("keeps subscriptions on transient errors", async () => {
    const store = new TowerStore();
    store.addPushSub("https://push.example/e1", JSON.stringify({ endpoint: "e1" }));
    await sendApprovalPush(store, KEYS, task, async () => {
      throw Object.assign(new Error("boom"), { statusCode: 500 });
    });
    expect(store.listPushSubs()).toHaveLength(1);
  });
});

describe("sendTaskDonePush", () => {
  const finished = (over: Partial<DelegatedTask>): DelegatedTask => ({
    ...task,
    status: "done",
    assigneeAgentId: "bob",
    result: "rate limit 30/min added",
    ...over,
  });

  it("announces a finished task with the assignee and PR ref", async () => {
    const store = new TowerStore();
    store.addPushSub("https://push.example/e1", JSON.stringify({ endpoint: "e1" }));
    const sent: string[] = [];
    await sendTaskDonePush(
      store,
      KEYS,
      finished({ prUrl: "https://github.com/acme/app/pull/42", commitSha: "ab12f3d9c0ffee00" }),
      async (_sub, payload) => {
        sent.push(payload);
      },
    );
    const p = JSON.parse(sent[0]!) as { title: string; body: string; tag: string };
    expect(p.title).toContain("done");
    expect(p.body).toContain("bob");
    expect(p.body).toContain("rate limit 30/min");
    expect(p.body).toContain("pull/42");
    expect(p.tag).toBe("t1");
  });

  it("announces a failure distinctly", async () => {
    const store = new TowerStore();
    store.addPushSub("https://push.example/e1", JSON.stringify({ endpoint: "e1" }));
    const sent: string[] = [];
    await sendTaskDonePush(
      store,
      KEYS,
      finished({ status: "failed", result: "runner exited 1" }),
      async (_sub, payload) => {
        sent.push(payload);
      },
    );
    const p = JSON.parse(sent[0]!) as { title: string; body: string };
    expect(p.title).toContain("failed");
    expect(p.body).toContain("runner exited 1");
  });

  it("drops dead endpoints just like approval pushes", async () => {
    const store = new TowerStore();
    store.addPushSub("https://push.example/dead", JSON.stringify({ endpoint: "dead" }));
    await sendTaskDonePush(store, KEYS, finished({}), async () => {
      throw Object.assign(new Error("gone"), { statusCode: 410 });
    });
    expect(store.listPushSubs()).toHaveLength(0);
  });
});
