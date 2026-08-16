import { afterEach, beforeEach } from 'vitest';

/**
 * `process.env` is shared by every integration test. Guard it.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE LAST SOURCE OF ORDER-DEPENDENCE, AND THE NASTIEST.            │
 * │                                                                    │
 * │  Ten test files flip the deployment mode — `INRP2P_MODE`,          │
 * │  `INRP2P_SANDBOX`, `NODE_ENV` — to prove the product fails closed  │
 * │  in production. They run in ONE process (`singleFork: true`), so   │
 * │  that is one shared global, and most of them restored it with a    │
 * │  call placed after the assertions.                                 │
 * │                                                                    │
 * │  Which means any failing assertion skipped the restore and left    │
 * │  the entire remaining run believing it was in production. The      │
 * │  symptom was a scatter of unrelated failures in different files    │
 * │  on every shuffled run — never the same two twice, and never the   │
 * │  test that actually caused it.                                     │
 * │                                                                    │
 * │  Snapshotting around EVERY test makes the leak impossible, and     │
 * │  leaves each file's own restore logic harmlessly in place.         │
 * └────────────────────────────────────────────────────────────────────┘
 */

/**
 * Give each parallel worker its own database, when asked.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  SOME TESTS ASSERT ON STATE THAT IS GLOBAL TO THE DATABASE.        │
 * │                                                                    │
 * │  The emergency pause is one switch for the whole deployment; the   │
 * │  fail-closed cases assert that a refused production request wrote  │
 * │  NOTHING anywhere. Those are correct assertions about correct      │
 * │  features, and no amount of rewriting makes them safe to run       │
 * │  beside another worker writing to the same tables — one fork       │
 * │  pausing a scope genuinely changes what another fork observes.     │
 * │                                                                    │
 * │  So parallelism is bought with isolation rather than with weaker   │
 * │  assertions: set `INRP2P_TEST_DB_PER_WORKER=1` and each worker     │
 * │  connects to `<database>_wN`, provisioned by                       │
 * │  `scripts/test-databases.mjs`. Left unset, everything shares one   │
 * │  database exactly as before.                                       │
 * │                                                                    │
 * │  This runs at setup-file load, before any test imports the pool —  │
 * │  `getPool()` reads `DATABASE_URL` lazily on first use, so the      │
 * │  redirect is in place by the time a connection is opened.          │
 * └────────────────────────────────────────────────────────────────────┘
 */
if (process.env.INRP2P_TEST_DB_PER_WORKER === '1') {
  const worker = process.env.VITEST_POOL_ID ?? '1';
  const base = process.env.DATABASE_URL;
  if (base !== undefined) {
    const url = new URL(base);
    // `/inrp2p_sandbox` → `/inrp2p_sandbox_w3`
    url.pathname = `${url.pathname.replace(/\/$/, '')}_w${worker}`;
    process.env.DATABASE_URL = url.toString();
  }
}

let snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot = { ...process.env };
});

afterEach(() => {
  /*
   * Registered in a setup file, so this runs LAST among `afterEach`
   * hooks — after each file's own restore has had its say. Keys added
   * by the test are deleted; keys it changed or deleted are put back.
   */
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else if (process.env[key] !== value) process.env[key] = value;
  }
});
