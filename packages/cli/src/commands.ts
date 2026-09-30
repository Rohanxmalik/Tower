import { writeFileSync, existsSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import type { Server } from "node:http";
import {
  startStdio,
  connectStdio,
  startHttp,
  buildProxyMcpServer,
  SymbolExtractor,
} from "@tower/server";
import type {
  SymbolRef,
  Claim,
  ClaimIntentOutput,
  CompleteClaimOutput,
  Conflict,
  RecordReadsOutput,
  ListClaimsOutput,
  Message,
  NextTaskOutput,
  SendMessageOutput,
  FetchMessagesOutput,
  PendingOutput,
} from "@tower/shared";
import { normalizeRepoUrl, pickRootCommit } from "@tower/shared";
import { renderConflicts, renderClaimsTable, formatAgo } from "./render.js";
import { hookContext, readWarning, renderAlternatives, towerRule } from "./nobody-waits.js";
import { remoteConfig, withRemote, openRemote, type RemoteCall } from "./remote.js";
import {
  buildService,
  towerDir,
  policyPath,
  claimIdPath,
  EXAMPLE_POLICY,
  MCP_SNIPPET,
  PRE_COMMIT_HOOK,
  POST_COMMIT_HOOK_SCRIPT,
  type BuildOptions,
  loadProjectId,
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
  if (symbolStrings.length > 0) return fingerprinted(cwd, parseSymbols(symbolStrings));
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
  /** Root commit sha. Without it a fork and its upstream stay in separate partitions,
   * so the CLI and hooks derive it automatically via {@link gitRepoId}. */
  repoId?: string;
  branch: string;
  files: string[];
  /** Each entry is "path#symbolName". */
  symbols: string[];
  purpose: string;
  etaMinutes?: number;
  /** guard only: proceed past a hard collision (the [f] option), claiming anyway. */
  force?: boolean;
}

/**
 * Attach each named symbol's declaration fingerprint as it stands on disk. Without it a
 * claim from the CLI or a hook could never be compared: no hard `write_read` when a read
 * moved, no heartbeat invalidation, no landed-signature notice on complete. A symbol that
 * is not found, a whole-file entry, or a missing file is left exactly as named.
 */
async function fingerprinted(cwd: string, named: SymbolRef[]): Promise<SymbolRef[]> {
  const byFile = new Map<string, SymbolRef[]>();
  for (const file of new Set(named.filter((n) => n.symbol !== "").map((n) => n.file))) {
    const abs = join(cwd, file);
    if (!existsSync(abs)) continue;
    byFile.set(file, await extractor.extract(file, readFileSync(abs, "utf8")));
  }
  return named.map((n) => {
    const found = byFile.get(n.file)?.find((s) => s.symbol === n.symbol);
    return found?.sig
      ? { ...n, sig: found.sig, ...(found.sigText ? { sigText: found.sigText } : {}) }
      : n;
  });
}

function parseSymbols(entries: string[]): { file: string; symbol: string }[] {
  return entries.map((e) => {
    const hash = e.lastIndexOf("#");
    if (hash < 0) return { file: e, symbol: "" };
    return { file: e.slice(0, hash), symbol: e.slice(hash + 1) };
  });
}

/** Write the example policy and print setup instructions. */
export function cmdInit(cwd: string, out: Writer = stdout, opts: { hooks?: boolean } = {}): void {
  const p = policyPath(cwd);
  buildService(cwd).store.close(); // ensures .tower/ exists
  if (existsSync(p)) {
    out(`.tower/policy.yaml already exists — leaving it untouched.`);
  } else {
    writeFileSync(p, EXAMPLE_POLICY);
    out(`Wrote ${p}`);
  }
  if (opts.hooks) installClaudeHooks(cwd, out);
  out("");
  out(MCP_SNIPPET);
  // The same text `setup` writes, so the two onboarding paths can never teach different rules.
  out(
    towerRule()
      .trim()
      .split("\n")
      .map((l) => (l ? `  ${l}` : l))
      .join("\n"),
  );
}

/** The Claude Code hook block Tower installs. Silent on the happy path, so a whole
 * session of per-edit checking costs zero context. */
export const CLAUDE_HOOKS = {
  SessionStart: [{ hooks: [{ type: "command", command: "node hooks/sessionstart-tower.mjs" }] }],
  UserPromptSubmit: [
    { hooks: [{ type: "command", command: "node hooks/userpromptsubmit-nudge.mjs" }] },
  ],
  PreToolUse: [
    {
      matcher: "Edit|Write|MultiEdit",
      hooks: [{ type: "command", command: "node hooks/pretooluse-tower.mjs" }],
    },
  ],
  PostToolUse: [
    {
      matcher: "Edit|Write|MultiEdit|Read",
      hooks: [{ type: "command", command: "node hooks/posttooluse-tower.mjs" }],
    },
  ],
  SessionEnd: [{ hooks: [{ type: "command", command: "node hooks/sessionend-tower.mjs" }] }],
} as const;

/**
 * Write the hook block into `.claude/settings.json`, merging with whatever is already
 * there. The hooks shipped in the repo but nothing installed them, and an unwired hook
 * enforces nothing — which made "three enforcement layers" true of the code and false of
 * every actual install.
 */
/** One of the five scripts. Present only in a clone of Tower — the npm package ships
 * `dist/` alone, and the hook entries reference `hooks/*.mjs` by relative path. */
const HOOK_SCRIPT = join("hooks", "pretooluse-tower.mjs");

export function installClaudeHooks(cwd: string, out: Writer = stdout): void {
  // Writing these from the npm package leaves five hooks pointing at files that do not
  // exist. Nothing errors, so the user is told "installed" and believes a conflicting
  // edit will be blocked. For an enforcement feature that is the worst possible outcome,
  // so refuse rather than write config that cannot work.
  if (!existsSync(join(cwd, HOOK_SCRIPT))) {
    out(`⚠️  Skipped the Claude Code hooks — ${HOOK_SCRIPT} is not in this directory.`);
    out(`   The five hook scripts live in a clone of Tower, not in the npm package.`);
    out(`   Installed from here they would point at nothing, and the hook that blocks a`);
    out(`   conflicting edit would never fire. To use them:`);
    out(`     git clone https://github.com/Rohanxmalik/Tower && cd Tower`);
    out(`     npm install && npm run build && npx tower-mcp init --hooks`);
    out(`   The git pre-commit guard needs no clone: tower-mcp setup --hooks`);
    return;
  }
  const dir = join(cwd, ".claude");
  const path = join(dir, "settings.json");
  let settings: { hooks?: Record<string, unknown> } = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, "utf8")) as { hooks?: Record<string, unknown> };
    } catch {
      out(`⚠️  .claude/settings.json exists but is invalid JSON — left untouched.`);
      return;
    }
  }

  const { hooks, added, updated } = mergeTowerHooks(settings.hooks ?? {});
  if (added.length === 0 && updated.length === 0) {
    out(`• .claude/settings.json already wires every Tower hook — skipped.`);
    return;
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ ...settings, hooks }, null, 2) + "\n");
  if (added.length) out(`✔ .claude/settings.json — installed ${added.join(", ")}`);
  if (updated.length)
    out(`✔ .claude/settings.json — updated ${updated.join(", ")} to this version`);
  out("  (run `npm run build` once so the hooks can load the CLI)");
}

