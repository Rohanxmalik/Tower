import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
  it("serves a health check", async () => {
    const service = new TowerService();
    httpServer = await startHttp(service, { port: 0 });
    const res = await fetch(url(httpServer, "/health"));
    expect(await res.json()).toEqual({ ok: true, service: "tower" });
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
    // Locked out now — even a correct token from this IP is refused until the window resets.
    expect((await wrong()).status).toBe(429);
    const good = await fetch(url(httpServer), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: "{}",
    });
    expect(good.status).toBe(429);
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
    expect(tools.length).toBe(9);
  });
});

describe("board", () => {
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
