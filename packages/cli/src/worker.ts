import { execFile } from "node:child_process";
import type { DelegatedTask, ListTasksOutput, AcceptTaskOutput, OkOutput } from "@tower/shared";
import { remoteConfig, withRemote } from "./remote.js";
import { buildService, type BuildOptions } from "./lib.js";
import type { Writer } from "./commands.js";

/** Shell-out contract; injectable so tests can fake runners and failures. */
export type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
) => Promise<{ code: number; out: string; timedOut?: boolean }>;

/** execFile-based Exec that never throws: captures stdout+stderr, exit code, timeouts. */
export const defaultExec: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" } : {}),
        // cmd.exe needs verbatim args or Node's quoting breaks `/c <template>`.
        windowsVerbatimArguments: cmd === "cmd",
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const out = `${stdout ?? ""}${stderr ?? ""}`;
        if (!err) return resolve({ code: 0, out });
        const timedOut = Boolean(err.killed || err.signal === "SIGKILL");
        const code = typeof err.code === "number" ? err.code : 1;
        resolve({ code: code === 0 ? 1 : code, out, timedOut });
      },
    );
  });

export interface WorkerOptions {
  /** Whose inbox this worker drains. */
  agentId: string;
  repo: string;
  runner: "claude" | "codex" | "cmd";
  /** runner "cmd": local shell template; `{{task}}` is replaced with the prompt. */
  cmdTemplate?: string;
  intervalMs?: number;
  /** Skip per-task confirmation. Required to run without a TTY. */
  auto?: boolean;
  /** Only accept tasks sent by these agent ids. */
  allowFrom?: string[];
  maxMinutes?: number;
  branchPrefix?: string;
  push?: boolean;
  pr?: boolean;
  /** Tests: stop after N poll cycles (default: run forever). */
  ticks?: number;
  exec?: Exec;
  ask?: (q: string) => Promise<string>;
}

export interface RunnerCmd {
  cmd: string;
  args: string[];
  /** Windows cmd.exe templates must be passed through unquoted. */
  verbatim?: boolean;
}

/** The headless command for each runner. Exported for tests and docs honesty. */
export function runnerCommand(
  opts: WorkerOptions,
  prompt: string,
  platform: NodeJS.Platform = process.platform,
): RunnerCmd {
  if (opts.runner === "claude") {
    return { cmd: "claude", args: ["-p", prompt, "--permission-mode", "acceptEdits"] };
  }
  if (opts.runner === "codex") {
    return { cmd: "codex", args: ["exec", "--full-auto", prompt] };
  }
  const full = (opts.cmdTemplate ?? "").replaceAll("{{task}}", prompt);
  return platform === "win32"
    ? { cmd: "cmd", args: ["/d", "/s", "/c", full], verbatim: true }
    : { cmd: "sh", args: ["-c", full] };
}

const TAIL_CHARS = 2000;
const tail = (s: string): string => s.slice(-TAIL_CHARS).trim();

interface TaskApi {
  listOpen(): Promise<DelegatedTask[]>;
  accept(taskId: string): Promise<boolean>;
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

  const prompt =
    `${task.body}\n\n` +
    `(You are completing a task delegated via Tower by agent "${task.fromAgentId}". ` +
    `Work only within this repository; make the change complete and keep tests green.)`;
  const runner = runnerCommand(opts, prompt);
  const timeoutMs = (opts.maxMinutes ?? 15) * 60_000;
  const run = await exec(runner.cmd, runner.args, { cwd, timeoutMs });

  if (run.timedOut) {
    await git("reset", "--hard");
    await restore();
    return fail(`runner timed out after ${opts.maxMinutes ?? 15}m — ${tail(run.out)}`);
  }
  if (run.code !== 0) {
    await git("reset", "--hard");
    await restore();
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
    out(`runner "cmd" needs --cmd "<template with {{task}}>" — nothing to run.`);
    return;
  }
  const ask = opts.ask;
  if (!opts.auto && !ask && !process.stdin.isTTY) {
    out("No terminal to confirm tasks on — pass --auto to run unattended (see docs/worker.md).");
    return;
  }

  const api = taskApi(cwd, opts, build);
  const intervalMs = opts.intervalMs ?? 15_000;
  for (let tick = 0; opts.ticks == null || tick < opts.ticks; tick++) {
    if (tick > 0) await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const open = (await api.listOpen())
        .filter((t) => !opts.allowFrom || opts.allowFrom.includes(t.fromAgentId))
        .sort((a, b) => a.createdAt - b.createdAt);
      const task = open[0];
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
      await runTask(cwd, opts, api, task, out);
    } catch (err) {
      out(`worker error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
