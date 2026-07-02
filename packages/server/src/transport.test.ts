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
});
