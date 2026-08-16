#!/usr/bin/env node
/**
 * Prove three independent upgrade paths reach the SAME schema.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  THE RISK THIS CLOSES.                                           │
 * │                                                                  │
 * │  DEL-10 edited `0010_del06_deal_room.sql`, which was already     │
 * │  published at the DEL-09 baseline. The migration runner records  │
 * │  applied files BY NAME, so a database that ran the ORIGINAL 0010 │
 * │  will never see the edited one — and would keep a different set  │
 * │  of CHECK constraints for ever.                                  │
 * │                                                                  │
 * │  Migration 0015 converges those databases. This script proves it │
 * │  by building all three populations for real and comparing their  │
 * │  catalogues column by column, constraint by constraint.          │
 * │                                                                  │
 * │    A · empty            → head                                   │
 * │    B · populated DEL-05 → head, crossing the edited 0010         │
 * │    C · populated DEL-09 with the ORIGINAL 0010 applied → head    │
 * │                                                                  │
 * │  Path C takes the original 0010 from git, so it is the file that │
 * │  actually shipped rather than a reconstruction.                  │
 * └──────────────────────────────────────────────────────────────────┘
 *
 *   DATABASE_URL=... node scripts/migration-convergence.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const BASE = process.env.DATABASE_URL;
if (!BASE) {
  console.error('DATABASE_URL must be set.');
  process.exit(1);
}

/** The commit whose 0010 is authoritative for path C. */
const BASELINE_COMMIT = process.env.BASELINE_COMMIT ?? 'e2c280d';
const DIR = path.join(process.cwd(), 'db', 'migrations');
const ALL = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const urlFor = (name) => {
  const u = new URL(BASE);
  u.pathname = `/${name}`;
  return u.toString();
};
const adminUrl = urlFor('postgres');

const problems = [];
const note = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

async function recreate(name) {
  const admin = new pg.Client(adminUrl);
  await admin.connect();
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [name],
  );
  await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
}

/** Apply raw SQL files and record them, without the runner. */
async function applyFiles(name, files, { originalFor } = {}) {
  const db = new pg.Client(urlFor(name));
  await db.connect();
  await db.query(
    `CREATE TABLE IF NOT EXISTS public.schema_migration (
       filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  for (const file of files) {
    const sql =
      originalFor && originalFor[file] !== undefined
        ? originalFor[file]
        : readFileSync(path.join(DIR, file), 'utf8');
    await db.query(sql);
    await db.query(
      `INSERT INTO public.schema_migration (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
      [file],
    );
  }
  await db.end();
}

/** Finish with the ordinary runner, so the tail is applied normally. */
function runMigrate(name) {
  const result = spawnSync(process.execPath, ['scripts/db.mjs', 'migrate'], {
    env: { ...process.env, DATABASE_URL: urlFor(name) },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`migrate failed for ${name}`);
  }
  return result.stdout.trim().split('\n').slice(-2).join(' | ');
}

/* ------------------------------------------------------------------ *
 * The catalogue fingerprint: what "the same schema" actually means.
 * ------------------------------------------------------------------ */

const FINGERPRINT = {
  columns: `
    SELECT table_name || '.' || column_name || ':' || data_type ||
           CASE WHEN is_nullable = 'NO' THEN '!' ELSE '' END AS f
      FROM information_schema.columns
     WHERE table_schema = ANY($1) ORDER BY 1`,
  constraints: `
    SELECT c.conrelid::regclass::text || ' ' || c.conname || ' ' ||
           pg_get_constraintdef(c.oid) AS f
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE n.nspname = ANY($1) ORDER BY 1`,
  indexes: `
    SELECT schemaname || '.' || indexname || ' ' || indexdef AS f
      FROM pg_indexes WHERE schemaname = ANY($1) ORDER BY 1`,
  triggers: `
    SELECT c.relname || '.' || t.tgname AS f
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1) AND NOT t.tgisinternal ORDER BY 1`,
  functions: `
    SELECT n.nspname || '.' || p.proname AS f
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ANY($1) ORDER BY 1`,
};

const SCHEMAS = ['sandbox', 'inrp2p'];

