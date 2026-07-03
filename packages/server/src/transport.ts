import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { buildMcpServer } from "./mcp.js";
import { TowerService } from "./service.js";

/** Constant-time string comparison; length mismatch still compares a full buffer. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare b against itself to keep timing independent of the mismatch position.
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * DNS-rebinding guard: a malicious website can point its own domain at 127.0.0.1 and
 * drive a token-less local Tower from the victim's browser. When no token is configured,
 * only accept requests whose Host header is a local name.
 */
function isLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/** Connect a Tower MCP server to stdio (local single-machine use). */
export async function startStdio(service: TowerService): Promise<void> {
  const server = buildMcpServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export interface HttpOptions {
  port: number;
  /** Optional bearer token; when set, requests must send `Authorization: Bearer <token>`. */
  token?: string;
  host?: string;
}

/**
 * Serve Tower over Streamable HTTP so a whole team can share one instance. Uses the
 * SDK's stateless pattern (a fresh MCP server per request) over a shared TowerService,
 * so all clients see the same claims.
 */
export function startHttp(service: TowerService, opts: HttpOptions): Promise<Server> {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "tower" });
  });

  app.post("/mcp", async (req, res) => {
    if (opts.token) {
      const header = req.header("authorization") ?? "";
      if (!safeEqual(header, `Bearer ${opts.token}`)) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    } else if (!isLocalHost(req.header("host"))) {
      // Token-less mode is for local use only; block DNS-rebinding from browsers.
      res.status(403).json({ error: "host not allowed without a token — set TOWER_TOKEN" });
      return;
    }
    const server = buildMcpServer(service);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Stateless server: no session GET/DELETE stream.
  const methodNotAllowed = (_req: express.Request, res: express.Response) =>
    res.status(405).json({ error: "method not allowed" });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return new Promise((resolve) => {
    const httpServer = app.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve(httpServer));
  });
}
