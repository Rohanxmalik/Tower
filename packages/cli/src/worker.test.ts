import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DelegatedTask } from "@tower/shared";
import { cmdWork, defaultExec, runnerCommand, type WorkerOptions, type Exec } from "./worker.js";
import { buildService } from "./lib.js";

const REPO = "team/app";

let dir: string;
let savedUrl: string | undefined;
let savedToken: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tower-work-"));
  savedUrl = process.env.TOWER_URL;
  savedToken = process.env.TOWER_TOKEN;
  delete process.env.TOWER_URL; // worker tests always run against the local store
  delete process.env.TOWER_TOKEN;
});
afterEach(() => {
  if (savedUrl !== undefined) process.env.TOWER_URL = savedUrl;
  if (savedToken !== undefined) process.env.TOWER_TOKEN = savedToken;
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function collect(): { out: (l: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { out: (l) => lines.push(l), lines };
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: dir }).toString().trim();
}

/** A real repo on `main` with committed helper scripts; `.tower/` is git-ignored. */
function initRepo(): void {
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "worker@test.local"]);
  git(["config", "user.name", "worker"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, ".gitignore"), ".tower/\n");
  writeFileSync(join(dir, "script.cjs"), "require('fs').writeFileSync('out.txt','done')\n");
  writeFileSync(join(dir, "noop.cjs"), "// touches nothing\n");
  writeFileSync(join(dir, "fail.cjs"), "process.exit(3)\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
}

/** Seed a delegated task the way the MCP tool does: send_message with kind "task". */
function seedTask(from: string, to: string, body: string): string {
  const svc = buildService(dir);
  const { id } = svc.sendMessage({
    fromAgentId: from,
    toAgentId: to,
    repo: REPO,
    body,
    kind: "task",
  });
  svc.store.close();
  return id;
}

function taskById(id: string): DelegatedTask | undefined {
  const svc = buildService(dir);
  const task = svc.listTasks({}).tasks.find((t) => t.id === id);
  svc.store.close();
  return task;
}

const baseOpts: WorkerOptions = {
  agentId: "bob",
  repo: REPO,
  runner: "cmd",
  cmdTemplate: "node script.cjs",
  intervalMs: 1,
  ticks: 1,
  auto: true,
  push: false,
  pr: false,
};

