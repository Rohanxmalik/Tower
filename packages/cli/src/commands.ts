import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import type { Server } from "node:http";
import { startStdio, startHttp, SymbolExtractor } from "@tower/server";
import type {
  SymbolRef,
  Claim,
  CheckCollisionOutput,
  ClaimIntentOutput,
  ListClaimsOutput,
  Message,
  NextTaskOutput,
  OkOutput,
  SendMessageOutput,
  FetchMessagesOutput,
} from "@tower/shared";
import { renderConflicts, renderClaimsTable, formatAgo } from "./render.js";
import { remoteConfig, withRemote, type RemoteCall } from "./remote.js";
import {
  buildService,
  towerDir,
  policyPath,
  claimIdPath,
  EXAMPLE_POLICY,
  MCP_SNIPPET,
  type BuildOptions,
} from "./lib.js";

export type Writer = (line: string) => void;
const stdout: Writer = (l) => process.stdout.write(l + "\n");

/** Persist the current claim id for the git post-commit hook (ensures .tower/ exists). */
function writeClaimId(cwd: string, id: string): void {
  mkdirSync(towerDir(cwd), { recursive: true });
  writeFileSync(claimIdPath(cwd), id);
}

/** Fetch active claims from a remote and index them by id, for collision rendering. */
async function remoteClaimLookup(
  call: RemoteCall,
  repo: string,
  branch: string,
): Promise<(id: string) => Claim | undefined> {
  const { claims } = (await call("list_claims", {
    repo,
    branch,
    status: "active",
  })) as ListClaimsOutput;
  const byId = new Map(claims.map((c) => [c.id, c] as const));
  return (id) => byId.get(id);
}

const extractor = new SymbolExtractor();

/**
 * Turn CLI inputs into concrete symbols. Explicit `--symbol path#name` entries win;
 * otherwise, for each `--file` that exists on disk, tree-sitter extracts its symbols so
 * a bare file claim becomes symbol-level automatically.
 */
export async function resolveSymbols(
  cwd: string,
  files: string[],
  symbolStrings: string[],
): Promise<SymbolRef[]> {
  if (symbolStrings.length > 0) return parseSymbols(symbolStrings);
  const out: SymbolRef[] = [];
  for (const file of files) {
    const abs = join(cwd, file);
    if (!existsSync(abs)) {
      out.push({ file, symbol: "" });
      continue;
    }
    const syms = await extractor.extract(file, readFileSync(abs, "utf8"));
    out.push(...syms);
  }
  return out;
}

export interface ClaimArgs {
  agentId: string;
  repo: string;
  branch: string;
  files: string[];
  /** Each entry is "path#symbolName". */
  symbols: string[];
  purpose: string;
  etaMinutes?: number;
  /** guard only: proceed past a hard collision (the [f] option), claiming anyway. */
  force?: boolean;
}

function parseSymbols(entries: string[]): { file: string; symbol: string }[] {
  return entries.map((e) => {
    const hash = e.lastIndexOf("#");
    if (hash < 0) return { file: e, symbol: "" };
    return { file: e.slice(0, hash), symbol: e.slice(hash + 1) };
  });
}

/** Write the example policy and print setup instructions. */
export function cmdInit(cwd: string, out: Writer = stdout): void {
  const p = policyPath(cwd);
  buildService(cwd).store.close(); // ensures .tower/ exists
  if (existsSync(p)) {
    out(`.tower/policy.yaml already exists — leaving it untouched.`);
  } else {
    writeFileSync(p, EXAMPLE_POLICY);
    out(`Wrote ${p}`);
  }
  out("");
  out(MCP_SNIPPET);
}

