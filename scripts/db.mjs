#!/usr/bin/env node
/**
 * Sandbox database lifecycle.
 *
 * Runs a REAL PostgreSQL 18.4 server from the `embedded-postgres` package —
 * actual server binaries, not an emulation — so migrations, transactions,
 * `FOR UPDATE` and genuinely concurrent sessions all behave as they will in
 * production. No system PostgreSQL, Docker or Homebrew install is required,
 * which matters because none is available in this environment.
 *
 *   node scripts/db.mjs start      start (initialising on first run) and migrate
 *   node scripts/db.mjs stop       stop the server
 *   node scripts/db.mjs migrate    apply pending migrations
 *   node scripts/db.mjs reset      destroy the data directory and rebuild
 *   node scripts/db.mjs status     report whether the server answers
 *   node scripts/db.mjs url        print the connection URL
 *
 * The data directory (`.sandbox-db/`) is git-ignored. It holds sandbox
 * fixtures only and can be deleted at any time.
 */

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, '.sandbox-db', 'data');
const RUN_DIR = path.join(ROOT, '.sandbox-db');
const PORT = Number(process.env.SANDBOX_PG_PORT ?? 55433);
const USER = 'inrp2p_sandbox';
const PASSWORD = 'sandbox-local-only';
const DB = 'inrp2p_sandbox';

/**
 * Load `.env.local`, the way `next dev` already does.
 *
 * Without this, pointing a migration at a hosted database means typing the
 * connection string into the terminal:
 *
 *     DATABASE_URL='postgres://user:PASSWORD@host/db' npm run db:migrate
 *
 * which writes the password into shell history, into the process list where
 * any other program on the machine can read it, and often into a screen
 * recording or a pasted snippet. Reading it from the same git-ignored file
 * the app already uses removes every one of those.
 *
 * A real environment variable still wins, so CI — which injects secrets
 * properly — is unaffected. Deliberately minimal: `KEY=value`, `#` comments,
 * and one level of surrounding quotes. Anything more elaborate belongs in a
 * dependency, and this script has none.
 */
