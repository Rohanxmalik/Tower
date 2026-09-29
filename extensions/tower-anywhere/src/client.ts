import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** A reference to one thing an agent intends to touch. `symbol: ""` means the whole artifact. */
export interface SymbolRef {
  file: string;
  symbol: string;
}

export type Severity = "hard" | "soft" | "info";

export interface Conflict {
  claimId: string;
  agentId: string;
  severity: Severity;
  reason: string;
  overlap: SymbolRef[];
  etaMinutes?: number;
}

export interface ClaimIntentOutput {
  claimId: string | null;
  conflicts: Conflict[];
  blocking: boolean;
  recommendation?: "proceed" | "stand_down";
}

export interface CheckCollisionOutput {
  conflicts: Conflict[];
}

/** Calls one Tower MCP tool and returns its structured result. */
export type ToolCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export interface TowerConnection {
  url: string;
  token?: string;
}

const DEFAULT_URL = "http://127.0.0.1:4319/mcp";

/**
 * Where to reach Tower. Unlike the code CLI there is no local SQLite fallback — a
 * marketing team has no repo to put a database next to, so this always talks to a
 * server someone is running (`tower serve --http`, or a hosted one).
 */
export function connectionFromEnv(env: NodeJS.ProcessEnv = process.env): TowerConnection {
  const url = env.TOWER_URL?.trim() || DEFAULT_URL;
  const token = env.TOWER_TOKEN?.trim();
  return token ? { url, token } : { url };
}

/**
 * Connect over MCP-HTTP, run `fn`, and always close the connection. Mirrors the
 * transport the code CLI uses, so this speaks the identical wire contract with no
 * shared code — which is what lets this folder move to its own repo unchanged.
 */
export async function withTower<T>(
  conn: TowerConnection,
  fn: (call: ToolCall) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(conn.url), {
    requestInit: conn.token ? { headers: { authorization: `Bearer ${conn.token}` } } : {},
  });
  const client = new Client({ name: "tower-anywhere", version: "0.1.0" });
  await client.connect(transport);
  try {
    return await fn(async (tool, args) => {
      const res = (await client.callTool({ name: tool, arguments: args })) as {
        isError?: boolean;
        structuredContent?: unknown;
        content?: { text?: string }[];
      };
      if (res.isError) throw new Error(res.content?.[0]?.text ?? `tool "${tool}" failed`);
      return res.structuredContent;
    });
  } finally {
    await client.close();
  }
}
