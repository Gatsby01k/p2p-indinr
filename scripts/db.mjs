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

export const DATABASE_URL = `postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DB}`;

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
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1200 });
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

  const client = new pg.Client({ connectionString: DATABASE_URL });
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
    console.log(applied ? `${applied} migration(s) applied` : 'schema up to date');
  } finally {
    await client.end();
  }
}

async function reset() {
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