/** Register a claim and print the collision prompt. Returns true if a hard collision was found. */
export async function cmdClaim(
  cwd: string,
  args: ClaimArgs,
  out: Writer = stdout,
  build?: BuildOptions,
): Promise<boolean> {
  const symbols = await resolveSymbols(cwd, args.files, args.symbols);
  const intent = {
    agentId: args.agentId,
    repo: args.repo,
    branch: args.branch,
    files: args.files,
    symbols,
    purpose: args.purpose,
    ...(args.etaMinutes != null ? { etaMinutes: args.etaMinutes } : {}),
  };

  const remote = remoteConfig();
  if (remote) {
    return withRemote(remote, async (call) => {
      const { claimId, conflicts } = (await call("claim_intent", intent)) as ClaimIntentOutput;
      writeClaimId(cwd, claimId);
      const lookup = conflicts.length
        ? await remoteClaimLookup(call, args.repo, args.branch)
        : () => undefined;
      out(renderConflicts(conflicts, lookup));
      out("");
      out(`(claim ${claimId.slice(0, 8)} registered for ${args.agentId} on ${remote.url})`);
      return conflicts.some((c) => c.severity === "hard");
    });
  }

  const service = buildService(cwd, build);
  const { claimId, conflicts } = service.claimIntent(intent);
  writeClaimId(cwd, claimId);
  out(renderConflicts(conflicts, (id) => service.store.getClaim(id)));
  out("");
  out(`(claim ${claimId.slice(0, 8)} registered for ${args.agentId})`);
  const hard = conflicts.some((c) => c.severity === "hard");
  service.store.close();
  return hard;
}

/**
 * Enforcement primitive for the PreToolUse hook: check for collisions on the target
 * file(s). If a **hard** collision exists, print it and return `true` (caller blocks the
 * edit) WITHOUT registering a claim. Otherwise register the claim and return `false`.
 */
export async function cmdGuard(
  cwd: string,
  args: ClaimArgs,
  out: Writer = stdout,
  build?: BuildOptions,
): Promise<boolean> {
  const symbols = await resolveSymbols(cwd, args.files, args.symbols);
  const scope = {
    agentId: args.agentId,
    repo: args.repo,
    branch: args.branch,
    files: args.files,
    symbols,
  };
  const intent = {
    ...scope,
    purpose: args.purpose,
    ...(args.etaMinutes != null ? { etaMinutes: args.etaMinutes } : {}),
  };

  const cleared = (claimId: string, where: string): void =>
    out(`✅ CLEAR — no conflicting claims. Registered claim ${claimId.slice(0, 8)}${where}.`);

  const forced = (n: number): void =>
    out(`⚠️  FORCED past ${n} hard conflict(s) — claim registered; you own the merge risk.`);

  const remote = remoteConfig();
  if (remote) {
    return withRemote(remote, async (call) => {
      const { conflicts } = (await call("check_collision", scope)) as CheckCollisionOutput;
      const hardCount = conflicts.filter((c) => c.severity === "hard").length;
      if (hardCount > 0) {
        out(renderConflicts(conflicts, await remoteClaimLookup(call, args.repo, args.branch)));
        if (!args.force) return true;
        forced(hardCount);
      }
      const { claimId } = (await call("claim_intent", intent)) as ClaimIntentOutput;
      writeClaimId(cwd, claimId);
      if (hardCount === 0) cleared(claimId, ` for ${args.agentId} on ${remote.url}`);
      return false;
    });
  }

  const service = buildService(cwd, build);
  const { conflicts } = service.checkCollision(scope);
  const hardCount = conflicts.filter((c) => c.severity === "hard").length;
  if (hardCount > 0) {
    out(renderConflicts(conflicts, (id) => service.store.getClaim(id)));
    if (!args.force) {
      service.store.close();
      return true; // block; do not register a claim for an edit we're stopping
    }
    forced(hardCount);
  }
  const { claimId } = service.claimIntent(intent);
  writeClaimId(cwd, claimId);
  if (hardCount === 0) cleared(claimId, ` for ${args.agentId}`);
  service.store.close();
  return false;
}

export interface NextTaskArgs {
  agentId: string;
  repo: string;
}

/**
 * The [d] option made real: ask the sequencer for a module that is safe to start now
 * (dependencies idle, under the per-module agent limit), given everyone's active claims.
 * Candidates come from `.tower/policy.yaml` modules.
 */
