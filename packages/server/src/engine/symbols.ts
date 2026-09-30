import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import Parser from "web-tree-sitter";
import type { SymbolRef, SymbolKind } from "@tower/shared";

const nodeRequire = createRequire(import.meta.url);

/** Map a file extension to a bundled tree-sitter grammar. */
const GRAMMAR_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
};

function extname(file: string): string {
  const i = file.lastIndexOf(".");
  return i < 0 ? "" : file.slice(i).toLowerCase();
}

function grammarWasmPath(grammar: string): string {
  return nodeRequire.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
}

/**
 * Extracts code symbols (functions, classes, methods, types) from source using
 * tree-sitter. Content-based and pure: callers supply the file text, so the engine
 * never needs filesystem or repo access. Unknown languages fall back to a single
 * file-level symbol so a claim is never lost.
 */
export class SymbolExtractor {
  private static coreReady: Promise<void> | null = null;
  private readonly languages = new Map<string, Parser.Language>();

  private static ensureCore(): Promise<void> {
    if (!SymbolExtractor.coreReady) SymbolExtractor.coreReady = Parser.init();
    return SymbolExtractor.coreReady;
  }

  private async loadLanguage(grammar: string): Promise<Parser.Language> {
    const cached = this.languages.get(grammar);
    if (cached) return cached;
    const lang = await Parser.Language.load(grammarWasmPath(grammar));
    this.languages.set(grammar, lang);
    return lang;
  }

  /** Returns the tree-sitter grammar name for a file, or null if unsupported. */
  static grammarFor(file: string): string | null {
    return GRAMMAR_BY_EXT[extname(file)] ?? null;
  }

  async extract(file: string, code: string): Promise<SymbolRef[]> {
    const grammar = SymbolExtractor.grammarFor(file);
    if (!grammar) return [{ file, symbol: "", kind: "file" }];

    await SymbolExtractor.ensureCore();
    const language = await this.loadLanguage(grammar);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(code);
    const symbols: SymbolRef[] = [];
    walk(tree.rootNode, null, file, code, symbols);
    parser.delete();

    // Always include a file-level marker so file-scope collisions still register.
    symbols.push({ file, symbol: "", kind: "file" });
    return dedupe(symbols);
  }

  /**
   * Symbols with their byte ranges.
   *
   * Exists so the PreToolUse hook can name the *function* an edit lands in rather than
   * claiming the whole file. Blocking at file granularity refuses correct edits — two
   * agents in different functions of one file collided — and a tool that blocks good
   * work gets uninstalled faster than one that misses a conflict.
   */
  async extractRanges(file: string, code: string): Promise<RangedSymbol[]> {
    const grammar = SymbolExtractor.grammarFor(file);
    if (!grammar) return [];
    await SymbolExtractor.ensureCore();
    const language = await this.loadLanguage(grammar);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(code);
    const out: RangedSymbol[] = [];
    walkRanges(tree.rootNode, null, file, code, out);
    parser.delete();
    return out;
  }
}

/** Like {@link walk}, but keeps each declaration's span. */
function walkRanges(
  node: TsNode,
  classCtx: string | null,
  file: string,
  code: string,
  out: RangedSymbol[],
): void {
  const kind = DECLARATION_KINDS[node.type];
  if (kind) {
    const name = nameOf(node);
    if (name) {
      const qualified = CALLABLE_IN_CLASS.has(node.type) && classCtx ? `${classCtx}.${name}` : name;
      out.push({
        file,
        symbol: qualified,
        kind,
        ...signatureOf(node, code),
        start: node.startIndex,
        end: node.endIndex,
      });
    }
  }
  const nextCtx = CLASS_NODE_TYPES.has(node.type) ? (nameOf(node) ?? classCtx) : classCtx;
  for (const child of node.namedChildren) walkRanges(child, nextCtx, file, code, out);
}

/**
 * The innermost symbol whose span contains `offset` — a method inside a class wins over
 * the class. Returns undefined when the edit lands between declarations (imports, top
 * level), where a file-level claim is the honest answer.
 */
export function symbolAt(symbols: RangedSymbol[], offset: number): RangedSymbol | undefined {
  let best: RangedSymbol | undefined;
  for (const s of symbols) {
    if (offset < s.start || offset >= s.end) continue;
    if (!best || s.end - s.start < best.end - best.start) best = s;
  }
  return best;
}

/** Scheme tag on every fingerprint. Bump it when the normalization below changes, so an
 * old `c1:` digest is never compared against a new one and read as "unchanged". */
const SIG_SCHEME = "c1";

/** Cap on the stored declaration text. Long enough to read a signature back, short
 * enough that a pathological one cannot bloat every claim that touches it. */
