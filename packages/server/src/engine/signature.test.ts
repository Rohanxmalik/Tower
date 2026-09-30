import { describe, it, expect } from "vitest";
import { fingerprintDeclaration } from "./signature.js";
import { SymbolExtractor } from "./symbols.js";

const parsed = async (code: string, symbol: string) => {
  const syms = await new SymbolExtractor().extract("a.ts", code);
  return syms.find((s) => s.symbol === symbol);
};

describe("fingerprintDeclaration", () => {
  // Contract-first rests on this: an agent *declares* the signature it is about to write,
  // and Tower must recognise that exact contract when the code later lands. If the two
  // fingerprints disagreed, every reader already on the new contract would be warned
  // anyway, and a warning that fires on correct work is one nobody leaves switched on.
  it("matches the fingerprint of the same declaration parsed from real code", async () => {
    const code = `export function verify(token: string, opts: Opts): boolean {\n  return !!token;\n}`;
    const real = await parsed(code, "verify");
    const declared = fingerprintDeclaration(
      "export function verify(token: string, opts: Opts): boolean",
    );
    expect(real?.sig).toBeDefined();
    expect(declared?.sig).toBe(real?.sig);
  });

  // The parser fingerprints the declaration node, which sits *inside* `export`, so its
  // text never includes the keyword — while an agent declaring a contract writes it
  // naturally. `export` is visibility, not contract: it has to compare as equal.
  it("treats a leading export keyword as outside the contract", async () => {
    const real = await parsed(
      `export function verify(token: string): boolean { return true; }`,
      "verify",
    );
    for (const declared of [
      "export function verify(token: string): boolean",
      "function verify(token: string): boolean",
      "export default function verify(token: string): boolean",
    ]) {
      expect(fingerprintDeclaration(declared)?.sig, declared).toBe(real?.sig);
    }
  });

  it("does not change the fingerprint of any parsed declaration", async () => {
    // Guards the claim that stripping `export` needed no scheme bump: parsed text never
    // starts with it, so every c1: digest already stored stays byte-identical.
    const real = await parsed(`function verify(token: string): boolean { return true; }`, "verify");
    expect(fingerprintDeclaration(real!.sigText!)?.sig).toBe(real?.sig);
  });

  it("ignores whitespace and the trailing comma a formatter leaves", () => {
    const a = fingerprintDeclaration("function verify(token: string, opts: Opts)");
    const b = fingerprintDeclaration("function verify(\n  token: string,\n  opts: Opts,\n)");
    expect(a?.sig).toBe(b?.sig);
  });

  it("distinguishes a changed parameter list", () => {
    const a = fingerprintDeclaration("function verify(token: string)");
    const b = fingerprintDeclaration("function verify(token: string, opts: Opts)");
    expect(a?.sig).not.toBe(b?.sig);
  });

  it("returns readable text for display and caps it", () => {
    const f = fingerprintDeclaration("function   verify(\n token: string\n)");
    expect(f?.sigText).toBe("function verify( token: string )");
    const long = fingerprintDeclaration(`function f(${"a: string, ".repeat(60)})`);
    expect(long?.sigText.length).toBeLessThanOrEqual(240);
  });

  it("returns undefined for empty or whitespace-only input", () => {
    expect(fingerprintDeclaration("")).toBeUndefined();
    expect(fingerprintDeclaration("   \n ")).toBeUndefined();
  });

  it("tags the scheme, so a future normalization change cannot compare as equal", () => {
    expect(fingerprintDeclaration("function f()")?.sig).toMatch(/^c1:[0-9a-f]{16}$/);
  });
});
