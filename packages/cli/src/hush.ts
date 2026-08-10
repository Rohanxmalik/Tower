/**
 * Node prints `ExperimentalWarning: SQLite is an experimental feature` because the
 * store uses the built-in `node:sqlite`. That's a deliberate dependency choice —
 * no native module to compile, so `npx tower-mcp` works first try everywhere — but
 * the warning is the first thing a new user sees and reads like a defect.
 *
 * Node emits it when `node:sqlite` is first imported, so this module must be
 * imported *before* anything that pulls the store in. It has no imports of its own
 * and installs the filter on import for exactly that reason.
 */
export function hushSqliteWarning(proc: Pick<NodeJS.Process, "emitWarning"> = process): void {
  const original = proc.emitWarning.bind(proc);
  proc.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const name = typeof warning === "string" ? String(rest[0] ?? "") : warning.name;
    const text = typeof warning === "string" ? warning : warning.message;
    // Silence this one warning only — everything else still surfaces.
    if (name === "ExperimentalWarning" && /SQLite/i.test(text)) return;
    return (original as (...a: unknown[]) => void)(warning, ...rest);
  }) as NodeJS.Process["emitWarning"];
}

/**
 * The store imports `node:sqlite` at module scope. It landed in Node 22.5 but
 * stayed behind `--experimental-sqlite` until **23.4**, backported unflagged to
 * **22.13** — so 22.5–22.12 and 23.0–23.3 pass a naive `>= 22.5` check and then
 * die with a raw ERR_UNKNOWN_BUILTIN_MODULE stack. Gate on the unflagged
 * versions and offer the flag as an escape hatch.
 */
export function requireModernNode(
  version = process.versions.node,
): { ok: true } | { ok: false; message: string } {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const unflagged = major >= 24 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13);
  if (unflagged) return { ok: true };
  // Already opted in by hand? Then a flagged build is fine.
  if (process.execArgv.some((a) => a.startsWith("--experimental-sqlite"))) return { ok: true };
  if ((process.env.NODE_OPTIONS ?? "").includes("--experimental-sqlite")) return { ok: true };
  return {
    ok: false,
    message:
      `Tower needs Node 22.13+, 23.4+ or 24+ (you have v${version}) — it uses the\n` +
      `built-in node:sqlite, which stayed behind a flag until those releases.\n\n` +
      `Upgrade:  https://nodejs.org   (or: nvm install 24 && nvm use 24)\n` +
      `Or run it on this version with:\n` +
      `  NODE_OPTIONS=--experimental-sqlite tower <command>\n`,
  };
}

hushSqliteWarning();

const node = requireModernNode();
if (!node.ok) {
  process.stderr.write(node.message);
  process.exit(1);
}
