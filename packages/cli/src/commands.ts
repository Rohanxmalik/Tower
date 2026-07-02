import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import { startStdio, startHttp, SymbolExtractor } from "@tower/server";
import type { SymbolRef } from "@tower/shared";
import { renderConflicts, renderClaimsTable } from "./render.js";
import {
  buildService,
  policyPath,
  claimIdPath,
  EXAMPLE_POLICY,
  MCP_SNIPPET,
  type BuildOptions,
} from "./lib.js";

export type Writer = (line: string) => void;
const stdout: Writer = (l) => process.stdout.write(l + "\n");

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
  const service = buildService(cwd, build);
  const symbols = await resolveSymbols(cwd, args.files, args.symbols);
  const { claimId, conflicts } = service.claimIntent({
    agentId: args.agentId,
    repo: args.repo,
    branch: args.branch,
    files: args.files,
    symbols,
    purpose: args.purpose,
    ...(args.etaMinutes != null ? { etaMinutes: args.etaMinutes } : {}),
  });
  writeFileSync(claimIdPath(cwd), claimId);
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
  const service = buildService(cwd, build);
  const symbols = await resolveSymbols(cwd, args.files, args.symbols);
  const { conflicts } = service.checkCollision({
    agentId: args.agentId,
    repo: args.repo,
    branch: args.branch,
    files: args.files,
    symbols,
  });
  const hard = conflicts.some((c) => c.severity === "hard");
  if (hard) {
    out(renderConflicts(conflicts, (id) => service.store.getClaim(id)));
    service.store.close();
    return true; // block; do not register a claim for an edit we're stopping
  }
  const { claimId } = service.claimIntent({
    agentId: args.agentId,
    repo: args.repo,
    branch: args.branch,
    files: args.files,
    symbols,
    purpose: args.purpose,
    ...(args.etaMinutes != null ? { etaMinutes: args.etaMinutes } : {}),
  });
  writeFileSync(claimIdPath(cwd), claimId);
  service.store.close();
  return false;
}

/** Complete (release on commit) a claim by id, optionally recording the commit sha. */
export function cmdComplete(
  cwd: string,
  claimId: string,
  commitSha: string | undefined,
  out: Writer = stdout,
  build?: BuildOptions,
): boolean {
  const service = buildService(cwd, build);
  const { ok } = service.completeClaim({ claimId, ...(commitSha ? { commitSha } : {}) });
  service.store.close();
  out(ok ? `Completed claim ${claimId.slice(0, 8)}.` : `No active claim ${claimId.slice(0, 8)}.`);
  return ok;
}

/** Print the active-claims table. */
export function cmdStatus(cwd: string, out: Writer = stdout, build?: BuildOptions): void {
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
    const port = args.port ?? 4319;
    const token = args.token ?? process.env.TOWER_TOKEN;
    const host = args.host ?? "127.0.0.1";
    const server = await startHttp(service, {
      port,
      host,
      ...(token ? { token } : {}),
    });
    server.on("close", () => service.store.close());
    log(`Tower listening on http://${host}:${port}/mcp${token ? " (token required)" : ""}`);
    return server;
  }
  log("Tower serving over stdio.");
  await startStdio(service);
  return undefined;
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
    const tick = (): void => {
      cmdStatus(cwd, out);
      ticks += 1;
      if (opts.ticks != null && ticks >= opts.ticks) return resolve();
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