const SIG_TEXT_MAX = 240;

/** Declarations that *are* their own contract — there is no body to exclude, because
 * every part of them is visible to a caller. */
const WHOLE_DECLARATION = new Set([
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
]);

/**
 * The text a caller can actually depend on: everything up to the body. A body rewrite,
 * a renamed local, a comment, a prettier run — none of them touch this. Adding a
 * parameter or changing a return type does.
 */
function declarationText(node: TsNode, code: string): string {
  if (WHOLE_DECLARATION.has(node.type)) return code.slice(node.startIndex, node.endIndex);
  const body = bodyOf(node);
  return code.slice(node.startIndex, body ? body.startIndex : node.endIndex);
}

/**
 * The body to exclude. Usually the node's own `body` field — but for
 * `const verify = (token) => { ... }` the body belongs to the arrow function, and
 * reading the declarator's own span would fold the implementation into the signature.
 */
function bodyOf(node: TsNode): TsNode | null {
  const direct = node.childForFieldName("body");
  if (direct) return direct;
  const value = node.childForFieldName("value");
  return value ? value.childForFieldName("body") : null;
}

/** For display: collapse runs of whitespace, keep it readable. */
function readableDeclaration(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * For comparison: drop whitespace entirely and the trailing comma prettier leaves when
 * it breaks a parameter list across lines. `verify(token: string)` and
 * `verify(\n  token: string,\n)` are the same contract, and a fingerprint that
 * disagreed would fire on every reformat — the fastest way to get the feature muted.
 */
function canonicalDeclaration(text: string): string {
  return text.replace(/\s+/g, "").replace(/,(?=[)\]}>])/g, "");
}

/**
 * Fingerprint a declaration. Returns the digest plus the readable form, so a staleness
 * report can show `verify(token)` → `verify(token, opts)` rather than sending the agent
 * back to re-read the file.
 */
export function signatureOf(
  node: TsNode,
  code: string,
): { sig: string; sigText: string } | undefined {
  const raw = declarationText(node, code);
  const canonical = canonicalDeclaration(raw);
  if (canonical === "") return undefined;
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return {
    sig: `${SIG_SCHEME}:${digest}`,
    sigText: readableDeclaration(raw).slice(0, SIG_TEXT_MAX),
  };
}

/** Node types that name a symbol, and the SymbolKind to record. */
const DECLARATION_KINDS: Record<string, SymbolKind> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  function_definition: "function", // python
  class_declaration: "class",
  class_definition: "class", // python
  interface_declaration: "type",
  type_alias_declaration: "type",
  enum_declaration: "type",
  method_definition: "method",
};

const CLASS_NODE_TYPES = new Set(["class_declaration", "class_definition"]);
const CALLABLE_IN_CLASS = new Set(["method_definition", "function_definition"]);

interface TsNode {
  type: string;
  namedChildren: TsNode[];
  childForFieldName(field: string): TsNode | null;
  text: string;
  startIndex: number;
  endIndex: number;
}

/** A symbol plus the byte range it spans, so a caller can ask "what encloses this edit?" */
export interface RangedSymbol extends SymbolRef {
  start: number;
  end: number;
}

function nameOf(node: TsNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode ? nameNode.text : null;
}

function walk(
  node: TsNode,
  classCtx: string | null,
  file: string,
  code: string,
  out: SymbolRef[],
): void {
  const kind = DECLARATION_KINDS[node.type];

  if (kind) {
    const name = nameOf(node);
    if (name) {
      const sig = signatureOf(node, code);
      if (CALLABLE_IN_CLASS.has(node.type) && classCtx) {
        out.push({ file, symbol: `${classCtx}.${name}`, kind: "method", ...sig });
      } else {
        out.push({ file, symbol: name, kind, ...sig });
      }
    }
  }

  // Variable-bound arrow/function expressions: `const foo = () => {}`.
  if (node.type === "variable_declarator") {
    const name = nameOf(node);
    const value = node.childForFieldName("value");
    if (
      name &&
      value &&
      (value.type === "arrow_function" || value.type === "function_expression")
    ) {
      out.push({ file, symbol: name, kind: "function", ...signatureOf(node, code) });
    }
  }

  const nextClassCtx = CLASS_NODE_TYPES.has(node.type) ? (nameOf(node) ?? classCtx) : classCtx;
  for (const child of node.namedChildren) walk(child, nextClassCtx, file, code, out);
}

function dedupe(symbols: SymbolRef[]): SymbolRef[] {
  const seen = new Set<string>();
  const result: SymbolRef[] = [];
  for (const s of symbols) {
    const key = `${s.file}::${s.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(s);
  }
  return result;
}
