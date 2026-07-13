import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  DelegatedTask,
  ListTasksOutput,
  AcceptTaskOutput,
  OkOutput,
  GetDecisionsOutput,
  WorkerStatus,
} from "@tower/shared";
import { TOWER_VERSION } from "@tower/shared";
import { remoteConfig, withRemote } from "./remote.js";
import { buildService, type BuildOptions } from "./lib.js";
import type { Writer } from "./commands.js";

/** Shell-out contract; injectable so tests can fake runners and failures. */
export type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; input?: string; shell?: boolean },
) => Promise<{ code: number; out: string; timedOut?: boolean }>;

/** execFile-based Exec that never throws: captures stdout+stderr, exit code, timeouts. */
export const defaultExec: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    // Own the timeout instead of using execFile's: with shell:true the direct child is
    // cmd.exe/sh, and on Windows killing only it orphans the actual agent — which keeps
    // editing files after our git reset and holds the stdio pipes open (so the callback
    // would never fire). taskkill /T reaches the whole tree. Owning the flag also stops
    // a maxBuffer kill from being misreported as a timeout.
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        // Agent CLIs (`claude`, `codex`) are .cmd shims on Windows; Node refuses to spawn
        // .cmd without a shell (CVE-2024-27980), so runners set shell:true. Their args are
        // all static — the untrusted prompt goes via stdin, never the command line.
        ...(opts.shell ? { shell: true } : {}),
        // cmd.exe needs verbatim args or Node's quoting breaks `/c <template>`.
        windowsVerbatimArguments: cmd === "cmd",
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (timer) clearTimeout(timer);
        const out = `${stdout ?? ""}${stderr ?? ""}`;
        if (!err) return resolve({ code: 0, out });
        const code = typeof err.code === "number" ? err.code : 1;
        resolve({ code: code === 0 ? 1 : code, out, timedOut });
      },
    );
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        if (process.platform === "win32" && child.pid) {
          execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
        } else {
          child.kill("SIGKILL");
        }
      }, opts.timeoutMs);
      timer.unref();
    }
    if (opts.input != null && child.stdin) {
      child.stdin.on("error", () => {}); // ignore EPIPE if the child exits early
      child.stdin.end(opts.input);
    }
  });

