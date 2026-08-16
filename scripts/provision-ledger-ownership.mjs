#!/usr/bin/env node
/**
 * Migrate the ledger schema on MANAGED PostgreSQL, where nobody is superuser.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  WHY THIS EXISTS AND WHY IT IS NOT A MIGRATION.                  │
 * │                                                                  │
 * │  Migration 0008 transfers three SECURITY DEFINER ledger          │
 * │  functions to `inrp2p_boundary`, then revokes them from PUBLIC   │
 * │  and grants EXECUTE to `inrp2p_app`. All three operations are    │
 * │  owner-only, and a SUPERUSER bypasses every one of the checks —  │
 * │  which is why the local gate, running against an embedded        │
 * │  cluster whose owner IS a superuser, has always passed, and why  │
 * │  the same migration fails on Neon, RDS and Cloud SQL.            │
 * │                                                                  │
 * │  The privileges below cannot live in migration history: 0008 is  │
 * │  already applied in some populations, and editing an applied     │
 * │  migration is exactly the divergence `0015` exists to repair.    │
 * │  They are also not something to leave switched on. So they are   │
 * │  granted here, held only for the length of the migration, and    │
 * │  withdrawn in a `finally` that runs even when the migration      │
 * │  fails — like `provision-roles.mjs`, an out-of-band step the     │
 * │  deployment procedure names explicitly.                          │
 * └──────────────────────────────────────────────────────────────────┘
 *
 *   node scripts/provision-ledger-ownership.mjs
 *
 * Safe to re-run. On a cluster whose owner is a superuser it is a no-op
 * with a note, because none of these grants change anything there.
 */

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_CLI = path.join(ROOT, 'scripts/db.mjs');

/**
 * Ask the migrator which database it is going to talk to.
 *
 * ⚠ ASKED, NOT IMPORTED. `db.mjs` dispatches its CLI at module scope, so
 * `import`ing it for the constant runs a command — with no argv it defaults
 * to `start`, which refuses on a remote host and exits. Its `url` subcommand
 * exists for exactly this, and going through it keeps one resolution of
 * `DATABASE_URL` (environment, then `.env.local`) rather than a second copy
 * here that could drift.
 */
function resolveDatabaseUrl() {
  const probe = spawnSync(process.execPath, [DB_CLI, 'url'], { cwd: ROOT, encoding: 'utf8' });
  const url = (probe.stdout ?? '').trim();
  if (probe.status !== 0 || url.length === 0) {
    throw new Error(`could not resolve DATABASE_URL from db.mjs: ${probe.stderr?.trim() ?? ''}`);
  }
  return url;
}

const DATABASE_URL = resolveDatabaseUrl();

/**
 * Held only while 0008 runs.
 *
 * `INHERIT`, not merely `SET`. PostgreSQL tests ownership with
 * `has_privs_of_role()`, which respects INHERIT and ignores SET — so a
 * membership granted `SET TRUE, INHERIT FALSE` lets you `SET ROLE` to the
 * owner and still refuses every owner-only statement. That distinction is
 * the whole reason 0008 fails twice rather than once.
 */
const DURING_MIGRATION = [
  'GRANT inrp2p_boundary TO CURRENT_USER WITH INHERIT TRUE, SET TRUE',
  'GRANT CREATE ON SCHEMA inrp2p TO inrp2p_boundary',
];

const AFTER_MIGRATION = [
  'REVOKE CREATE ON SCHEMA inrp2p FROM inrp2p_boundary',
  /*
   * Back to SET-only. Leaving the connecting role able to ACT as
   * `inrp2p_boundary` would hand it direct DML on every money table, which
   * is precisely the escalation the role split exists to prevent — the
   * boundary's authority is meant to be reachable only by calling one of
   * the three definer functions.
   */
  'GRANT inrp2p_boundary TO CURRENT_USER WITH INHERIT FALSE, SET TRUE',
];

/**
 * Needed for as long as the application connects as this role.
 *
 * `inrp2p_app` is the APPLICATION's own privilege set — EXECUTE on the
 * three definer functions and DML on `inrp2p.value_lock`, nothing more. It
 * is not an escalation; it is the authority the app is supposed to have,
 * and PostgreSQL 16 withheld it only because a CREATEROLE-created role is
 * granted back to its creator with `inherit=false`.
 *
 * The better end state is the one 0013 designs for: the app connects as
 * `inrp2p_web` with its own password (see `provision-roles.mjs`) and this
 * grant becomes unnecessary. Until then, without it `post_entry` and
 * `ensure_accounts` raise `permission denied` on the first funded deal.
 */
const RUNTIME = ['GRANT inrp2p_app TO CURRENT_USER WITH INHERIT TRUE'];

function announce(url) {
  const { host } = new URL(url);
  const remote = !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(new URL(url).hostname);
  // The host, never the credential in front of it.
  console.log(`${remote ? '⚠ REMOTE' : 'local'} database: ${host}`);
  return remote;
}

async function run(client, statements) {
  for (const sql of statements) {
    await client.query(sql);
    console.log(`  ok  ${sql}`);
  }
}

async function migrate() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DB_CLI, 'migrate'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main() {
  announce(DATABASE_URL);

  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('127.0.0.1') ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();

  const { rows } = await client.query(
    'SELECT current_user AS who, usesuper AS superuser FROM pg_user WHERE usename = current_user',
  );
  const { who, superuser } = rows[0] ?? { who: 'unknown', superuser: false };
  console.log(`connected as ${who}${superuser ? ' (superuser — these grants are a no-op)' : ''}`);

  let code = 1;
  try {
    console.log('\n── temporary privileges');
    await run(client, DURING_MIGRATION);

    console.log('\n── migrating');
    code = await migrate();
  } finally {
    /*
     * ALWAYS. A failed migration must not leave `CREATE` on the ledger
     * schema behind, and the next attempt re-grants it anyway.
     */
    console.log('\n── withdrawing temporary privileges');
    await run(client, AFTER_MIGRATION);
  }

  if (code === 0) {
    console.log('\n── runtime privileges for the connecting role');
    await run(client, RUNTIME);

    const check = await client.query(`
      SELECT has_function_privilege(
               current_user,
               'inrp2p.post_entry(TEXT, JSONB, UUID[], NUMERIC[])',
               'EXECUTE') AS can_post,
             (SELECT count(*)::int FROM public.schema_migration) AS applied`);
    const { can_post: canPost, applied } = check.rows[0];
    console.log(`\nmigrations applied: ${applied}`);
    console.log(`${who} may execute inrp2p.post_entry: ${canPost}`);
    if (!canPost) {
      console.error(
        '\nThe ledger is unreachable from the connecting role. Point DATABASE_URL at\n' +
          '`inrp2p_web` (see scripts/provision-roles.mjs) before serving traffic.',
      );
      code = 1;
    }
  }

  await client.end();
  process.exit(code);
}

await main();
