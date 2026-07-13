import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TOWER_VERSION } from "@tower/shared";
import { startHttp } from "./transport.js";
import { TowerService } from "./service.js";

let httpServer: Server | undefined;

afterEach(async () => {
  if (httpServer) {
    await new Promise<void>((r) => httpServer!.close(() => r()));
    httpServer = undefined;
  }
});

function url(server: Server, path = "/mcp"): URL {
  const port = (server.address() as AddressInfo).port;
  return new URL(`http://127.0.0.1:${port}${path}`);
}

async function mcpClient(server: Server, token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(url(server), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
  });
  const client = new Client({ name: "http-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe("HTTP transport", () => {
  it("serves a health check with the server version (worker handshake)", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0 });
    const res = await fetch(url(httpServer, "/health"));
    expect(await res.json()).toEqual({ ok: true, service: "tower", version: TOWER_VERSION });
  });

  it("lets two clients share one Tower (B sees A's claim)", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0 });

    const alice = await mcpClient(httpServer);
    await alice.callTool({
      name: "claim_intent",
      arguments: {
        agentId: "alice",
        repo: "acme/app",
        branch: "main",
        symbols: [{ file: "src/auth.ts", symbol: "AuthService.verify" }],
        purpose: "replace JWT",
      },
    });

    const bob = await mcpClient(httpServer);
    const res = (await bob.callTool({
      name: "check_collision",
      arguments: {
        agentId: "bob",
        repo: "acme/app",
        branch: "main",
        symbols: [{ file: "src/auth.ts", symbol: "AuthService.verify" }],
      },
    })) as { structuredContent: { conflicts: { severity: string; agentId: string }[] } };

    expect(res.structuredContent.conflicts[0]!.severity).toBe("hard");
    expect(res.structuredContent.conflicts[0]!.agentId).toBe("alice");
  });

  it("rejects unauthorized requests when a token is configured", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0, token: "secret" });
    await expect(mcpClient(httpServer)).rejects.toThrow();
  });

  it("rejects a wrong bearer token (timing-safe compare)", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0, token: "secret" });
    const res = await fetch(url(httpServer), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("blocks non-local Host headers in token-less mode (DNS-rebinding guard)", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0 });
    const port = (httpServer.address() as AddressInfo).port;
    // fetch() refuses to override Host, so send a raw request like a rebinding browser would.
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: { host: "evil.example.com", "content-type": "application/json" },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(403);
  });

  it("locks out an IP after repeated failed auth attempts (brute-force guard)", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0, token: "secret" });
    const wrong = () =>
      fetch(url(httpServer!), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer nope" },
        body: "{}",
      });
    for (let i = 0; i < 10; i++) expect((await wrong()).status).toBe(401);
    // Guessers are locked out now…
    expect((await wrong()).status).toBe(429);
    // …but a VALID token still gets in: behind a NAT or reverse proxy the whole team
    // shares one address, and a stranger's failures must never lock teammates out.
    const good = await fetch(url(httpServer), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: "{}",
    });
    expect(good.status).not.toBe(429);
    expect(good.status).not.toBe(401);
  });

  it("does NOT lock out requests that omit the Authorization header (board polling)", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0, token: "secret" });
    // 20 tokenless polls (what the board does before a token is entered) must not lock.
    for (let i = 0; i < 20; i++) {
      expect((await fetch(url(httpServer, "/api/board"))).status).toBe(401);
    }
    // a correct token from the same IP still works — the IP was never locked.
    const ok = await fetch(url(httpServer, "/api/board"), {
      headers: { authorization: "Bearer secret" },
    });
    expect(ok.status).toBe(200);
  });

  it("does not count successful auth towards the lockout", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0, token: "secret" });
    for (let i = 0; i < 15; i++) {
      const res = await fetch(url(httpServer), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer secret" },
        body: "{}",
      });
      expect(res.status).not.toBe(429);
    }
  });

  it("still serves localhost requests in token-less mode", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0 });
    const client = await mcpClient(httpServer); // Host: 127.0.0.1 — allowed
    const { tools } = await client.listTools();
    expect(tools.length).toBe(17);
  });
});

