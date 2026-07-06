import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { buildMcpServer } from "./mcp.js";
import { BOARD_HTML } from "./board.js";
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

/**
 * Brute-force guard: after MAX_AUTH_FAILURES failed auth attempts from one IP within
 * WINDOW_MS, refuse all its requests (429) until the window resets. Correct tokens never
 * accumulate failures, so legitimate teammates are unaffected.
 */
const MAX_AUTH_FAILURES = 10;
const AUTH_WINDOW_MS = 60_000;

class AuthThrottle {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  private entry(ip: string): { count: number; resetAt: number } | undefined {
    const e = this.failures.get(ip);
    if (e && e.resetAt <= Date.now()) {
      this.failures.delete(ip);
      return undefined;
    }
    return e;
  }

  isLocked(ip: string): boolean {
    const e = this.entry(ip);
    return e !== undefined && e.count >= MAX_AUTH_FAILURES;
  }

  recordFailure(ip: string): void {
    const e = this.entry(ip);
    if (e) {
      this.failures.set(ip, { count: e.count + 1, resetAt: e.resetAt });
    } else {
      this.failures.set(ip, { count: 1, resetAt: Date.now() + AUTH_WINDOW_MS });
    }
  }
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

  const throttle = new AuthThrottle();

  /** Shared gate for /mcp and /api/board: bearer token (with brute-force lockout) or,
   * in token-less local mode, the DNS-rebinding Host guard. Sends the error response
   * itself and returns false when the request must not proceed. */
  const authorize = (req: express.Request, res: express.Response): boolean => {
    if (opts.token) {
      const ip = req.socket.remoteAddress ?? "unknown";
      if (throttle.isLocked(ip)) {
        res.status(429).json({ error: "too many failed auth attempts — try again later" });
        return false;
      }
      const header = req.header("authorization") ?? "";
      if (!safeEqual(header, `Bearer ${opts.token}`)) {
        throttle.recordFailure(ip);
        res.status(401).json({ error: "unauthorized" });
        return false;
      }
      return true;
    }
    if (!isLocalHost(req.header("host"))) {
      // Token-less mode is for local use only; block DNS-rebinding from browsers.
      res.status(403).json({ error: "host not allowed without a token — set TOWER_TOKEN" });
      return false;
    }
    return true;
  };

  // The live radar board. The page itself carries no data (safe to serve unauthenticated);
  // it polls /api/board with the token the operator enters. The bare domain is what
  // people paste around, so send it to the board instead of "Cannot GET /".
  app.get("/", (_req, res) => {
    res.redirect("/board");
  });
  app.get("/board", (_req, res) => {
    res.type("html").send(BOARD_HTML);
  });

  app.get("/api/board", (req, res) => {
    if (!authorize(req, res)) return;
    res.json(service.boardSnapshot());
  });

  app.post("/mcp", async (req, res) => {
    if (!authorize(req, res)) return;
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