type HookGroup = { matcher?: string; hooks?: { command?: string }[] };

/**
 * Merge Tower's hook groups into existing settings. The user's own hooks are never
 * changed: a group holding only Tower's command is brought up to date (an older install
 * kept a matcher without `Read` forever), Tower's command is moved out of a group it
 * shares with the user's hooks rather than changing that group's matcher, and Tower's
 * group is appended beside the user's when the event has only theirs.
 */
export function mergeTowerHooks(existing: Record<string, unknown>): {
  hooks: Record<string, unknown>;
  added: string[];
  updated: string[];
} {
  const hooks: Record<string, unknown> = { ...existing };
  const added: string[] = [];
  const updated: string[] = [];
  for (const [event, blocks] of Object.entries(CLAUDE_HOOKS)) {
    const tower = blocks[0];
    const command = tower.hooks[0].command;
    const current = existing[event];
    if (current === undefined) {
      hooks[event] = blocks;
      added.push(event);
      continue;
    }
    if (!Array.isArray(current)) continue; // not a shape we understand — leave it alone
    const groups = current as HookGroup[];
    const isOurs = (g: HookGroup) => (g.hooks ?? []).some((h) => h.command === command);
    const ownOnly = (g: HookGroup) => (g.hooks ?? []).every((h) => h.command === command);
    const at = groups.findIndex(isOurs);
    if (at < 0) {
      hooks[event] = [...groups, tower];
      added.push(event);
    } else if (!ownOnly(groups[at]!)) {
      const theirs = {
        ...groups[at],
        hooks: groups[at]!.hooks!.filter((h) => h.command !== command),
      };
      hooks[event] = [...groups.slice(0, at), theirs, ...groups.slice(at + 1), tower];
      updated.push(event);
    } else if (JSON.stringify(groups[at]) !== JSON.stringify(tower)) {
      hooks[event] = groups.map((g, i) => (i === at ? tower : g));
      updated.push(event);
    }
  }
  return { hooks, added, updated };
}

export interface SetupOpts {
  /** Team mode: point .mcp.json at a hosted Tower instead of a local npx server. */
  url?: string;
  token?: string;
  /** Also install the pre-commit / post-commit git hooks. */
  hooks?: boolean;
  /** Write the keep-going rule: on a hard conflict, work outside `alternatives.avoid`
   * instead of stopping to ask. Opt-in — it trades a little human control for no waiting. */
  keepGoing?: boolean;
}

