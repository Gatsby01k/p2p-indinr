/**
 * ATOMIC SINGLE-WINNER JOIN — real concurrency, real database.
 *
 * This is not a mock and not a sequential simulation. Every case below opens
 * TWO OR MORE INDEPENDENT PostgreSQL CONNECTIONS from a pool and releases them
 * against the same deal link inside the same instant, then asserts on what the
 * database actually committed.
 *
 * The property under test is that the winner is decided by PostgreSQL — by
 * `SELECT ... FOR UPDATE`, a conditional state change, and `UNIQUE(link_id)` —
 * and not by any application check, button state or ordering luck.
 *
 * Requires the sandbox database:  npm run db:start
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getPool } from '@/server/db/pool';
import {
  SandboxFailure,
  createDealLink,
  getLinkPreview,
  issueFirmQuote,
  joinDealLink,
  signInSandbox,
  type SessionUser,
} from '@/server/sandbox/service';

let creator: SessionUser;
let alice: SessionUser;
let bob: SessionUser;
const contenders: SessionUser[] = [];

beforeAll(async () => {
  creator = await signInSandbox('race-creator@sandbox.test');
  alice = await signInSandbox('race-alice@sandbox.test');
  bob = await signInSandbox('race-bob@sandbox.test');
  for (let i = 0; i < 16; i += 1) {
    contenders.push(await signInSandbox(`race-c${i}@sandbox.test`));
  }
});

/** A fresh, open link with a fresh quote behind it. */
async function freshLink(): Promise<string> {
  const quote = await issueFirmQuote(creator, 'USDT_TO_INR', 500_000_000n);
  const link = await createDealLink(creator, quote.quoteId);
  return link.publicId;
}

/** Count what the database actually holds for a link. */
async function factsFor(publicId: string) {
  const { rows } = await getPool().query(
    `SELECT l.state                                   AS link_state,
            l.consumed_at IS NOT NULL                 AS has_consumed_at,
            (SELECT count(*) FROM sandbox.deal d WHERE d.link_id = l.link_id)        AS deals,
            (SELECT count(*) FROM sandbox.participant p
               JOIN sandbox.deal d2 ON d2.deal_id = p.deal_id
              WHERE d2.link_id = l.link_id)                                          AS participants
       FROM sandbox.deal_link l
      WHERE l.public_id = $1`,
    [publicId],
  );
  const r = rows[0]!;
  return {
    linkState: r.link_state as string,
    hasConsumedAt: r.has_consumed_at as boolean,
    deals: Number(r.deals),
    participants: Number(r.participants),
  };
}

type Settled = { winners: number; consumed: number; other: string[] };

function tally(results: PromiseSettledResult<unknown>[]): Settled {
  const out: Settled = { winners: 0, consumed: 0, other: [] };
  for (const r of results) {
    if (r.status === 'fulfilled') out.winners += 1;
    else if (r.reason instanceof SandboxFailure && r.reason.code === 'LINK_CONSUMED')
      out.consumed += 1;
    else out.other.push(r.reason instanceof Error ? `${r.reason.message}` : String(r.reason));
  }
  return out;
}

