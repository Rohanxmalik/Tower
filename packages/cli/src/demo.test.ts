import { describe, it, expect } from "vitest";
import { TowerService } from "@tower/server";
import { seedDemo, cmdDemo, DEMO_TOKEN } from "./demo.js";

describe("seedDemo", () => {
  it("seeds a hard collision, a finished delegation, an open broadcast, a rule, and a live worker", () => {
    const svc = new TowerService();
    const s = seedDemo(svc);
    expect(s.conflictCount).toBeGreaterThan(0);

    const snap = svc.boardSnapshot();
    expect(snap.conflicts.some((c) => c.severity === "hard")).toBe(true);
    const done = snap.tasks.find((t) => t.id === s.doneTaskId);
    expect(done?.status).toBe("done");
    expect(done?.commitSha).toBeTruthy();
    expect(snap.tasks.find((t) => t.id === s.openTaskId)?.status).toBe("open");
    expect(snap.rules[0]?.title).toContain("tests");
    expect(snap.workers.some((w) => w.agentId === "bob")).toBe(true);
    svc.store.close();
  });

  it("threads bob's reply under the finished task", () => {
    const svc = new TowerService();
    const s = seedDemo(svc);
    const snap = svc.boardSnapshot();
    expect(snap.messages.some((m) => m.kind === "task_update" && m.replyTo === s.doneTaskId)).toBe(
      true,
    );
    svc.store.close();
  });
});

describe("cmdDemo", () => {
  it("boots a live board on a free port that answers with the demo token", async () => {
    const lines: string[] = [];
    const demo = await cmdDemo((l) => lines.push(l), { open: false });
    try {
      const health = await fetch(`http://127.0.0.1:${demo.port}/health`);
      expect(health.ok).toBe(true);

      const board = await fetch(`http://127.0.0.1:${demo.port}/api/board`, {
        headers: { authorization: `Bearer ${DEMO_TOKEN}` },
      });
      expect(board.status).toBe(200);
      const data = (await board.json()) as { conflicts: unknown[]; tasks: unknown[] };
      expect(data.conflicts.length).toBeGreaterThan(0);
      expect(data.tasks.length).toBe(2);

      expect(lines.join("\n")).toContain("demo is live");
      expect(demo.url).toContain(`#token=${DEMO_TOKEN}`);
    } finally {
      await demo.close();
    }
  });
});
