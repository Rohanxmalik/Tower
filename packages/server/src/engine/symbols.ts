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
    walk(tree.rootNode, null, file, symbols);
    parser.delete();

    // Always include a file-level marker so file-scope collisions still register.
    symbols.push({ file, symbol: "", kind: "file" });
    return dedupe(symbols);
  }
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
}

function nameOf(node: TsNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode ? nameNode.text : null;
}

function walk(node: TsNode, classCtx: string | null, file: string, out: SymbolRef[]): void {
  const kind = DECLARATION_KINDS[node.type];

  if (kind) {
    const name = nameOf(node);
    if (name) {
      if (CALLABLE_IN_CLASS.has(node.type) && classCtx) {
        out.push({ file, symbol: `${classCtx}.${name}`, kind: "method" });
      } else {
        out.push({ file, symbol: name, kind });
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
      out.push({ file, symbol: name, kind: "function" });
    }
  }

  const nextClassCtx = CLASS_NODE_TYPES.has(node.type) ? (nameOf(node) ?? classCtx) : classCtx;
  for (const child of node.namedChildren) walk(child, nextClassCtx, file, out);
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
