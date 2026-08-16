#!/usr/bin/env node
/**
 * Prove a BASELINE database upgrades to HEAD without losing or
 * inventing a single row.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  THE GAP THIS CLOSES.                                            │
 * │                                                                  │
 * │  Every gate before DEL-10 applied migrations to a FRESHLY        │
 * │  CREATED database. On an empty database the DEL-06 backfill was  │
 * │  a no-op, so four consecutive stages certified an upgrade path   │
 * │  that could not actually run: a legacy dispute reading "Nothing  │
 * │  arrived." (16 characters) violated the new 20-character         │
 * │  minimum, and every historical RESOLVED dispute violated a rule  │
 * │  requiring a maker-checker proposal that did not exist yet.      │
 * │                                                                  │
 * │  So this builds a database at the OLD schema, fills it with the  │
 * │  awkward data a real deployment would have, upgrades it, and     │
 * │  then checks the result row by row.                              │
 * │                                                                  │
 * │  It asserts in BOTH directions. Nothing may be lost, and nothing │
 * │  may be fabricated — a migration that quietly invents a          │
 * │  plausible statement or a maker-checker approval is worse than   │
 * │  one that fails loudly.                                          │
 * └──────────────────────────────────────────────────────────────────┘
 *
 *   DATABASE_URL=... node scripts/upgrade-fixture.mjs
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

/** Migrations up to and including this one form the BASELINE. */
const BASELINE_THROUGH = '0009_del05_payment_rails.sql';

const base = process.env.DATABASE_URL;
if (!base) {
  console.error('DATABASE_URL must be set.');
  process.exit(1);
}

const url = new URL(base);
const fixtureName = `${url.pathname.replace(/^\//, '')}_upgrade`;
const fixtureUrl = (() => {
  const u = new URL(base);
  u.pathname = `/${fixtureName}`;
  return u.toString();
})();

const adminUrl = (() => {
  const u = new URL(base);
  u.pathname = '/postgres';
  return u.toString();
})();

const problems = [];
const note = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

/* ---------- 1. A database at the baseline schema ---------- */

