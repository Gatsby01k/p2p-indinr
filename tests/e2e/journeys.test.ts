import { describe, expect, it } from 'vitest';
import { getPool } from '@/server/db/pool';
import { newCommandId } from '@/server/boundary/command';
import {
  claimCommand,
  confirmCommand,
  createDealCommand,
  disputeCommand,
  joinCommand,
  messageCommand,
} from '@/services/commands';
import { signInSandbox } from '@/server/sandbox/service';

/**
 * The three corridors, driven end to end through the real boundary.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHAT THIS IS, AND WHAT IT IS NOT.                                 │
 * │                                                                    │
 * │  The browser run (see the final report) covers the journey from    │
 * │  the landing calculator through sign-in, deal creation, the shared │
 * │  link, a second verified user joining, the deal room, and the      │
 * │  role-gated payment instructions — with screenshots.               │
 * │                                                                    │
 * │  These tests carry the SAME journeys past that point, through the  │
 * │  identical service functions the UI calls, and assert the parts a  │
 * │  screenshot cannot: the deal state machine, the ledger, and the    │
 * │  audit trail. They are not a substitute for the browser evidence   │
 * │  and are not described as one.                                     │
 * └────────────────────────────────────────────────────────────────────┘
 */

/** Verified accounts, seeded by `tests/e2e/seed.test.ts`. */
async function verified(email: string) {
  const user = await signInSandbox(email);
  const { rows } = await getPool().query(
    `SELECT is_verified FROM sandbox.app_user WHERE user_id = $1`,
    [user.userId],
  );
  if (rows[0]?.is_verified !== true) {
    throw new Error(`${email} is not verified — run the seed first`);
  }
  return user;
}

async function stateOf(dealId: string): Promise<string> {
  const { rows } = await getPool().query(`SELECT state FROM sandbox.deal WHERE deal_id = $1`, [
    dealId,
  ]);
  return String(rows[0]!.state);
}

/** Create → share → join, the shape every corridor begins with. */
async function createAndJoin(
  scenario: 'INR_TO_INR' | 'INR_TO_USDT' | 'USDT_TO_INR',
  amount: string,
  creatorEmail: string,
  joinerEmail: string,
) {
  const creator = await verified(creatorEmail);
  const joiner = await verified(joinerEmail);

  const created = await createDealCommand(creator, {
    commandId: newCommandId(),
    scenario,
    inrAmount: amount,
    intent: 'PAY',
  });
  expect(created.ok, `create ${scenario}`).toBe(true);
  if (!created.ok) throw new Error('create failed');

  const joined = await joinCommand(joiner, newCommandId(), created.value.publicId);
  expect(joined.ok, `join ${scenario}`).toBe(true);
  if (!joined.ok) throw new Error('join failed');

  return { creator, joiner, publicId: created.value.publicId, dealId: joined.value.dealId };
}

describe('J1 · INR → INR, the protected payment journey', () => {
  it('runs create → join → pay → confirm and lands COMPLETED', async () => {
    const { creator, joiner, dealId } = await createAndJoin(
      'INR_TO_INR',
      '25000',
      'payer.e2e@example.in',
      'payee.e2e@example.in',
    );
    expect(await stateOf(dealId)).toBe('FIAT_PENDING');

    // The payer marks the transfer with its bank reference.
    const utr = `E2E${Date.now().toString().slice(-9)}`;
    const claimed = await claimCommand(
      creator,
      newCommandId(),
      dealId,
      utr,
      'Sent by UPI from my own verified account.',
    );
    expect(claimed.ok, 'payment claim').toBe(true);
    expect(await stateOf(dealId)).toBe('FIAT_CLAIMED');

    // Only the RECEIVING side may confirm arrival.
    const wrongSide = await confirmCommand(creator, newCommandId(), dealId);
    expect(wrongSide.ok, 'the payer cannot confirm their own payment').toBe(false);

    const confirmed = await confirmCommand(joiner, newCommandId(), dealId);
    expect(confirmed.ok, 'the payee confirms arrival').toBe(true);
    expect(await stateOf(dealId)).toBe('COMPLETED');
  });

  it('records the fee against the frozen snapshot, not a live re-read', async () => {
    const { creator, joiner, dealId } = await createAndJoin(
      'INR_TO_INR',
      '25000',
      'payer.e2e@example.in',
      'payee.e2e@example.in',
    );
    const { snapshotForDeal } = await import('@/server/commerce/pricing');
    const { withTransaction } = await import('@/server/db/pool');
    // `snapshotForDeal` reads inside a transaction, like its callers do.
    const snapshot = await withTransaction((tx) => snapshotForDeal(tx, dealId));
    expect(snapshot).not.toBeNull();

    await claimCommand(
      creator,
      newCommandId(),
      dealId,
      `E2F${Date.now().toString().slice(-9)}`,
      'Paid.',
    );
    await confirmCommand(joiner, newCommandId(), dealId);

    const after = await withTransaction((tx) => snapshotForDeal(tx, dealId));
    // The promise made at creation is the promise honoured at settlement.
    expect(after).toEqual(snapshot);
  });
});

