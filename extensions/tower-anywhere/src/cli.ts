import { parseArgs } from "node:util";
import { connectionFromEnv, withTower, type ToolCall } from "./client.js";
import { claim, guard, type ClaimArgs, type Writer } from "./claim.js";

export const HELP = `tower-anywhere — claim before you edit, for work that isn't code.

Same collision detection Tower gives coding agents, for any named artifact: a campaign
brief, a content calendar, a landing page draft, a runbook. No file IDs, no integration —
the artifact is whatever string your team already calls it.

Usage: tower-anywhere <command> [options]

Commands:
  claim <artifact>    Register intent and print any conflicts.
  guard <artifact>    Same, but exit 2 on a hard conflict and register nothing.
                      Use this to gate a script.
  release --claim <id>   Done — free the artifact for everyone else.
  keepalive --claim <id> Extend a claim (they expire; call every ~60s on long work).

Options:
  --who <name>        Who's working (default: $TOWER_WHO, else "someone")
  --space <name>      Your team's coordination space (default: $TOWER_SPACE)
  --section <name>    Part of the artifact, e.g. "hero headline". Omit to claim all of it.
  --purpose <text>    What you're doing — the other person sees this.
  --eta <minutes>     Roughly how long you'll be.
  --force             Claim anyway, past a hard conflict.

Environment:
  TOWER_URL           Tower server (default http://127.0.0.1:4319/mcp)
  TOWER_TOKEN         Bearer token, if your server requires one.

Examples:
  tower-anywhere claim "Q3 Launch Brief" --purpose "rewriting the positioning"
  tower-anywhere claim "Content Calendar" --section "October" --purpose "slotting webinars"
  tower-anywhere guard "Homepage Copy" --who alice --purpose "hero rewrite"
`;

function toNum(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const OPTIONS = {
  who: { type: "string" },
  space: { type: "string" },
  section: { type: "string" },
  purpose: { type: "string" },
  eta: { type: "string" },
  force: { type: "boolean" },
  claim: { type: "string" },
} as const;

export interface ParsedClaim {
  args: ClaimArgs;
}

/**
 * Build claim args from argv plus environment defaults. Returns an error string
 * instead of throwing so the caller can print it and pick an exit code.
 */
export function parseClaimArgs(
  rest: string[],
  env: NodeJS.ProcessEnv = process.env,
): ClaimArgs | string {
  const { values, positionals } = parseArgs({
    args: rest,
    options: OPTIONS,
    allowPositionals: true,
  });
  const artifact = positionals[0];
  if (!artifact) return `needs an artifact, e.g. tower-anywhere claim "Q3 Launch Brief"`;
  const space = values.space ?? env.TOWER_SPACE?.trim();
  if (!space) return `needs --space <name> (or set TOWER_SPACE) so your team shares one board`;
  const section = values.section?.trim();
  return {
    who: values.who ?? env.TOWER_WHO?.trim() ?? "someone",
    space,
    artifact,
    ...(section ? { section } : {}),
    purpose: values.purpose ?? "",
    ...(toNum(values.eta) != null ? { etaMinutes: Math.floor(toNum(values.eta)!) } : {}),
    ...(values.force ? { force: true } : {}),
  };
}

/** Parse the `--claim <id>` shared by release/keepalive. */
function parseClaimId(rest: string[]): string | undefined {
  const { values } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true });
  return values.claim;
}

export async function run(
  argv: string[],
  out: Writer,
  connect: <T>(fn: (call: ToolCall) => Promise<T>) => Promise<T> = (fn) =>
    withTower(connectionFromEnv(), fn),
): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "claim":
    case "guard": {
      const args = parseClaimArgs(rest);
      if (typeof args === "string") {
        out(args);
        return 1;
      }
      const blocked = await connect((call) =>
        command === "claim" ? claim(call, args, out) : guard(call, args, out),
      );
      return blocked ? 2 : 0;
    }

    case "release":
    case "keepalive": {
      const claimId = parseClaimId(rest);
      if (!claimId) {
        out(`${command} needs --claim <id>`);
        return 1;
      }
      const tool = command === "release" ? "complete_claim" : "heartbeat";
      const res = (await connect((call) => call(tool, { claimId }))) as { ok?: boolean };
      out(
        res.ok
          ? `${command === "release" ? "Released" : "Extended"} claim ${claimId.slice(0, 8)}.`
          : `No active claim ${claimId.slice(0, 8)}.`,
      );
      return res.ok ? 0 : 1;
    }

    default:
      out(HELP);
      return command ? 1 : 0;
  }
}
