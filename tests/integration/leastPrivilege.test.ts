import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { getPool } from '@/server/db/pool';

/**
 * Privilege escalation, attempted with the REAL login roles.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  `SET LOCAL ROLE` UNDER THE OWNER IS NOT THE SAME TEST.            │
 * │                                                                    │
 * │  DEL-04 proved the grant matrix that way, and it proved the        │
 * │  matrix — not the deployment. A session that can `RESET ROLE` back │
 * │  to the owner has the owner's authority available to it the whole  │
 * │  time.                                                             │
 * │                                                                    │
 * │  So this suite opens SEPARATE CONNECTIONS as `inrp2p_web` and      │
 * │  `inrp2p_worker`, authenticating as those roles, and tries to do   │
 * │  the things a compromised application would try. There is no way   │
 * │  back to the owner from inside one of these sessions.              │
 * └────────────────────────────────────────────────────────────────────┘
 */

const PASSWORD = 'least-privilege-drill-password-not-a-secret';

/** Built from the suite's own connection, so it follows the test port. */
function urlFor(role: string): string {
  const base =
    process.env.DATABASE_URL ??
    'postgres://inrp2p_sandbox:sandbox-local-only@127.0.0.1:55433/inrp2p_sandbox';
  const u = new URL(base);
  u.username = role;
  u.password = PASSWORD;
  return u.toString();
}

let web: Client;
let worker: Client;

beforeAll(async () => {
  /*
   * Grant LOGIN for the drill only. Migration 0013 creates these roles
   * NOLOGIN precisely so a credential never lives in version control;
   * this password is generated for the test process and is worthless
   * outside it.
   */
  for (const role of ['inrp2p_web', 'inrp2p_worker']) {
    // Two steps: a `DO` block takes no bind parameters, so PostgreSQL
    // builds the escaped statement from bound values and we run the
    // text it returns.
    const { rows } = await getPool().query(
      `SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS stmt`,
      [role, PASSWORD],
    );
    await getPool().query(rows[0].stmt as string);
  }

  web = new Client({ connectionString: urlFor('inrp2p_web') });
  worker = new Client({ connectionString: urlFor('inrp2p_worker') });
  await web.connect();
  await worker.connect();
});

afterAll(async () => {
  await web?.end().catch(() => {});
  await worker?.end().catch(() => {});
  // Closed again afterwards: a LOGIN role left behind by a test run is
  // a way in that nobody meant to leave open.
  for (const role of ['inrp2p_web', 'inrp2p_worker']) {
    await getPool()
      .query(`ALTER ROLE ${role} NOLOGIN`)
      .catch(() => {});
  }
});

