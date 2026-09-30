import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_HOOKS, installClaudeHooks } from "./commands.js";

/**
 * `tower init --hooks` on a machine that already has the hooks. It skipped every event
 * that existed, so an install from before 0.11 kept `PostToolUse: Edit|Write|MultiEdit`
 * forever — no Read, so no recorded reads and none of 0.12's read-time warnings — and
 * re-running the documented command reported "already wires every Tower hook".
 */

type Group = { matcher?: string; hooks: { type: string; command: string }[] };
type Settings = { hooks: Record<string, Group[]>; model?: string };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tower-hooks-install-"));
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "hooks", "pretooluse-tower.mjs"), "// stub");
  mkdirSync(join(dir, ".claude"), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (s: object) =>
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(s, null, 2));
const read = () =>
  JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")) as Settings;
const post = "node hooks/posttooluse-tower.mjs";
const collect = () => {
  const lines: string[] = [];
  return { out: (l: string) => lines.push(l), text: () => lines.join("\n") };
};

describe("init --hooks upgrades Tower's own entries", () => {
  it("widens an old PostToolUse matcher to include Read", () => {
    write({
      model: "keep-me",
      hooks: {
        PostToolUse: [
          { matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: post }] },
        ],
      },
    });
    const { out, text } = collect();
    installClaudeHooks(dir, out);
    const cfg = read();
    expect(cfg.hooks.PostToolUse).toEqual(CLAUDE_HOOKS.PostToolUse);
    expect(cfg.model).toBe("keep-me");
    expect(text()).toMatch(/updated PostToolUse/);
  });

  it("never changes a group that also holds the user's own hook", () => {
    const mine = { type: "command", command: "node my-formatter.mjs" };
    write({
      hooks: {
        PostToolUse: [
          { matcher: "Edit|Write|MultiEdit", hooks: [mine, { type: "command", command: post }] },
        ],
      },
    });
    installClaudeHooks(dir, () => {});
    const groups = read().hooks.PostToolUse!;
    // the user's group keeps its matcher and its own hook; Tower's moves out on its own
    expect(groups[0]).toEqual({ matcher: "Edit|Write|MultiEdit", hooks: [mine] });
    expect(groups).toContainEqual(CLAUDE_HOOKS.PostToolUse[0]);
  });

  it("adds Tower's entry beside the user's own for the same event", () => {
    const mine: Group = { matcher: "Bash", hooks: [{ type: "command", command: "mine.mjs" }] };
    write({ hooks: { PreToolUse: [mine] } });
    installClaudeHooks(dir, () => {});
    const groups = read().hooks.PreToolUse!;
    expect(groups[0]).toEqual(mine);
    expect(groups).toContainEqual(CLAUDE_HOOKS.PreToolUse[0]);
  });

  it("is idempotent: a second run changes nothing and says so", () => {
    installClaudeHooks(dir, () => {});
    const first = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    const { out, text } = collect();
    installClaudeHooks(dir, out);
    expect(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).toBe(first);
    expect(text()).toContain("already wires every Tower hook");
  });
});

// The documented manual path is `cp .claude/settings.example.json .claude/settings.json`.
// It had drifted from what `init --hooks` writes — no Read matcher — so everyone who
// followed the docs by hand silently got none of the read-time features.
describe(".claude/settings.example.json", () => {
  it("wires exactly what init --hooks writes", () => {
    const example = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../.claude/settings.example.json", import.meta.url)),
        "utf8",
      ),
    ) as { hooks: unknown };
    expect(example.hooks).toEqual(CLAUDE_HOOKS);
  });
});
