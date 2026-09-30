import type { Alternatives, Conflict, SymbolRef } from "@tower/shared";

/**
 * The agent-facing text for 0.12.0 — what an agent reads when it has just read contested
 * code, when a claim is refused, and in the rules `tower setup` writes. Kept apart from
 * `commands.ts` and tested directly: this wording is what the agent acts on, and a vague
 * line costs it a re-read, which is the token spend Tower exists to prevent.
 */

/** How many conflicts a read warning names before summarising. */
const WARN_LINES = 5;
/** How many symbols a refusal lists before summarising. */
const AVOID_SHOWN = 8;

const where = (overlap: SymbolRef[]): string => [...new Set(overlap.map((s) => s.file))].join(", ");

/** One short block per read, or `null` when there is nothing to say — the hook then
 * prints nothing at all, rather than an empty message the agent has to read. */
export function readWarning(conflicts: Conflict[]): string | null {
  if (conflicts.length === 0) return null;
  const lines = conflicts.slice(0, WARN_LINES).map((c) => {
    const delta =
      c.wasSigText && c.nowSigText ? ` (was \`${c.wasSigText}\`, now \`${c.nowSigText}\`)` : "";
    return `• ${c.reason}${delta} [${where(c.overlap)}]`;
  });
  const more =
    conflicts.length > WARN_LINES ? [`• …and ${conflicts.length - WARN_LINES} more`] : [];
  return ["Tower: another agent is changing code you just read —", ...lines, ...more].join("\n");
}

/**
 * Wrap text so Claude Code actually shows it to the agent. Plain stdout from a
 * PostToolUse hook goes to the debug log and never reaches the model; only this JSON
 * shape, on stdout with exit 0, is delivered as context next to the tool result.
 */
export function hookContext(text: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text },
  });
}

/** The CLI's printout after a refusal. Empty for a claim that was not refused. */
export function renderAlternatives(alt: Alternatives | undefined): string {
  if (!alt) return "";
  const shown = alt.avoid
    .slice(0, AVOID_SHOWN)
    .map((s) => (s.symbol ? `${s.symbol}() (${s.file})` : s.file));
  const extra =
    alt.avoid.length > AVOID_SHOWN ? `, and ${alt.avoid.length - AVOID_SHOWN} more` : "";
  return [
    "What to do instead:",
    `  ${alt.advice}`,
    `  Avoid for now: ${shown.join(", ")}${extra}`,
    ...(alt.nextTask ? [`  Suggested next: module "${alt.nextTask.module}"`] : []),
  ].join("\n");
}

const RULE_HEAD = `## Tower (agent coordination)

Before editing any file, call the \`claim_intent\` MCP tool on the \`tower\` server with
the files and symbols you will change, and \`reads\`: the declarations your work is
built against. If you are changing a symbol's signature, set \`declares\` on it to the
new declaration — agents that depend on it are handed that contract and can code
against it in parallel instead of waiting for you.
`;

const ON_CONFLICT_STOP = `If a \`hard\` conflict returns, stop and ask the
user; the response's \`alternatives\` says what is safe to work on meanwhile.
`;

const ON_CONFLICT_KEEP_GOING = `If a \`hard\` conflict returns, don't stop: work on anything outside the response's
\`alternatives.avoid\` (or its \`nextTask\`), and come back to this once Tower messages
you that it is free. Only ask the user if nothing safe is left to do.
`;

const RULE_TAIL = `If a response reports \`unreadMessages > 0\`, call \`fetch_messages\` — a teammate's
agent may have delegated you a task, or Tower may be telling you that code you were
waiting on is free; act on it and reply with a \`task_update\` where one is asked for.
`;

/**
 * The rules block `tower setup` writes. Stopping on a hard conflict stays the default:
 * carrying on alone trades a little human control for no waiting, which is a choice a
 * team should make on purpose — `tower setup --keep-going`.
 */
export function towerRule(opts: { keepGoing?: boolean } = {}): string {
  return RULE_HEAD + (opts.keepGoing ? ON_CONFLICT_KEEP_GOING : ON_CONFLICT_STOP) + RULE_TAIL;
}
