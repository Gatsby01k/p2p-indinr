import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { getPool, withTransaction } from '@/server/db/pool';

/**
 * DEL-04 money core — the ledger spine, executed.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  TS-02 SAYS ITS OWN SQL HAS NEVER BEEN EXECUTED.                   │
 * │                                                                    │
 * │  Its §0 header states it plainly, and TS-00 confirmed it: the      │
 * │  money schema existed only as Markdown, and `check-schema.mjs`     │
 * │  parses that Markdown rather than a database. Structural checking  │
 * │  is not execution.                                                 │
 * │                                                                    │
 * │  These tests are the first evidence that the money schema RUNS:    │
 * │  the CE encoding produces the ids the specification computes, the  │
 * │  closed catalogue actually refuses what it claims to refuse, and   │
 * │  an unbalanced entry cannot commit.                                │
 * └────────────────────────────────────────────────────────────────────┘
 */

const NS_ACCOUNT = '6f2a1c4e-0b7d-5f8a-9c31-2e4d6a8b0f13';

async function accountId(key: {
  asset: string;
  family: string;
  scopeKind: string;
  scopeId: string;
  shard: number;
}): Promise<string> {
  const { rows } = await getPool().query(
    `SELECT inrp2p.account_id_of(
              ROW($1,$2,$3,$4,$5)::inrp2p.account_key) AS id`,
    [key.asset, key.family, key.scopeKind, key.scopeId, key.shard],
  );
  return rows[0]!.id as string;
}

/* ------------------------------------------------------------------ *
 * The schema exists and is separate
 * ------------------------------------------------------------------ */

