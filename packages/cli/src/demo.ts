import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import { startHttp, TowerService } from "@tower/server";
import type { Writer } from "./commands.js";

/**
 * `tower demo` — the zero-setup wow moment: boots an in-memory Tower, seeds a
 * two-agent story (a hard collision + a delegated task with its reply), and opens
 * the live board. Nothing touches disk; Ctrl+C throws it all away.
 */

export const DEMO_TOKEN = "demo";
const DEMO_REPO = "acme/app";

export interface DemoSeed {
  aliceClaimId: string;
  bobClaimId: string;
  /** Collisions bob was warned about when he claimed what alice holds. */
  conflictCount: number;
  doneTaskId: string;
  openTaskId: string;
}

/** Seed the demo story into a service. Exported so tests can assert the story. */
export function seedDemo(svc: TowerService): DemoSeed {
  const symbol = { file: "src/auth.ts", symbol: "AuthService.verify", kind: "method" as const };
  const alice = svc.claimIntent({
    agentId: "alice",
    repo: DEMO_REPO,
    branch: "main",
    files: ["src/auth.ts"],
    symbols: [symbol],
    purpose: "hardening token checks",
    etaMinutes: 20,
  });
  // bob claims the SAME symbol → the hard collision the board flashes red.
  const bob = svc.claimIntent({
    agentId: "bob",
    repo: DEMO_REPO,
    branch: "main",
    files: ["src/auth.ts"],
    symbols: [symbol],
    purpose: "adding refresh tokens",
    etaMinutes: 15,
  });

  // One delegation round-tripped (reply + commit chip)…
  const done = svc.sendMessage({
    fromAgentId: "alice",
    toAgentId: "bob",
    repo: DEMO_REPO,
    kind: "task",
    body: "add rate limiting to /login",
  });
  svc.acceptTask({ taskId: done.id, agentId: "bob" });
  svc.completeTask({
    taskId: done.id,
    agentId: "bob",
    success: true,
    result: "rate limit 30/min added, tests green",
    commitSha: "ab12f3d9c0ffee00",
  });
  // …one broadcast still waiting for a taker…
  const open = svc.createTask({
    repo: DEMO_REPO,
    body: "write API docs for the auth module",
    fromAgentId: "alice",
    toAgentId: "*",
  });
  // …a pinned team rule and a live worker for the presence dot + dropdown.
  svc.logDecision({
    title: "always write tests first",
    body: "",
    author: "alice",
    tags: ["rule"],
    relatedFiles: [],
  });
  svc.heartbeatWorker({ agentId: "bob", repo: DEMO_REPO, runner: "claude", status: "ok" });

  return {
    aliceClaimId: alice.claimId,
    bobClaimId: bob.claimId,
    conflictCount: bob.conflicts.length,
    doneTaskId: done.id,
    openTaskId: open.id,
  };
}

export interface DemoHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function cmdDemo(
  out: Writer,
  opts: { open?: boolean; port?: number } = {},
): Promise<DemoHandle> {
  const svc = new TowerService(); // in-memory store — disposable by design
  const seeded = seedDemo(svc);
  const server = await startHttp(svc, { port: opts.port ?? 0, token: DEMO_TOKEN });
  const port = (server.address() as AddressInfo).port;
  const url = `http://localhost:${port}/board#token=${DEMO_TOKEN}`;

  out("");
  out(`Tower demo is live → ${url}`);
  out("");
  out("What you're seeing: alice and bob both claimed AuthService.verify — a HARD");
  out("collision caught before either wrote a line. Below it: a delegated task with");
  out("bob's reply + commit, a broadcast still waiting, and a pinned team rule.");
  out("Ctrl+C stops the demo (nothing was written to disk).");
  out("");

  if (opts.open ?? true) {
    const opener =
      process.platform === "win32"
        ? { cmd: "cmd", args: ["/c", "start", "", url] }
        : process.platform === "darwin"
          ? { cmd: "open", args: [url] }
          : { cmd: "xdg-open", args: [url] };
    execFile(opener.cmd, opener.args, () => {}); // best-effort; the printed URL is the fallback
  }

  // Keep the story alive: claims would TTL-expire and the worker dot would go grey.
  const hb = setInterval(() => {
    svc.heartbeat({ claimId: seeded.aliceClaimId });
    svc.heartbeat({ claimId: seeded.bobClaimId });
    svc.heartbeatWorker({ agentId: "bob", repo: DEMO_REPO, runner: "claude", status: "ok" });
  }, 20_000);
  hb.unref(); // the HTTP server is what keeps the process alive, not this timer

  return {
    port,
    url,
    close: async () => {
      clearInterval(hb);
      await new Promise<void>((r) => server.close(() => r()));
      svc.store.close();
    },
  };
}
