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
  type ClaimArgs,
} from "./commands.js";

const HELP = `Tower — air-traffic control for AI agents editing a shared repo.

Usage: tower <command> [options]

Commands:
  init                       Write .tower/policy.yaml + print MCP setup
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