export interface WorkerOptions {
  /** Whose inbox this worker drains. */
  agentId: string;
  repo: string;
  runner: "claude" | "codex" | "cmd";
  /** runner "cmd": operator-authored shell command; receives the task prompt on STDIN. */
  cmdTemplate?: string;
  intervalMs?: number;
  /** Skip per-task confirmation. Required to run without a TTY. */
  auto?: boolean;
  /** Only accept tasks sent by these agent ids. */
  allowFrom?: string[];
  /** Park each task for approval from the board/phone instead of the terminal. */
  remoteApprove?: boolean;
  maxMinutes?: number;
  branchPrefix?: string;
  push?: boolean;
  pr?: boolean;
  /** Cap on tasks STARTED per rolling 24h; over it the worker reports "low" capacity
   * and accepts nothing until the window frees up. In-memory — a restart resets it. */
  budget?: number;
  /** Tests: stop after N poll cycles (default: run forever). */
  ticks?: number;
  exec?: Exec;
  ask?: (q: string) => Promise<string>;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface RunnerCmd {
  cmd: string;
  args: string[];
  /** Windows cmd.exe templates must be passed through unquoted. */
  verbatim?: boolean;
  /** Prompt to feed on stdin (keeps untrusted text off the command line). */
  input?: string;
  /** Run through a shell (needed for the `.cmd` agent shims on Windows). */
  shell?: boolean;
}

/** The headless command for each runner. Exported for tests and docs honesty. */
export function runnerCommand(
  opts: WorkerOptions,
  prompt: string,
  platform: NodeJS.Platform = process.platform,
): RunnerCmd {
  // claude/codex take the prompt on stdin, and run via the shell so the Windows `.cmd`
  // shim spawns (Node blocks bare .cmd execution). The whole invocation is one static
  // string (no args array → no DEP0190) and carries no untrusted text — the prompt is
  // piped on stdin, so there is nothing to escape or inject.
  if (opts.runner === "claude") {
    return { cmd: "claude -p --permission-mode acceptEdits", args: [], input: prompt, shell: true };
  }
  if (opts.runner === "codex") {
    return { cmd: "codex exec --full-auto -", args: [], input: prompt, shell: true };
  }
  // Custom commands run exactly as the operator wrote them (trusted, static) and get
  // the prompt on STDIN too. Task text is NEVER substituted into the shell string —
  // a `{{task}}`-style splice would let a task body break out of any quoting and run
  // arbitrary commands on the worker machine.
  const template = opts.cmdTemplate ?? "";
  return platform === "win32"
    ? { cmd: "cmd", args: ["/d", "/s", "/c", template], verbatim: true, input: prompt }
    : { cmd: "sh", args: ["-c", template], input: prompt };
}

const TAIL_CHARS = 2000;
const tail = (s: string): string => s.slice(-TAIL_CHARS).trim();

/** Cooldown after a rate-limit failure: report "low" capacity, accept nothing, self-recover. */
export const COOLDOWN_MS = 10 * 60_000;
/** Rolling window for --budget. */
export const BUDGET_WINDOW_MS = 24 * 60 * 60_000;
/** Runner output that means "the agent is out of tokens/requests", not "the task is bad".
 * Vendors expose no quota API, so exhaustion is detected from the failure text. */
export const RATE_LIMIT_RE = /rate.?limit|too many requests|\b429\b|quota|usage limit|exhaust/i;

/** One-shot startup handshake: warn (never block) when server and worker drift by
 * major.minor. Pre-0.7 servers have no version in /health — silently skipped. */
export async function checkServerVersion(
  mcpUrl: string,
  out: Writer,
  f: typeof fetch = fetch,
): Promise<void> {
  try {
    const res = await f(new URL(mcpUrl).origin + "/health");
    if (!res.ok) return;
    const version = ((await res.json()) as { version?: string }).version;
    if (!version) return;
    const mm = (v: string) => v.split(".").slice(0, 2).join(".");
    if (mm(version) !== mm(TOWER_VERSION)) {
      out(
        `⚠ version drift: server ${version} vs worker ${TOWER_VERSION} — ` +
          `upgrade the older side (npm i -g tower-mcp@latest)`,
      );
    }
  } catch {
    // best-effort probe; a worker must start even if the server is briefly down
  }
}

interface TaskApi {
  listOpen(): Promise<DelegatedTask[]>;
  accept(taskId: string): Promise<boolean>;
  requestApproval(taskId: string): Promise<boolean>;
  heartbeat(status: WorkerStatus): Promise<void>;
  /** Pinned team rules (decisions tagged "rule") — prepended to every task prompt. */
  rules(): Promise<GetDecisionsOutput["decisions"]>;
  complete(input: {
    taskId: string;
    success: boolean;
    result: string;
    commitSha?: string;
    prUrl?: string;
  }): Promise<void>;
}

/** Task operations against the hosted Tower (TOWER_URL) or the local repo store. */
function taskApi(cwd: string, opts: WorkerOptions, build?: BuildOptions): TaskApi {
  const remote = remoteConfig();
  if (remote) {
    return {
      listOpen: async () =>
        (
          (await withRemote(remote, (call) =>
            call("list_tasks", { status: "open", forAgentId: opts.agentId, repo: opts.repo }),
          )) as ListTasksOutput
        ).tasks,
      accept: async (taskId) =>
        (
          (await withRemote(remote, (call) =>
            call("accept_task", { taskId, agentId: opts.agentId }),
          )) as AcceptTaskOutput
        ).ok,
      requestApproval: async (taskId) =>
        (
          (await withRemote(remote, (call) =>
            call("request_approval", { taskId, agentId: opts.agentId }),
          )) as OkOutput
        ).ok,
      heartbeat: async (status) => {
        (await withRemote(remote, (call) =>
          call("heartbeat_worker", {
            agentId: opts.agentId,
            repo: opts.repo,
            runner: opts.runner,
            status,
          }),
        )) as OkOutput;
      },
      rules: async () =>
        (
          (await withRemote(remote, (call) =>
            call("get_decisions", { tags: ["rule"] }),
          )) as GetDecisionsOutput
        ).decisions,
      complete: async (input) => {
        (await withRemote(remote, (call) =>
          call("complete_task", { ...input, agentId: opts.agentId }),
        )) as OkOutput;
      },
    };
  }
  const local = <T>(fn: (svc: ReturnType<typeof buildService>) => T): T => {
    const svc = buildService(cwd, build);
    try {
      return fn(svc);
    } finally {
      svc.store.close();
    }
  };
  return {
    listOpen: async () =>
      local((svc) => svc.listTasks({ status: "open", forAgentId: opts.agentId, repo: opts.repo }))
        .tasks,
    accept: async (taskId) => local((svc) => svc.acceptTask({ taskId, agentId: opts.agentId })).ok,
    requestApproval: async (taskId) =>
      local((svc) => svc.requestApproval({ taskId, agentId: opts.agentId })).ok,
    heartbeat: async (status) => {
      local((svc) =>
        svc.heartbeatWorker({
          agentId: opts.agentId,
          repo: opts.repo,
          runner: opts.runner,
          status,
        }),
      );
    },
    rules: async () => local((svc) => svc.getDecisions({ tags: ["rule"] })).decisions,
    complete: async (input) => {
      local((svc) => svc.completeTask({ ...input, agentId: opts.agentId }));
    },
  };
}

/** One accepted task, end to end: branch → run agent → commit → push/PR → complete. */
async function runTask(
  cwd: string,
  opts: WorkerOptions,
  api: TaskApi,
  task: DelegatedTask,
  out: Writer,
  onFailureOutput?: (runOut: string) => void,
): Promise<void> {
  const exec = opts.exec ?? defaultExec;
  const git = (...args: string[]) => exec("git", args, { cwd });
  const id8 = task.id.slice(0, 8);
  const branch = `${opts.branchPrefix ?? "tower/task-"}${id8}`;
  const fail = async (result: string): Promise<void> => {
    await api.complete({ taskId: task.id, success: false, result });
    out(`❌ task ${id8} failed — ${result}`);
  };

  const status = await git("status", "--porcelain");
  if (status.out.trim() !== "") {
    return fail("working tree dirty — refusing to run (commit or stash first)");
  }
  const orig = (await git("rev-parse", "--abbrev-ref", "HEAD")).out.trim() || "main";
  await git("checkout", "-b", branch);
  const restore = () => git("checkout", orig);

  // Pinned team rules ride every prompt — phone-editable guardrails, no git commit.
  let rulesHeader = "";
  try {
    const rules = (await api.rules()).slice(0, 10);
    if (rules.length) {
      rulesHeader =
        "Team rules (follow these strictly):\n" +
        rules.map((r) => `- ${r.title}${r.body ? `: ${r.body}` : ""}`).join("\n") +
        "\n\n---\n\n";
    }
  } catch {
    // rules are best-effort — a fetch failure must not block the task
  }
  const prompt =
    rulesHeader +
    `${task.body}\n\n` +
    `(You are completing a task delegated via Tower by agent "${task.fromAgentId}". ` +
    `Work only within this repository; make the change complete and keep tests green.)`;
  const runner = runnerCommand(opts, prompt);
  const timeoutMs = (opts.maxMinutes ?? 15) * 60_000;
  const run = await exec(runner.cmd, runner.args, {
    cwd,
    timeoutMs,
    ...(runner.input != null ? { input: runner.input } : {}),
    ...(runner.shell ? { shell: true } : {}),
  });

  if (run.timedOut) {
    await git("reset", "--hard");
    await restore();
    onFailureOutput?.(run.out);
    return fail(`runner timed out after ${opts.maxMinutes ?? 15}m — ${tail(run.out)}`);
  }
  if (run.code !== 0) {
    await git("reset", "--hard");
    await restore();
    onFailureOutput?.(run.out);
    return fail(`runner exited ${run.code} — ${tail(run.out)}`);
  }

  await git("add", "-A");
  const staged = await git("diff", "--cached", "--quiet");
  const notes: string[] = [];
  let commitSha: string | undefined;
  let prUrl: string | undefined;

  if (staged.code !== 0) {
    const title = task.body.split("\n")[0]!.slice(0, 60);
    await git("commit", "-m", `tower task ${id8}: ${title}`);
    commitSha = (await git("rev-parse", "HEAD")).out.trim();
    if (opts.push ?? true) {
      const push = await git("push", "-u", "origin", branch);
      if (push.code !== 0) {
        notes.push(`push failed: ${tail(push.out).slice(0, 200)}`);
      } else if (opts.pr ?? true) {
        const pr = await exec(
          "gh",
          [
            "pr",
            "create",
            "--title",
            `tower task ${id8}: ${title}`,
            "--body",
            `Delegated via Tower by ${task.fromAgentId}. Task ${task.id}.`,
            "--head",
            branch,
          ],
          { cwd, timeoutMs: 60_000 },
        );
        prUrl = pr.code === 0 ? /https:\/\/\S+/.exec(pr.out)?.[0] : undefined;
      }
    }
  } else {
    notes.push("runner finished with no file changes");
  }
  await restore();

  const result = [...notes, tail(run.out)].filter(Boolean).join(" — ") || "done";
  await api.complete({
    taskId: task.id,
    success: true,
    result,
    ...(commitSha ? { commitSha } : {}),
    ...(prUrl ? { prUrl } : {}),
  });
  out(
    `✅ task ${id8} done — branch ${branch}` +
      (commitSha ? ` @ ${commitSha.slice(0, 7)}` : "") +
      (prUrl ? ` · ${prUrl}` : ""),
  );
}

/**
 * The worker daemon behind `tower work`: polls for delegated tasks addressed to this
 * agent, confirms (unless --auto), accepts first-wins, runs the local coding agent
 * headlessly on an isolated branch, pushes/PRs, and reports the outcome back.
 */
export async function cmdWork(
  cwd: string,
  opts: WorkerOptions,
  out: Writer,
  build?: BuildOptions,
): Promise<void> {
  const remote = remoteConfig();
  out(
    `tower work — agent ${opts.agentId} on ${opts.repo} · runner ${opts.runner} · ` +
      `${opts.auto ? "AUTO (no per-task confirmation)" : "CONFIRM each task"} · ` +
      `allow-from ${opts.allowFrom?.join(",") ?? "anyone"} · server ${remote?.url ?? "local"}`,
  );
  if (opts.runner === "cmd" && !opts.cmdTemplate) {
    out(`runner "cmd" needs --cmd "<command>" (it receives the task prompt on stdin).`);
    return;
  }
  if (opts.runner === "cmd" && opts.cmdTemplate?.includes("{{task}}")) {
    // Refuse rather than silently run with a literal "{{task}}": substitution was
    // removed because splicing task text into a shell string is command injection.
    out(
      `--cmd no longer substitutes {{task}} (command-injection risk). ` +
        `Your command now receives the task prompt on STDIN — drop {{task}} and read stdin.`,
    );
    return;
  }
  const ask = opts.ask;
  if (!opts.auto && !opts.remoteApprove && !ask && !process.stdin.isTTY) {
    out("No terminal to confirm tasks on — pass --auto or --approve remote (see docs/worker.md).");
    return;
  }
  if (remote) await checkServerVersion(remote.url, out);

  const api = taskApi(cwd, opts, build);
  const intervalMs = opts.intervalMs ?? 15_000;
  const stopFile = join(cwd, ".tower", "STOP");

  // Self-reported capacity: vendors expose no "tokens remaining" API, so the worker
  // watches its own failures. A rate-limit-looking failure → 10-min cooldown; over
  // --budget → "low" until the 24h window frees. Low = heartbeat says so + accept nothing.
  const now = opts.now ?? Date.now;
  let cooldownUntil = 0;
  const startedAt: number[] = [];
  const overBudget = (): boolean => {
    if (opts.budget == null) return false;
    const cutoff = now() - BUDGET_WINDOW_MS;
    while (startedAt.length && startedAt[0]! < cutoff) startedAt.shift();
    return startedAt.length >= opts.budget;
  };
  const capacity = (): WorkerStatus => (now() < cooldownUntil || overBudget() ? "low" : "ok");
  const noteRunFailure = (runOut: string): void => {
    if (!RATE_LIMIT_RE.test(runOut)) return;
    cooldownUntil = now() + COOLDOWN_MS;
    out(
      `⚠ capacity low — rate limit in runner output; cooling down until ` +
        new Date(cooldownUntil).toLocaleTimeString(),
    );
  };
  let wasLow = false;

  // Presence must not flap while a long task runs (runTask can hold the loop for
  // minutes; the online window is 30s) — heartbeat on a timer, independent of ticks.
  const hb = setInterval(() => {
    api.heartbeat(capacity()).catch(() => {});
  }, 15_000);
  hb.unref();
  try {
    for (let tick = 0; opts.ticks == null || tick < opts.ticks; tick++) {
      if (tick > 0) await new Promise((r) => setTimeout(r, intervalMs));
      if (existsSync(stopFile)) {
        // Kill switch: `touch .tower/STOP` (or create the file from any editor) and the
        // daemon stops accepting work. Delete the file to allow a restart.
        out(`🛑 ${stopFile} exists — worker stopping. Delete the file to run again.`);
        return;
      }
      try {
        await api.heartbeat(capacity()); // presence + self-reported capacity for the board
        const low = capacity() === "low";
        if (low && !wasLow) {
          out(
            overBudget()
              ? `⏸ budget reached (${opts.budget} task(s)/24h) — not accepting more until the window frees`
              : `⏸ capacity low — not accepting tasks during cooldown`,
          );
        }
        wasLow = low;
        if (low) continue; // heartbeat still reports "low"; accept nothing until it clears
        const candidates = (await api.listOpen())
          .filter((t) => !opts.allowFrom || opts.allowFrom.includes(t.fromAgentId))
          .sort((a, b) => a.createdAt - b.createdAt);

        // Remote-approve: a human OKs each task from the board/phone. Park un-parked
        // tasks, ignore rejected ones, and only run once approved.
        if (opts.remoteApprove) {
          const approved = candidates.find((t) => t.approval === "approved");
          if (approved) {
            if (await api.accept(approved.id)) {
              startedAt.push(now());
              await runTask(cwd, opts, api, approved, out, noteRunFailure);
            }
            continue;
          }
          const unparked = candidates.find((t) => t.approval == null);
          if (unparked && (await api.requestApproval(unparked.id))) {
            out(
              `⏸ task ${unparked.id.slice(0, 8)} from ${unparked.fromAgentId} — awaiting approval on the board`,
            );
          }
          continue; // pending/rejected tasks just wait
        }

        const task = candidates[0];
        if (!task) continue;

        if (!opts.auto && ask) {
          const answer = await ask(
            `Run task ${task.id.slice(0, 8)} from ${task.fromAgentId}: ` +
              `"${task.body.slice(0, 80)}"? [y/N]: `,
          );
          if (!/^y(es)?$/i.test(answer.trim())) {
            out(`skipped task ${task.id.slice(0, 8)} (answered no)`);
            continue;
          }
        }
        if (!(await api.accept(task.id))) continue; // someone else won the race
        startedAt.push(now());
        await runTask(cwd, opts, api, task, out, noteRunFailure);
      } catch (err) {
        out(`worker error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    clearInterval(hb);
  }
}
