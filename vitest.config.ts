import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@tower/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      "@tower/server": fileURLToPath(new URL("./packages/server/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "action/**/*.test.mjs"],
    server: {
      deps: {
        // node:sqlite is a newer builtin vitest doesn't auto-externalize yet.
        external: [/node:sqlite/],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/index.ts", "**/*.test.ts", "**/*.d.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