describe('atomic single-winner Join', () => {
  it('two independent sessions racing one link: exactly one winner', async () => {
    const publicId = await freshLink();

    // Both promises are created before either is awaited, so the two
    // transactions are genuinely in flight against separate connections.
    const results = await Promise.allSettled([
      joinDealLink(alice, publicId),
      joinDealLink(bob, publicId),
    ]);

    const t = tally(results);
    expect(t.other, `unexpected failures: ${t.other.join(' | ')}`).toEqual([]);
    expect(t.winners).toBe(1);
    expect(t.consumed).toBe(1);

    const facts = await factsFor(publicId);
    expect(facts.linkState).toBe('CONSUMED');
    expect(facts.hasConsumedAt).toBe(true);
    expect(facts.deals).toBe(1);
    expect(facts.participants).toBe(2); // one deal, both seats, no duplicates
  });

  it('16 concurrent sessions on one link: still exactly one winner', async () => {
    const publicId = await freshLink();

    const results = await Promise.allSettled(contenders.map((u) => joinDealLink(u, publicId)));

    const t = tally(results);
    expect(t.other, `unexpected failures: ${t.other.join(' | ')}`).toEqual([]);
    expect(t.winners).toBe(1);
    expect(t.consumed).toBe(contenders.length - 1);

    const facts = await factsFor(publicId);
    expect(facts.deals).toBe(1);
    expect(facts.participants).toBe(2);
  });

  it('leaves no partial records for the losers', async () => {
    const publicId = await freshLink();
    await Promise.allSettled([
      joinDealLink(alice, publicId),
      joinDealLink(bob, publicId),
      joinDealLink(contenders[0]!, publicId),
    ]);

    // Every loser rolled back completely: no orphan deal, no orphan seat.
    const { rows } = await getPool().query(
      `SELECT (SELECT count(*) FROM sandbox.deal d
                 JOIN sandbox.deal_link l ON l.link_id = d.link_id
                WHERE l.public_id = $1)                                     AS deals,
              (SELECT count(*) FROM sandbox.participant p
                 JOIN sandbox.deal d2 ON d2.deal_id = p.deal_id
                 JOIN sandbox.deal_link l2 ON l2.link_id = d2.link_id
                WHERE l2.public_id = $1)                                    AS seats,
              (SELECT count(DISTINCT role) FROM sandbox.participant p2
                 JOIN sandbox.deal d3 ON d3.deal_id = p2.deal_id
                 JOIN sandbox.deal_link l3 ON l3.link_id = d3.link_id
                WHERE l3.public_id = $1)                                    AS roles`,
      [publicId],
    );
    expect(Number(rows[0]!.deals)).toBe(1);
    expect(Number(rows[0]!.seats)).toBe(2);
    expect(Number(rows[0]!.roles)).toBe(2); // exactly FIAT_SIDE and CRYPTO_SIDE
  });

  it('the link stays consumed after reload and retry', async () => {
    const publicId = await freshLink();
    await joinDealLink(alice, publicId);

    // "Reload": a completely fresh read through a new connection.
    const preview = await getLinkPreview(publicId);
    expect(preview?.displayStatus).toBe('CONSUMED');
    expect(preview?.joinable).toBe(false);

    // Retry by the winner and by a third party both fail, persistently.
    await expect(joinDealLink(alice, publicId)).rejects.toMatchObject({ code: 'LINK_CONSUMED' });
    await expect(joinDealLink(bob, publicId)).rejects.toMatchObject({ code: 'LINK_CONSUMED' });

    const facts = await factsFor(publicId);
    expect(facts.deals).toBe(1);
  });

  it('the database itself refuses a second deal for one link', async () => {
    // Bypass the service entirely and attack the constraint directly, proving
    // the guarantee is not merely application logic.
    const publicId = await freshLink();
    await joinDealLink(alice, publicId);

    const { rows } = await getPool().query(
      `SELECT d.link_id, d.quote_id, d.direction, d.usdt_minor, d.inr_minor,
              d.rate_num, d.rate_den, d.pricing_source, d.observed_at
         FROM sandbox.deal d
         JOIN sandbox.deal_link l ON l.link_id = d.link_id
        WHERE l.public_id = $1`,
      [publicId],
    );
    const d = rows[0]!;

    await expect(
      getPool().query(
        `INSERT INTO sandbox.deal
           (public_id, link_id, quote_id, direction, usdt_minor, inr_minor,
            rate_num, rate_den, pricing_source, observed_at)
         VALUES ('INRP-ZZZZZZZZZZ',$1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          d.link_id,
          d.quote_id,
          d.direction,
          d.usdt_minor,
          d.inr_minor,
          d.rate_num,
          d.rate_den,
          d.pricing_source,
          d.observed_at,
        ],
      ),
    ).rejects.toMatchObject({ constraint: 'deal_link_uq' });
  });

  it('a creator cannot win the race for their own link', async () => {
    const publicId = await freshLink();
    const results = await Promise.allSettled([
      joinDealLink(creator, publicId),
      joinDealLink(alice, publicId),
    ]);

    const creatorResult = results[0]!;
    expect(creatorResult.status).toBe('rejected');
    expect((creatorResult as PromiseRejectedResult).reason).toMatchObject({
      code: 'CANNOT_JOIN_OWN_LINK',
    });
    expect(results[1]!.status).toBe('fulfilled');

    const facts = await factsFor(publicId);
    expect(facts.deals).toBe(1);
    expect(facts.participants).toBe(2);
  });
});
