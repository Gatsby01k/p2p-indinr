#!/usr/bin/env node
/**
 * The upgrade drill: migrate to the DEL-08 baseline, seed, then upgrade.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  AN EMPTY-DATABASE MIGRATION TEST PROVES ALMOST NOTHING.         │
 * │                                                                  │
 * │  The migrations that break in production are the ones that add a │
 * │  NOT NULL column to a table with rows, or a CHECK that existing  │
 * │  data violates, or a UNIQUE index over values that are already   │
 * │  duplicated. None of that can fail on an empty schema.           │
 * │                                                                  │
 * │  So this stops at the previous accepted baseline, writes         │
 * │  representative rows, and only then applies the new migrations — │
 * │  which is the sequence a real deployment performs.               │
 * └──────────────────────────────────────────────────────────────────┘
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const { Client } = pg;

/** The last migration in the accepted DEL-08 baseline. */
const BASELINE = '0012_del08_risk_control.sql';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://inrp2p_sandbox:sandbox-local-only@127.0.0.1:55433/inrp2p_sandbox';

function run(args, env = {}) {
  return execFileSync('node', args, {
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
}

async function main() {
  const migrations = readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort();
  const baselineIndex = migrations.indexOf(BASELINE);
  if (baselineIndex < 0) throw new Error(`baseline ${BASELINE} not found`);

  const after = migrations.slice(baselineIndex + 1);
  if (after.length === 0) {
    console.log('no migrations after the baseline; nothing to drill');
    return;
  }

  console.log(`baseline: ${BASELINE}`);
  console.log(`upgrading through: ${after.join(', ')}\n`);

  /* ---- 1. Start the database, then RESET IT TO EMPTY ---- */
  run(['scripts/db.mjs', 'start']);

  /*
   * `db.mjs start` applies every migration, which would make this drill
   * pass vacuously: everything would already be at the head, the
   * "upgrade" step would be a no-op, and the seeded rows would never
   * have been written under the baseline schema. (The first version of
   * this script did exactly that and reported success.)
   *
   * So the database is dropped and recreated here, and only the
   * baseline migrations are applied below.
   */
  const adminUrl = DATABASE_URL.replace(/\/[^/?]*(\?|$)/, '/postgres$1');
  const appDb = new URL(DATABASE_URL).pathname.replace(/^\//, '');
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [appDb],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${appDb}`);
  await admin.query(`CREATE DATABASE ${appDb}`);
  await admin.end();

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migration (
      filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

  const { readFileSync } = await import('node:fs');
  for (const file of migrations.slice(0, baselineIndex + 1)) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM public.schema_migration WHERE filename = $1',
      [file],
    );
    if (rowCount) continue;
    await client.query('BEGIN');
    await client.query(readFileSync(join('db/migrations', file), 'utf8'));
    await client.query('INSERT INTO public.schema_migration (filename) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log(`  baseline ${file}`);
  }

  /* ---- 2. Representative data, written as the baseline schema ---- */
  const { rows: users } = await client.query(
    `INSERT INTO sandbox.app_user (email, display_name)
     VALUES ('upgrade-a@example.com','Upgrade A'), ('upgrade-b@example.com','Upgrade B')
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING user_id`,
  );
  const [a, b] = users.map((u) => u.user_id);

  await client.query(
    `INSERT INTO sandbox.audit_event (actor_id, action, subject_kind, subject_id, outcome)
     VALUES ($1,'UPGRADE_DRILL','user',$1,'OK')`,
    [a],
  );
  /*
   * An outbox row written BEFORE the delivery columns existed. Migration
   * 0013 adds `state`, `attempts` and the lease fields to this table, so
   * a row that predates them is exactly the case an empty-database test
   * cannot produce.
   */
  await client.query(
    `INSERT INTO sandbox.outbox_event (event_key, event_type, subject_kind, subject_id, payload)
     -- The test. prefix marks a drill artefact rather than a product
     -- event, so the outbox manifest test can hold every OTHER type to
     -- the declared registry. See tests/integration/outboxIntegrity.
     VALUES ($1,'test.upgrade.drill','user',$2,'{"legacy":true}'::jsonb)
     ON CONFLICT (event_key) DO NOTHING`,
    [`upgrade-drill-${Date.now()}`, b],
  );

  const before = await client.query(
    `SELECT (SELECT count(*) FROM sandbox.audit_event)  AS audit,
            (SELECT count(*) FROM sandbox.outbox_event) AS outbox`,
  );
  await client.end();

  /* ---- 3. Apply the new migrations over that data ---- */
  run(['scripts/db.mjs', 'migrate']);

  /* ---- 4. Verify nothing was lost or silently rewritten ---- */
  const check = new Client({ connectionString: DATABASE_URL });
  await check.connect();

  const problems = [];
  const after2 = await check.query(
    `SELECT (SELECT count(*) FROM sandbox.audit_event)  AS audit,
            (SELECT count(*) FROM sandbox.outbox_event) AS outbox`,
  );
  if (Number(after2.rows[0].audit) < Number(before.rows[0].audit)) {
    problems.push('audit rows were lost');
  }
  if (Number(after2.rows[0].outbox) < Number(before.rows[0].outbox)) {
    problems.push('outbox rows were lost');
  }

  // The pre-existing outbox row must have acquired a sane delivery
  // state rather than a NULL that breaks the worker's first pass.
  const legacy = await check.query(
    `SELECT state, attempts FROM sandbox.outbox_event
      WHERE payload->>'legacy' = 'true' LIMIT 1`,
  );
  if (legacy.rows.length === 0) problems.push('the pre-upgrade outbox row is missing');
  else if (legacy.rows[0].state !== 'PENDING') {
    problems.push(`pre-upgrade outbox row has state=${legacy.rows[0].state}, expected PENDING`);
  }

  const version = await check.query(`SELECT version, checksum FROM sandbox.schema_state`);
  if (version.rows.length === 0) problems.push('schema_state was not written');

  // And the ledger still balances after the upgrade.
  const zeroSum = await check.query(
    `SELECT count(*)::int AS n FROM (
       SELECT asset FROM inrp2p.posting GROUP BY asset HAVING sum(amount_minor) <> 0) t`,
  );
  if (Number(zeroSum.rows[0].n) > 0) problems.push('the ledger does not balance after upgrade');

  await check.end();

  if (problems.length > 0) {
    for (const p of problems) console.error(`  UPGRADE PROBLEM: ${p}`);
    process.exit(1);
  }

  console.log('\nupgrade drill passed:');
  console.log(`  schema v${version.rows[0].version} checksum ${version.rows[0].checksum.slice(0, 12)}…`);
  console.log(`  audit ${before.rows[0].audit} → ${after2.rows[0].audit}`);
  console.log(`  outbox ${before.rows[0].outbox} → ${after2.rows[0].outbox}`);
  console.log('  pre-upgrade outbox row carried forward as PENDING');
  console.log('  ledger balances per asset');
}

main().catch((error) => {
  console.error('upgrade drill failed:', error.message);
  process.exit(1);
});
