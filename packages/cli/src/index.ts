import { parseArgs } from "node:util";
import {
  cmdInit,
  cmdClaim,
  cmdGuard,
  cmdStatus,
  cmdServe,
  cmdWatch,
  cmdComplete,
  cmdNextTask,
  cmdSend,
  cmdInbox,
  cmdSetup,
  gatherSendArgs,
  gitDefaults,
  type ClaimArgs,
  type SendArgs,
} from "./commands.js";
import { cmdWork, type WorkerOptions } from "./worker.js";

const HELP = `Tower — air-traffic control for AI agents editing a shared repo.

Usage: tower <command> [options]

Commands:
  init                       Write .tower/policy.yaml + print MCP setup
  setup [--url <https://...>] [--token t] [--hooks]   One-command onboarding: .mcp.json + rules + git hooks
  serve [--http] [--port n] [--token t]   Start the coordination server
  status                     Show active claims
  watch                      Live-poll active claims
  complete --claim <id> [--sha <sha>]     Complete a claim (used by the git hook)
  claim --agent <id> --repo <r> [--branch b] [--file p]... [--symbol path#name]... [--purpose s] [--eta m]
                             Register an edit intent and print any collisions
  guard <same args as claim> [--force]
                             Enforcement: exit 2 (blocked) on a hard collision, else claim.
                             --force claims anyway (the [f] option). Used by the PreToolUse hook.
  next-task --agent <id> --repo <r>
                             The [d] option: a module that's safe to start right now
                             (needs modules in .tower/policy.yaml)
  send                       Message another agent — just run it; it asks the rest.
                             (--from/--repo are inferred from git; flags for scripts:
                              --to <id|*> --body <text> [--task] [--reply-to <id>])
  inbox [--agent <id>]       Read your messages (marks them read; agent inferred from git)
  work [--auto | --approve remote] [--runner claude|codex|cmd] [--allow-from a,b]
                             Worker daemon: picks up delegated tasks, runs your local
                             agent headlessly, commits on a branch, opens a PR, reports
                             back. Confirms each task in the terminal by default; --auto
                             runs unattended; --approve remote waits for a board/phone tap.

Run with no command to print this help.`;