/** Run a statement and return the error message, or null on success. */
async function attempt(client: Client, sql: string): Promise<string | null> {
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('ROLLBACK');
    return null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Did the statement change anything?
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A REFUSAL AND A NO-OP ARE BOTH ACCEPTABLE. SUCCESS IS NOT.        │
 * │                                                                    │
 * │  Some tables are protected by a privilege REVOKE, which raises;    │
 * │  others by a `DO INSTEAD NOTHING` rule, which silently affects     │
 * │  zero rows. Asserting on the error message would pass for the      │
 * │  first kind and fail for the second even though both are safe, so  │
 * │  the assertion is on the EFFECT: no rows moved.                    │
 * └────────────────────────────────────────────────────────────────────┘
 */
async function affectedRows(client: Client, sql: string): Promise<number | 'REFUSED'> {
  try {
    await client.query('BEGIN');
    const result = await client.query(sql);
    await client.query('ROLLBACK');
    return result.rowCount ?? 0;
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    return 'REFUSED';
  }
}

describe('the web role is genuinely least-privilege', () => {
  it('connects as itself, not as the owner', async () => {
    const { rows } = await web.query(`SELECT current_user AS role, session_user AS session`);
    expect(rows[0].role).toBe('inrp2p_web');
    expect(rows[0].session).toBe('inrp2p_web');
  });

  it('holds NO superuser or role-granting attribute', async () => {
    const { rows } = await web.query(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication
         FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
      rolreplication: false,
    });
  });

  it('CANNOT create, alter or drop a schema object', async () => {
    expect(await attempt(web, `CREATE TABLE sandbox.hostile (id int)`)).toMatch(
      /permission denied/i,
    );
    expect(await attempt(web, `DROP TABLE sandbox.deal`)).toMatch(
      /must be owner|permission denied/i,
    );
    expect(await attempt(web, `ALTER TABLE sandbox.deal ADD COLUMN hostile int`)).toMatch(
      /must be owner|permission denied/i,
    );
    expect(await attempt(web, `CREATE SCHEMA hostile`)).toMatch(/permission denied/i);
  });

  it('CANNOT grant itself anything', async () => {
    expect(await attempt(web, `GRANT inrp2p_sandbox TO inrp2p_web`)).not.toBeNull();
    expect(await attempt(web, `ALTER ROLE inrp2p_web SUPERUSER`)).not.toBeNull();
  });

  it('CANNOT become the owner', async () => {
    // The whole reason a separate login matters: there is no way back.
    expect(await attempt(web, `SET ROLE inrp2p_sandbox`)).toMatch(
      /permission denied|must be (a )?member/i,
    );
  });

  it('CANNOT write the ledger directly', async () => {
    expect(
      await attempt(
        web,
        `INSERT INTO inrp2p.posting (entry_id, seq, account_id, asset, amount_minor)
         VALUES (gen_random_uuid(), 1, gen_random_uuid(), 'USDT', 1)`,
      ),
    ).toMatch(/permission denied/i);

    expect(await attempt(web, `UPDATE inrp2p.account_balance SET balance_minor = 0`)).toMatch(
      /permission denied/i,
    );
    expect(await attempt(web, `SELECT * FROM inrp2p.journal_entry`)).toMatch(/permission denied/i);
  });

  it('CAN reach the ledger only through the boundary function', async () => {
    // Not an escalation: `post_entry` is SECURITY DEFINER owned by
    // `inrp2p_boundary` and enforces every invariant. Reaching it is
    // the intended path, and it is the ONLY one.
    const { rows } = await web.query(
      `SELECT has_function_privilege(current_user,
         'inrp2p.post_entry(text,jsonb,uuid[],numeric[])', 'EXECUTE') AS allowed`,
    );
    expect(rows[0].allowed).toBe(true);
  });

  it('CANNOT DELETE from anything', async () => {
    /*
     * Nothing in this product legitimately deletes a row. The privilege
     * is withheld ENTIRELY rather than narrowed to the sensitive tables,
     * so a bug that tries to delete fails loudly instead of succeeding
     * on the one table nobody thought to protect.
     */
    for (const table of [
      'sandbox.deal',
      'sandbox.audit_event',
      'sandbox.deal_message',
      'sandbox.payment_intent',
      'sandbox.risk_decision_log',
      'inrp2p.value_lock',
    ]) {
      const affected = await affectedRows(web, `DELETE FROM ${table}`);
      // Refused outright, or silently a no-op. Never a deletion.
      expect(affected, table).toSatisfy((r: number | string) => r === 'REFUSED' || r === 0);
    }
  });

  it('CANNOT rewrite immutable history', async () => {
    for (const [table, column] of [
      ['sandbox.audit_event', 'outcome'],
      ['sandbox.risk_decision_log', 'decision'],
      ['sandbox.screening_result', 'hit'],
      ['sandbox.quote_fee_snapshot', 'final_fee_minor'],
      ['sandbox.reputation_event', 'points'],
    ] as const) {
      const affected = await affectedRows(web, `UPDATE ${table} SET ${column} = ${column}`);
      expect(affected, table).toSatisfy((r: number | string) => r === 'REFUSED' || r === 0);
    }
  });

  it('CANNOT truncate', async () => {
    expect(await attempt(web, `TRUNCATE sandbox.audit_event`)).toMatch(
      /permission denied|must be owner/i,
    );
  });

  it('has a LOCKED search_path', async () => {
    const { rows } = await web.query(`SHOW search_path`);
    // A caller that could prepend its own schema could shadow
    // `sandbox.deal` with a table it controls.
    expect(rows[0].search_path).toContain('sandbox');
    expect(rows[0].search_path.startsWith('pg_catalog')).toBe(true);
  });

  it('has bounded statement, lock and idle timeouts', async () => {
    const statement = await web.query(`SHOW statement_timeout`);
    const lock = await web.query(`SHOW lock_timeout`);
    const idle = await web.query(`SHOW idle_in_transaction_session_timeout`);
    expect(statement.rows[0].statement_timeout).not.toBe('0');
    expect(lock.rows[0].lock_timeout).not.toBe('0');
    expect(idle.rows[0].idle_in_transaction_session_timeout).not.toBe('0');
  });

  it('CAN do its actual job', async () => {
    // Least privilege that breaks the product is not least privilege,
    // it is an outage. The role must still read and write app data.
    const read = await web.query(`SELECT count(*)::int AS n FROM sandbox.deal`);
    expect(Number(read.rows[0].n)).toBeGreaterThanOrEqual(0);
    expect(await attempt(web, `SELECT * FROM inrp2p_read.account_balance LIMIT 1`)).toBeNull();
  });
});

describe('the worker role', () => {
  it('connects as itself and owns nothing', async () => {
    const { rows } = await worker.query(`SELECT current_user AS role`);
    expect(rows[0].role).toBe('inrp2p_worker');
    expect(await attempt(worker, `CREATE TABLE sandbox.hostile2 (id int)`)).toMatch(
      /permission denied/i,
    );
  });

  it('CAN update the outbox delivery columns and nothing else on that table', async () => {
    expect(
      await attempt(
        worker,
        `UPDATE sandbox.outbox_event SET attempts = attempts, next_attempt_at = next_attempt_at`,
      ),
    ).toBeNull();

    // The EVENT itself is immutable: a dispatcher may record delivery,
    // never rewrite what happened.
    expect(await attempt(worker, `UPDATE sandbox.outbox_event SET payload = '{}'::jsonb`)).toMatch(
      /permission denied/i,
    );
    expect(await attempt(worker, `UPDATE sandbox.outbox_event SET event_type = 'forged'`)).toMatch(
      /permission denied/i,
    );
  });
});