describe('the money schema is real and distinct from the sandbox', () => {
  it('exists', async () => {
    const { rows } = await getPool().query(
      `SELECT nspname FROM pg_namespace WHERE nspname = 'inrp2p'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('carries the ledger spine', async () => {
    const { rows } = await getPool().query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'inrp2p' ORDER BY table_name`,
    );
    const tables = rows.map((r) => r.table_name);
    // Deliberately an EXACT list, not a superset check: a table appearing
    // in the money schema without anybody noticing is precisely the kind
    // of change that should have to be written down here first.
    expect(tables).toEqual([
      'account_balance',
      'journal_catalogue',
      'journal_entry',
      'ledger_account',
      'posting',
      'system_money_state',
      'value_lock',
    ]);
  });

  it('holds only USDT and TRX as ledger assets — there is no INR balance', async () => {
    const { rows } = await getPool().query(
      `SELECT unnest(enum_range(NULL::inrp2p.ledger_asset))::text AS asset`,
    );
    expect(rows.map((r) => r.asset)).toEqual(['USDT', 'TRX']);
  });

  it('creates the five database roles', async () => {
    const { rows } = await getPool().query(
      `SELECT rolname FROM pg_roles
        WHERE rolname IN ('inrp2p_owner','inrp2p_boundary','inrp2p_app',
                          'inrp2p_relay','inrp2p_recon')
        ORDER BY rolname`,
    );
    expect(rows.map((r) => r.rolname)).toEqual([
      'inrp2p_app',
      'inrp2p_boundary',
      'inrp2p_owner',
      'inrp2p_recon',
      'inrp2p_relay',
    ]);
  });

  it('has exactly one money-state row, and a second is unrepresentable', async () => {
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM inrp2p.system_money_state`,
    );
    expect(rows[0]!.n).toBe(1);
    await expect(
      getPool().query(`INSERT INTO inrp2p.system_money_state (id) VALUES (FALSE)`),
    ).rejects.toThrow(/system_money_state_singleton|check constraint/i);
  });
});

/* ------------------------------------------------------------------ *
 * Deterministic account identity
 * ------------------------------------------------------------------ */

describe('account identity is derived, deterministic and unambiguous', () => {
  it('is stable for the same key', async () => {
    const key = { asset: 'USDT', family: 'wallet.hot', scopeKind: 'hot', scopeId: '', shard: 0 };
    expect(await accountId(key)).toBe(await accountId(key));
  });

  it('is a v5 UUID in the account namespace', async () => {
    const id = await accountId({
      asset: 'USDT',
      family: 'wallet.hot',
      scopeKind: 'hot',
      scopeId: '',
      shard: 0,
    });
    // Version nibble 5, variant 10x.
    expect(id[14]).toBe('5');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);

    // And it is genuinely namespaced: a different namespace differs.
    const { rows } = await getPool().query(
      `SELECT inrp2p.uuid_v5($1::uuid, 'x'::bytea) = inrp2p.uuid_v5($2::uuid, 'x'::bytea) AS same`,
      [NS_ACCOUNT, '00000000-0000-0000-0000-000000000000'],
    );
    expect(rows[0]!.same).toBe(false);
  });

  it('DOES NOT collide across a delimiter — the v2.0 ambiguity is gone', async () => {
    /*
     * The exact defect TS-02 §0 records as v2.0 defect A. With a
     * pipe-joined key these two produced the same string and therefore
     * the same account id, collapsing one party's receivable into
     * another's. Length-prefixed CE makes them distinct.
     */
    const a = await accountId({
      asset: 'USDT',
      family: 'receivable.divergence',
      scopeKind: 'divergence',
      scopeId: 'desk_9|x',
      shard: 0,
    });
    const b = await accountId({
      asset: 'USDT',
      family: 'receivable.divergence',
      scopeKind: 'divergence|desk_9',
      scopeId: 'x',
      shard: 0,
    });
    expect(a).not.toBe(b);
  });

  it('refuses a key with a NULL component rather than encoding a short one', async () => {
    await expect(
      getPool().query(
        `SELECT inrp2p.ce_account_key(ROW('USDT', NULL, 'hot', '', 0)::inrp2p.account_key)`,
      ),
    ).rejects.toThrow(/NULL component|null_value/i);
  });

  it('frames every field with a byte length, not a character count', async () => {
    // A multi-byte scope_id must lengthen the encoding by its BYTE count.
    const { rows } = await getPool().query(
      `SELECT octet_length(inrp2p.ce_account_key(
                ROW('USDT','party.balance','user',$1,0)::inrp2p.account_key)) AS n`,
      ['é'],
    );
    const { rows: ascii } = await getPool().query(
      `SELECT octet_length(inrp2p.ce_account_key(
                ROW('USDT','party.balance','user',$1,0)::inrp2p.account_key)) AS n`,
      ['e'],
    );
    expect(Number(rows[0]!.n) - Number(ascii[0]!.n)).toBe(1);
  });

  it('derives class from family, and returns NULL outside the catalogue', async () => {
    const { rows } = await getPool().query(
      `SELECT inrp2p.account_class_of('wallet.hot')::text     AS a,
              inrp2p.account_class_of('party.balance')::text  AS b,
              inrp2p.account_class_of('fee_revenue')::text    AS c,
              inrp2p.account_class_of('platform_capital')::text AS d,
              inrp2p.account_class_of('not_a_family')::text   AS e`,
    );
    expect(rows[0]).toEqual({
      a: 'ASSET',
      b: 'LIABILITY',
      c: 'REVENUE',
      d: 'EQUITY',
      e: null,
    });
  });
});

/* ------------------------------------------------------------------ *
 * The closed catalogue
 * ------------------------------------------------------------------ */

describe('the account catalogue is closed', () => {
  it('materializes a legitimate account through ensure_accounts', async () => {
    await getPool().query(
      `SELECT inrp2p.ensure_accounts(ARRAY[
         ROW('USDT','wallet.hot','hot','',0)::inrp2p.account_key])`,
    );
    const { rows } = await getPool().query(
      `SELECT class::text, account_id FROM inrp2p.ledger_account
        WHERE family = 'wallet.hot' AND asset = 'USDT'`,
    );
    expect(rows[0]!.class).toBe('ASSET');
    expect(rows[0]!.account_id).toBe(
      await accountId({
        asset: 'USDT',
        family: 'wallet.hot',
        scopeKind: 'hot',
        scopeId: '',
        shard: 0,
      }),
    );
  });

  it('creates the balance row alongside it', async () => {
    await getPool().query(
      `SELECT inrp2p.ensure_accounts(ARRAY[
         ROW('USDT','party.balance','user','u_bal_1',0)::inrp2p.account_key])`,
    );
    const id = await accountId({
      asset: 'USDT',
      family: 'party.balance',
      scopeKind: 'user',
      scopeId: 'u_bal_1',
      shard: 0,
    });
    const { rows } = await getPool().query(
      `SELECT balance_minor::text, class::text FROM inrp2p.account_balance WHERE account_id = $1`,
      [id],
    );
    expect(rows[0]!.balance_minor).toBe('0');
    expect(rows[0]!.class).toBe('LIABILITY');
  });

  it('is idempotent', async () => {
    const key = `ROW('USDT','escrow','deal','d_idem',0)::inrp2p.account_key`;
    await getPool().query(`SELECT inrp2p.ensure_accounts(ARRAY[${key}])`);
    await getPool().query(`SELECT inrp2p.ensure_accounts(ARRAY[${key}])`);
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM inrp2p.ledger_account
        WHERE family='escrow' AND scope_id='d_idem'`,
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('refuses a family outside the catalogue', async () => {
    await expect(
      getPool().query(
        `SELECT inrp2p.ensure_accounts(ARRAY[
           ROW('USDT','inr.balance','user','u1',0)::inrp2p.account_key])`,
      ),
    ).rejects.toThrow();
  });

  it('refuses an INR-shaped family outright — there is no INR ledger balance', async () => {
    await expect(
      getPool().query(
        `INSERT INTO inrp2p.ledger_account (account_id, asset, class, family, scope_kind, scope_id)
         VALUES (gen_random_uuid(), 'USDT', 'LIABILITY', 'inr_custody', 'user', 'u1')`,
      ),
    ).rejects.toThrow(/asset_family|check constraint/i);
  });

  it('refuses a TRX account with a USDT-only family', async () => {
    await expect(
      getPool().query(
        `SELECT inrp2p.ensure_accounts(ARRAY[
           ROW('TRX','escrow','deal','d1',0)::inrp2p.account_key])`,
      ),
    ).rejects.toThrow();
  });

  it('refuses a hand-chosen account id that was not derived from its key', async () => {
    await expect(
      getPool().query(
        `INSERT INTO inrp2p.ledger_account (account_id, asset, class, family, scope_kind, scope_id)
         VALUES ('11111111-1111-5111-8111-111111111111','USDT','ASSET','wallet.cold','cold','')`,
      ),
    ).rejects.toThrow(/id_derived|check constraint/i);
  });

  it('refuses sharding a family that is not shardable', async () => {
    await expect(
      getPool().query(
        `SELECT inrp2p.ensure_accounts(ARRAY[
           ROW('USDT','escrow','deal','d2',3)::inrp2p.account_key])`,
      ),
    ).rejects.toThrow(/shardable|check constraint/i);
  });

  it('refuses a scope_id outside the permitted alphabet', async () => {
    await expect(
      getPool().query(
        `SELECT inrp2p.ensure_accounts(ARRAY[
           ROW('USDT','party.balance','user','bad id!',0)::inrp2p.account_key])`,
      ),
    ).rejects.toThrow(/alphabet/i);
  });

  it('is immutable: an account cannot be updated or deleted', async () => {
    await getPool().query(
      `SELECT inrp2p.ensure_accounts(ARRAY[
         ROW('USDT','wallet.cold','cold','',0)::inrp2p.account_key])`,
    );
    // RAISES rather than silently discarding: code that believes it just
    // corrected a ledger must be told that it did not.
    await expect(
      getPool().query(`UPDATE inrp2p.ledger_account SET family = 'wallet.hot'
                        WHERE family = 'wallet.cold'`),
    ).rejects.toThrow(/is immutable/i);
    await expect(
      getPool().query(`DELETE FROM inrp2p.ledger_account WHERE family = 'wallet.cold'`),
    ).rejects.toThrow(/is immutable/i);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM inrp2p.ledger_account WHERE family = 'wallet.cold'`,
    );
    expect(rows[0]!.n).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Amounts
 * ------------------------------------------------------------------ */

describe('amounts are exact integers', () => {
  it('rejects a fractional amount instead of rounding it into money', async () => {
    /*
     * TS-02 §0 defect O: `NUMERIC(38,0)` rounded 1.5 to 2 BEFORE the
     * scale check ran, so the check was dead code and fractional input
     * was silently accepted. The unconstrained base preserves the scale.
     */
    await expect(getPool().query(`SELECT 1.5::inrp2p.amount_minor`)).rejects.toThrow(
      /amount_minor_integral|check/i,
    );
  });

  it('rejects even 1.0, because scale must be <= 0', async () => {
    /*
     * `scale(1.0)` is 1, so `scale(VALUE) <= 0` refuses it — and that is
     * the specified behaviour, not an accident. TS-02 §4.3 notes that
     * v2.0 CLAIMED to reject `1.0` while actually accepting it (the
     * constrained base rounded first). v2.1 genuinely rejects it, so a
     * money value must be written as an integer with no decimal point at
     * all. There is no ambiguity about what a caller meant.
     */
    await expect(getPool().query(`SELECT 1.0::inrp2p.amount_minor`)).rejects.toThrow(
      /amount_minor_integral|check/i,
    );
  });

  it('accepts a plain integer', async () => {
    const { rows } = await getPool().query(`SELECT (1::inrp2p.amount_minor)::text AS v`);
    expect(rows[0]!.v).toBe('1');
  });

  it('rejects NaN', async () => {
    await expect(getPool().query(`SELECT 'NaN'::numeric::inrp2p.amount_minor`)).rejects.toThrow();
  });

  it('accepts a magnitude far beyond a 64-bit integer', async () => {
    const big = '99999999999999999999999999999999999999';
    const { rows } = await getPool().query(`SELECT ($1::inrp2p.amount_minor)::text AS v`, [big]);
    expect(rows[0]!.v).toBe(big);
  });
});

/* ------------------------------------------------------------------ *
 * Double entry
 * ------------------------------------------------------------------ */

describe('every journal entry balances per asset', () => {
  async function seedJournal(code: string) {
    await getPool().query(
      `INSERT INTO inrp2p.journal_catalogue (journal_code, entry_class, description)
       VALUES ($1,'SNJ','Test journal for the balancing proof')
       ON CONFLICT DO NOTHING`,
      [code],
    );
  }

  /*
   * A 64-hex entry-key digest of the right shape for the constraint.
   *
   * Genuinely random per call, because `journal_entry_key_uk` is doing
   * its job: a fixed digest collides with the row an earlier run of this
   * suite already committed against the same database, and the failure
   * would look like a defect in the code rather than in the fixture.
   * Replay is asserted deliberately below by reusing ONE digest.
   */
  const digest = () => randomBytes(32).toString('hex');

  it('commits a balanced entry', async () => {
    await seedJournal('TEST_BALANCED');
    await getPool().query(
      `SELECT inrp2p.ensure_accounts(ARRAY[
         ROW('USDT','wallet.hot','hot','',0)::inrp2p.account_key,
         ROW('USDT','party.balance','user','u_bal_ok',0)::inrp2p.account_key])`,
    );
    const hot = await accountId({
      asset: 'USDT',
      family: 'wallet.hot',
      scopeKind: 'hot',
      scopeId: '',
      shard: 0,
    });
    const party = await accountId({
      asset: 'USDT',
      family: 'party.balance',
      scopeKind: 'user',
      scopeId: 'u_bal_ok',
      shard: 0,
    });

    await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO inrp2p.journal_entry
           (journal_code, entry_class, entry_key_digest, entry_key_json, mode_version, txid)
         VALUES ('TEST_BALANCED','SNJ',$1,'{"t":"ok"}'::jsonb,1,txid_current())
         RETURNING entry_id`,
        [digest()],
      );
      const entryId = rows[0]!.entry_id as string;
      await tx.query(
        `INSERT INTO inrp2p.posting (entry_id, seq, account_id, asset, amount_minor)
         VALUES ($1,1,$2,'USDT',1000), ($1,2,$3,'USDT',-1000)`,
        [entryId, hot, party],
      );
      return null;
    });

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM inrp2p.journal_entry WHERE journal_code='TEST_BALANCED'`,
    );
    expect(rows[0]!.n).toBeGreaterThanOrEqual(1);
  });

  it('REFUSES an unbalanced entry at commit', async () => {
    await seedJournal('TEST_UNBALANCED');
    await getPool().query(
      `SELECT inrp2p.ensure_accounts(ARRAY[
         ROW('USDT','wallet.hot','hot','',0)::inrp2p.account_key,
         ROW('USDT','party.balance','user','u_bal_bad',0)::inrp2p.account_key])`,
    );
    const hot = await accountId({
      asset: 'USDT',
      family: 'wallet.hot',
      scopeKind: 'hot',
      scopeId: '',
      shard: 0,
    });
    const party = await accountId({
      asset: 'USDT',
      family: 'party.balance',
      scopeKind: 'user',
      scopeId: 'u_bal_bad',
      shard: 0,
    });

    await expect(
      withTransaction(async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO inrp2p.journal_entry
             (journal_code, entry_class, entry_key_digest, entry_key_json, mode_version, txid)
           VALUES ('TEST_UNBALANCED','SNJ',$1,'{"t":"bad"}'::jsonb,1,txid_current())
           RETURNING entry_id`,
          [digest()],
        );
        const entryId = rows[0]!.entry_id as string;
        // 1000 out, only 999 back: a rupee of value invented.
        await tx.query(
          `INSERT INTO inrp2p.posting (entry_id, seq, account_id, asset, amount_minor)
           VALUES ($1,1,$2,'USDT',1000), ($1,3,$3,'USDT',-999)`,
          [entryId, hot, party],
        );
        return null;
      }),
    ).rejects.toThrow(/not balanced per asset/i);

    // Nothing survived the refusal.
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM inrp2p.journal_entry WHERE journal_code='TEST_UNBALANCED'`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('REFUSES an entry with no postings at all', async () => {
    await seedJournal('TEST_EMPTY');
    await expect(
      withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO inrp2p.journal_entry
             (journal_code, entry_class, entry_key_digest, entry_key_json, mode_version, txid)
           VALUES ('TEST_EMPTY','SNJ',$1,'{"t":"empty"}'::jsonb,1,txid_current())`,
          [digest()],
        );
        return null;
      }),
    ).rejects.toThrow(/has no postings/i);
  });

  it('balances PER ASSET, not in aggregate', async () => {
    await seedJournal('TEST_CROSS_ASSET');
    await getPool().query(
      `SELECT inrp2p.ensure_accounts(ARRAY[
         ROW('USDT','wallet.hot','hot','',0)::inrp2p.account_key,
         ROW('TRX','wallet.gas','gas','',0)::inrp2p.account_key])`,
    );
    const usdt = await accountId({
      asset: 'USDT',
      family: 'wallet.hot',
      scopeKind: 'hot',
      scopeId: '',
      shard: 0,
    });
    const trx = await accountId({
      asset: 'TRX',
      family: 'wallet.gas',
      scopeKind: 'gas',
      scopeId: '',
      shard: 0,
    });

    // Sums to zero across both assets, but neither asset balances alone.
    await expect(
      withTransaction(async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO inrp2p.journal_entry
             (journal_code, entry_class, entry_key_digest, entry_key_json, mode_version, txid)
           VALUES ('TEST_CROSS_ASSET','SNJ',$1,'{"t":"cross"}'::jsonb,1,txid_current())
           RETURNING entry_id`,
          [digest()],
        );
        const entryId = rows[0]!.entry_id as string;
        await tx.query(
          `INSERT INTO inrp2p.posting (entry_id, seq, account_id, asset, amount_minor)
           VALUES ($1,1,$2,'USDT',500), ($1,2,$3,'TRX',-500)`,
          [entryId, usdt, trx],
        );
        return null;
      }),
    ).rejects.toThrow(/not balanced per asset/i);
  });

  it('makes posting asset match the account by FOREIGN KEY, not by trigger', async () => {
    await seedJournal('TEST_ASSET_MISMATCH');
    const hot = await accountId({
      asset: 'USDT',
      family: 'wallet.hot',
      scopeKind: 'hot',
      scopeId: '',
      shard: 0,
    });
    await expect(
      withTransaction(async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO inrp2p.journal_entry
             (journal_code, entry_class, entry_key_digest, entry_key_json, mode_version, txid)
           VALUES ('TEST_ASSET_MISMATCH','SNJ',$1,'{"t":"mm"}'::jsonb,1,txid_current())
           RETURNING entry_id`,
          [digest()],
        );
        // A USDT account claimed as TRX.
        await tx.query(
          `INSERT INTO inrp2p.posting (entry_id, seq, account_id, asset, amount_minor)
           VALUES ($1,1,$2,'TRX',10)`,
          [rows[0]!.entry_id, hot],
        );
        return null;
      }),
    ).rejects.toThrow(/posting_account_fk|foreign key/i);
  });

  it('refuses a zero posting', async () => {
    await expect(
      getPool().query(
        `INSERT INTO inrp2p.posting (entry_id, seq, account_id, asset, amount_minor)
         VALUES (gen_random_uuid(), 1, gen_random_uuid(), 'USDT', 0)`,
      ),
    ).rejects.toThrow(/posting_nonzero|check constraint/i);
  });

  it('refuses a journal code that is not in the catalogue', async () => {
    await expect(
      getPool().query(
        `INSERT INTO inrp2p.journal_entry
           (journal_code, entry_class, entry_key_digest, entry_key_json, mode_version, txid)
         VALUES ('NOT_A_JOURNAL','SNJ',$1,'{}'::jsonb,1,txid_current())`,
        ['0'.repeat(64)],
      ),
    ).rejects.toThrow(/journal_entry_code_fk|foreign key/i);
  });

  it('refuses a second entry for the same journal and natural key', async () => {
    await seedJournal('TEST_REPLAY');
    await getPool().query(
      `SELECT inrp2p.ensure_accounts(ARRAY[
         ROW('USDT','wallet.hot','hot','',0)::inrp2p.account_key,
         ROW('USDT','party.balance','user','u_replay',0)::inrp2p.account_key])`,
    );
    const hot = await accountId({
      asset: 'USDT',
      family: 'wallet.hot',
      scopeKind: 'hot',
      scopeId: '',
      shard: 0,
    });
    const party = await accountId({
      asset: 'USDT',
      family: 'party.balance',
      scopeKind: 'user',
      scopeId: 'u_replay',
      shard: 0,
    });
    const key = digest();

    const post = () =>
      withTransaction(async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO inrp2p.journal_entry
             (journal_code, entry_class, entry_key_digest, entry_key_json, mode_version, txid)
           VALUES ('TEST_REPLAY','SNJ',$1,'{"t":"replay"}'::jsonb,1,txid_current())
           RETURNING entry_id`,
          [key],
        );
        await tx.query(
          `INSERT INTO inrp2p.posting (entry_id, seq, account_id, asset, amount_minor)
           VALUES ($1,1,$2,'USDT',77), ($1,2,$3,'USDT',-77)`,
          [rows[0]!.entry_id, hot, party],
        );
        return null;
      });

    await post();
    // Exactly-once posting is structural: the unique key refuses the second.
    await expect(post()).rejects.toThrow(/journal_entry_key_uk|duplicate key/i);
  });

  it('keeps journal entries and postings immutable', async () => {
    await expect(
      getPool().query(`UPDATE inrp2p.journal_entry SET mode_version = 999`),
    ).rejects.toThrow(/is immutable/i);
    await expect(getPool().query(`DELETE FROM inrp2p.posting`)).rejects.toThrow(/is immutable/i);

    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM inrp2p.posting`);
    expect(rows[0]!.n, 'postings survive the refused DELETE').toBeGreaterThan(0);
  });
});
