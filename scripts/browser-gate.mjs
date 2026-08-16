#!/usr/bin/env node
/**
 * The DEL-10 browser gate, end to end, against the BUILT application.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  ONE COMMAND, FOUR THINGS, IN THIS ORDER.                        │
 * │                                                                  │
 * │    1 · a production build                                        │
 * │    2 · an isolated sandbox PostgreSQL cluster, migrated to head  │
 * │    3 · `next start` on a dedicated port, waited on until         │
 * │        READINESS — not merely until the port accepts a socket    │
 * │    4 · headless Playwright against that server                   │
 * │                                                                  │
 * │  What this removes, by construction rather than by exemption:    │
 * │  `nextjs-portal`, the dev error overlay, first-request           │
 * │  compilation contention, the aborted navigations it caused, and  │
 * │  load timings that were really measuring a compiler.             │
 * └──────────────────────────────────────────────────────────────────┘
 *
 *   node scripts/browser-gate.mjs
 *   node scripts/browser-gate.mjs --keep-server   (leave it up to debug)
 *   node scripts/browser-gate.mjs --no-build      (reuse the last build)
 */

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  GATE_BASE,
  GATE_DATABASE_URL,
  GATE_LOG,
  GATE_PORT,
  ROOT,
  buildProduction,
  startDatabase,
  startServer,
  stagingEnv,
  step,
  stopDatabase,
  stopServer,
} from './e2e/stack.mjs';

const flag = (name) => process.argv.includes(`--${name}`);

const RUN_ID = process.env.E2E_RUN_ID ?? `g${Date.now().toString(36).slice(-5)}`;
const OUT = process.env.E2E_OUT ?? 'artifacts/e2e';

let server = null;
let exitCode = 1;

process.on('SIGINT', async () => {
  await stopServer(server);
  process.exit(130);
});

try {
  /* ---- 1 · build ------------------------------------------------- */
  if (flag('no-build')) {
    step('1 · production build — skipped (--no-build)');
  } else {
    step('1 · production build');
    buildProduction();
  }

  /* ---- 2 · isolated database ------------------------------------- */
  step('2 · isolated sandbox PostgreSQL');
  startDatabase({ fresh: flag('fresh-db') });
  console.log(`  ${GATE_DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);

  /* ---- 3 · the built server -------------------------------------- */
  step(`3 · next start on ${GATE_BASE}`);
  /*
   * A fresh log per run. The harness reads sign-in codes out of it, and
   * a code left over from the previous run is a code that no longer
   * matches any live challenge — which reads as a broken sign-in.
   */
  rmSync(GATE_LOG, { force: true });
  server = await startServer({ port: GATE_PORT, log: GATE_LOG });

  /* ---- 4 · the browser gate -------------------------------------- */
  step('4 · headless Playwright against the built server');
  /*
   * Clear the evidence directory first. A screenshot left over from an
   * earlier run sits beside this run's and looks exactly like it — which
   * is the worst possible property for a directory somebody reads to
   * decide whether the thing works.
   */
  rmSync(join(ROOT, OUT), { recursive: true, force: true });
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'browser-e2e.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: stagingEnv({
      BASE_URL: GATE_BASE,
      SERVER_LOG: GATE_LOG,
      E2E_RUN_ID: RUN_ID,
      E2E_OUT: OUT,
      // The gate's own cluster, so `grant-role` acts on the database the
      // server is actually serving.
      DATABASE_URL: GATE_DATABASE_URL,
    }),
  });
  exitCode = run.status ?? 1;
} catch (error) {
  console.error(`\ngate failed to start: ${error.message}`);
  exitCode = 1;
} finally {
  if (server && !flag('keep-server')) {
    step('teardown');
    await stopServer(server);
    if (!flag('keep-db')) stopDatabase();
  } else if (server) {
    console.log(`\nserver left running on ${GATE_BASE} (pid ${server.child.pid})`);
  }
}

process.exit(exitCode);
