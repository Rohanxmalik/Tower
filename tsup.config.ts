import { defineConfig } from "tsup";

// Bundles the CLI into a single self-contained package (`tower-mcp`): the workspace
// packages @tower/shared and @tower/server are inlined; runtime npm deps stay external
// (declared in packages/cli/package.json) and are installed by npm/npx.
//
// Two entries: `index` (the CLI/bin) and `commands` (imported by the PreToolUse hook).
export default defineConfig({
  entry: {
    index: "packages/cli/src/index.ts",
    commands: "packages/cli/src/commands.ts",
  },
  outDir: "packages/cli/dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  noExternal: [/^@tower\//],
  // Runtime deps stay external (declared in packages/cli/package.json, installed by npm).
  // web-tree-sitter / tree-sitter-wasms MUST be external: they load .wasm from node_modules.
  external: [
    "@modelcontextprotocol/sdk",
    "express",
    "web-tree-sitter",
    "tree-sitter-wasms",
    "yaml",
    "zod",
    // web-push does a dynamic require("crypto"); bundling it breaks the ESM output
    // ("Dynamic require ... is not supported") and crashes serve at startup.
    "web-push",
  ],
  banner: { js: "#!/usr/bin/env node" },
  clean: false,
  dts: false,
  splitting: false,
  shims: false,
});