function toNum(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse the shared claim/guard options, or return null after printing an error. */
function parseClaimArgs(rest: string[]): ClaimArgs | null {
  const { values } = parseArgs({
    args: rest,
    options: {
      agent: { type: "string" },
      repo: { type: "string" },
      branch: { type: "string" },
      file: { type: "string", multiple: true },
      symbol: { type: "string", multiple: true },
      purpose: { type: "string" },
      eta: { type: "string" },
      force: { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (!values.agent || !values.repo) {
    process.stderr.write("requires --agent and --repo\n");
    return null;
  }
  return {
    agentId: values.agent,
    repo: values.repo,
    branch: values.branch ?? "main",
    files: values.file ?? [],
    symbols: values.symbol ?? [],
    purpose: values.purpose ?? "",
    ...(toNum(values.eta) != null ? { etaMinutes: toNum(values.eta)! } : {}),
    ...(values.force ? { force: true } : {}),
  };
}

export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const cwd = process.cwd();

  switch (command) {
    case "init":
      cmdInit(cwd);
      return 0;

    case "setup": {
      const { values } = parseArgs({
        args: rest,
        options: {
          url: { type: "string" },
          token: { type: "string" },
          hooks: { type: "boolean" },
        },
        allowPositionals: false,
      });
      cmdSetup(cwd, {
        ...(values.url ? { url: values.url } : {}),
        ...(values.token ? { token: values.token } : {}),
        ...(values.hooks ? { hooks: true } : {}),
      });
      return 0;
    }

    case "status":
      await cmdStatus(cwd);
      return 0;

    case "watch":
      await cmdWatch(cwd);
      return 0;

    case "complete": {
      const { values } = parseArgs({
        args: rest,
        options: { claim: { type: "string" }, sha: { type: "string" } },
        allowPositionals: false,
      });
      if (!values.claim) {
        process.stderr.write("complete requires --claim <id>\n");
        return 1;
      }
      const ok = await cmdComplete(cwd, values.claim, values.sha);
      return ok ? 0 : 1;
    }

    case "serve": {
      const { values } = parseArgs({
        args: rest,
        options: {
          http: { type: "boolean" },
          port: { type: "string" },
          token: { type: "string" },
          host: { type: "string" },
        },
        allowPositionals: false,
      });
      await cmdServe(cwd, {
        http: values.http ?? false,
        ...(toNum(values.port) != null ? { port: toNum(values.port)! } : {}),
        ...(values.token ? { token: values.token } : {}),
        ...(values.host ? { host: values.host } : {}),
      });
      return 0;
    }

    case "claim": {
      const args = parseClaimArgs(rest);
      if (!args) return 1;
      const hardConflict = await cmdClaim(cwd, args);
      return hardConflict ? 2 : 0;
    }

    case "guard": {
      const args = parseClaimArgs(rest);
      if (!args) return 1;
      const blocked = await cmdGuard(cwd, args);
      return blocked ? 2 : 0;
    }

    case "next-task": {
      const { values } = parseArgs({
        args: rest,
        options: { agent: { type: "string" }, repo: { type: "string" } },
        allowPositionals: false,
      });
      if (!values.agent || !values.repo) {
        process.stderr.write("next-task requires --agent and --repo\n");
        return 1;
      }
      await cmdNextTask(cwd, { agentId: values.agent, repo: values.repo });
      return 0;
    }

    case "send": {
      const { values } = parseArgs({
        args: rest,
        options: {
          from: { type: "string" },
          to: { type: "string" },
          repo: { type: "string" },
          body: { type: "string" },
          task: { type: "boolean" },
          "reply-to": { type: "string" },
        },
        allowPositionals: false,
      });
      const partial: Partial<SendArgs> = {
        ...(values.from ? { from: values.from } : {}),
        ...(values.to ? { to: values.to } : {}),
        ...(values.repo ? { repo: values.repo } : {}),
        ...(values.body ? { body: values.body } : {}),
        ...(values.task !== undefined ? { task: values.task } : {}),
        ...(values["reply-to"] ? { replyTo: values["reply-to"] } : {}),
      };
      const interactive = process.stdin.isTTY && (!partial.to || !partial.body);
      if (!interactive && (!partial.to || !partial.body)) {
        // Non-TTY (hooks/CI/agents) must never hang on a prompt.
        process.stderr.write("send requires --to and --body (from/repo are inferred from git)\n");
        return 1;
      }
      const defaults = gitDefaults(cwd);
      let full: SendArgs;
      if (interactive) {
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          full = await gatherSendArgs(partial, { ...defaults, ask: (q) => rl.question(q) });
        } finally {
          rl.close();
        }
      } else {
        full = {
          from: partial.from ?? defaults.defaultFrom,
          to: partial.to!,
          repo: partial.repo ?? defaults.defaultRepo,
          body: partial.body!,
          ...(partial.task !== undefined ? { task: partial.task } : {}),
          ...(partial.replyTo ? { replyTo: partial.replyTo } : {}),
        };
      }
      await cmdSend(cwd, full);
      return 0;
    }

    case "work": {
      const { values } = parseArgs({
        args: rest,
        options: {
          agent: { type: "string" },
          repo: { type: "string" },
          runner: { type: "string" },
          cmd: { type: "string" },
          interval: { type: "string" },
          auto: { type: "boolean" },
          approve: { type: "string" },
          "allow-from": { type: "string" },
          "max-minutes": { type: "string" },
          "no-push": { type: "boolean" },
          "no-pr": { type: "boolean" },
        },
        allowPositionals: false,
      });
      const runner = values.runner ?? "claude";
      if (runner !== "claude" && runner !== "codex" && runner !== "cmd") {
        process.stderr.write(`unknown --runner "${runner}" (claude | codex | cmd)\n`);
        return 1;
      }
      if (values.approve != null && values.approve !== "remote") {
        // A typo here must not silently fall back to terminal-confirm mode.
        process.stderr.write(`unknown --approve "${values.approve}" (only: remote)\n`);
        return 1;
      }
      const defaults = gitDefaults(cwd);
      const opts: WorkerOptions = {
        agentId: values.agent ?? defaults.defaultFrom,
        repo: values.repo ?? defaults.defaultRepo,
        runner,
        ...(values.cmd ? { cmdTemplate: values.cmd } : {}),
        ...(toNum(values.interval) != null ? { intervalMs: toNum(values.interval)! * 1000 } : {}),
        ...(values.auto ? { auto: true } : {}),
        ...(values.approve === "remote" ? { remoteApprove: true } : {}),
        ...(values["allow-from"]
          ? { allowFrom: values["allow-from"].split(",").map((s) => s.trim()) }
          : {}),
        ...(toNum(values["max-minutes"]) != null
          ? { maxMinutes: toNum(values["max-minutes"])! }
          : {}),
        ...(values["no-push"] ? { push: false } : {}),
        ...(values["no-pr"] ? { pr: false } : {}),
      };
      if (!opts.auto && !opts.remoteApprove && process.stdin.isTTY) {
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          await cmdWork(cwd, { ...opts, ask: (q) => rl.question(q) }, (l) =>
            process.stdout.write(l + "\n"),
          );
        } finally {
          rl.close();
        }
      } else {
        await cmdWork(cwd, opts, (l) => process.stdout.write(l + "\n"));
      }
      return 0;
    }

    case "inbox": {
      const { values } = parseArgs({
        args: rest,
        options: { agent: { type: "string" }, repo: { type: "string" } },
        allowPositionals: false,
      });
      // No --agent? Use the same identity `send` would (TOWER_AGENT / git user.name).
      const agentId = values.agent ?? gitDefaults(cwd).defaultFrom;
      await cmdInbox(cwd, {
        agentId,
        ...(values.repo ? { repo: values.repo } : {}),
      });
      return 0;
    }

    default:
      process.stdout.write(HELP + "\n");
      return command ? 1 : 0;
  }
}

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`tower: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
