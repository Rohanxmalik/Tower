import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Hosted Tower connection details. */
export interface RemoteConfig {
  url: string;
  token?: string;
}

/**
 * Read remote-Tower config from the environment. When `TOWER_URL` is set, the CLI (and the
 * enforcement hook) coordinate against a shared hosted Tower instead of the local SQLite
 * file — this is what makes enforcement work across machines. Returns null for local mode.
 */
export function remoteConfig(env: NodeJS.ProcessEnv = process.env): RemoteConfig | null {
  const url = env.TOWER_URL;
  if (!url) return null;
  const token = env.TOWER_TOKEN;
  return token ? { url, token } : { url };
}

export type RemoteCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Connect to the hosted Tower over MCP-HTTP, run `fn` with a tool-caller, and always close
 * the connection. Tool errors (validation, auth) are surfaced as thrown Errors.
 */
export async function withRemote<T>(
  cfg: RemoteConfig,
  fn: (call: RemoteCall) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: cfg.token ? { headers: { authorization: `Bearer ${cfg.token}` } } : {},
  });
  const client = new Client({ name: "tower-cli", version: "0.5.0" });
  await client.connect(transport);
  try {
    return await fn(async (tool, args) => {
      const res = (await client.callTool({ name: tool, arguments: args })) as {
        isError?: boolean;
        structuredContent?: unknown;
        content?: { text?: string }[];
      };
      if (res.isError) throw new Error(res.content?.[0]?.text ?? `remote tool "${tool}" failed`);
      return res.structuredContent;
    });
  } finally {
    await client.close();
  }
}