function loadEnvLocal() {
  const file = path.join(ROOT, '.env.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    // An exported variable is the operator's explicit instruction for this
    // one run; a file is a default. The instruction wins.
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvLocal();

/** The embedded database this script can start and stop locally. */
export const LOCAL_URL = `postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DB}`;

/**
 * The database commands act on.
 *
 * `DATABASE_URL` wins when set — from the real environment or from
 * `.env.local` — so `npm run db:migrate` can target a hosted PostgreSQL for
 * a deployment. `start`/`stop`/`reset` only ever manage the LOCAL embedded
 * server and refuse to touch a remote one.
 */
export const DATABASE_URL = process.env.DATABASE_URL || LOCAL_URL;

function isRemote(url) {
  try {
    const h = new URL(url).hostname;
    return !(h === 'localhost' || h === '127.0.0.1' || h === '::1');
  } catch {
    return false;
  }
}

/** Hosted providers require TLS; the embedded local server does not offer it. */
function clientConfig(url) {
  return isRemote(url)
    ? { connectionString: url, ssl: { rejectUnauthorized: false } }
    : { connectionString: url };
}

const NATIVE = path.join(ROOT, 'node_modules', '@embedded-postgres', 'darwin-arm64', 'native');
const BIN = path.join(NATIVE, 'bin');

function bin(name) {
  const p = path.join(BIN, name);
  if (!existsSync(p)) {
    console.error(
      `PostgreSQL binary not found: ${p}\n` +
        'Install it with: npm install --save-dev embedded-postgres',
    );
    process.exit(2);
  }
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isUp() {
  const client = new pg.Client({ ...clientConfig(LOCAL_URL), connectionTimeoutMillis: 1200 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

function initdb() {
  mkdirSync(RUN_DIR, { recursive: true });
  const pwFile = path.join(RUN_DIR, 'pw.txt');
  writeFileSync(pwFile, PASSWORD, { mode: 0o600 });
  const r = spawnSync(
    bin('initdb'),
    ['-D', DATA_DIR, '-U', USER, '--pwfile', pwFile, '-E', 'UTF8', '--no-locale'],
    { encoding: 'utf8' },
  );
  rmSync(pwFile, { force: true });
  if (r.status !== 0) {
    console.error(r.stdout || '', r.stderr || '');
    throw new Error(`initdb failed (status ${r.status})`);
  }
}

async function start() {
  if (isRemote(DATABASE_URL)) {
    console.error(
      `DATABASE_URL points at a remote host (${new URL(DATABASE_URL).host}).\n` +
        'This command only manages the LOCAL embedded server. Use `db:migrate` to\n' +
        'apply migrations to a hosted database.',
    );
    process.exit(2);
  }
  if (await isUp()) {
    console.log(`sandbox database already running on port ${PORT}`);
    return;
  }
  if (!existsSync(DATA_DIR)) {
    console.log('initialising sandbox data directory…');
    initdb();
  }

  const log = path.join(RUN_DIR, 'postgres.log');
  const child = spawn(
    bin('postgres'),
    ['-D', DATA_DIR, '-p', String(PORT), '-k', RUN_DIR, '-c', 'listen_addresses=127.0.0.1'],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore'] },
  );
  child.unref();
  writeFileSync(path.join(RUN_DIR, 'postmaster.pid.own'), String(child.pid));

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await isUp()) break;
    // The very first connection also has to create the database.
    await ensureDatabase();
    if (await isUp()) break;
    await sleep(500);
  }
  if (!(await isUp())) {
    console.error(`server did not become ready; see ${log}`);
    process.exit(1);
  }
  console.log(`sandbox database ready on port ${PORT}`);
}

/** `initdb -U` creates a role and a same-named database; ours differs. */
async function ensureDatabase() {
  const admin = new pg.Client({
    connectionString: `postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/postgres`,
    connectionTimeoutMillis: 1200,
  });
  try {
    await admin.connect();
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB]);
    if (rowCount === 0) await admin.query(`CREATE DATABASE ${DB} OWNER ${USER}`);
  } catch {
    /* server not up yet — the caller retries */
  } finally {
    await admin.end().catch(() => {});
  }
}

function stop() {
  if (isRemote(DATABASE_URL)) {
    console.error('DATABASE_URL is remote; refusing to stop anything.');
    process.exit(2);
  }
  if (!existsSync(DATA_DIR)) {
    console.log('no data directory; nothing to stop');
    return;
  }
  const r = spawnSync(bin('pg_ctl'), ['-D', DATA_DIR, '-m', 'fast', 'stop'], { encoding: 'utf8' });
  console.log(r.stdout?.trim() || r.stderr?.trim() || 'stopped');
}

async function migrate() {
  const dir = path.join(ROOT, 'db', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const target = DATABASE_URL;
  if (isRemote(target)) {
    console.log(`migrating REMOTE database: ${new URL(target).host}`);
  }
  const client = new pg.Client(clientConfig(target));
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migration (
        filename    TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    let applied = 0;
    for (const f of files) {
      const { rowCount } = await client.query(
        'SELECT 1 FROM public.schema_migration WHERE filename = $1',
        [f],
      );
      if (rowCount) continue;

      const sql = readFileSync(path.join(dir, f), 'utf8');
      // Each migration is one transaction: it applies completely or not at all.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migration (filename) VALUES ($1)', [f]);
        await client.query('COMMIT');
        console.log(`  applied ${f}`);
        applied += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  FAILED  ${f}\n${err.message}`);
        process.exitCode = 1;
        return;
      }
    }
    /*
     * RECORD THE SCHEMA VERSION AND ITS CHECKSUM.
     *
     * The application compares this at readiness and refuses to serve if
     * it does not match what the build expects — a web process running
     * against a database it was not built for is how a "successful"
     * deploy silently writes the wrong shape.
     *
     * The checksum covers the CONTENT of every applied migration, not
     * just their names, so a file edited after it was applied is caught
     * rather than assumed identical.
     */
    const digest = createHash('sha256');
    for (const f of files) digest.update(readFileSync(path.join(dir, f)));
    const checksum = digest.digest('hex');
    const version = files.length;

    await client.query(
      `INSERT INTO sandbox.schema_state (singleton, version, checksum, applied_at)
       VALUES (TRUE, $1, $2, now())
       ON CONFLICT (singleton) DO UPDATE
         SET version = EXCLUDED.version, checksum = EXCLUDED.checksum,
             applied_at = EXCLUDED.applied_at`,
      [version, checksum],
    );

    console.log(applied ? `${applied} migration(s) applied` : 'schema up to date');
    console.log(`schema v${version} checksum ${checksum.slice(0, 12)}…`);
  } finally {
    await client.end();
  }
}

async function reset() {
  if (isRemote(DATABASE_URL)) {
    console.error('DATABASE_URL is remote; refusing to destroy a hosted database.');
    process.exit(2);
  }
  stop();
  rmSync(path.join(ROOT, '.sandbox-db'), { recursive: true, force: true });
  await start();
  await migrate();
}

const cmd = process.argv[2] ?? 'start';

switch (cmd) {
  case 'start':
    await start();
    await ensureDatabase();
    await migrate();
    break;
  case 'stop':
    stop();
    break;
  case 'migrate':
    await migrate();
    break;
  case 'reset':
    await reset();
    break;
  case 'status':
    console.log((await isUp()) ? 'up' : 'down');
    process.exit((await isUp()) ? 0 : 1);
    break;
  case 'url':
    console.log(DATABASE_URL);
    break;
  default:
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
}
