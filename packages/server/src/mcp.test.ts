import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "./mcp.js";
import { TowerService } from "./service.js";

async function connect(service: TowerService): Promise<Client> {
  const server = buildMcpServer(service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

interface ToolResult {
  structuredContent?: unknown;
  content: { type: string; text?: string }[];
}

describe("MCP server", () => {
  let service: TowerService;
  let client: Client;

  beforeEach(async () => {
    service = new TowerService();
    client = await connect(service);
  });

  it("lists all 17 Tower tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "accept_task",
        "check_collision",
        "fetch_messages",
        "claim_intent",
        "complete_claim",
        "complete_task",
        "get_decisions",
        "heartbeat",
        "heartbeat_worker",
        "list_claims",
        "list_tasks",
        "log_decision",
        "next_task",
        "release_claim",
        "request_approval",
        "resolve_approval",
        "send_message",
      ].sort(),
    );
  });

  it("claim_intent round-trips and returns structured output", async () => {
    const res = (await client.callTool({
      name: "claim_intent",
      arguments: {
        agentId: "claude-a",
        repo: "acme/app",
        branch: "main",
        symbols: [{ file: "src/auth.ts", symbol: "verify" }],
        purpose: "x",
      },
    })) as ToolResult;
    const structured = res.structuredContent as { claimId: string; conflicts: unknown[] };
    expect(structured.claimId).toBeTruthy();
    expect(structured.conflicts).toEqual([]);
  });

  it("surfaces a hard collision between two agents through MCP", async () => {
    await client.callTool({
      name: "claim_intent",
      arguments: {
        agentId: "cursor-bob",
        repo: "acme/app",
        branch: "main",
        symbols: [{ file: "src/auth.ts", symbol: "AuthService.verify" }],
        purpose: "replace JWT",
        etaMinutes: 6,
      },
    });
    const res = (await client.callTool({
      name: "claim_intent",
      arguments: {
        agentId: "claude-a",
        repo: "acme/app",
        branch: "main",
        symbols: [{ file: "src/auth.ts", symbol: "AuthService.verify" }],
        purpose: "y",
      },
    })) as ToolResult;
    const structured = res.structuredContent as { conflicts: { severity: string }[] };
    expect(structured.conflicts[0]!.severity).toBe("hard");
    expect(res.content[0]!.text).toContain("HARD");
  });

  it("validates input and returns an error result for a malformed claim", async () => {
    const res = (await client.callTool({
      name: "claim_intent",
      arguments: { repo: "r", branch: "main" },
    })) as ToolResult & { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("agentId");
  });

  it("exercises the full claim lifecycle + sequencer through MCP", async () => {
    const claim = (await client.callTool({
      name: "claim_intent",
      arguments: {
        agentId: "a",
        repo: "acme/app",
        branch: "main",
        files: ["src/x.ts"],
        purpose: "work",
      },
    })) as ToolResult;
    const claimId = (claim.structuredContent as { claimId: string }).claimId;

    const hb = (await client.callTool({
      name: "heartbeat",
      arguments: { claimId },
    })) as ToolResult;
    expect((hb.structuredContent as { ok: boolean }).ok).toBe(true);

    const list = (await client.callTool({
      name: "list_claims",
      arguments: { repo: "acme/app", status: "active" },
    })) as ToolResult;
    expect((list.structuredContent as { claims: unknown[] }).claims).toHaveLength(1);

    const next = (await client.callTool({
      name: "next_task",
      arguments: { agentId: "a", repo: "acme/app", candidates: [{ id: "t", module: "auth" }] },
    })) as ToolResult;
    expect(next.structuredContent).toHaveProperty("reason");

    const done = (await client.callTool({
      name: "complete_claim",
      arguments: { claimId, commitSha: "sha1" },
    })) as ToolResult;
    expect((done.structuredContent as { ok: boolean }).ok).toBe(true);

    const rel = (await client.callTool({
      name: "release_claim",
      arguments: { claimId },
    })) as ToolResult;
    expect((rel.structuredContent as { ok: boolean }).ok).toBe(false); // already completed
  });

  it("logs and recalls a decision through MCP", async () => {
    await client.callTool({
      name: "log_decision",
      arguments: { title: "Use Redis for pub/sub", author: "claude", body: "low latency" },
    });
    const res = (await client.callTool({
      name: "get_decisions",
      arguments: { query: "redis" },
    })) as ToolResult;
    const structured = res.structuredContent as { decisions: unknown[] };
    expect(structured.decisions).toHaveLength(1);
  });
});
