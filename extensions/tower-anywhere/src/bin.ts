#!/usr/bin/env node
import { run } from "./cli.js";

run(process.argv.slice(2), (l) => process.stdout.write(l + "\n"))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`tower-anywhere: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
