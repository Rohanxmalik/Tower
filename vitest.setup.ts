/**
 * Hermetic test environment.
 *
 * `remoteConfig()` reads `TOWER_URL` / `TOWER_TOKEN` from `process.env` by default, so a
 * developer who has those exported for a real server — which is the normal state for anyone
 * running `tower work` — would have the unit suite silently talk to **production**. That was
 * observed: six CLI tests failed because they were colliding with live claims on a hosted
 * instance rather than the temp-dir store they intended to use.
 *
 * Tests must never depend on, or reach, the machine's ambient configuration.
 */
const AMBIENT = ["TOWER_URL", "TOWER_TOKEN", "TOWER_AGENT"] as const;

for (const key of AMBIENT) delete process.env[key];
