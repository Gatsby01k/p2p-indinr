#!/usr/bin/env node
/**
 * Provision one migrated database per parallel test worker.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  WHY THIS EXISTS.                                                │
 * │                                                                  │
 * │  A handful of integration tests assert on state that belongs to  │
 * │  the whole deployment: the emergency pause switch, and the       │
 * │  fail-closed cases that check a refused production request wrote │
 * │  nothing ANYWHERE. Those assertions are right, and they cannot   │
 * │  survive another worker writing to the same tables at the same   │
 * │  moment.                                                         │
 * │                                                                  │
 * │  Rather than weaken them, parallel workers get real isolation —  │
 * │  a separate database each, migrated to the same schema.          │
 * └──────────────────────────────────────────────────────────────────┘
 *
 *   node scripts/test-databases.mjs 4     create/refresh 4 worker DBs
 *   node scripts/test-databases.mjs 4 --drop   remove them again
 */

import { spawnSync } from 'node:child_process';
import pg from 'pg';

const workers = Number(process.argv[2] ?? 4);
const drop = process.argv.includes('--drop');

const base = process.env.DATABASE_URL;
if (!base) {
  console.error('DATABASE_URL must be set to the base sandbox database.');
  process.exit(1);
}

const baseUrl = new URL(base);
const baseName = baseUrl.pathname.replace(/^\//, '');

/** Connect to `postgres` so the target database is not in use. */
function adminUrl() {
  const u = new URL(base);
  u.pathname = '/postgres';
  return u.toString();
}

function workerUrl(n) {
  const u = new URL(base);
  u.pathname = `/${baseName}_w${n}`;
  return u.toString();
}

const admin = new pg.Client(adminUrl());
await admin.connect();

let failed = 0;

for (let n = 1; n <= workers; n += 1) {
  const name = `${baseName}_w${n}`;
  try {
    // Terminate stragglers so DROP cannot block on an idle connection.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${JSON.stringify(name).replace(/"/g, '"')}`);
    if (drop) {
      console.log(`  dropped ${name}`);
      continue;
    }
    await admin.query(`CREATE DATABASE "${name}"`);

    // Migrate through the ordinary runner, so a worker database is
    // built the same way every other database is.
    const result = spawnSync(process.execPath, ['scripts/db.mjs', 'migrate'], {
      env: { ...process.env, DATABASE_URL: workerUrl(n) },
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      failed += 1;
      console.error(`  FAILED to migrate ${name}`);
      console.error((result.stderr || result.stdout || '').split('\n').slice(-6).join('\n'));
      continue;
    }
    console.log(`  ready ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAILED ${name}: ${error.message}`);
  }
}

await admin.end();

if (failed > 0) process.exit(1);
console.log(drop ? 'worker databases removed' : `${workers} worker database(s) ready`);
