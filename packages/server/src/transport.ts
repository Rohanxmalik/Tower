import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import {
  CreateTaskInput,
  LogDecisionInput,
  PushSubscriptionInput,
  ResolveApprovalInput,
  TOWER_VERSION,
} from "@tower/shared";
import { buildMcpServer } from "./mcp.js";
import { BOARD_HTML, BOARD_SW_JS } from "./board.js";
import { ensureVapidKeys, sendApprovalPush, sendTaskDonePush } from "./push.js";
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
/** Hard cap on tracked IPs — an attacker rotating addresses can't grow the map forever. */
const MAX_TRACKED_IPS = 10_000;

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

  /** Periodic cleanup: entries expire lazily on access, but an IP never seen again
   * would linger — sweep drops them, and the cap bounds worst-case memory. */
  sweep(): void {
    const now = Date.now();
    for (const [ip, e] of this.failures) if (e.resetAt <= now) this.failures.delete(ip);
    if (this.failures.size > MAX_TRACKED_IPS) this.failures.clear();
  }
}

/** Per-IP cap on authenticated writes (task/rule creation, push subscribe) — a token
 * holder can't flood the DB or spam workers by scripting the board endpoints. */
const MAX_WRITES_PER_WINDOW = 30;

class WriteLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  allow(ip: string): boolean {
    const now = Date.now();
    const e = this.hits.get(ip);
    if (!e || e.resetAt <= now) {
      this.hits.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
      return true;
    }
    this.hits.set(ip, { count: e.count + 1, resetAt: e.resetAt });
    return e.count + 1 <= MAX_WRITES_PER_WINDOW;
  }

  sweep(): void {
    const now = Date.now();
    for (const [ip, e] of this.hits) if (e.resetAt <= now) this.hits.delete(ip);
    if (this.hits.size > MAX_TRACKED_IPS) this.hits.clear();
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
  // Behind Render/nginx/Cloudflare the socket address is the proxy's — without this,
  // every client shares one brute-force bucket and 10 bad tokens lock out the world.
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => {
    // version lets workers detect major.minor drift against the server (handshake).
    res.json({ ok: true, service: "tower", version: TOWER_VERSION });
  });

  const throttle = new AuthThrottle();
  const writes = new WriteLimiter();

  // Web push: parked-for-approval tasks buzz every subscribed phone, no open tab
  // needed — and finished work buzzes too, closing the loop.
  const vapidKeys = ensureVapidKeys(service.store);
  service.onApprovalRequested = (task) => {
    void sendApprovalPush(service.store, vapidKeys, task);
  };
  service.onTaskCompleted = (task) => {
    void sendTaskDonePush(service.store, vapidKeys, task);
  };

  const clientIp = (req: express.Request): string =>
    req.ip ?? req.socket.remoteAddress ?? "unknown";

  /** 429s write bursts from one IP; call after authorize() on mutating routes. */
  const limitWrites = (req: express.Request, res: express.Response): boolean => {
    if (writes.allow(clientIp(req))) return true;
    res.status(429).json({ error: "rate limited — slow down" });
    return false;
  };

  /** Shared gate for /mcp and /api/board: bearer token (with brute-force lockout) or,
   * in token-less local mode, the DNS-rebinding Host guard. Sends the error response
   * itself and returns false when the request must not proceed. */
  const authorize = (req: express.Request, res: express.Response): boolean => {
    if (opts.token) {
      const header = req.header("authorization") ?? "";
      // A valid token always wins — teammates behind a NAT/proxy must never be
      // locked out by someone else's failed attempts on the shared address.
      if (safeEqual(header, `Bearer ${opts.token}`)) return true;
      const ip = clientIp(req);
      if (throttle.isLocked(ip)) {
        res.status(429).json({ error: "too many failed auth attempts — try again later" });
        return false;
      }
      // Only a *present but wrong* token counts as a brute-force attempt. A missing
      // header is just "not signed in yet" — the board polls before a token is entered,
      // and those requests must not lock out the IP (which is shared by the whole team).
      if (header) throttle.recordFailure(ip);
      res.status(401).json({ error: "unauthorized" });
      return false;
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
    // The board holds the token in localStorage and has one-tap Approve buttons —
    // refuse to be framed so another site can't overlay and clickjack them.
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.type("html").send(BOARD_HTML);
  });

  // The board's service worker (push notifications). Must be same-origin and is
  // fetched by the browser without headers, so it is served unauthenticated — it
  // contains only static notification-display code, no data.
  app.get("/board-sw.js", (_req, res) => {
    res.type("application/javascript").send(BOARD_SW_JS);
  });

  app.get("/api/board", (req, res) => {
    if (!authorize(req, res)) return;
    res.json(service.boardSnapshot());
  });

  // Create a delegated task from the board (incl. mobile) — a worker picks it up.
  app.post("/api/task", (req, res) => {
    if (!authorize(req, res)) return;
    if (!limitWrites(req, res)) return;
    const parsed = CreateTaskInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "repo and body are required" });
      return;
    }
    res.json(service.createTask(parsed.data));
  });

  // Pin a team rule (or any decision) from the board — tagged "rule" entries are
  // prepended to every delegated task prompt by the workers.
  app.post("/api/decision", (req, res) => {
    if (!authorize(req, res)) return;
    if (!limitWrites(req, res)) return;
    const parsed = LogDecisionInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "title and author are required" });
      return;
    }
    res.json(service.logDecision(parsed.data));
  });

  // Web push opt-in: the board fetches the public key, subscribes, and posts the
  // subscription here so parked tasks can buzz the phone.
  app.get("/api/push-key", (req, res) => {
    if (!authorize(req, res)) return;
    res.json({ key: vapidKeys.publicKey });
  });

  app.post("/api/push-subscribe", (req, res) => {
    if (!authorize(req, res)) return;
    if (!limitWrites(req, res)) return;
    const parsed = PushSubscriptionInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "endpoint and keys are required" });
      return;
    }
    service.store.addPushSub(parsed.data.endpoint, JSON.stringify(parsed.data));
    res.json({ ok: true });
  });

  // Approve or reject a parked task (the phone taps ✓/✗).
  app.post("/api/approve", (req, res) => {
    if (!authorize(req, res)) return;
    const parsed = ResolveApprovalInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "taskId and approved are required" });
      return;
    }
    res.json(service.resolveApproval(parsed.data));
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

  // Terminal error handler: without it Express's default page leaks stack traces and
  // absolute paths (e.g. on malformed JSON, which fails before auth) unless NODE_ENV
  // happens to be "production". Always answer with a generic JSON error instead.
  const onError: express.ErrorRequestHandler = (err, _req, res, _next) => {
    const raw = (err as { status?: number; statusCode?: number } | null) ?? {};
    const status = raw.status ?? raw.statusCode ?? 500;
    res
      .status(typeof status === "number" && status >= 400 && status < 600 ? status : 500)
      .json({ error: status >= 500 ? "internal error" : "bad request" });
  };
  app.use(onError);

  return new Promise((resolve) => {
    const httpServer = app.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve(httpServer));
    // Bound throttle/limiter memory on long-lived servers; unref'd so it never
    // holds the process open, cleared on close so tests shut down cleanly.
    const sweeper = setInterval(() => {
      throttle.sweep();
      writes.sweep();
    }, 5 * 60_000);
    sweeper.unref();
    httpServer.on("close", () => clearInterval(sweeper));
  });
}
