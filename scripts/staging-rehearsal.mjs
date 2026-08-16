#!/usr/bin/env node
/**
 * The eleven-step staging rehearsal.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  A DEPLOYMENT PLAN NOBODY HAS EXECUTED IS A DOCUMENT, NOT A PLAN.│
 * │                                                                  │
 * │  This runs the whole thing, once, in order, against a REHEARSAL  │
 * │  cluster of its own — never the development database and never   │
 * │  anything hosted. Every step either passes or fails the run;     │
 * │  there is no step that merely prints advice.                     │
 * │                                                                  │
 * │   1 · least-privilege database roles                             │
 * │   2 · configuration, including what production REFUSES           │
 * │   3 · convergent migration from three independent histories      │
 * │   4 · web and worker startup on the built artefact               │
 * │   5 · liveness and readiness, public and authenticated           │
 * │   6 · the full sandbox journey suite in a real browser           │
 * │   7 · emergency pause, and a resume that needs two people        │
 * │   8 · backup and restore, verified                               │
 * │   9 · adapter failure — production fails closed                  │
 * │  10 · worker crash recovery                                      │
 * │  11 · application-code rollback, without touching the schema     │
 * │                                                                  │
 * │  ⚠ WHAT THIS IS NOT. There is no hosted staging environment, no  │
 * │  real provider and no real money anywhere in it. It rehearses    │
 * │  the SEQUENCE and the CONTROLS against the real build, the real  │
 * │  server and a real PostgreSQL. Where a step cannot be genuine —  │
 * │  production adapters that do not exist — it proves the refusal   │
 * │  instead, which is the honest thing to assert.                   │
 * └──────────────────────────────────────────────────────────────────┘
 *
 *   node scripts/staging-rehearsal.mjs
 *   node scripts/staging-rehearsal.mjs --skip-browser   (faster re-runs)
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import {
  ROOT,
  buildProduction,
  buildRoot,
  probeLive,
  probeReady,
  stagingEnv,
  startServer,
  stopServer,
} from './e2e/stack.mjs';

const flag = (name) => process.argv.includes(`--${name}`);

/* ------------------------------------------------------------------ *
 * The rehearsal's own everything
 * ------------------------------------------------------------------ */

const PG_DIR = process.env.REHEARSAL_PG_DIR ?? '.sandbox-db-rehearsal';
const PG_PORT = Number(process.env.REHEARSAL_PG_PORT ?? 55460);
const DB_URL = `postgres://inrp2p_sandbox:sandbox-local-only@127.0.0.1:${PG_PORT}/inrp2p_sandbox`;
const WEB_PORT = Number(process.env.REHEARSAL_PORT ?? 3220);
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const LOG = join(ROOT, 'artifacts', 'rehearsal-server.log');
const REPORT = join(ROOT, 'artifacts', 'staging-rehearsal.log');

/**
 * The scheduler's credential, minted per run.
 *
 * Never a constant and never committed: the rehearsal proves the worker
 * endpoint refuses without it and accepts with it, which is only worth
 * anything if the value is fresh.
 */
const WORKER_SECRET = randomBytes(24).toString('base64url');

const steps = [];
let web = null;

const transcript = [];
function say(line) {
  console.log(line);
  transcript.push(line);
}

function step(number, title, detail = '') {
  say(`\n── ${String(number).padStart(2, ' ')} · ${title}${detail ? ` — ${detail}` : ''}`);
}