/** The tower entry for .mcp.json: hosted HTTP when a url is given, else local via npx. */
function towerServerEntry(opts: SetupOpts): Record<string, unknown> {
  if (opts.url) {
    // Run the client locally rather than pointing the agent straight at the URL. The
    // local process computes this repo's identity and stamps it on every call, so a
    // fork and its upstream share one coordination space instead of splitting in
    // silence. The token goes in env, not in an Authorization header written to disk.
    return {
      command: "npx",
      args: ["-y", "tower-mcp", "serve", "--remote", opts.url],
      ...(opts.token ? { env: { TOWER_TOKEN: opts.token } } : {}),
    };
  }
  return { command: "npx", args: ["-y", "tower-mcp", "serve"] };
}

/** Write or merge .mcp.json, overwriting only the "tower" server entry. */
function setupMcpJson(cwd: string, opts: SetupOpts, out: Writer): void {
  const path = join(cwd, ".mcp.json");
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, unknown> };
    } catch {
      out(`⚠️  .mcp.json exists but is invalid JSON — left untouched. Fix it, then re-run setup.`);
      return;
    }
  }
  const merged = {
    ...config,
    mcpServers: { ...(config.mcpServers ?? {}), tower: towerServerEntry(opts) },
  };
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
  out(`✔ .mcp.json — tower server ${opts.url ? `→ ${opts.url}` : "(local, via npx)"}`);
  if (opts.token) {
    // .mcp.json is shared project config - teams commit it, and Tower's own repo
    // tracks it. Keeping the token out of an Authorization header is not enough when
    // the file itself ends up on a public remote.
    out(`⚠️  .mcp.json now holds your team token. That file is a secret, not shareable`);
    out(`   config - added to .gitignore. If git already tracks it, untrack it now:`);
    out(`     git rm --cached .mcp.json`);
  }
}

/** Append the claim-first rule to a rules file; idempotent via the claim_intent marker. */
function setupRulesFile(
  cwd: string,
  name: string,
  createIfMissing: boolean,
  rule: string,
  out: Writer,
): void {
  const path = join(cwd, name);
  const exists = existsSync(path);
  if (!exists && !createIfMissing) return;
  const current = exists ? readFileSync(path, "utf8") : "";
  if (current.includes("claim_intent")) {
    out(`• ${name} already mentions claim_intent — skipped.`);
    return;
  }
  const sep = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(path, current + sep + rule);
  out(`✔ ${name} — claim-first rule ${exists ? "appended" : "created"}`);
}

/** Install one embedded git hook; never overwrites an existing hook file. */
function installHook(hooksDir: string, name: string, content: string, out: Writer): void {
  const path = join(hooksDir, name);
  if (existsSync(path)) {
    out(`⚠️  .git/hooks/${name} already exists — skipped (Tower never overwrites hooks).`);
    return;
  }
  writeFileSync(path, content);
  try {
    chmodSync(path, 0o755);
  } catch {
    // Windows has no executable bit; Git for Windows runs hooks regardless.
  }
  out(`✔ .git/hooks/${name} installed`);
}

/**
 * Keep `.tower/` out of the user's commits — claiming or serving creates a SQLite
 * db there, and without this the next `git status` shows an unexplained binary.
 * Idempotent: never adds the entry twice, never rewrites an unrelated line.
 */
