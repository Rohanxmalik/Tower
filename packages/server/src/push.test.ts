import { describe, it, expect } from "vitest";
import { TowerStore } from "./store/sqlite.js";
import { ensureVapidKeys, sendApprovalPush, type PushKeys } from "./push.js";
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