const admin = new pg.Client(adminUrl);
await admin.connect();
await admin.query(
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = $1 AND pid <> pg_backend_pid()`,
  [fixtureName],
);
await admin.query(`DROP DATABASE IF EXISTS "${fixtureName}"`);
await admin.query(`CREATE DATABASE "${fixtureName}"`);
await admin.end();

const dir = path.join(process.cwd(), 'db', 'migrations');
const all = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const baseline = all.filter((f) => f <= BASELINE_THROUGH);

const db = new pg.Client(fixtureUrl);
await db.connect();

console.log(`baseline: applying ${baseline.length} migration(s) through ${BASELINE_THROUGH}`);
for (const file of baseline) {
  await db.query(readFileSync(path.join(dir, file), 'utf8'));
}
// The runner's own bookkeeping, so the upgrade continues from here.
await db.query(
  `CREATE TABLE IF NOT EXISTS public.schema_migration (
     filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
);
for (const file of baseline) {
  await db.query(`INSERT INTO public.schema_migration (filename) VALUES ($1)`, [file]);
}

/* ---------- 2. Fill it with awkward, realistic data ---------- */

console.log('seeding a populated deployment');

const seed = await db.query(`
  WITH u AS (
    INSERT INTO sandbox.app_user (email, display_name, is_verified)
    SELECT format('legacy%s@example.com', g), format('Legacy %s', g), (g % 2 = 0)
      FROM generate_series(1, 12) g
    RETURNING user_id
  )
  SELECT count(*)::int AS users FROM u
`);
const users = seed.rows[0].users;

// Quotes, links and deals — the shape a live deployment actually has.
// `deal.quote_id` and `deal_link.quote_id` are both NOT NULL at this
// schema, so the chain is built in order rather than stubbed.
await db.query(`
  INSERT INTO sandbox.quote
    (issued_to, direction, state, inr_minor, rate_num, rate_den, pricing_source,
     observed_at, expires_at, protection_fee_minor, network_fee_minor, fee_bearer, title)
  SELECT (SELECT user_id FROM sandbox.app_user ORDER BY created_at LIMIT 1),
         'INR_TO_INR', 'CONSUMED', 2500000, 1, 1, 'REFERENCE',
         now() - interval '30 days', now() + interval '30 days',
         37500, 0, 'PAYER', format('Legacy quote %s', g)
    FROM generate_series(1, 9) g
`);

await db.query(`
  INSERT INTO sandbox.deal_link
    (public_id, quote_id, created_by, creator_role, state, expires_at, consumed_at)
  SELECT format('INRP-%s', lpad(q.n::text, 10, '0')),
         q.quote_id,
         (SELECT user_id FROM sandbox.app_user ORDER BY created_at LIMIT 1),
         'FIAT_SIDE',
         (CASE WHEN q.n % 3 = 0 THEN 'CONSUMED' ELSE 'OPEN' END)::sandbox.link_state,
         now() + interval '7 days',
         -- A consumed link must say WHEN, or the state is unexplained.
         CASE WHEN q.n % 3 = 0 THEN now() - interval '20 days' ELSE NULL END
    FROM (SELECT quote_id, row_number() OVER (ORDER BY created_at) AS n
            FROM sandbox.quote) q
`);

await db.query(`
  INSERT INTO sandbox.deal
    (public_id, deal_code, link_id, quote_id, direction, inr_minor,
     rate_num, rate_den, pricing_source, observed_at,
     protection_fee_minor, network_fee_minor, fee_bearer, title, state, completed_at)
  SELECT format('INRP-%s', lpad((1000 + l.n)::text, 10, '0')),
         format('INR-%s', lpad(l.n::text, 4, '0')),
         l.link_id, l.quote_id, 'INR_TO_INR', 2500000,
         1, 1, 'REFERENCE', now() - interval '30 days',
         37500, 0, 'PAYER', format('Legacy deal %s', l.n),
         (CASE WHEN l.n % 4 = 0 THEN 'COMPLETED' ELSE 'FIAT_PENDING' END)::sandbox.deal_state,
         -- A completed deal names the moment it completed.
         CASE WHEN l.n % 4 = 0 THEN now() - interval '15 days' ELSE NULL END
    FROM (SELECT link_id, quote_id, row_number() OVER (ORDER BY created_at) AS n
            FROM sandbox.deal_link) l
`);

/*
 * The disputes that broke the migration. Deliberately spanning the
 * boundary: below the new 20-character minimum, exactly at it, well
 * over it, blank, and NULL — resolved and unresolved.
 */
await db.query(`
  INSERT INTO sandbox.dispute
    (deal_id, raised_by, reason, detail, state, resolution, resolved_by, resolved_at)
  SELECT d.deal_id,
         (SELECT user_id FROM sandbox.app_user ORDER BY created_at LIMIT 1),
         'PAYMENT_NOT_RECEIVED',
         CASE d.n
           WHEN 1 THEN 'Nothing arrived.'
           WHEN 2 THEN 'Something is wrong.'
           WHEN 3 THEN 'Exactly twenty ch.'
           WHEN 4 THEN repeat('This is a very long legacy statement. ', 200)
           WHEN 5 THEN ''
           WHEN 6 THEN NULL
           WHEN 7 THEN 'The UTR does not appear on my statement at all.'
           WHEN 8 THEN 'Short.'
           ELSE 'A perfectly ordinary legacy complaint of adequate length.'
         END,
         CASE WHEN d.n % 3 = 0 THEN 'RESOLVED' ELSE 'OPEN' END,
         CASE WHEN d.n % 3 = 0
              THEN (ARRAY['RELEASED','REFUNDED','CANCELLED'])[1 + (d.n / 3) % 3]
              ELSE NULL END,
         -- A resolved dispute names who resolved it, or the state lies.
         CASE WHEN d.n % 3 = 0
              THEN (SELECT user_id FROM sandbox.app_user ORDER BY created_at LIMIT 1)
              ELSE NULL END,
         CASE WHEN d.n % 3 = 0 THEN now() - interval '10 days' ELSE NULL END
    FROM (SELECT deal_id, row_number() OVER (ORDER BY created_at) AS n FROM sandbox.deal) d
`);

// Commands, ledger, outbox, sessions and grants — the rest of a
// deployment's real weight.
await db.query(`
  INSERT INTO sandbox.command
    (command_id, actor_id, command_type, payload_hash, status, result)
  SELECT gen_random_uuid(),
         (SELECT user_id FROM sandbox.app_user ORDER BY created_at LIMIT 1),
         'CREATE_DEAL', encode(sha256(g::text::bytea), 'hex'), 'SUCCEEDED', '{"ok":true}'::jsonb
    FROM generate_series(1, 20) g
`);
await db.query(`
  INSERT INTO sandbox.outbox_event (event_key, event_type, subject_kind, subject_id, payload)
  SELECT format('legacy-%s', g), 'deal.joined', 'deal', d.deal_id, '{"legacy":true}'::jsonb
    FROM generate_series(1, 15) g
    JOIN LATERAL (SELECT deal_id FROM sandbox.deal ORDER BY created_at LIMIT 1) d ON TRUE
`);
await db.query(`
  INSERT INTO sandbox.session (user_id, token_hash, origin, expires_at)
  SELECT user_id, encode(sha256(user_id::text::bytea), 'hex'), 'EMAIL_OTP',
         now() + interval '7 days'
    FROM sandbox.app_user LIMIT 5
`);

const before = {};
for (const t of [
  'app_user',
  'deal',
  'deal_link',
  'dispute',
  'command',
  'outbox_event',
  'session',
]) {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM sandbox.${t}`);
  before[t] = rows[0].n;
}
const { rows: disputeDetail } = await db.query(
  `SELECT dispute_id, detail, state, resolution FROM sandbox.dispute ORDER BY raised_at`,
);
console.log(`  seeded: ${JSON.stringify(before)} (users=${users})`);

await db.end();

/* ---------- 3. Upgrade to HEAD through the ordinary runner ---------- */

console.log('upgrading baseline → head');
const migrate = spawnSync(process.execPath, ['scripts/db.mjs', 'migrate'], {
  env: { ...process.env, DATABASE_URL: fixtureUrl },
  encoding: 'utf8',
});
if (migrate.status !== 0) {
  console.error(migrate.stdout);
  console.error(migrate.stderr);
  console.error('\nUPGRADE FAILED — the populated path is broken.');
  process.exit(1);
}
console.log(`  ${migrate.stdout.trim().split('\n').slice(-2).join(' | ')}`);

/* ---------- 4. Verify nothing was lost or invented ---------- */

const after = new pg.Client(fixtureUrl);
await after.connect();

console.log('verifying');

for (const t of ['app_user', 'deal', 'deal_link', 'command', 'outbox_event', 'session']) {
  const { rows } = await after.query(`SELECT count(*)::int AS n FROM sandbox.${t}`);
  note(rows[0].n === before[t], `${t} preserved`, `${before[t]} → ${rows[0].n}`);
}

// Every legacy dispute became exactly one case.
const { rows: caseCount } = await after.query(
  `SELECT count(*)::int AS n FROM sandbox.dispute_case`,
);
note(
  caseCount[0].n === before.dispute,
  'every dispute became exactly one case',
  `${before.dispute} → ${caseCount[0].n}`,
);

// No case violates the new domain.
const { rows: bad } = await after.query(
  `SELECT count(*)::int AS n FROM sandbox.dispute_case
    WHERE char_length(statement) NOT BETWEEN 20 AND 4000`,
);
note(bad[0].n === 0, 'every statement satisfies the new length rule');

/*
 * The anti-fabrication check, and the point of the whole exercise: a
 * statement a person actually wrote must still be findable inside the
 * migrated one. A migration that replaced short text with a tidy
 * placeholder would pass every count above and still have destroyed
 * what somebody said.
 */
let preserved = 0;
let padded = 0;
for (const row of disputeDetail) {
  const original = (row.detail ?? '').trim();
  const { rows } = await after.query(
    `SELECT statement FROM sandbox.dispute_case WHERE case_id = $1`,
    [row.dispute_id],
  );
  if (rows.length !== 1) {
    note(false, `case missing for dispute ${row.dispute_id}`);
    continue;
  }
  const statement = rows[0].statement;
  if (original === '') {
    // Nothing was written; a placeholder is the honest answer.
    if (/no statement was recorded/i.test(statement)) padded += 1;
    else note(false, 'an empty legacy detail did not get the honest placeholder');
  } else if (original.length > 4000) {
    if (statement.startsWith(original.slice(0, 200)) && /truncated/i.test(statement)) padded += 1;
    else note(false, 'an over-long statement was not truncated transparently');
  } else if (!statement.includes(original)) {
    note(false, `original words lost: ${JSON.stringify(original.slice(0, 40))}`);
  } else {
    preserved += 1;
    if (statement !== original) padded += 1;
  }
}
note(true, 'legacy words preserved verbatim', `${preserved} kept, ${padded} annotated`);

// Resolved legacy rulings kept their disposition and declare that no
// proposal backs them.
const { rows: resolved } = await after.query(
  `SELECT count(*)::int AS n FROM sandbox.dispute_case
    WHERE state = 'RESOLVED' AND resolved_by_proposal IS NULL
      AND resolution_note NOT LIKE 'Resolved before DEL-06%'`,
);
note(resolved[0].n === 0, 'no resolved case hides a missing proposal');

const { rows: fabricated } = await after.query(
  `SELECT count(*)::int AS n FROM sandbox.dispute_case WHERE resolved_by_proposal IS NOT NULL`,
);
note(fabricated[0].n === 0, 'no maker-checker approval was invented');

const { rows: version } = await after.query(`SELECT version FROM sandbox.schema_state`);
note(Number(version[0].version) === all.length, 'schema reached head', `v${version[0].version}`);

await after.end();

console.log('');
if (problems.length > 0) {
  console.error(`${problems.length} problem(s): ${problems.join('; ')}`);
  process.exit(1);
}
console.log('populated baseline → head upgrade preserved every row and invented nothing');
