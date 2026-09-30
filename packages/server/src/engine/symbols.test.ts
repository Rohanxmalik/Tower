import { describe, it, expect } from "vitest";
import { SymbolExtractor, symbolAt } from "./symbols.js";

const extractor = new SymbolExtractor();

async function names(file: string, code: string): Promise<string[]> {
  const syms = await extractor.extract(file, code);
  return syms.filter((s) => s.symbol !== "").map((s) => s.symbol);
}

describe("SymbolExtractor.grammarFor", () => {
  it("maps extensions to grammars", () => {
    expect(SymbolExtractor.grammarFor("a.ts")).toBe("typescript");
    expect(SymbolExtractor.grammarFor("a.tsx")).toBe("tsx");
    expect(SymbolExtractor.grammarFor("a.js")).toBe("javascript");
    expect(SymbolExtractor.grammarFor("a.py")).toBe("python");
    expect(SymbolExtractor.grammarFor("a.md")).toBeNull();
  });
});

describe("TypeScript extraction", () => {
  it("extracts functions, classes and methods", async () => {
    const code = `
      export function verify(token: string) { return !!token; }
      export class AuthService {
        verify(t: string) { return true; }
        refresh() {}
      }
    `;
    const got = await names("src/auth.ts", code);
    expect(got).toContain("verify");
    expect(got).toContain("AuthService");
    expect(got).toContain("AuthService.verify");
    expect(got).toContain("AuthService.refresh");
  });

  it("extracts interfaces and type aliases as types", async () => {
    const code = `
      export interface User { id: string; }
      export type Token = string;
    `;
    const syms = await extractor.extract("src/types.ts", code);
    const types = syms.filter((s) => s.kind === "type").map((s) => s.symbol);
    expect(types).toContain("User");
    expect(types).toContain("Token");
  });

  it("extracts arrow functions bound to const", async () => {
    const code = `export const handler = (req) => req;`;
    expect(await names("src/h.ts", code)).toContain("handler");
  });
});

describe("Python extraction", () => {
  it("extracts functions, classes and methods", async () => {
    const code = [
      "def verify(token):",
      "    return bool(token)",
      "",
      "class AuthService:",
      "    def verify(self, t):",
      "        return True",
    ].join("\n");
    const got = await names("src/auth.py", code);
    expect(got).toContain("verify");
    expect(got).toContain("AuthService");
    expect(got).toContain("AuthService.verify");
  });
});

describe("fallback", () => {
  it("returns a file-level symbol for unsupported extensions", async () => {
    const syms = await extractor.extract("README.md", "# hello");
    expect(syms).toEqual([{ file: "README.md", symbol: "", kind: "file" }]);
  });

  it("always includes a file-level marker for supported files", async () => {
    const syms = await extractor.extract("src/a.ts", "function f(){}");
    expect(syms.some((s) => s.symbol === "" && s.kind === "file")).toBe(true);
  });
});

describe("extractRanges + symbolAt — what the PreToolUse hook blocks on (0.10.0)", () => {
  const code = `function alpha() {
  return 1;
}

function beta() {
  return 2;
}

class Svc {
  verify() { return true; }
}
`;

  it("locates the function an edit lands in", async () => {
    const ranges = await new SymbolExtractor().extractRanges("x.ts", code);
    expect(symbolAt(ranges, code.indexOf("return 1;"))?.symbol).toBe("alpha");
    expect(symbolAt(ranges, code.indexOf("return 2;"))?.symbol).toBe("beta");
  });

  it("prefers the innermost symbol — a method over its class", async () => {
    const ranges = await new SymbolExtractor().extractRanges("x.ts", code);
    expect(symbolAt(ranges, code.indexOf("return true;"))?.symbol).toBe("Svc.verify");
  });

  it("returns nothing between declarations, so the caller can fall back to the file", async () => {
    const ranges = await new SymbolExtractor().extractRanges("x.ts", code);
    // The blank line between alpha's closing brace and `function beta` belongs to no
    // declaration — a file-level claim is the honest answer there.
    const between = code.indexOf("}\n\nfunction beta") + 2;
    expect(symbolAt(ranges, between)).toBeUndefined();
  });

  it("returns no ranges for a language with no grammar", async () => {
    expect(await new SymbolExtractor().extractRanges("notes.txt", "hello")).toEqual([]);
  });

  it("means two agents in different functions of one file no longer block each other", async () => {
    const ranges = await new SymbolExtractor().extractRanges("x.ts", code);
    const a = symbolAt(ranges, code.indexOf("return 1;"))?.symbol;
    const b = symbolAt(ranges, code.indexOf("return 2;"))?.symbol;
    expect(a).not.toBe(b);
  });
});