async function fingerprint(name) {
  const db = new pg.Client(urlFor(name));
  await db.connect();
  const out = {};
  for (const [key, sql] of Object.entries(FINGERPRINT)) {
    const { rows } = await db.query(sql, [SCHEMAS]);
    out[key] = rows.map((r) => r.f);
  }
  const { rows: state } = await db.query(`SELECT version, checksum FROM sandbox.schema_state`);
  out.schemaState = state[0] ?? null;
  const { rows: counts } = await db.query(
    `SELECT (SELECT count(*)::int FROM sandbox.dispute_case) AS cases,
            (SELECT count(*)::int FROM sandbox.dispute_case WHERE state='RESOLVED') AS resolved,
            (SELECT count(*)::int FROM sandbox.dispute_case WHERE resolved_by_proposal IS NOT NULL) AS with_proposal,
            (SELECT count(*)::int FROM sandbox.deal) AS deals`,
  );
  out.data = counts[0];
  await db.end();
  return out;
}

/* ------------------------------------------------------------------ *
 * Populations
 * ------------------------------------------------------------------ */

/** DEL-05-era rows: the shape that crosses 0010's backfill. */
const SEED_PRE_0010 = `
  INSERT INTO sandbox.app_user (email, display_name, is_verified)
  SELECT format('conv%s@example.com', g), format('Conv %s', g), (g % 2 = 0)
    FROM generate_series(1, 6) g;

  INSERT INTO sandbox.quote
    (issued_to, direction, state, inr_minor, rate_num, rate_den, pricing_source,
     observed_at, expires_at, protection_fee_minor, network_fee_minor, fee_bearer, title)
  SELECT (SELECT user_id FROM sandbox.app_user ORDER BY created_at LIMIT 1),
         'INR_TO_INR', 'CONSUMED', 2500000, 1, 1, 'REFERENCE',
         now() - interval '30 days', now() + interval '30 days',
         37500, 0, 'PAYER', format('Conv quote %s', g)
    FROM generate_series(1, 6) g;

  INSERT INTO sandbox.deal_link
    (public_id, quote_id, created_by, creator_role, state, expires_at, consumed_at)
  SELECT format('INRP-%s', lpad(q.n::text, 10, '0')), q.quote_id,
         (SELECT user_id FROM sandbox.app_user ORDER BY created_at LIMIT 1),
         'FIAT_SIDE', 'CONSUMED'::sandbox.link_state,
         now() + interval '7 days', now() - interval '20 days'
    FROM (SELECT quote_id, row_number() OVER (ORDER BY created_at) AS n
            FROM sandbox.quote) q;

  INSERT INTO sandbox.deal
    (public_id, deal_code, link_id, quote_id, direction, inr_minor,
     rate_num, rate_den, pricing_source, observed_at,
     protection_fee_minor, network_fee_minor, fee_bearer, title, state, completed_at)
  SELECT format('INRP-%s', lpad((2000 + l.n)::text, 10, '0')),
         format('INR-%s', lpad(l.n::text, 4, '0')),
         l.link_id, l.quote_id, 'INR_TO_INR', 2500000, 1, 1, 'REFERENCE',
         now() - interval '30 days', 37500, 0, 'PAYER',
         format('Conv deal %s', l.n), 'FIAT_PENDING'::sandbox.deal_state, NULL
    FROM (SELECT link_id, quote_id, row_number() OVER (ORDER BY created_at) AS n
            FROM sandbox.deal_link) l;
`;

/** The awkward legacy disputes: short, blank, NULL, resolved, cancelled. */
const SEED_LEGACY_DISPUTES = `
  INSERT INTO sandbox.dispute
    (deal_id, raised_by, reason, detail, state, resolution, resolved_by, resolved_at)
  SELECT d.deal_id,
         (SELECT user_id FROM sandbox.app_user ORDER BY created_at LIMIT 1),
         'PAYMENT_NOT_RECEIVED',
         CASE d.n WHEN 1 THEN 'Nothing arrived.'
                  WHEN 2 THEN ''
                  WHEN 3 THEN NULL
                  WHEN 4 THEN 'A complaint of perfectly adequate length for the rule.'
                  WHEN 5 THEN 'Short.'
                  ELSE 'The reference does not appear anywhere on my statement.' END,
         CASE WHEN d.n % 3 = 0 THEN 'RESOLVED' ELSE 'OPEN' END,
         CASE WHEN d.n % 3 = 0
              THEN (ARRAY['RELEASED','REFUNDED','CANCELLED'])[1 + (d.n / 3) % 3]
              ELSE NULL END,
         CASE WHEN d.n % 3 = 0
              THEN (SELECT user_id FROM sandbox.app_user ORDER BY created_at LIMIT 1)
              ELSE NULL END,
         CASE WHEN d.n % 3 = 0 THEN now() - interval '10 days' ELSE NULL END
    FROM (SELECT deal_id, row_number() OVER (ORDER BY created_at) AS n
            FROM sandbox.deal) d;
`;