function ensureGitignored(
  cwd: string,
  entry: string,
  present: RegExp,
  comment: string,
  out: Writer,
): void {
  const path = join(cwd, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (present.test(existing)) return;
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${existing}${prefix}\n${comment}\n${entry}\n`);
  out(`✔ .gitignore — added ${entry}`);
}

export function setupGitignore(cwd: string, out: Writer = stdout, opts: SetupOpts = {}): void {
  ensureGitignored(
    cwd,
    ".tower/",
    /^\.tower\/?\s*$/m,
    "# Tower's local state (claims, messages, tasks)",
    out,
  );
  // Only when a token was written: without one, .mcp.json is ordinary shared config
  // and a team is right to commit it.
  if (opts.token) {
    ensureGitignored(
      cwd,
      ".mcp.json",
      /^\.mcp\.json\s*$/m,
      "# Holds your Tower team token — a secret, not shareable config",
      out,
    );
  }
}

/** One-command onboarding: .mcp.json + agent rules (+ git hooks with --hooks). */
export function cmdSetup(cwd: string, opts: SetupOpts, out: Writer = stdout): void {
  setupMcpJson(cwd, opts, out);
  const rule = towerRule({ ...(opts.keepGoing ? { keepGoing: true } : {}) });
  setupRulesFile(cwd, "CLAUDE.md", true, rule, out);
  setupRulesFile(cwd, "AGENTS.md", false, rule, out);
  setupGitignore(cwd, out, opts);
  if (opts.hooks) {
    const hooksDir = join(cwd, ".git", "hooks");
    if (existsSync(hooksDir)) {
      installHook(hooksDir, "pre-commit", PRE_COMMIT_HOOK, out);
      installHook(hooksDir, "post-commit", POST_COMMIT_HOOK_SCRIPT, out);
    } else {
      out(`⚠️  --hooks: no .git/hooks directory here — skipped git hooks.`);
    }
  }
  out("");
  out("Done. Reload your editor to load the tower MCP server; then try: npx -y tower-mcp send");
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
    // Fall back to deriving it here, so every caller partitions the same way even if it
    // forgot to pass one.
    ...((args.repoId ?? gitRepoId(cwd)) ? { repoId: args.repoId ?? gitRepoId(cwd) } : {}),
    branch: args.branch,
    files: args.files,
    symbols,
    purpose: args.purpose,
    ...(args.etaMinutes != null ? { etaMinutes: args.etaMinutes } : {}),
    ...(args.force ? { force: true } : {}),
  };

  const remote = remoteConfig();
  if (remote) {
    return withRemote(remote, async (call) => {
      const { claimId, conflicts, blocking, alternatives } = (await call(
        "claim_intent",
        intent,
      )) as ClaimIntentOutput;
      if (claimId) writeClaimId(cwd, claimId);
      const lookup = conflicts.length
        ? await remoteClaimLookup(call, args.repo, args.branch)
        : () => undefined;
      out(renderConflicts(conflicts, lookup));
      out("");
      out(
        claimId
          ? `(claim ${claimId.slice(0, 8)} registered for ${args.agentId} on ${remote.url})`
          : `(claim REFUSED — another agent holds this. Re-run with --force to override.)`,
      );
      if (alternatives) out(renderAlternatives(alternatives));
      return blocking || conflicts.some((c) => c.severity === "hard");
    });
  }

  const service = buildService(cwd, build);
  const { claimId, conflicts, blocking, alternatives } = service.claimIntent(intent);
  if (claimId) writeClaimId(cwd, claimId);
  out(renderConflicts(conflicts, (id) => service.store.getClaim(id)));
  out("");
  out(
    claimId
      ? `(claim ${claimId.slice(0, 8)} registered for ${args.agentId})`
      : `(claim REFUSED — another agent holds this. Re-run with --force to override.)`,
  );
  if (alternatives) out(renderAlternatives(alternatives));
  const hard = blocking || conflicts.some((c) => c.severity === "hard");
  service.store.close();
  return hard;
}

/**
 * Enforcement primitive for the PreToolUse hook and the pre-commit guard. Returns `true`
 * (caller blocks the edit) on a hard collision, registering nothing; otherwise claims.
 *
 * It goes straight through `claim_intent` — a refusal there registers nothing, so no
 * separate pre-check is needed. The pre-check this replaced ran `check_collision`, which
 * cannot register a waiter, returns no `alternatives`, ignores the agent's recorded
 * reads and is never counted: a hook-blocked agent was promised a message it never got,
 * and a claim refused over a moved read was dropped while the edit went ahead unclaimed.
 */
export async function cmdGuard(
  cwd: string,
  args: ClaimArgs,
  out: Writer = stdout,
  build?: BuildOptions,
): Promise<boolean> {
  const symbols = await resolveSymbols(cwd, args.files, args.symbols);
  const repoId = args.repoId ?? gitRepoId(cwd);
  const intent = {
    agentId: args.agentId,
    repo: args.repo,
    ...(repoId ? { repoId } : {}),
    branch: args.branch,
    files: args.files,
    symbols,
    purpose: args.purpose,
    ...(args.etaMinutes != null ? { etaMinutes: args.etaMinutes } : {}),
    ...(args.force ? { force: true } : {}),
  };
  const where = (url?: string): string => ` for ${args.agentId}${url ? ` on ${url}` : ""}`;

  /** Shared by both transports: print the verdict, return whether to block. */
  const verdict = (
    res: ClaimIntentOutput,
    lookup: (claimId: string) => Claim | undefined,
    url?: string,
  ): boolean => {
    const hard = res.conflicts.filter((c) => c.severity === "hard");
    if (res.claimId) writeClaimId(cwd, res.claimId);
    if (hard.length === 0 && res.claimId) {
      out(
        `✅ CLEAR — no conflicting claims. Registered claim ${res.claimId.slice(0, 8)}${where(url)}.`,
      );
      return false;
    }
    out(renderConflicts(res.conflicts, lookup));
    if (res.claimId) {
      out(
        `⚠️  FORCED past ${hard.length} hard conflict(s) — claim registered; you own the merge risk.`,
      );
      return false;
    }
    if (res.alternatives) out(renderAlternatives(res.alternatives));
    return true; // refused: block, and nothing was registered for the edit we're stopping
  };

  const remote = remoteConfig();
  if (remote) {
    return withRemote(remote, async (call) => {
      const res = (await call("claim_intent", intent)) as ClaimIntentOutput;
      const lookup = res.conflicts.some((c) => c.severity === "hard")
        ? await remoteClaimLookup(call, args.repo, args.branch)
        : () => undefined;
      return verdict(res, lookup, remote.url);
    });
  }

  const service = buildService(cwd, build);
  try {
    return verdict(service.claimIntent(intent), (id) => service.store.getClaim(id));
  } finally {
    service.store.close();
  }
}

export interface NextTaskArgs {
  agentId: string;
  repo: string;
  repoId?: string;
  projectId?: string;
}

/**
 * The [d] option made real: ask the sequencer for a module that is safe to start now
 * (dependencies idle, under the per-module agent limit), given everyone's active claims.
 * Candidates come from `.tower/policy.yaml` modules.
 */
/**
 * The identity every server call must carry so a fork, a mirror and the upstream all
 * land in one coordination space. Resolution order matches `resolveRepoKey`:
 * an explicit flag, then `.tower/policy.yaml`'s projectId, then the git root commit.
 *
 * Every command that reaches the server sends this — a command that forgets it is
 * invisible to the ones that don't, which is the exact bug this release fixes.
 */
export function repoIdentity(
  cwd: string,
  args: { repoId?: string; projectId?: string } = {},
): { repoId?: string; projectId?: string } {
  const projectId = args.projectId ?? loadProjectId(cwd);
  const repoId = args.repoId ?? gitRepoId(cwd);
  return { ...(repoId ? { repoId } : {}), ...(projectId ? { projectId } : {}) };
}

export async function cmdNextTask(
  cwd: string,
  args: NextTaskArgs,
  out: Writer = stdout,
  build?: BuildOptions,
): Promise<void> {
  const input = {
    agentId: args.agentId,
    repo: args.repo,
    ...repoIdentity(cwd, args),
    candidates: [],
  };
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
  const base = { claimId, ...(commitSha ? { commitSha } : {}) };
  const remote = remoteConfig();
  let result: CompleteClaimOutput;
  if (remote) {
    result = await withRemote(remote, async (call) => {
      const { claims } = (await call("list_claims", { status: "active" })) as ListClaimsOutput;
      const symbols = await finalDeclarations(
        cwd,
        claims.find((c) => c.id === claimId),
      );
      return (await call("complete_claim", {
        ...base,
        ...(symbols.length ? { symbols } : {}),
      })) as CompleteClaimOutput;
    });
  } else {
    const service = buildService(cwd, build);
    const symbols = await finalDeclarations(cwd, service.store.getClaim(claimId));
    result = service.completeClaim({ ...base, ...(symbols.length ? { symbols } : {}) });
    service.store.close();
  }
  const told = result.notified ?? 0;
  out(
    result.ok
      ? `Completed claim ${claimId.slice(0, 8)}.` +
          (told
            ? ` Told ${told} agent${told === 1 ? "" : "s"} what a declaration they read landed as.`
            : "")
      : `No active claim ${claimId.slice(0, 8)}.`,
  );
  return result.ok;
}

/**
 * The claimed symbols as they stand now, fingerprinted from the working tree. Sent with
 * `complete_claim` so Tower can tell each reader what a declaration landed as — and
 * whether that matches what was declared. Best-effort: a file that has gone, or a
 * symbol that no longer parses, is simply left out.
 */
async function finalDeclarations(cwd: string, claim: Claim | undefined): Promise<SymbolRef[]> {
  if (!claim) return [];
  const wanted = claim.symbols.filter((s) => s.symbol !== "");
  const out: SymbolRef[] = [];
  for (const file of new Set(wanted.map((s) => s.file))) {
    const abs = join(cwd, file);
    if (!existsSync(abs)) continue;
    const names = new Set(wanted.filter((s) => s.file === file).map((s) => s.symbol));
    const now = await extractor.extract(file, readFileSync(abs, "utf8"));
    out.push(...now.filter((s) => names.has(s.symbol) && s.sig));
  }
  return out;
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
  /** Proxy mode: forward every tool to this hosted Tower, stamping identity on the way. */
  remote?: string;
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
 * The warning shown when `serve` would run a **local** server while `TOWER_URL` points
 * somewhere else — the highest-severity defect found in testing, because it fails with
 * no visible symptom. A decision logged through the MCP tool landed in the local
 * `.tower/tower.db` while the hosted board stayed empty, so a team can believe it is
 * coordinating on a shared server while every write goes to a file on one laptop.
 */
export function localModeWarning(url: string): string {
  return [
    "WARNING: TOWER_URL is set (" + url + "), but `serve` starts a LOCAL server.",
    "",
    "   Everything written through it would go to .tower/tower.db on this machine,",
    "   NOT to the shared Tower - silently. Your teammates would see nothing.",
    "",
    "   Run the client here as a proxy instead, so this repo's identity is computed",
    "   on this machine and stamped onto every call:",
    "",
    '     "tower": { "command": "npx",',
    '                "args": ["-y", "tower-mcp", "serve", "--remote", "' + url + '"] }',
    "",
    "   Or run: npx -y tower-mcp setup --url " + url + " --token <TOWER_TOKEN>",
    "",
    "   Do not point the agent straight at the URL. A direct entry skips this machine,",
    "   so nothing computes repoId and a fork and its upstream coordinate apart.",
  ].join("\n");
}

/**
 * Returns the configured remote URL when starting `serve` here would silently create a
 * **local** server instead — otherwise `undefined`.
 *
 * `--http` *is* the server, so `TOWER_URL` is irrelevant in that mode; only the stdio
 * path (the one an editor spawns) can create the split brain this guards against.
 */
export function localServeConflict(
  args: Pick<ServeArgs, "http">,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (args.http) return undefined;
  const url = env.TOWER_URL?.trim();
  return url ? url : undefined;
}

export interface ServeDeps {
  /** Interactive confirm, used only when stdin is a TTY. */
  ask?: Ask;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Start the coordination server (stdio by default, or HTTP). Returns the HTTP
 * Server when in `--http` mode (so callers/tests can close it); undefined for stdio.
 */
/**
 * A remote connection that dials on first use and re-dials after a drop.
 *
 * The proxy is on the critical path of every session, so it must never take the MCP
 * server down with it: a laptop that slept, a host that idled, or a redeploy would
 * otherwise leave every tool throwing for the rest of the day. One retry on a fresh
 * connection covers the common cases (cold start, dropped socket); a genuine outage
 * surfaces as a clear tool error rather than a silent no-op.
 */
export function lazyRemote(
  cfg: { url: string; token?: string },
  log: Writer = () => {},
): { call: RemoteCall; close: () => Promise<void> } {
  let conn: Promise<{ call: RemoteCall; close: () => Promise<void> }> | null = null;

  const connect = (): Promise<{ call: RemoteCall; close: () => Promise<void> }> => {
    conn ??= openRemote(cfg).catch((err: unknown) => {
      conn = null; // never cache a failure — the next call should dial again
      throw err;
    });
    return conn;
  };

  const call: RemoteCall = async (tool, args) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await (await connect()).call(tool, args);
      } catch (err) {
        lastError = err;
        conn = null; // drop the socket and dial fresh on the retry
        if (attempt === 0) log(`Tower: reconnecting to ${cfg.url}…`);
      }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `Tower is unreachable at ${cfg.url} (${reason}). Coordination is NOT enforced for ` +
        `this call — treat it as unchecked and retry once the server is back.`,
    );
  };

  return {
    call,
    close: async () => {
      const open = conn;
      conn = null;
      if (!open) return;
      try {
        await (await open).close();
      } catch {
        // already gone
      }
    },
  };
}

export async function cmdServe(
  cwd: string,
  args: ServeArgs,
  log: Writer = (l) => process.stderr.write(l + "\n"),
  deps: ServeDeps = {},
): Promise<Server | undefined> {
  const env = deps.env ?? process.env;

  // Proxy mode: run the MCP client here on the developer's machine so the project
  // identity (repoId / projectId) can be computed from cwd and stamped onto every
  // call. Pointing .mcp.json straight at the hosted URL skips this machine entirely,
  // which is how a fork and its upstream silently coordinated in separate spaces.
  const proxyUrl = args.remote ?? (args.http ? undefined : env.TOWER_PROXY_URL);
  if (proxyUrl) {
    const identity = repoIdentity(cwd);
    const token = args.token ?? env.TOWER_TOKEN;
    log(`Tower proxy → ${proxyUrl}`);
    log(
      identity.projectId
        ? `  project: ${identity.projectId} (from .tower/policy.yaml)`
        : identity.repoId
          ? `  repoId:  ${identity.repoId.slice(0, 12)}… (git root commit — forks match)`
          : `  ⚠ no repoId and no projectId — not a git repo. Teammates on a fork will NOT` +
            ` see your claims. Set "projectId: <name>" in .tower/policy.yaml.`,
    );
    // Connect lazily, and serve stdio first. Dialling the server up front means a cold
    // host (Render's free tier sleeps and takes ~50s to wake), a stale token or a flaky
    // network kills the process before it ever speaks MCP — the editor then shows a dead
    // server with no Tower tools at all, which is worse than the bug this replaced. The
    // tools are always present; a call that cannot reach the server fails loudly, once.
    const { call, close } = lazyRemote(token ? { url: proxyUrl, token } : { url: proxyUrl }, log);
    try {
      await connectStdio(buildProxyMcpServer(call, identity));
    } finally {
      await close();
    }
    return undefined;
  }

  const remoteUrl = localServeConflict(args, env);
  if (remoteUrl) {
    log(localModeWarning(remoteUrl));
    const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
    if (!isTTY) {
      // Spawned by an MCP client, so nobody can answer — refuse rather than write
      // somewhere nobody will look.
      log("");
      log("   Refusing to start local-only. Register the HTTP endpoint above, or unset TOWER_URL.");
      throw new Error("serve: TOWER_URL is set - refusing to start a silent local server");
    }
    const answer = deps.ask ? await deps.ask("Start a LOCAL server anyway? [y/N]: ") : "";
    if (!/^y(es)?$/i.test(answer.trim())) {
      throw new Error("serve: cancelled - TOWER_URL is set");
    }
    log("   Continuing with a local server at your request.");
  }

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

/**
 * Re-exported so existing callers keep working; the implementation now lives in
 * `@tower/shared` so the CLI, the server and the hooks all normalize identically.
 * Three copies of this function was how one team ended up in three partitions.
 */
export { normalizeRepoUrl } from "@tower/shared";

/** Root-commit lookups shell out to git, so cache per (cwd, process). */
const repoIdCache = new Map<string, string | undefined>();

/**
 * The repository's root commit sha — identical across every clone, fork and mirror,
 * which is what lets a fork and its upstream share one coordination space.
 * `undefined` for shallow clones and non-repos; callers fall back to the remote URL.
 */
export function gitRepoId(cwd: string): string | undefined {
  if (repoIdCache.has(cwd)) return repoIdCache.get(cwd);
  let id: string | undefined;
  try {
    const out = execSync("git rev-list --max-parents=0 HEAD", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    id = pickRootCommit(out);
  } catch {
    id = undefined; // shallow clone, empty repo, or not a repo at all
  }
  repoIdCache.set(cwd, id);
  return id;
}

/** Best-effort defaults so `tower send` can skip questions: agent id + repo from git. */
export function gitDefaults(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  defaultFrom: string;
  defaultRepo: string;
  defaultRepoId?: string;
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
  const repoId = gitRepoId(cwd);
  return {
    defaultFrom: env.TOWER_AGENT || git("git config user.name") || "dev",
    defaultRepo: origin ? normalizeRepoUrl(origin) : basename(cwd),
    ...(repoId ? { defaultRepoId: repoId } : {}),
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

/** Read-only nudge: how many tasks/messages are waiting for you. Marks nothing read,
 * prints nothing when the inbox is clear — meant to run from a Claude Code hook so an
 * interactive agent gets "🗼 Tower: N tasks waiting" without polling the board. */
export async function cmdNudge(
  cwd: string,
  args: { agentId: string; repo?: string; json?: boolean },
  out: Writer = stdout,
  build?: BuildOptions,
): Promise<void> {
  const input = { agentId: args.agentId, ...(args.repo ? { repo: args.repo } : {}) };
  const remote = remoteConfig();
  const { unreadMessages, openTasks } = remote
    ? ((await withRemote(remote, (call) => call("pending", input))) as PendingOutput)
    : (() => {
        const service = buildService(cwd, build);
        const r = service.pending(input);
        service.store.close();
        return r;
      })();

  if (args.json) {
    out(JSON.stringify({ unreadMessages, openTasks }));
    return;
  }
  if (unreadMessages + openTasks === 0) return; // silent when nothing waits

  // A delegated task IS an unread message (same id), so it's counted in both. Report the
  // inbox unread total as the headline and call out how many of them are delegated tasks —
  // don't add the two numbers, or a single task reads as "2 things waiting".
  const taskNote =
    openTasks > 0 ? ` (${openTasks} delegated task${openTasks === 1 ? "" : "s"})` : "";
  const headline =
    unreadMessages > 0
      ? `${unreadMessages} unread${taskNote}`
      : `${openTasks} open delegated task${openTasks === 1 ? "" : "s"}`;
  out(
    `🗼 Tower: ${headline} waiting for ${args.agentId}. ` +
      `Call fetch_messages / list_tasks to pick up.`,
  );
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

export interface PresenceArgs {
  agentId: string;
  repo: string;
  repoId?: string;
  runner?: string;
}

/**
 * Announce that an agent session is alive, and extend the claims it holds.
 *
 * Presence used to depend on an agent volunteering `heartbeat_worker`, which an
 * interactive editor session never does — so the board reported zero agents during
 * active multi-agent work. The session-lifecycle hooks call this instead, so liveness
 * is driven by the harness rather than by agent goodwill.
 */
export async function cmdPresence(
  cwd: string,
  args: PresenceArgs,
  out: Writer = stdout,
): Promise<void> {
  const payload = {
    agentId: args.agentId,
    repo: args.repo,
    runner: args.runner ?? "interactive",
    status: "ok" as const,
  };

  const remote = remoteConfig();
  if (remote) {
    await withRemote(remote, async (call) => {
      await call("heartbeat_worker", payload);
      return undefined;
    });
    out(`presence: ${args.agentId} on ${remote.url}`);
    return;
  }

  const service = buildService(cwd);
  service.heartbeatWorker(payload);
  service.store.close();
  out(`presence: ${args.agentId} (local)`);
}

/**
 * Release every active claim an agent holds — called when a session ends, so a closed
 * editor stops blocking files it is no longer editing.
 */
export async function cmdRelease(
  cwd: string,
  agentId: string,
  out: Writer = stdout,
): Promise<number> {
  const remote = remoteConfig();
  if (remote) {
    return withRemote(remote, async (call) => {
      const { claims } = (await call("list_claims", { status: "active" })) as ListClaimsOutput;
      const mine = claims.filter((c) => c.agentId === agentId);
      for (const c of mine) await call("release_claim", { claimId: c.id });
      out(`released ${mine.length} claim(s) for ${agentId}`);
      return mine.length;
    });
  }

  const service = buildService(cwd);
  const mine = service.store.listClaims({ status: "active" }).filter((c) => c.agentId === agentId);
  for (const c of mine) service.store.releaseClaim(c.id);
  service.store.close();
  out(`released ${mine.length} claim(s) for ${agentId}`);
  return mine.length;
}

export interface RecordReadsArgs {
  agentId: string;
  repo: string;
  repoId?: string;
  /** So a read of work on another branch is warned as soft. The hook passes it. */
  branch?: string;
  file: string;
}

/**
 * Record the declarations in a file the agent just read, with the signature each had at
 * that moment. Called by the PostToolUse hook on every Read, so an agent's next claim
 * carries a read set it never had to assemble.
 *
 * Silent and best-effort: a missed read costs a warning Tower could have given, never
 * correctness, and a Read must never fail because coordination was unavailable.
 */
export async function cmdRecordReads(cwd: string, args: RecordReadsArgs): Promise<Conflict[]> {
  const abs = join(cwd, args.file);
  const rel = args.file.startsWith(cwd) ? args.file.slice(cwd.length + 1) : args.file;
  if (!existsSync(abs) && !existsSync(args.file)) return [];
  const source = readFileSync(existsSync(abs) ? abs : args.file, "utf8");
  const reads = (await extractor.extract(rel.split("\\").join("/"), source)).filter(
    (s) => s.symbol !== "" && s.sig,
  );
  if (reads.length === 0) return [];

  const projectId = loadProjectId(cwd);
  // Derived exactly as cmdClaim derives it. Without the fallback a caller that omitted
  // repoId recorded its reads under the bare repo name while its claims went under the
  // root commit — two partitions, so no read was ever matched against a claim.
  const repoId = args.repoId ?? gitRepoId(cwd);
  const payload = {
    agentId: args.agentId,
    repo: args.repo,
    ...(repoId ? { repoId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(args.branch ? { branch: args.branch } : {}),
    reads,
  };
  // The warnings come back to the caller — the PostToolUse hook — which is what gets
  // them in front of the agent at the moment of reading rather than at its next claim.
  const remote = remoteConfig();
  if (remote) {
    const res = (await withRemote(remote, (call) => call("record_reads", payload))) as
      RecordReadsOutput | undefined;
    return res?.conflicts ?? [];
  }
  const service = buildService(cwd);
  const res = service.recordReads(payload);
  service.store.close();
  return res.conflicts;
}

/**
 * What the PostToolUse hook prints after a Read: `additionalContext` JSON when someone is
 * changing what was just read, or `null` to print nothing. The hook stays a thin shell
 * around this so the output an agent actually sees is covered by the unit suite — hooks
 * run from the built CLI, which the suite never executes.
 */
export async function hookRecordReads(cwd: string, args: RecordReadsArgs): Promise<string | null> {
  const text = readWarning(await cmdRecordReads(cwd, args));
  return text ? hookContext(text) : null;
}

/** Print how often each kind of collision has actually fired. Counts only — the store
 * keeps no file, symbol or line of code against a conflict. */
export async function cmdStats(cwd: string, out: Writer = stdout): Promise<void> {
  const remote = remoteConfig();
  const stats = remote
    ? ((await withRemote(remote, (call) => call("list_claims", { status: "active" }))) as never)
    : (() => {
        const service = buildService(cwd);
        const s = service.store.conflictStats();
        service.store.close();
        return s;
      })();

  if (remote) {
    out("stats reads the local store; run it where the server runs.");
    return;
  }
  const s = stats as unknown as {
    total: number;
    byKind: Record<string, number>;
    bySeverity: Record<string, number>;
    forced: number;
  };
  if (s.total === 0) {
    out("No collisions recorded yet — nothing has collided, or nothing has claimed.");
    return;
  }
  const pct = (n: number): string => `${Math.round((n / s.total) * 100)}%`;
  out(`${s.total} collision(s) recorded\n`);
  out(`  by kind`);
  out(
    `    write_write  ${s.byKind.write_write ?? 0}  (${pct(s.byKind.write_write ?? 0)})  two agents on the same symbol`,
  );
  out(
    `    write_read   ${s.byKind.write_read ?? 0}  (${pct(s.byKind.write_read ?? 0)})  a contract moved under a reader`,
  );
  out(`\n  by severity`);
  out(
    `    hard ${s.bySeverity.hard ?? 0}   soft ${s.bySeverity.soft ?? 0}   info ${s.bySeverity.info ?? 0}`,
  );
  out(`\n  forced past a hard conflict: ${s.forced}`);
}