export async function cmdNextTask(
  cwd: string,
  args: NextTaskArgs,
  out: Writer = stdout,
  build?: BuildOptions,
): Promise<void> {
  const input = { agentId: args.agentId, repo: args.repo, candidates: [] };
  const remote = remoteConfig();
  const result = remote
    ? ((await withRemote(remote, (call) => call("next_task", input))) as NextTaskOutput)
    : (() => {
        const service = buildService(cwd, build);
        const r = service.nextTask(input);
        service.store.close();
        return r;
      })();
  if (result.task) {
    out(`▶ Next task: ${result.task.id} (module "${result.task.module}")`);
    out(`  ${result.reason}`);
  } else {
    out(`✋ Nothing safe to start: ${result.reason}`);
    out(`  (Modules are declared in .tower/policy.yaml — see "tower init".)`);
  }
}

/** Complete (release on commit) a claim by id, optionally recording the commit sha. */
export async function cmdComplete(
  cwd: string,
  claimId: string,
  commitSha: string | undefined,
  out: Writer = stdout,
  build?: BuildOptions,
): Promise<boolean> {
  const input = { claimId, ...(commitSha ? { commitSha } : {}) };
  const remote = remoteConfig();
  const ok = remote
    ? ((await withRemote(remote, (call) => call("complete_claim", input))) as OkOutput).ok
    : (() => {
        const service = buildService(cwd, build);
        const result = service.completeClaim(input);
        service.store.close();
        return result.ok;
      })();
  out(ok ? `Completed claim ${claimId.slice(0, 8)}.` : `No active claim ${claimId.slice(0, 8)}.`);
  return ok;
}

/** Print the active-claims table (from the hosted Tower when TOWER_URL is set). */
export async function cmdStatus(
  cwd: string,
  out: Writer = stdout,
  build?: BuildOptions,
): Promise<void> {
  const remote = remoteConfig();
  if (remote) {
    const { claims } = (await withRemote(remote, (call) =>
      call("list_claims", { status: "active" }),
    )) as ListClaimsOutput;
    out(renderClaimsTable(claims));
    return;
  }
  const service = buildService(cwd, build);
  const claims = service.listClaims({ status: "active" }).claims;
  out(renderClaimsTable(claims));
  service.store.close();
}

export interface ServeArgs {
  http?: boolean;
  port?: number;
  token?: string;
  host?: string;
}

/**
 * Resolve the HTTP port: an explicit `--port` wins, else the `PORT` env var (set by
 * Render/Railway/Fly and most PaaS), else 4319. Lets the deploy buttons "just work".
 */
export function resolvePort(
  argPort: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (argPort != null) return argPort;
  const fromEnv = env.PORT ? Number(env.PORT) : NaN;
  return Number.isFinite(fromEnv) ? fromEnv : 4319;
}

/**
 * Start the coordination server (stdio by default, or HTTP). Returns the HTTP
 * Server when in `--http` mode (so callers/tests can close it); undefined for stdio.
 */
export async function cmdServe(
  cwd: string,
  args: ServeArgs,
  log: Writer = (l) => process.stderr.write(l + "\n"),
): Promise<Server | undefined> {
  const service = buildService(cwd);
  if (args.http) {
    const port = resolvePort(args.port);
    const token = args.token ?? process.env.TOWER_TOKEN;
    const host = args.host ?? "127.0.0.1";
    const server = await startHttp(service, {
      port,
      host,
      ...(token ? { token } : {}),
    });
    server.on("close", () => service.store.close());
    log(`Tower listening on http://${host}:${port}/mcp${token ? " (token required)" : ""}`);
    log(`Live board:      http://${host}:${port}/board`);
    return server;
  }
  log("Tower serving over stdio.");
  await startStdio(service);
  return undefined;
}

export interface SendArgs {
  from: string;
  to: string;
  repo: string;
  body: string;
  /** Send as a task request instead of a plain message. */
  task?: boolean;
  replyTo?: string;
}

/** Normalize a git remote URL to a stable "host/owner/repo" id (matches the hooks). */
export function normalizeRepoUrl(url: string): string {
  return url
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^ssh:\/\/git@/, "")
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

/** Best-effort defaults so `tower send` can skip questions: agent id + repo from git. */
export function gitDefaults(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  defaultFrom: string;
  defaultRepo: string;
} {
  const git = (cmd: string): string => {
    try {
      return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    } catch {
      return "";
    }
  };
  const origin = git("git config --get remote.origin.url");
  return {
    defaultFrom: env.TOWER_AGENT || git("git config user.name") || "dev",
    defaultRepo: origin ? normalizeRepoUrl(origin) : basename(cwd),
  };
}

