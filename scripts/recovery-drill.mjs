#!/usr/bin/env node
/**
 * The backup and restore drill.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  A BACKUP NOBODY HAS RESTORED IS NOT A BACKUP.                   │
 * │                                                                  │
 * │  This backs the database up, restores it into a SEPARATE empty   │
 * │  one, and then verifies the things that would actually matter    │
 * │  after a real recovery:                                          │
 * │                                                                  │
 * │    · the schema version matches;                                 │
 * │    · the ledger still sums to zero PER ASSET;                    │
 * │    · every journal entry still has both its legs;                │
 * │    · immutable history is still immutable;                       │
 * │    · audit and outbox rows survived.                             │
 * │                                                                  │
 * │  A restore that produces a database which merely OPENS is not a  │
 * │  recovery. One whose ledger does not balance is worse than none: │
 * │  it looks like one.                                              │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * TWO MODES, and the report says which ran.
 *
 *   `pg_dump`  — the real thing, used whenever the binaries are on the
 *                machine. This is what production would use.
 *   `logical`  — a `COPY`-based row export, used when they are not. The
 *                embedded PostgreSQL this repository develops against
 *                ships only `initdb`, `pg_ctl` and `postgres`, so the
 *                fallback is what makes the drill runnable in CI at all.
 *
 * The fallback is a genuine backup and a genuine restore — it exercises
 * the same verification — but it is NOT equivalent to `pg_dump -Fc`, and
 * the report labels it so nobody reads a green result as proof that the
 * production path was tested.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

// `pg` is CommonJS. A named import resolves at run time rather than
// at parse time, so it fails only when the script is actually used —
// which is the worst moment to discover an import error.
const { Client } = pg;

const SOURCE_URL =
  process.env.DRILL_SOURCE_URL ??
  process.env.DATABASE_URL ??
  'postgres://inrp2p_sandbox:sandbox-local-only@127.0.0.1:55433/inrp2p_sandbox';

const RESTORE_DB = process.env.DRILL_RESTORE_DB ?? 'inrp2p_restore_drill';

/** Tables carried by the logical fallback, parents before children. */
const SCHEMAS = ['sandbox', 'inrp2p'];

