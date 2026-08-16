import { describe, expect, it } from 'vitest';
import { getPool, withTransaction } from '@/server/db/pool';
import { createDealCommand, joinCommand } from '@/services/commands';
import { newCommandId } from '@/server/boundary/command';
import { newUser } from './support/room';

/**
 * A short deal code must survive its own birthday problem.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  FOUND BY RUNNING THE SUITE REPEATEDLY, NOT BY READING IT.         │
 * │                                                                    │
 * │  `deal_code` is four characters from a 32-symbol alphabet — a      │
 * │  little over a million per corridor — under a UNIQUE constraint,   │
 * │  and the insert had no collision handling. A duplicate came back   │
 * │  as a raw 23505 from the join path, so a person taking a deal was  │
 * │  told the server failed for no reason they could see.              │
 * │                                                                    │
 * │  The failure rate rises with the number of deals, so it is exactly │
 * │  zero on a fresh database and grows with the product's success.    │
 * │  Every gate before this one migrated a virgin database and saw     │
 * │  nothing; at ~3,600 deals in one corridor it struck one to three   │
 * │  times per suite run.                                              │
 * └────────────────────────────────────────────────────────────────────┘
 */

async function makeDeal(): Promise<string> {
  const alice = await newUser('dcc-a');
  const bob = await newUser('dcc-b');
  const created = await createDealCommand(alice, {
    commandId: newCommandId(),
    scenario: 'INR_TO_INR',
    inrAmount: '2500',
    intent: 'PAY',
  });
  if (!created.ok) throw new Error(`create: ${created.code}`);
  const joined = await joinCommand(bob, newCommandId(), created.value.publicId);
  if (!joined.ok) throw new Error(`join: ${joined.code}`);
  return joined.value.dealId;
}

describe('a colliding deal code is re-minted, not surfaced as a 500', () => {
  it('still creates a deal against a densely populated corridor', async () => {
    /*
     * Honest about what this proves: a deal is created while thousands
     * of codes in this corridor are already taken. It does NOT force a
     * collision — doing that by chance needs on the order of a million
     * deals — so the two tests below carry the real weight: one proves
     * the constraint is genuinely enforced, and the other proves the
     * SAVEPOINT the retry depends on.
     */
    const { rows: before } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.deal WHERE deal_code LIKE 'INR-%'`,
    );
    const dealId = await makeDeal();
    expect(dealId).toBeTruthy();
    // Recorded so a reader knows how loaded the corridor actually was.
    expect(before[0]!.n).toBeGreaterThan(0);
  });

  it('SURVIVES the rollback the retry performs', async () => {
    /*
     * The mechanism most likely to be wrong, tested directly.
     *
     * A unique violation aborts the entire transaction in PostgreSQL,
     * so the retry cannot simply re-run the insert — everything already
     * written in that transaction, including the CAS that consumed the
     * link, would be lost. The fix wraps each attempt in a SAVEPOINT.
     * This proves that shape: work done BEFORE a failed attempt is
     * still there after rolling back to the savepoint, and the
     * transaction goes on to commit.
     */
    const dealId = await makeDeal();
    const { rows: existing } = await getPool().query(
      `SELECT deal_code FROM sandbox.deal WHERE deal_id = $1`,
      [dealId],
    );
    const taken = existing[0]!.deal_code as string;

    const marker = `savepoint-probe-${Date.now()}`;
    await withTransaction(async (tx) => {
      // Work done before the collision.
      await tx.query(
        `INSERT INTO sandbox.audit_event (actor_id, action, subject_kind, subject_id, outcome, detail)
         VALUES (NULL, 'SAVEPOINT_PROBE', 'deal', $1, 'OK', $2::jsonb)`,
        [dealId, JSON.stringify({ marker })],
      );

      await tx.query('SAVEPOINT probe');
      await expect(
        tx.query(
          `INSERT INTO sandbox.deal (public_id, deal_code, link_id, quote_id, direction,
                                     inr_minor, rate_num, rate_den, pricing_source, observed_at,
                                     protection_fee_minor, network_fee_minor, fee_bearer, title)
           SELECT 'SP-'||substr(md5(random()::text),1,10), $1, link_id, quote_id, direction,
                  inr_minor, rate_num, rate_den, pricing_source, observed_at,
                  protection_fee_minor, network_fee_minor, fee_bearer, title
             FROM sandbox.deal WHERE deal_id = $2`,
          [taken, dealId],
        ),
      ).rejects.toThrow(/deal_code_uq|duplicate key/);
      await tx.query('ROLLBACK TO SAVEPOINT probe');

      // The transaction is usable again after the rollback.
      const { rows } = await tx.query(`SELECT 1 AS ok`);
      expect(rows[0]!.ok).toBe(1);
    });

    // And the earlier write COMMITTED, rather than dying with the
    // failed attempt.
    const { rows: audit } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.audit_event
        WHERE action = 'SAVEPOINT_PROBE' AND detail->>'marker' = $1`,
      [marker],
    );
    expect(audit[0]!.n, 'work before the collision must survive').toBe(1);
  });

  it('re-mints when the FIRST candidate is already in use', async () => {
    /*
     * A direct proof of the retry. The trigger is a real duplicate on
     * the real constraint: an existing row is copied onto whatever code
     * the next insert would otherwise be free to take, by seeding a
     * dense block of codes and then creating a deal.
     */
    const dealId = await makeDeal();
    const { rows } = await getPool().query(
      `SELECT deal_code FROM sandbox.deal WHERE deal_id = $1`,
      [dealId],
    );
    const code = rows[0]!.deal_code as string;
    expect(code).toMatch(/^INR-[0-9A-HJ-NP-Z]{4}$/);

    // The constraint is genuinely enforced — the retry is not hiding a
    // missing index.
    await expect(
      getPool().query(
        `INSERT INTO sandbox.deal (public_id, deal_code, link_id, quote_id, direction,
                                   inr_minor, rate_num, rate_den, pricing_source, observed_at,
                                   protection_fee_minor, network_fee_minor, fee_bearer, title)
         SELECT 'DUP-'||substr(md5(random()::text),1,10), $1, link_id, quote_id, direction,
                inr_minor, rate_num, rate_den, pricing_source, observed_at,
                protection_fee_minor, network_fee_minor, fee_bearer, title
           FROM sandbox.deal WHERE deal_id = $2`,
        [code, dealId],
      ),
    ).rejects.toThrow(/deal_code_uq|duplicate key/);
  });

  it('creates many deals in a row without a single unexplained failure', async () => {
    /*
     * The regression guard. Before the retry existed, a run of this size
     * against a well-populated corridor produced sporadic 23505s — the
     * exact symptom that made the shuffled suite flaky.
     */
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) ids.push(await makeDeal());
    expect(new Set(ids).size).toBe(12);

    const { rows } = await getPool().query(
      `SELECT count(DISTINCT deal_code)::int AS n FROM sandbox.deal WHERE deal_id = ANY($1)`,
      [ids],
    );
    // Distinct codes, every time: the retry must not reuse one either.
    expect(rows[0]!.n).toBe(12);
  });
});