export type Ask = (question: string) => Promise<string>;

/**
 * Interactive completion for `tower send`: derivable fields (from/repo) come from git,
 * everything else is asked — so the command can be just `tower send`.
 */
export async function gatherSendArgs(
  partial: Partial<SendArgs>,
  ctx: { defaultFrom: string; defaultRepo: string; ask: Ask },
): Promise<SendArgs> {
  const required = async (given: string | undefined, question: string): Promise<string> => {
    if (given) return given;
    let answer = "";
    while (!answer) answer = (await ctx.ask(question)).trim();
    return answer;
  };
  const to = await required(partial.to, "To (agent id, or * for everyone): ");
  const body = await required(partial.body, "Message: ");
  let task = partial.task;
  if (task === undefined) {
    task = /^y(es)?$/i.test((await ctx.ask("Is this a task for them? [y/N]: ")).trim());
  }
  return {
    from: partial.from ?? ctx.defaultFrom,
    to,
    repo: partial.repo ?? ctx.defaultRepo,
    body,
    task,
    ...(partial.replyTo ? { replyTo: partial.replyTo } : {}),
  };
}

/** Send an async message/task to another agent (the agent channel, from the terminal). */
export async function cmdSend(
  cwd: string,
  args: SendArgs,
  out: Writer = stdout,
  build?: BuildOptions,
): Promise<void> {
  const input = {
    fromAgentId: args.from,
    toAgentId: args.to,
    repo: args.repo,
    body: args.body,
    kind: (args.task ? "task" : "message") as "task" | "message",
    ...(args.replyTo ? { replyTo: args.replyTo } : {}),
  };
  const remote = remoteConfig();
  const { id } = remote
    ? ((await withRemote(remote, (call) => call("send_message", input))) as SendMessageOutput)
    : (() => {
        const service = buildService(cwd, build);
        const r = service.sendMessage(input);
        service.store.close();
        return r;
      })();
  out(`📨 Sent ${args.task ? "task" : "message"} ${id.slice(0, 8)} → ${args.to}`);
}

function renderMessages(messages: Message[], now: number): string {
  if (!messages.length) return "Inbox empty.";
  return messages
    .map((m) => {
      const tag = m.kind === "task" ? "TASK" : m.kind === "task_update" ? "DONE" : "MSG ";
      return `[${tag}] ${m.fromAgentId} → ${m.toAgentId} (${formatAgo(now - m.createdAt)})\n       ${m.body}${m.replyTo ? `\n       ↪ re: ${m.replyTo.slice(0, 8)}` : ""}\n       (reply: tower send --reply-to ${m.id.slice(0, 8)}… )`;
    })
    .join("\n");
}

/** Read (and mark read) an agent's inbox. */
export async function cmdInbox(
  cwd: string,
  args: { agentId: string; repo?: string },
  out: Writer = stdout,
  build?: BuildOptions,
): Promise<void> {
  const input = {
    agentId: args.agentId,
    ...(args.repo ? { repo: args.repo } : {}),
    unreadOnly: true,
  };
  const remote = remoteConfig();
  const { messages } = remote
    ? ((await withRemote(remote, (call) => call("fetch_messages", input))) as FetchMessagesOutput)
    : (() => {
        const service = buildService(cwd, build);
        const r = service.fetchMessages(input);
        service.store.close();
        return r;
      })();
  out(renderMessages(messages, Date.now()));
}

/** Poll the active-claims table until interrupted. */
export async function cmdWatch(
  cwd: string,
  out: Writer = stdout,
  opts: { intervalMs?: number; ticks?: number } = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 1000;
  let ticks = 0;
  await new Promise<void>((resolve) => {
    const tick = async (): Promise<void> => {
      await cmdStatus(cwd, out);
      ticks += 1;
      if (opts.ticks != null && ticks >= opts.ticks) return resolve();
      setTimeout(() => void tick(), intervalMs);
    };
    void tick();
  });
}
