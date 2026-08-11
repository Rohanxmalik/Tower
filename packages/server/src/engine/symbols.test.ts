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