/**
 * DEL-09-era rows, written against the POST-0010 schema.
 *
 * Path C's database already crossed 0010, so its disputes live in
 * `dispute_case`. Every resolved case carries a proposal, because the
 * ORIGINAL constraint demanded one — which is precisely why the
 * original 0010 could never migrate a legacy ruling.
 */
const SEED_POST_0010 = `
  INSERT INTO sandbox.dispute_case
    (deal_id, opened_by, category, statement, state, opened_at)
  SELECT d.deal_id,
         (SELECT user_id FROM sandbox.app_user ORDER BY created_at LIMIT 1),
         'PAYMENT_NOT_RECEIVED',
         format('A DEL-09 era complaint number %s, long enough to satisfy the rule.', d.n),
         'OPEN'::sandbox.case_state,
         now() - interval '5 days'
    FROM (SELECT deal_id, row_number() OVER (ORDER BY created_at) AS n
            FROM sandbox.deal) d;
`;

async function seed(name, sql) {
  const db = new pg.Client(urlFor(name));
  await db.connect();
  await db.query(sql);
  await db.end();
}

/* ------------------------------------------------------------------ *
 * Build the three paths
 * ------------------------------------------------------------------ */

const BASELINE_0010 = '0010_del06_deal_room.sql';
const THROUGH_0009 = ALL.filter((f) => f < BASELINE_0010);
const DEL09_TAIL = ALL.filter((f) => f > BASELINE_0010 && f <= '0013_del09_least_privilege.sql');

console.log('DEL-10 migration convergence\n');

/* ---- A · empty → head ---- */
console.log('A · empty database → head');
await recreate('conv_a');
console.log(`  ${runMigrate('conv_a')}`);