describe("cmdWork (worker daemon)", () => {
  it("accepts an open task, runs the agent, commits on a branch, and completes it", async () => {
    initRepo();
    const id = seedTask("alice", "bob", "write out.txt so we know the worker ran");
    const id8 = id.slice(0, 8);

    const { out, lines } = collect();
    await cmdWork(dir, baseOpts, out);

    const task = taskById(id);
    expect(task?.status).toBe("done");
    expect(task?.assigneeAgentId).toBe("bob");
    expect(task?.commitSha).toBe(git(["rev-parse", `tower/task-${id8}`]));

    // the work branch exists and its commit contains out.txt
    const shown = git(["show", "--name-only", "--pretty=format:", `tower/task-${id8}`]);
    expect(shown).toContain("out.txt");
    // original branch was restored
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");

    // the delegator got a task_update closing the loop
    const svc = buildService(dir);
    const inbox = svc.fetchMessages({ agentId: "alice", unreadOnly: true }).messages;
    svc.store.close();
    expect(inbox.some((m) => m.kind === "task_update" && m.replyTo === id)).toBe(true);

    expect(lines.join("\n")).toContain("✅");
  });

  it("prints a startup banner with agent, repo, runner, mode, and server", async () => {
    initRepo();
    const { out, lines } = collect();
    await cmdWork(dir, baseOpts, out);
    const text = lines.join("\n");
    expect(text).toContain("bob");
    expect(text).toContain(REPO);
    expect(text).toContain("cmd");
    expect(text).toContain("AUTO");
    expect(text).toContain("local");
  });

  it("leaves tasks from non-allowed agents untouched", async () => {
    initRepo();
    const id = seedTask("mallory", "bob", "please run something sketchy");
    const { out } = collect();
    await cmdWork(dir, { ...baseOpts, allowFrom: ["alice"] }, out);
    expect(taskById(id)?.status).toBe("open");
    expect(git(["branch", "--list", "tower/task-*"])).toBe("");
  });

  it("refuses to run on a dirty working tree and fails the task with a clear result", async () => {
    initRepo();
    const id = seedTask("alice", "bob", "do the thing");
    writeFileSync(join(dir, "stray.txt"), "uncommitted");
    const { out, lines } = collect();
    await cmdWork(dir, baseOpts, out);
    const task = taskById(id);
    expect(task?.status).toBe("failed");
    expect(task?.result).toContain("dirty");
    expect(lines.join("\n")).toContain("❌");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  it("marks the task failed when the runner exits non-zero", async () => {
    initRepo();
    const id = seedTask("alice", "bob", "this one blows up");
    const { out } = collect();
    await cmdWork(dir, { ...baseOpts, cmdTemplate: "node fail.cjs" }, out);
    const task = taskById(id);
    expect(task?.status).toBe("failed");
    expect(task?.result).toContain("exited");
    expect(task?.commitSha).toBeUndefined();
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  it("succeeds with a note when the runner makes no file changes", async () => {
    initRepo();
    const id = seedTask("alice", "bob", "a task that changes nothing");
    const { out } = collect();
    await cmdWork(dir, { ...baseOpts, cmdTemplate: "node noop.cjs" }, out);
    const task = taskById(id);
    expect(task?.status).toBe("done");
    expect(task?.commitSha).toBeUndefined();
    expect(task?.result).toContain("no file changes");
  });

  it("treats a runner timeout as failure with a clear result", async () => {
    initRepo();
    const id = seedTask("alice", "bob", "a task that runs forever");
    const exec: Exec = (cmd, args, opts) =>
      cmd === "git"
        ? defaultExec(cmd, args, opts)
        : Promise.resolve({ code: 1, out: "killed", timedOut: true });
    const { out } = collect();
    await cmdWork(dir, { ...baseOpts, maxMinutes: 1, exec }, out);
    const task = taskById(id);
    expect(task?.status).toBe("failed");
    expect(task?.result).toContain("timed out");
  });

  it("notes a failed push in the result without failing the task", async () => {
    initRepo(); // no origin remote → push must fail
    const id = seedTask("alice", "bob", "write out.txt");
    const { out } = collect();
    await cmdWork(dir, { ...baseOpts, push: true, pr: false }, out);
    const task = taskById(id);
    expect(task?.status).toBe("done");
    expect(task?.commitSha).toBeTruthy();
    expect(task?.result).toContain("push failed");
    expect(task?.prUrl).toBeUndefined();
  });

  it("refuses to start unattended without --auto (non-TTY, no ask) and leaves tasks open", async () => {
    initRepo();
    const id = seedTask("alice", "bob", "should never run");
    const { out, lines } = collect();
    await cmdWork(dir, { ...baseOpts, auto: false }, out);
    expect(lines.join("\n")).toContain("--auto");
    expect(taskById(id)?.status).toBe("open");
  });

  it("asks before each task in confirm mode and skips on a non-yes answer", async () => {
    initRepo();
    const id = seedTask("alice", "bob", "needs a human to say yes");
    const questions: string[] = [];
    const ask = (q: string): Promise<string> => {
      questions.push(q);
      return Promise.resolve("n");
    };
    const { out, lines } = collect();
    await cmdWork(dir, { ...baseOpts, auto: false, ask }, out);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain(id.slice(0, 8));
    expect(questions[0]).toContain("alice");
    expect(taskById(id)?.status).toBe("open");
    expect(lines.join("\n").toLowerCase()).toContain("skip");
  });

  it("runs the task when the confirmation answer is yes", async () => {
    initRepo();
    const id = seedTask("alice", "bob", "confirmed work");
    const { out } = collect();
    await cmdWork(dir, { ...baseOpts, auto: false, ask: () => Promise.resolve("y") }, out);
    expect(taskById(id)?.status).toBe("done");
  });

  it("skips quietly when another agent already accepted the task", async () => {
    initRepo();
    const id = seedTask("alice", "*", "broadcast task");
    const svc = buildService(dir);
    expect(svc.acceptTask({ taskId: id, agentId: "carol" }).ok).toBe(true);
    svc.store.close();
    const { out, lines } = collect();
    await cmdWork(dir, baseOpts, out);
    const task = taskById(id);
    expect(task?.status).toBe("accepted");
    expect(task?.assigneeAgentId).toBe("carol");
    expect(lines.join("\n")).not.toContain("✅");
  });

  it("processes the oldest open task first (list is newest-first)", async () => {
    initRepo();
    const first = seedTask("alice", "bob", "older task");
    const second = seedTask("alice", "bob", "newer task");
    const { out } = collect();
    await cmdWork(dir, baseOpts, out);
    expect(taskById(first)?.status).toBe("done");
    expect(taskById(second)?.status).toBe("open");
  });

  it("errors out when runner is cmd but no --cmd template was given", async () => {
    initRepo();
    const id = seedTask("alice", "bob", "no template");
    const { out, lines } = collect();
    const opts: WorkerOptions = { ...baseOpts };
    delete opts.cmdTemplate;
    await cmdWork(dir, opts, out);
    expect(lines.join("\n")).toContain("--cmd");
    expect(taskById(id)?.status).toBe("open");
  });

  it("keeps polling after a task-level error", async () => {
    initRepo();
    seedTask("alice", "bob", "will explode in exec");
    const exec: Exec = () => Promise.reject(new Error("exec exploded"));
    const { out, lines } = collect();
    // 2 ticks: the first hits the exec error, the second must still poll.
    await cmdWork(dir, { ...baseOpts, ticks: 2, exec }, out);
    expect(lines.join("\n")).toContain("exec exploded");
  });
});

describe("runnerCommand", () => {
  it("builds the claude headless command", () => {
    const c = runnerCommand({ ...baseOpts, runner: "claude" }, "do it");
    expect(c.cmd).toBe("claude");
    expect(c.args).toEqual(["-p", "do it", "--permission-mode", "acceptEdits"]);
  });

  it("builds the codex headless command", () => {
    const c = runnerCommand({ ...baseOpts, runner: "codex" }, "do it");
    expect(c.cmd).toBe("codex");
    expect(c.args).toEqual(["exec", "--full-auto", "do it"]);
  });

  it("substitutes {{task}} into the cmd template and uses the platform shell", () => {
    const opts = { ...baseOpts, cmdTemplate: "runner {{task}}" };
    const posix = runnerCommand(opts, "the prompt", "linux");
    expect(posix).toEqual({ cmd: "sh", args: ["-c", "runner the prompt"] });
    const win = runnerCommand(opts, "the prompt", "win32");
    expect(win.cmd).toBe("cmd");
    expect(win.args).toEqual(["/d", "/s", "/c", "runner the prompt"]);
    expect(win.verbatim).toBe(true);
  });
});

describe("defaultExec", () => {
  it("captures output and exit code without throwing", async () => {
    const ok = await defaultExec("git", ["--version"], { cwd: dir });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("git version");
    const missing = await defaultExec("definitely-not-a-real-command-xyz", [], { cwd: dir });
    expect(missing.code).not.toBe(0);
  });
});
