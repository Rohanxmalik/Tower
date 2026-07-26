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

hushSqliteWarning();