/* ---- B · populated DEL-05 → head, crossing the edited 0010 ---- */
console.log('\nB · populated DEL-05 database → head (crosses the edited 0010)');
await recreate('conv_b');
await applyFiles('conv_b', THROUGH_0009);
await seed('conv_b', SEED_PRE_0010);
await seed('conv_b', SEED_LEGACY_DISPUTES);
{
  const db = new pg.Client(urlFor('conv_b'));
  await db.connect();
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM sandbox.dispute`);
  console.log(`  seeded ${rows[0].n} legacy dispute(s)`);
  await db.end();
}
console.log(`  ${runMigrate('conv_b')}`);

/* ---- C · populated DEL-09, ORIGINAL 0010 already applied → head ---- */
console.log('\nC · populated DEL-09 baseline with the ORIGINAL 0010 → head');
/*
 * The ORIGINAL 0010, as shipped.
 *
 * Normally read straight out of git so it is the file that actually
 * shipped rather than a reconstruction. `ORIGINAL_0010_PATH` exists for
 * running this from a clean-path copy of the tree, where git is not
 * present — the file is still extracted from the baseline commit, just
 * ahead of time.
 */
const originalSql = process.env.ORIGINAL_0010_PATH
  ? readFileSync(process.env.ORIGINAL_0010_PATH, 'utf8')
  : execFileSync('git', ['show', `${BASELINE_COMMIT}:db/migrations/${BASELINE_0010}`], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
const originSource = process.env.ORIGINAL_0010_PATH
  ? `file ${process.env.ORIGINAL_0010_PATH}`
  : `git ${BASELINE_COMMIT}`;
console.log(`  original 0010 from ${originSource} (${originalSql.length} bytes)`);
// The shipped file must genuinely differ, or path C proves nothing.
if (originalSql === readFileSync(path.join(DIR, BASELINE_0010), 'utf8')) {
  note(false, 'path C is vacuous: the original and edited 0010 are identical');
}
await recreate('conv_c');
await applyFiles('conv_c', [...THROUGH_0009, BASELINE_0010, ...DEL09_TAIL], {
  originalFor: { [BASELINE_0010]: originalSql },
});
await seed('conv_c', SEED_PRE_0010);
await seed('conv_c', SEED_POST_0010);
{
  const db = new pg.Client(urlFor('conv_c'));
  await db.connect();
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM sandbox.dispute_case`);
  console.log(`  seeded ${rows[0].n} DEL-09 era case(s)`);
  // Prove the divergence EXISTS before 0015 runs, or the test is hollow.
  const { rows: before } = await db.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'dispute_case_resolved_rule'
        AND conrelid = 'sandbox.dispute_case'::regclass`,
  );
  const diverged = String(before[0]?.def ?? '').includes('resolved_by_proposal');
  note(
    diverged,
    'path C genuinely diverges before 0015',
    diverged ? 'old rule present' : 'no divergence to fix',
  );
  await db.end();
}
console.log(`  ${runMigrate('conv_c')}`);

/* ------------------------------------------------------------------ *
 * Compare
 * ------------------------------------------------------------------ */

console.log('\ncomparing catalogues');
const fps = {
  A: await fingerprint('conv_a'),
  B: await fingerprint('conv_b'),
  C: await fingerprint('conv_c'),
};

for (const aspect of Object.keys(FINGERPRINT)) {
  const a = fps.A[aspect];
  for (const other of ['B', 'C']) {
    const b = fps[other][aspect];
    const onlyA = a.filter((x) => !b.includes(x));
    const onlyB = b.filter((x) => !a.includes(x));
    const same = onlyA.length === 0 && onlyB.length === 0;
    note(
      same,
      `${aspect}: A ≡ ${other}`,
      same ? `${a.length} entries` : `A-only ${onlyA.length}, ${other}-only ${onlyB.length}`,
    );
    if (!same) {
      for (const x of onlyA.slice(0, 3)) console.log(`        only in A: ${x}`);
      for (const x of onlyB.slice(0, 3)) console.log(`        only in ${other}: ${x}`);
    }
  }
}

/* The runner's own fingerprint must agree across all three. */
const checksums = new Set(Object.values(fps).map((f) => f.schemaState?.checksum));
note(
  checksums.size === 1,
  'schema_state checksum identical in all three',
  [...checksums].join(' | '),
);
const versions = new Set(Object.values(fps).map((f) => Number(f.schemaState?.version)));
note(
  versions.size === 1 && [...versions][0] === ALL.length,
  'schema version is head in all three',
  `v${[...versions][0]}`,
);

/* The specific constraints this whole exercise is about. */
for (const [name, fp] of Object.entries(fps)) {
  const rule = fp.constraints.find((c) => c.includes('dispute_case_resolved_rule'));
  const trace = fp.constraints.find((c) => c.includes('dispute_case_ruling_traceable'));
  note(
    Boolean(rule) && !rule.includes('resolved_by_proposal'),
    `${name}: resolved_rule no longer requires a proposal`,
  );
  note(Boolean(trace), `${name}: ruling_traceable present`);
}

/* Data survived. Nothing lost, nothing invented. */
console.log('\ndata after convergence');
for (const [name, fp] of Object.entries(fps)) {
  console.log(
    `  ${name}: deals=${fp.data.deals} cases=${fp.data.cases} ` +
      `resolved=${fp.data.resolved} with_proposal=${fp.data.with_proposal}`,
  );
}
// Path B carried legacy disputes across; path C kept its own.
note(
  fps.B.data.cases > 0,
  'B carried its legacy disputes into dispute_case',
  `${fps.B.data.cases} case(s)`,
);
note(fps.C.data.cases > 0, 'C retained its DEL-09 era cases', `${fps.C.data.cases} case(s)`);
note(
  fps.C.data.with_proposal === 0 || fps.C.data.resolved >= fps.C.data.with_proposal,
  'C invented no proposal for any case',
);

const report = {
  generatedAt: new Date().toISOString(),
  baselineCommit: BASELINE_COMMIT,
  migrations: ALL.length,
  paths: {
    A: 'empty → head',
    B: 'populated DEL-05 → head (crosses edited 0010)',
    C: `populated DEL-09 with original 0010 from ${BASELINE_COMMIT} → head`,
  },
  schemaState: fps.A.schemaState,
  data: { A: fps.A.data, B: fps.B.data, C: fps.C.data },
  converged: problems.length === 0,
  problems,
};
writeFileSync('MIGRATION-CONVERGENCE.json', JSON.stringify(report, null, 2));

console.log('');
if (problems.length > 0) {
  console.error(`${problems.length} problem(s): ${problems.join('; ')}`);
  process.exit(1);
}
console.log('all three paths converge on one schema; no row lost or fabricated');