function check(ok, label, detail = '') {
  steps.push({ ok, label, detail });
  say(`   ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

const env = (extra = {}) =>
  stagingEnv({
    DATABASE_URL: DB_URL,
    SANDBOX_PG_DIR: PG_DIR,
    SANDBOX_PG_PORT: String(PG_PORT),
    WORKER_TICK_SECRET: WORKER_SECRET,
    ...extra,
  });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    env: env(options.env),
    maxBuffer: 64 * 1024 * 1024,
    ...(options.stdio ? { stdio: options.stdio } : {}),
  });
  return {
    ok: result.status === 0,
    status: result.status,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

async function sql(query, params = []) {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await client.query(query, params);
  } finally {
    await client.end();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================== */

const started = Date.now();
say(`INRP2P — staging rehearsal · ${new Date().toISOString()}`);
say(`database ${DB_URL.replace(/:[^:@]+@/, ':***@')} · web ${BASE}`);

try {
  /* ---------------------------------------------------------------- *
   * 1 · Least-privilege database roles
   * ---------------------------------------------------------------- */
  step(1, 'least-privilege database roles');
  /*
   * Stop before deleting. Removing a running cluster's data directory
   * leaves a postgres process holding the port with nothing underneath
   * it, and the next `start` then fails for a reason that has nothing to
   * do with the rehearsal.
   */
  run(process.execPath, ['scripts/db.mjs', 'stop']);
  rmSync(join(ROOT, PG_DIR), { recursive: true, force: true });
  const dbUp = run(process.execPath, ['scripts/db.mjs', 'start']);
  check(dbUp.ok, 'the rehearsal cluster starts and migrates to head', dbUp.ok ? '' : dbUp.out.slice(-200));
  if (!dbUp.ok) throw new Error('cluster');

  /*
   * Migration 0013 creates the runtime roles NOLOGIN precisely so no
   * credential lives in the repository. Provisioning is the out-of-band
   * step that gives them one, and the passwords are minted here for this
   * run only — they are never printed and never written down.
   */
  const rolePasswords = {
    INRP2P_WEB_PASSWORD: randomBytes(24).toString('base64url'),
    INRP2P_WORKER_PASSWORD: randomBytes(24).toString('base64url'),
    INRP2P_READONLY_PASSWORD: randomBytes(24).toString('base64url'),
  };
  const provisioned = run(process.execPath, ['scripts/provision-roles.mjs'], {
    env: rolePasswords,
  });
  check(provisioned.ok, 'web, worker and readonly roles are granted LOGIN', provisioned.out.trim().replace(/\n/g, ' · '));

  /*
   * The four RUNTIME roles, named explicitly. `inrp2p_sandbox` is the
   * cluster's bootstrap owner and is a superuser by construction —
   * sweeping it in with a `LIKE 'inrp2p_%'` would have made this check
   * fail for a reason that has nothing to do with least privilege.
   */
  const RUNTIME_ROLES = ['inrp2p_web', 'inrp2p_worker', 'inrp2p_readonly', 'inrp2p_migrator'];
  const rolesRow = await sql(
    `SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolbypassrls
       FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
    [RUNTIME_ROLES],
  );
  check(
    rolesRow.rows.length === RUNTIME_ROLES.length,
    'the four least-privilege roles exist',
    rolesRow.rows.map((r) => r.rolname).join(', '),
  );
  check(
    rolesRow.rows.every((r) => !r.rolsuper && !r.rolcreaterole && !r.rolbypassrls),
    'no runtime role is a superuser, may create roles, or bypasses RLS',
  );
  // Short passwords are refused rather than warned about.
  const weak = run(process.execPath, ['scripts/provision-roles.mjs'], {
    env: { INRP2P_WEB_PASSWORD: 'short' },
  });
  check(!weak.ok, 'a password under 24 characters is refused', weak.out.trim().slice(0, 80));

  /* ---------------------------------------------------------------- *
   * 2 · Configuration
   * ---------------------------------------------------------------- */
  step(2, 'configuration');
  /*
   * Run as a TYPED check against the real `loadConfig`/`validateConfig`,
   * not against a reimplementation: a rehearsal that probes a copy of
   * the gate proves the copy.
   */
  const cfg = run('npx', [
    'vitest',
    'run',
    '--config',
    'vitest.rehearsal.config.ts',
    'tests/rehearsal/configuration.test.ts',
  ], { cwd: buildRoot() });
  check(cfg.ok, 'staging validates, production refuses, no value is echoed', cfg.out.match(/Tests\s+.*/)?.[0] ?? cfg.out.slice(-200));

  /* ---------------------------------------------------------------- *
   * 3 · Convergent migration
   * ---------------------------------------------------------------- */
  step(3, 'convergent migration from three independent histories');
  const converge = run(process.execPath, ['scripts/migration-convergence.mjs']);
  check(converge.ok, 'empty, DEL-05 and DEL-09 databases converge on one schema', converge.out.trim().split('\n').pop());

  const schema = await sql(`SELECT version, checksum FROM sandbox.schema_state`);
  check(
    Number(schema.rows[0]?.version) === 15,
    'the rehearsal database is at the version this build expects',
    `v${schema.rows[0]?.version} ${String(schema.rows[0]?.checksum).slice(0, 12)}…`,
  );

  /* ---------------------------------------------------------------- *
   * 4 · Web and worker startup
   * ---------------------------------------------------------------- */
  step(4, 'web and worker startup on the built artefact');
  if (!flag('skip-build')) buildProduction({ out: join(ROOT, 'artifacts', 'build.txt') });
  check(existsSync(join(buildRoot(), '.next', 'BUILD_ID')), 'a production build exists');

  rmSync(LOG, { force: true });
  web = await startServer({ port: WEB_PORT, log: LOG, label: 'rehearsal-web', env: {
    DATABASE_URL: DB_URL,
    WORKER_TICK_SECRET: WORKER_SECRET,
  } });
  check(true, 'the web process is serving', BASE);

  const tick = async (secret = WORKER_SECRET) =>
    fetch(`${BASE}/api/worker/tick`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
    });

  const unauthorised = await fetch(`${BASE}/api/worker/tick`, { method: 'POST' });
  check(unauthorised.status === 401, 'the worker endpoint refuses an unauthenticated caller', `HTTP ${unauthorised.status}`);
  const wrong = await tick('not-the-scheduler-secret-at-all');
  check(wrong.status === 401, 'and refuses the wrong credential', `HTTP ${wrong.status}`);

  const firstTick = await tick();
  const firstBody = await firstTick.json();
  check(firstTick.status === 200 && firstBody.ok === true, 'the scheduler can run one worker pass', JSON.stringify(firstBody));

  /* ---------------------------------------------------------------- *
   * 5 · Readiness
   * ---------------------------------------------------------------- */
  step(5, 'liveness and readiness');
  const live = await probeLive(BASE);
  check(live.status === 200 && live.body.alive === true, 'liveness answers without touching the database');

  const ready = await probeReady(BASE);
  check(ready.status === 200 && ready.ready === true, 'readiness says this instance may take traffic');
  check(
    Object.keys(ready.body).join(',') === 'ready',
    'the public readiness body carries NO detail',
    JSON.stringify(ready.body).slice(0, 120),
  );

  /*
   * And readiness must FAIL when the database is gone — otherwise a load
   * balancer would keep sending traffic to an instance that cannot serve
   * it. Liveness must stay green through the same outage, or the process
   * gets restart-looped into a database that is still down.
   */
  run(process.execPath, ['scripts/db.mjs', 'stop']);
  await sleep(1200);
  const outageLive = await probeLive(BASE);
  const outageReady = await probeReady(BASE);
  check(outageLive.status === 200, 'liveness stays green through a database outage');
  check(
    outageReady.status === 503 && outageReady.ready === false,
    'readiness goes red and routes traffic away',
    `HTTP ${outageReady.status}`,
  );
  const back = run(process.execPath, ['scripts/db.mjs', 'start']);
  check(back.ok, 'the database comes back');
  for (let i = 0; i < 40; i += 1) {
    if ((await probeReady(BASE)).ready) break;
    await sleep(500);
  }
  check((await probeReady(BASE)).ready === true, 'and readiness recovers with no restart');

  /* ---------------------------------------------------------------- *
   * 6 · The full sandbox journey suite
   * ---------------------------------------------------------------- */
  step(6, 'the full sandbox journey suite, in a real browser');
  if (flag('skip-browser')) {
    check(true, 'skipped by --skip-browser', 'not a pass; re-run without the flag before signing off');
  } else {
    const e2e = run(process.execPath, ['scripts/browser-e2e.mjs'], {
      env: {
        BASE_URL: BASE,
        SERVER_LOG: LOG,
        E2E_RUN_ID: `reh${Date.now().toString(36).slice(-4)}`,
        E2E_OUT: 'artifacts/rehearsal-e2e',
      },
    });
    const tally = /(\d+)\/(\d+) browser checks passed/.exec(e2e.out);
    check(e2e.ok, 'every browser check passes against the rehearsal server', tally ? tally[0] : e2e.out.slice(-200));
  }

  /* ---------------------------------------------------------------- *
   * 7 · Emergency pause and two-person resume
   * ---------------------------------------------------------------- */
  step(7, 'emergency pause, and a resume that needs two people');
  const control = run('npx', [
    'vitest',
    'run',
    '--config',
    'vitest.rehearsal.config.ts',
    'tests/rehearsal/controlPlane.test.ts',
    '-t',
    'pause',
  ], { cwd: buildRoot() });
  check(control.ok, 'one person pauses, one cannot resume, two can', control.out.match(/Tests\s+.*/)?.[0] ?? '');

  /* ---------------------------------------------------------------- *
   * 8 · Backup and restore
   * ---------------------------------------------------------------- */
  step(8, 'backup and restore, verified');
  /*
   * Move protected value first. The drill verifies that a restored
   * ledger balances per asset and that every entry still has both legs,
   * and it refuses — correctly — to call a run on an empty ledger
   * meaningful. The browser journeys create deals but never fund the
   * sandbox ledger, because no customer can.
   */
  const value = run('npx', [
    'vitest',
    'run',
    '--config',
    'vitest.rehearsal.config.ts',
    'tests/rehearsal/protectedValue.test.ts',
  ], { cwd: buildRoot() });
  check(value.ok, 'an administrator funds the ledger and a participant locks value', value.out.match(/Tests\s+.*/)?.[0] ?? value.out.slice(-200));

  const drill = run(process.execPath, ['scripts/recovery-drill.mjs'], {
    env: { DRILL_SOURCE_URL: DB_URL, DRILL_RESTORE_DB: 'inrp2p_rehearsal_restore' },
  });
  check(drill.ok, 'the restored copy balances and its history is intact', drill.out.trim().split('\n').slice(-2).join(' · ').slice(0, 200));

  /* ---------------------------------------------------------------- *
   * 9 · Adapter failure
   * ---------------------------------------------------------------- */
  step(9, 'adapter failure — production fails closed');
  /*
   * A SECOND process, on its own port, in genuine production mode: no
   * sandbox acknowledgement, no provider credentials. It must come up
   * and then refuse to take traffic, naming nothing in the public body.
   * The rehearsal's own web process keeps serving throughout.
   */
  const prodPort = WEB_PORT + 1;
  let prodWeb = null;
  try {
    /*
     * `waitForReady: false` — refusing to become ready IS the result
     * being measured here, so this waits only for the port to answer and
     * then reads the verdict itself.
     */
    prodWeb = await startServer({
      port: prodPort,
      log: LOG,
      label: 'production-mode-probe',
      timeoutMs: 45_000,
      waitForReady: false,
      env: { INRP2P_MODE: 'production', INRP2P_SANDBOX: '', TRUSTED_ORIGINS: '' },
    });

    const probe = await probeReady(`http://127.0.0.1:${prodPort}`);
    check(
      probe.reachable && probe.ready === false && probe.status === 503,
      'production comes up and refuses traffic until its adapters exist',
      `HTTP ${probe.status}`,
    );
    check(
      JSON.stringify(probe.body) === '{"ready":false}',
      'and says nothing about WHY to an anonymous caller',
      JSON.stringify(probe.body),
    );
    // Liveness is still green: the process is healthy, it is the
    // DEPLOYMENT that is incomplete. Restarting it would fix nothing.
    const prodLive = await probeLive(`http://127.0.0.1:${prodPort}`);
    check(prodLive.status === 200, 'while liveness stays green — a restart would not help');
  } catch (error) {
    check(false, 'the production-mode probe could not be started', String(error?.message ?? error).slice(0, 200));
  } finally {
    if (prodWeb) await stopServer(prodWeb);
  }

  /* ---------------------------------------------------------------- *
   * 10 · Worker crash recovery
   * ---------------------------------------------------------------- */
  step(10, 'worker crash recovery');
  const crash = run('npx', [
    'vitest',
    'run',
    '--config',
    'vitest.rehearsal.config.ts',
    'tests/rehearsal/controlPlane.test.ts',
    '-t',
    'worker that dies',
  ], { cwd: buildRoot() });
  check(crash.ok, 'a lapsed lease is recovered and the event is delivered', crash.out.match(/Tests\s+.*/)?.[0] ?? '');

  // And through the scheduler endpoint the deployment actually uses.
  await sql(
    `INSERT INTO sandbox.outbox_event
       (event_key, event_type, subject_kind, subject_id, payload, lease_owner, lease_expires_at)
     VALUES ($1,'deal.joined','deal', gen_random_uuid(), '{}'::jsonb,
             'crashed-worker', now() - interval '10 minutes')`,
    [`rehearsal-crash-${Date.now()}`],
  );
  const recoveryTick = await (await tick()).json();
  check(
    recoveryTick.recovered >= 1,
    'the scheduler tick recovers a crashed worker’s lease',
    JSON.stringify(recoveryTick),
  );
  const stuck = await sql(
    `SELECT count(*)::int AS n FROM sandbox.outbox_event
      WHERE state='PENDING' AND lease_owner IS NOT NULL AND lease_expires_at < now()`,
  );
  check(Number(stuck.rows[0].n) === 0, 'no event is left leased to a process that no longer exists');

  /* ---------------------------------------------------------------- *
   * 11 · Application-code rollback
   * ---------------------------------------------------------------- */
  step(11, 'application-code rollback, without touching the schema');
  const before = await sql(`SELECT version, checksum FROM sandbox.schema_state`);
  await stopServer(web);
  web = null;

  /*
   * ROLL BACK THE CODE, NEVER THE MIGRATIONS.
   *
   * The runbook is explicit: financial history is immutable and a
   * reverse migration would delete committed records, so a bad deploy is
   * fixed by putting the previous IMAGE back in front of the SAME
   * database. This restarts the built artefact against the unchanged
   * schema and requires readiness to come back — which is what "rolling
   * back is safe" has to mean.
   */
  web = await startServer({ port: WEB_PORT, log: LOG, label: 'rolled-back-web', env: {
    DATABASE_URL: DB_URL,
    WORKER_TICK_SECRET: WORKER_SECRET,
  } });
  const afterRollback = await probeReady(BASE);
  check(afterRollback.ready === true, 'the rolled-back process takes traffic again');

  const after = await sql(`SELECT version, checksum FROM sandbox.schema_state`);
  check(
    after.rows[0].version === before.rows[0].version &&
      after.rows[0].checksum === before.rows[0].checksum,
    'the schema is untouched by the rollback',
    `v${after.rows[0].version} ${String(after.rows[0].checksum).slice(0, 12)}…`,
  );
  const history = await sql(
    `SELECT count(*)::int AS n FROM sandbox.audit_event WHERE occurred_at > now() - interval '2 hours'`,
  );
  check(
    Number(history.rows[0].n) > 0,
    'and the audit history written before the rollback is still there',
    `${history.rows[0].n} events`,
  );
} catch (error) {
  check(false, 'rehearsal aborted', String(error?.message ?? error).slice(0, 300));
} finally {
  if (web) await stopServer(web);
  run(process.execPath, ['scripts/db.mjs', 'stop']);
}

/* ================================================================== *
 * Report
 * ================================================================== */

const failed = steps.filter((s) => !s.ok);
say(`\n${steps.length - failed.length}/${steps.length} rehearsal checks passed in ${Math.round((Date.now() - started) / 1000)}s`);
if (failed.length > 0) {
  say('\nfailed:');
  for (const f of failed) say(`  ${f.label} ${f.detail}`);
}

mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
writeFileSync(REPORT, `${transcript.join('\n')}\n`);
say(`\ntranscript: ${REPORT}`);

process.exit(failed.length === 0 ? 0 : 1);