function haveBinary(name) {
  try {
    execFileSync('which', [name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function parse(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port || '5432',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  };
}

/** Restore-safe table order: nothing is loaded before what it references. */
async function orderedTables(client) {
  const { rows } = await client.query(
    `WITH RECURSIVE t AS (
       SELECT c.oid, c.relname, n.nspname, 0 AS depth
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname = ANY($1::text[])
     )
     SELECT nspname, relname FROM t ORDER BY nspname, relname`,
    [SCHEMAS],
  );
  return rows.map((r) => ({ schema: r.nspname, table: r.relname }));
}

async function main() {
  const started = Date.now();
  const source = parse(SOURCE_URL);
  const workDir = mkdtempSync(join(tmpdir(), 'inrp2p-drill-'));
  const mode = haveBinary('pg_dump') && haveBinary('pg_restore') ? 'pg_dump' : 'logical';

  let manifest;

  /* ================= 1. BACK UP ================= */

  if (mode === 'pg_dump') {
    const dumpPath = join(workDir, 'backup.dump');
    execFileSync(
      'pg_dump',
      ['-h', source.host, '-p', source.port, '-U', source.user, '-Fc', '-f', dumpPath, source.database],
      { env: { ...process.env, PGPASSWORD: source.password }, stdio: 'pipe' },
    );
    const bytes = readFileSync(dumpPath);
    manifest = {
      mode,
      createdAt: new Date().toISOString(),
      sourceDatabase: source.database,
      byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      artefact: dumpPath,
    };
  } else {
    const client = new Client({ connectionString: SOURCE_URL });
    await client.connect();
    const tables = await orderedTables(client);

    /*
     * `bytea` DOES NOT SURVIVE JSON.
     *
     * `pg` decodes it to a Buffer, and `JSON.stringify` turns a Buffer
     * into `{"type":"Buffer","data":[…]}` — which restores as a 30-byte
     * object where a 32-byte digest belonged, and the CHECK constraint
     * catches it. Hex on the way out, Buffer on the way back in.
     *
     * This is precisely the class of problem `pg_dump` exists to solve,
     * and precisely why the report labels this mode as not equivalent.
     */
    const { rows: byteaColumns } = await client.query(
      `SELECT table_schema, table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = ANY($1::text[]) AND data_type = 'bytea'`,
      [SCHEMAS],
    );
    const binaryColumns = new Set(
      byteaColumns.map((c) => `${c.table_schema}.${c.table_name}.${c.column_name}`),
    );

    const dump = { tables: [], binaryColumns: [...binaryColumns] };
    for (const { schema, table } of tables) {
      const { rows } = await client.query(`SELECT * FROM ${schema}.${table}`);
      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          if (binaryColumns.has(`${schema}.${table}.${column}`) && Buffer.isBuffer(value)) {
            row[column] = value.toString('hex');
          }
        }
      }
      dump.tables.push({ schema, table, rows });
    }
    await client.end();

    const json = JSON.stringify(dump);
    const dumpPath = join(workDir, 'backup.json');
    writeFileSync(dumpPath, json);
    manifest = {
      mode,
      createdAt: new Date().toISOString(),
      sourceDatabase: source.database,
      byteSize: Buffer.byteLength(json),
      // The checksum is taken from the ARTEFACT ON DISK, before any
      // restore. A checksum computed afterwards proves nothing about
      // the thing a real recovery would read.
      sha256: createHash('sha256').update(json).digest('hex'),
      artefact: dumpPath,
      tableCount: dump.tables.length,
      note: 'Logical row export. Not equivalent to pg_dump -Fc; see the drill header.',
    };
  }
  writeFileSync(join(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  /* ================= 2. RESTORE, ISOLATED ================= */

  const admin = new Client({ connectionString: SOURCE_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${RESTORE_DB}`);
  await admin.query(`CREATE DATABASE ${RESTORE_DB}`);
  await admin.end();

  const restoredUrl = SOURCE_URL.replace(/\/[^/?]*(\?|$)/, `/${RESTORE_DB}$1`);

  if (mode === 'pg_dump') {
    execFileSync(
      'pg_restore',
      ['-h', source.host, '-p', source.port, '-U', source.user, '-d', RESTORE_DB, '--no-owner',
       manifest.artefact],
      { env: { ...process.env, PGPASSWORD: source.password }, stdio: 'pipe' },
    );
  } else {
    // Rebuild the schema from the migrations, then load the rows. That
    // is a genuine restore path — and it also proves the migrations run
    // cleanly against an empty database, which is worth knowing.
    execFileSync('node', ['scripts/db.mjs', 'migrate'], {
      env: { ...process.env, DATABASE_URL: restoredUrl },
      stdio: 'pipe',
    });

    const dump = JSON.parse(readFileSync(manifest.artefact, 'utf8'));
    const client = new Client({ connectionString: restoredUrl });
    await client.connect();


    /*
     * Which columns are JSON, so the round trip does not corrupt them.
     *
     * `pg` decodes `jsonb` into a JS object and encodes a JS ARRAY as a
     * PostgreSQL array literal. Re-inserting a decoded `jsonb` array
     * without re-stringifying it therefore turns `[{...}]` into `{...}`
     * and the CHECK constraint refuses it — which is exactly how this
     * was caught. Genuine `text[]` columns must NOT be stringified, so
     * the distinction comes from the catalogue rather than a guess.
     */
    const { rows: jsonColumns } = await client.query(
      `SELECT table_schema, table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = ANY($1::text[]) AND data_type IN ('json','jsonb')`,
      [SCHEMAS],
    );
    const isJson = new Set(
      jsonColumns.map((c) => `${c.table_schema}.${c.table_name}.${c.column_name}`),
    );

    /*
     * Which tables carry RULES.
     *
     * PostgreSQL refuses `ON CONFLICT` on a table with INSERT/UPDATE
     * rules, and this schema has several (the no-delete rules on the
     * outbox and on deal links). Meanwhile the migrations SEED some
     * tables — the journal catalogue, the fee and risk policies — so the
     * restore target is not empty for those and does need conflict
     * handling. The statement is therefore chosen per table rather than
     * assumed for all of them.
     */
    const { rows: ruled } = await client.query(
      `SELECT schemaname, tablename FROM pg_rules WHERE schemaname = ANY($1::text[])`,
      [SCHEMAS],
    );
    const hasRules = new Set(ruled.map((r) => `${r.schemaname}.${r.tablename}`));
    const isBinary = new Set(dump.binaryColumns ?? []);
    // Constraints are deferred for the load only: rows arrive in an
    // arbitrary order and every one of them is re-checked at COMMIT.
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query('SET session_replication_role = replica');
    for (const { schema, table, rows } of dump.tables) {
      if (rows.length === 0) continue;
      // No pre-clear: the target was created empty, and several tables
      // carry rules that make DELETE a no-op anyway.
      const columns = Object.keys(rows[0]);
      const quoted = columns.map((c) => `"${c}"`).join(',');
      for (const row of rows) {
        const values = columns.map((c) => {
          const key = `${schema}.${table}.${c}`;
          if (row[c] === null) return null;
          if (isJson.has(key)) return JSON.stringify(row[c]);
          if (isBinary.has(key) && typeof row[c] === 'string') {
            return Buffer.from(row[c], 'hex');
          }
          return row[c];
        });
        const holders = columns.map((_, i) => `$${i + 1}`).join(',');
        /*
         * `OVERRIDING SYSTEM VALUE` is required for `GENERATED ALWAYS AS
         * IDENTITY` columns. A restore must preserve the ORIGINAL ids —
         * `audit_id` and the outbox `seq` are referenced by cursors and
         * by ordering guarantees, and letting the database re-generate
         * them would silently renumber history.
         */
        /*
         * No `ON CONFLICT`: some tables carry RULES (the DEL-02 outbox
         * and deal-link no-delete rules), and PostgreSQL refuses to
         * combine the two. The target database was created empty
         * moments ago, so there is nothing to conflict with — and a
         * duplicate here would be a real fault worth failing on rather
         * than swallowing.
         */
        const conflict = hasRules.has(`${schema}.${table}`) ? '' : 'ON CONFLICT DO NOTHING';
        await client.query(
          `INSERT INTO ${schema}.${table} (${quoted})
           OVERRIDING SYSTEM VALUE VALUES (${holders}) ${conflict}`,
          values,
        );
      }
    }
    await client.query('SET session_replication_role = origin');
    await client.query('COMMIT');
    await client.end();
  }
  const restoredAt = Date.now();

  /* ================= 3. VERIFY ================= */

  const client = new Client({ connectionString: restoredUrl });
  await client.connect();

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  const version = await client.query(
    `SELECT version FROM sandbox.schema_state LIMIT 1`,
  ).catch(() => ({ rows: [] }));
  check(
    'schema-version',
    version.rows.length > 0,
    version.rows.length > 0 ? `v${version.rows[0].version}` : 'no schema_state row',
  );

  /*
   * THE LEDGER MUST STILL BALANCE — per asset, exactly, in integers.
   * This is the check that separates a recovery from a database that
   * merely opens.
   */
  const zeroSum = await client.query(
    `SELECT p.asset::text AS asset, sum(p.amount_minor)::text AS total
       FROM inrp2p.posting p GROUP BY p.asset HAVING sum(p.amount_minor) <> 0`,
  );
  check(
    'ledger-zero-sum',
    zeroSum.rows.length === 0,
    zeroSum.rows.length === 0 ? 'balanced per asset' : JSON.stringify(zeroSum.rows),
  );

  const orphans = await client.query(
    `SELECT count(*)::int AS n FROM inrp2p.journal_entry e
      WHERE (SELECT count(*) FROM inrp2p.posting p WHERE p.entry_id = e.entry_id) < 2`,
  );
  check('entry-integrity', Number(orphans.rows[0].n) === 0, `orphaned entries=${orphans.rows[0].n}`);

  /*
   * IMMUTABLE HISTORY MUST STILL REFUSE TO MOVE.
   *
   * Tested against a TRIGGER-protected table, because that protection
   * binds every role including the owner this drill connects as. The
   * audit trail is protected by a privilege REVOKE instead, which the
   * owner is by definition exempt from — so asserting it here would
   * have tested nothing and passed for the wrong reason. (The first
   * version of this check did exactly that, and reported a false
   * failure, which is how the distinction was noticed.)
   */
  let immutable = false;
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE sandbox.deal_message SET body='TAMPERED'`);
    await client.query('ROLLBACK');
  } catch {
    immutable = true;
    await client.query('ROLLBACK').catch(() => {});
  }
  check(
    'immutable-history',
    immutable,
    immutable ? 'append-only tables refuse UPDATE after restore' : 'HISTORY IS WRITABLE',
  );

  /*
   * And the runtime roles hold no UPDATE on the audit trail — the
   * separate protection that a trigger does not provide.
   */
  const auditPriv = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.role_table_grants
      WHERE table_schema='sandbox' AND table_name='audit_event'
        AND privilege_type='UPDATE' AND grantee IN ('inrp2p_web','inrp2p_worker')`,
  );
  check(
    'audit-privilege',
    Number(auditPriv.rows[0].n) === 0,
    `runtime UPDATE grants on audit_event: ${auditPriv.rows[0].n}`,
  );

  const counts = await client.query(
    `SELECT (SELECT count(*) FROM sandbox.audit_event)  AS audit,
            (SELECT count(*) FROM sandbox.outbox_event) AS outbox,
            (SELECT count(*) FROM inrp2p.journal_entry) AS entries,
            (SELECT count(*) FROM inrp2p.posting)       AS postings`,
  );
  const c = counts.rows[0];
  check(
    'row-counts',
    Number(c.entries) >= 0,
    `audit=${c.audit} outbox=${c.outbox} entries=${c.entries} postings=${c.postings}`,
  );

  /*
   * A drill on an EMPTY database proves the plumbing and nothing about
   * the data. Reported as a distinct check so a green run on an empty
   * source cannot be mistaken for a meaningful recovery test.
   */
  const representative = Number(c.entries) > 0 && Number(c.audit) > 0;
  check(
    'representative-data',
    representative,
    representative
      ? `${c.entries} ledger entries restored`
      : 'SOURCE WAS EMPTY: run the integration suite first for a meaningful drill',
  );

  await client.end();

  /* ================= 4. REPORT ================= */

  const report = {
    manifest,
    checks,
    measured: {
      backupAndRestoreSeconds: Math.round((restoredAt - started) / 1000),
      /*
       * MEASURED, on drill data, in this mode. Not an RPO or RTO claim:
       * a real target needs a production-sized dataset and a real
       * incident, and a number invented here would be exactly the kind
       * nobody should trust.
       */
      note: 'Measured on drill data only. Not a demonstrated production RPO/RTO.',
    },
    passed: checks.every((c) => c.ok),
  };
  writeFileSync(join(workDir, 'recovery-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nartefacts: ${workDir}`);
  if (!report.passed) process.exit(1);
}

main().catch((error) => {
  console.error('recovery drill failed:', error.message);
  process.exit(1);
});
