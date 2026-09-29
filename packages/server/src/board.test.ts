import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { BOARD_HTML } from "./board.js";

/**
 * The board is ~800 lines of browser JS inside a template string, and nothing executed
 * it. Rewriting its tables broke the page twice — once by deleting presence maps the
 * activity log still read, once by deleting an `ids` binding — and both survived a green
 * test run because no test ever rendered anything.
 *
 * This runs the board's own script against a minimal DOM. It won't catch styling, but it
 * catches "the page throws on load", which is the failure that matters.
 */
interface Node {
  tagName: string;
  className: string;
  children: Node[];
  textContent: string;
  appendChild(c: Node): Node;
  replaceChildren(...c: Node[]): void;
  setAttribute(k: string, v: string): void;
  addEventListener(): void;
  options: Node[];
  value: string;
}

function makeNode(tag: string): Node {
  const node = {
    tagName: tag,
    className: "",
    children: [] as Node[],
    _text: "",
    options: [] as Node[],
    value: "",
    hidden: false,
    disabled: false,
    dataset: {},
    style: {},
    attrs: {} as Record<string, string>,
    appendChild(c: Node) {
      this.children.push(c);
      return c;
    },
    replaceChildren(...c: Node[]) {
      this.children = c;
    },
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
    addEventListener() {},
    get textContent(): string {
      return this._text || this.children.map((c) => c.textContent).join("");
    },
    set textContent(v: string) {
      this._text = String(v);
      this.children = [];
    },
  };
  return node as unknown as Node;
}

function renderBoard(snapshot: Record<string, unknown>): Record<string, Node> {
  const byId: Record<string, Node> = {};
  const ctx: Record<string, unknown> = {
    document: {
      createElement: makeNode,
      getElementById: (id: string) => (byId[id] ??= makeNode("div")),
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      body: makeNode("body"),
    },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setInterval() {},
    setTimeout() {},
    clearInterval() {},
    console,
    location: { origin: "http://x", href: "http://x" },
    navigator: {},
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);

  const script = /<script>([\s\S]*?)<\/script>/.exec(BOARD_HTML)?.[1] ?? "";
  // `render` is closure-scoped; expose a handle from inside the closure.
  const hooked = script.replace(
    "function render(data) {",
    "globalThis.__render = function (d) { return render(d); };\n  function render(data) {",
  );
  vm.runInContext(hooked, ctx);
  (ctx.__render as (d: unknown) => void)(snapshot);
  return byId;
}

function tableOf(host: Node | undefined): { head: string[]; rows: string[][] } | null {
  const t = host?.children[0];
  if (!t || t.tagName !== "table") return null;
  return {
    head: t.children[0].children[0].children.map((c) => c.textContent),
    rows: t.children[1].children.map((r) => r.children.map((c) => c.textContent)),
  };
}

const now = Date.now();
const SNAPSHOT = {
  now,
  claims: [
    {
      id: "c1",
      agentId: "alice",
      repo: "github.com/a/acme-web",
      branch: "main",
      files: ["app.js"],
      symbols: [{ file: "app.js", symbol: "validateEmail" }],
      purpose: "stricter rules",
      status: "active",
      createdAt: now - 60_000,
      expiresAt: now + 60_000,
      etaMinutes: 8,
    },
  ],
  conflicts: [],
  messages: [],
  tasks: [
    {
      id: "3a3d46c4-aaaa",
      repo: "github.com/a/acme-web",
      fromAgentId: "alice",
      toAgentId: "bob",
      assigneeAgentId: "bob",
      body: "add health endpoint",
      status: "accepted",
      size: "s",
      createdAt: now - 30_000,
      updatedAt: now - 10_000,
    },
  ],
  workers: [
    {
      agentId: "alice",
      repo: "r",
      runner: "claude",
      status: "ok",
      lastSeen: now - 2_000,
      presence: "working",
      claims: [],
    },
    {
      agentId: "bob",
      repo: "r",
      runner: "claude",
      status: "ok",
      lastSeen: now - 300_000,
      presence: "idle",
      claims: [],
    },
  ],
  rules: [],
};

describe("board — three live tables (0.10.0)", () => {
  it("renders without throwing", () => {
    expect(() => renderBoard(SNAPSHOT)).not.toThrow();
  });

  it("1 · Live agents shows status, runner and how long ago each was seen", () => {
    const table = tableOf(renderBoard(SNAPSHOT).roster);
    expect(table?.head).toEqual(["Agent", "Status", "Runner", "Last seen"]);
    expect(table?.rows[0]?.[0]).toContain("alice");
    expect(table?.rows[0]?.[1]).toBe("working");
    expect(table?.rows[0]?.[2]).toBe("claude");
    // The complaint this fixes: an active agent read as "seen earlier" forever.
    expect(table?.rows[1]?.[1]).toBe("idle");
  });

  it("2 · Active claims shows agent, file, symbol, purpose and ETA", () => {
    const table = tableOf(renderBoard(SNAPSHOT).edits);
    expect(table?.head).toEqual(["Agent", "File", "Symbol", "Purpose", "ETA"]);
    expect(table?.rows[0]).toEqual(["alice", "app.js", "validateEmail", "stricter rules", "8m"]);
  });

  it("3 · Active work shows only tasks in flight", () => {
    const table = tableOf(renderBoard(SNAPSHOT).work);
    expect(table?.head).toEqual(["Task", "From", "To", "Status", "Size"]);
    expect(table?.rows[0]).toEqual(["3a3d46c4", "alice", "bob", "accepted", "s"]);
  });

  it("hides finished tasks from Active work", () => {
    const done = {
      ...SNAPSHOT,
      tasks: [{ ...SNAPSHOT.tasks[0], status: "done" }],
    };
    expect(tableOf(renderBoard(done).work)).toBeNull();
  });

  it("renders empty state rather than throwing when nothing is happening", () => {
    const empty = {
      now,
      claims: [],
      conflicts: [],
      messages: [],
      tasks: [],
      workers: [],
      rules: [],
    };
    const byId = renderBoard(empty);
    expect(byId.roster?.textContent).toContain("No agents seen yet");
    expect(byId.edits?.textContent).toContain("No active edits");
    expect(byId.work?.textContent).toContain("Nothing in flight");
  });
});