describe("board", () => {
  it("redirects the root URL to the board", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0 });
    const res = await fetch(url(httpServer, "/"), { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/board");
  });

  it("serves the board page without auth", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0, token: "secret" });
    const res = await fetch(url(httpServer, "/board"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("TOWER");
  });

  it("requires auth for /api/board when a token is set", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0, token: "secret" });
    expect((await fetch(url(httpServer, "/api/board"))).status).toBe(401);
    const ok = await fetch(url(httpServer, "/api/board"), {
      headers: { authorization: "Bearer secret" },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { claims: unknown[]; conflicts: unknown[]; now: number };
    expect(body.claims).toEqual([]);
    expect(body.conflicts).toEqual([]);
    expect(typeof body.now).toBe("number");
  });

  it("returns claims and pairwise conflicts on /api/board", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0 });
    const claim = (agentId: string) =>
      service.claimIntent({
        agentId,
        repo: "acme/app",
        branch: "main",
        files: [],
        symbols: [{ file: "src/auth.ts", symbol: "AuthService.verify" }],
        purpose: "work",
      });
    claim("alice");
    claim("bob");
    const res = await fetch(url(httpServer, "/api/board"));
    const body = (await res.json()) as {
      claims: { agentId: string }[];
      conflicts: { severity: string }[];
    };
    expect(body.claims).toHaveLength(2);
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0]!.severity).toBe("hard");
  });

  it("includes the comms feed in /api/board and the COMMS panel in the page", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0 });
    service.sendMessage({
      fromAgentId: "alice",
      toAgentId: "bob",
      repo: "team/app",
      kind: "task",
      body: "add rate limiting to /login",
    });
    const api = (await (await fetch(url(httpServer, "/api/board"))).json()) as {
      messages: { body: string; kind: string }[];
    };
    expect(api.messages).toHaveLength(1);
    expect(api.messages[0]!.kind).toBe("task");
    const page = await (await fetch(url(httpServer, "/board"))).text();
    expect(page).toContain("COMMS");
  });

  it("includes delegated tasks in /api/board and the delegation tree on the page", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0 });
    const { id } = service.sendMessage({
      fromAgentId: "alice",
      toAgentId: "bob",
      repo: "team/app",
      kind: "task",
      body: "add rate limiting to /login",
    });
    service.acceptTask({ taskId: id, agentId: "bob" });
    const api = (await (await fetch(url(httpServer, "/api/board"))).json()) as {
      tasks: { status: string; assigneeAgentId?: string }[];
    };
    expect(api.tasks).toHaveLength(1);
    expect(api.tasks[0]!.status).toBe("accepted");
    expect(api.tasks[0]!.assigneeAgentId).toBe("bob");
    const page = await (await fetch(url(httpServer, "/board"))).text();
    expect(page).toContain("Delegated tasks"); // the who-asked-whom tree
  });

  it("the board page ships the mobile controls: a send box and approve/reject", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0 });
    const page = await (await fetch(url(httpServer, "/board"))).text();
    expect(page).toContain("Delegate task"); // send box submit button
    expect(page).toContain("api/task"); // POSTs a delegated task
    expect(page).toContain("api/approve"); // approve/reject a parked task
    expect(page).toContain("Approve");
    expect(page).not.toContain("innerHTML"); // agent strings are textContent-only
  });

  it("creates a task from the board via POST /api/task (mobile send box)", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0, token: "secret" });
    // auth required
    expect(
      (
        await fetch(url(httpServer, "/api/task"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo: "team/app", body: "add health endpoint" }),
        })
      ).status,
    ).toBe(401);
    const res = await fetch(url(httpServer, "/api/task"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({ repo: "team/app", body: "add health endpoint", toAgentId: "bob" }),
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(id).toBeTruthy();
    expect(service.listTasks({ status: "open" }).tasks[0]!.body).toBe("add health endpoint");
  });

  it("rejects a task create with a missing body (400)", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0 });
    const res = await fetch(url(httpServer, "/api/task"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "team/app" }),
    });
    expect(res.status).toBe(400);
  });

  it("approves a parked task via POST /api/approve", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0 });
    const { id } = service.createTask({ repo: "r", body: "x", fromAgentId: "a", toAgentId: "*" });
    service.requestApproval({ taskId: id, agentId: "bob" });
    const res = await fetch(url(httpServer, "/api/approve"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: id, approved: true }),
    });
    expect(res.status).toBe(200);
    expect(service.listTasks({}).tasks[0]!.approval).toBe("approved");
  });

  it("serves /board with clickjacking protection headers", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0 });
    const res = await fetch(url(httpServer, "/board"));
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("answers malformed JSON with a generic error — no stack traces or paths", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0, token: "secret" });
    // Malformed JSON fails inside express.json(), BEFORE auth — exactly where the
    // default Express handler would leak a stack trace with absolute filesystem paths.
    const res = await fetch(url(httpServer, "/api/task"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("node_modules");
    expect(JSON.parse(text)).toEqual({ error: "bad request" });
  });

  it("blocks non-local /api/board without a token (rebinding guard)", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0 });
    const port = (httpServer.address() as AddressInfo).port;
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/api/board", headers: { host: "evil.example.com" } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe("0.7.0 endpoints — rules, push, rate limit", () => {
  const auth = { authorization: "Bearer secret", "content-type": "application/json" };

  it("logs a team rule via /api/decision and surfaces it in the board snapshot", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0, token: "secret" });
    const res = await fetch(url(httpServer, "/api/decision"), {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: "always write tests", author: "board", tags: ["rule"] }),
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(id).toBeTruthy();
    const board = await fetch(url(httpServer, "/api/board"), { headers: auth });
    const snap = (await board.json()) as { rules: { title: string }[] };
    expect(snap.rules[0]!.title).toBe("always write tests");
  });

  it("rejects an invalid decision body and requires auth", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0, token: "secret" });
    const bad = await fetch(url(httpServer, "/api/decision"), {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ body: "no title" }),
    });
    expect(bad.status).toBe(400);
    const noAuth = await fetch(url(httpServer, "/api/decision"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x", author: "y" }),
    });
    expect(noAuth.status).toBe(401);
  });

  it("serves the service worker without auth", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0, token: "secret" });
    const res = await fetch(url(httpServer, "/board-sw.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("showNotification");
  });

  it("hands out a stable VAPID public key and stores a subscription", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0, token: "secret" });
    const k1 = (await (
      await fetch(url(httpServer, "/api/push-key"), { headers: auth })
    ).json()) as {
      key: string;
    };
    const k2 = (await (
      await fetch(url(httpServer, "/api/push-key"), { headers: auth })
    ).json()) as {
      key: string;
    };
    expect(k1.key).toBeTruthy();
    expect(k1.key).toBe(k2.key);

    const sub = await fetch(url(httpServer, "/api/push-subscribe"), {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        endpoint: "https://push.example/abc",
        keys: { p256dh: "p", auth: "a" },
      }),
    });
    expect((await sub.json()) as { ok: boolean }).toEqual({ ok: true });
    expect(service.store.listPushSubs()).toHaveLength(1);

    const unauthKey = await fetch(url(httpServer, "/api/push-key"));
    expect(unauthKey.status).toBe(401);
  });

  it("rate limits write bursts from one IP (31st create → 429)", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0, token: "secret" });
    let lastStatus = 0;
    for (let i = 0; i < 31; i++) {
      const res = await fetch(url(httpServer, "/api/task"), {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ repo: "acme/app", body: `task ${i}` }),
      });
      lastStatus = res.status;
      if (i < 30) expect(res.status).toBe(200);
    }
    expect(lastStatus).toBe(429);
  });
});