describe("signature fingerprints", () => {
  const sigOf = async (file: string, code: string, symbol: string) => {
    const syms = await new SymbolExtractor().extract(file, code);
    return syms.find((s) => s.symbol === symbol);
  };

  // The whole point: a claim is only as fresh as the read that produced it. Two agents
  // can write different symbols and still collide, when one moves a contract the other
  // read. Detecting that needs a fingerprint of the *declaration*, not the body — a
  // fingerprint over the body fires on every reformat and gets switched off in a week.
  it("is stable across reformatting", async () => {
    const a = await sigOf(
      "a.ts",
      `export function verify(token: string): boolean { return !!token; }`,
      "verify",
    );
    const b = await sigOf(
      "a.ts",
      `export function verify(\n  token: string,\n): boolean {\n  return !!token;\n}`,
      "verify",
    );
    expect(a?.sig).toBeDefined();
    expect(a?.sig).toBe(b?.sig);
  });

  it("is stable when only the body changes", async () => {
    const a = await sigOf(
      "a.ts",
      `function verify(token: string): boolean { return !!token; }`,
      "verify",
    );
    const b = await sigOf(
      "a.ts",
      `function verify(token: string): boolean { log("x"); return token.length > 0; }`,
      "verify",
    );
    expect(a?.sig).toBe(b?.sig);
  });

  it("moves when a parameter is added — the reviewer's exact case", async () => {
    const a = await sigOf(
      "a.ts",
      `function verify(token: string): boolean { return true; }`,
      "verify",
    );
    const b = await sigOf(
      "a.ts",
      `function verify(token: string, opts: Opts): boolean { return true; }`,
      "verify",
    );
    expect(a?.sig).not.toBe(b?.sig);
  });

  it("moves when the return type changes", async () => {
    const a = await sigOf("a.ts", `function verify(t: string): boolean { return true; }`, "verify");
    const b = await sigOf(
      "a.ts",
      `function verify(t: string): Promise<User> { return x; }`,
      "verify",
    );
    expect(a?.sig).not.toBe(b?.sig);
  });

  it("moves when a parameter type changes", async () => {
    const a = await sigOf("a.ts", `function f(x: string) {}`, "f");
    const b = await sigOf("a.ts", `function f(x: number) {}`, "f");
    expect(a?.sig).not.toBe(b?.sig);
  });

  it("carries a readable sigText, so Tower can ship the delta instead of a re-read", async () => {
    const s = await sigOf(
      "a.ts",
      `function verify(token: string): boolean { return true; }`,
      "verify",
    );
    expect(s?.sigText).toContain("verify");
    expect(s?.sigText).toContain("token: string");
    expect(s?.sigText).not.toContain("return true");
  });

  it("caps sigText so a pathological signature cannot bloat a claim", async () => {
    const params = Array.from({ length: 400 }, (_, i) => `p${i}: string`).join(", ");
    const s = await sigOf("a.ts", `function wide(${params}) {}`, "wide");
    expect(s?.sigText?.length).toBeLessThanOrEqual(240);
  });

  it("treats a whole type alias as its own contract", async () => {
    const a = await sigOf("a.ts", `type Token = { id: string };`, "Token");
    const b = await sigOf("a.ts", `type Token = { id: string; scope: string };`, "Token");
    expect(a?.sig).not.toBe(b?.sig);
  });

  it("moves when an interface member changes", async () => {
    const a = await sigOf("a.ts", `interface User { id: string; }`, "User");
    const b = await sigOf("a.ts", `interface User { id: number; }`, "User");
    expect(a?.sig).not.toBe(b?.sig);
  });

  it("moves when a class changes what it extends", async () => {
    const a = await sigOf("a.ts", `class Svc extends Base { m() {} }`, "Svc");
    const b = await sigOf("a.ts", `class Svc extends Other { m() {} }`, "Svc");
    expect(a?.sig).not.toBe(b?.sig);
  });

  it("does not move a class signature when only a method body changes", async () => {
    const a = await sigOf("a.ts", `class Svc extends Base { m() { return 1; } }`, "Svc");
    const b = await sigOf("a.ts", `class Svc extends Base { m() { return 2; } }`, "Svc");
    expect(a?.sig).toBe(b?.sig);
  });

  it("fingerprints python defs too", async () => {
    const a = await sigOf("a.py", `def verify(token):\n    return True\n`, "verify");
    const b = await sigOf("a.py", `def verify(token, opts):\n    return True\n`, "verify");
    expect(a?.sig).toBeDefined();
    expect(a?.sig).not.toBe(b?.sig);
  });

  it("is versioned, so the algorithm can change without silently comparing apples to oranges", async () => {
    const s = await sigOf("a.ts", `function f() {}`, "f");
    expect(s?.sig).toMatch(/^c1:[0-9a-f]{16}$/);
  });

  it("gives a file-level fallback symbol no signature to compare", async () => {
    const syms = await new SymbolExtractor().extract("notes.txt", "hello");
    expect(syms[0]?.sig).toBeUndefined();
  });
});