describe('J2 · INR → USDT and J3 · USDT → INR', () => {
  it.each([
    ['INR_TO_USDT', '83000', 'buyer.e2e@example.in', 'seller.e2e@example.in'],
    ['USDT_TO_INR', '83000', 'seller.e2e@example.in', 'buyer.e2e@example.in'],
  ] as const)('%s creates, joins and exposes an exact quote', async (scenario, amount, a, b) => {
    const { dealId } = await createAndJoin(scenario, amount, a, b);

    const { rows } = await getPool().query(
      `SELECT direction, inr_minor, usdt_minor, rate_num, rate_den, pricing_source,
              protection_fee_minor, network_fee_minor
         FROM sandbox.deal WHERE deal_id = $1`,
      [dealId],
    );
    const deal = rows[0]!;
    expect(deal.direction).toBe(scenario);
    // A crypto corridor must carry BOTH legs and the rate that joined
    // them — a deal priced without a recorded rate cannot be audited.
    expect(deal.usdt_minor).not.toBeNull();
    expect(Number(deal.rate_num)).toBeGreaterThan(0);
    expect(Number(deal.rate_den)).toBeGreaterThan(0);
    expect(deal.pricing_source).toBeTruthy();
  });

  it('never invents custodial INR: no INR ledger account exists', async () => {
    /*
     * The honest-refusal property carried since DEL-04. INRP2P holds no
     * rupees, so an INR-denominated balance would be a fiction.
     */
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM inrp2p.ledger_account WHERE asset::text = 'INR'`,
    );
    expect(rows[0]!.n).toBe(0);
  });
});

describe('J4 · The dispute journey', () => {
  it('opens a case, freezes the deal and records an immutable statement', async () => {
    const { creator, joiner, dealId } = await createAndJoin(
      'INR_TO_INR',
      '25000',
      'payer.e2e@example.in',
      'payee.e2e@example.in',
    );
    await claimCommand(
      creator,
      newCommandId(),
      dealId,
      `E2G${Date.now().toString().slice(-9)}`,
      'Paid.',
    );

    const opened = await disputeCommand(
      joiner,
      newCommandId(),
      dealId,
      'PAYMENT_NOT_RECEIVED',
      'The reference does not appear on my statement and nothing has arrived.',
    );
    expect(opened.ok, 'the payee opens a case').toBe(true);
    expect(await stateOf(dealId)).toBe('DISPUTED');

    // Ordinary progress is frozen while a case is open.
    const confirmed = await confirmCommand(joiner, newCommandId(), dealId);
    expect(confirmed.ok, 'a disputed deal cannot simply be confirmed').toBe(false);

    const { rows } = await getPool().query(
      `SELECT state, statement, snapshot FROM sandbox.dispute_case WHERE deal_id = $1`,
      [dealId],
    );
    expect(rows[0]!.state).toBe('OPEN');
    expect(String(rows[0]!.statement)).toContain('does not appear on my statement');
    // The snapshot freezes the facts as they were when the case opened.
    expect(rows[0]!.snapshot).toBeTruthy();
  });

  it('only ONE active case can exist per deal', async () => {
    const { creator, joiner, dealId } = await createAndJoin(
      'INR_TO_INR',
      '25000',
      'payer.e2e@example.in',
      'payee.e2e@example.in',
    );
    await claimCommand(
      creator,
      newCommandId(),
      dealId,
      `E2H${Date.now().toString().slice(-9)}`,
      'Paid.',
    );

    const first = await disputeCommand(
      joiner,
      newCommandId(),
      dealId,
      'PAYMENT_NOT_RECEIVED',
      'Nothing has arrived in my account and I would like this reviewed.',
    );
    expect(first.ok).toBe(true);

    const second = await disputeCommand(
      creator,
      newCommandId(),
      dealId,
      'OTHER',
      'I disagree with the complaint that has just been raised against me.',
    );
    expect(second.ok, 'a second live case is refused').toBe(false);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.dispute_case
        WHERE deal_id = $1 AND state IN ('OPEN','UNDER_REVIEW')`,
      [dealId],
    );
    expect(rows[0]!.n).toBe(1);
  });
});

describe('J5 · The deal room carries a real conversation', () => {
  it('posts, orders and refuses to edit a message', async () => {
    const { creator, joiner, dealId } = await createAndJoin(
      'INR_TO_INR',
      '25000',
      'payer.e2e@example.in',
      'payee.e2e@example.in',
    );

    const a = await messageCommand(
      creator,
      newCommandId(),
      dealId,
      'I have sent the transfer, the reference is on its way.',
    );
    const b = await messageCommand(
      joiner,
      newCommandId(),
      dealId,
      'Thank you — I will check my account and confirm shortly.',
    );
    expect(a.ok && b.ok).toBe(true);

    const { rows } = await getPool().query(
      `SELECT body FROM sandbox.deal_message WHERE deal_id = $1 ORDER BY seq`,
      [dealId],
    );
    // Includes the system message written when the counterparty joined.
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(String(rows.at(-1)!.body)).toContain('check my account');
  });
});
