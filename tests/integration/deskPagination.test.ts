import { fundForDeals, clearRiskCounters } from './support/escrow';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DESK_PAGE_SIZE, deskCounts, deskQueue } from '@/server/sandbox/ops';
import {
  createDealLink,
  issueProtectedQuote,
  joinDealLink,
  signInSandbox,
  type SessionUser,
} from '@/server/sandbox/service';
import { makeOperator, type OperatorFixture } from './support/operator';

/**
 * DEL-10: the Deal Desk is BOUNDED, and still tells the truth.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  AN UNBOUNDED QUEUE IS SLOWEST ON THE DAY IT MATTERS MOST.         │
 * │                                                                    │
 * │  The desk used to select every open deal on the platform — twice   │
 * │  per render, once to count and once to filter — and render every   │
 * │  row. That is fine with four deals and unusable with four          │
 * │  thousand, which is precisely the situation an operator opens the  │
 * │  page in.                                                          │
 * │                                                                    │
 * │  Two properties matter and they pull against each other, so both   │
 * │  are asserted here: the PAGE is bounded, and the COUNTS are not.   │
 * │  A bound that also truncated the counts would be worse than no     │
 * │  bound, because an operator would believe they had seen the queue. │
 * └────────────────────────────────────────────────────────────────────┘
 */

const unique = () => Math.random().toString(36).slice(2, 10);

/** Comfortably more than one page, so the second page is real. */
const BACKLOG = DESK_PAGE_SIZE + 12;

let operator: OperatorFixture;
let maker: SessionUser;
let taker: SessionUser;

beforeAll(async () => {
  operator = await makeOperator(`desk-ops-${unique()}@example.com`);
  maker = await signInSandbox(`desk-maker-${unique()}@example.com`);
  taker = await signInSandbox(`desk-taker-${unique()}@example.com`);

  // Real deals through the real path: a queue seeded with rows the
  // product could not have produced would measure the wrong thing.
  for (let i = 0; i < BACKLOG; i += 1) {
    const quote = await issueProtectedQuote(maker, 120_000n);
    const link = await createDealLink(maker, quote.quoteId, 'PAY');
    await joinDealLink(taker, link.publicId);
  }
}, 120_000);

/*
 * Escrow is real now: the crypto side must own what it sells, and every
 * deal counts toward that account's rolling exposure. Neither is what
 * this file tests, so both are handled by shared fixture support rather
 * than by relaxing the checks that make them true.
 */
beforeAll(async () => {
  await fundForDeals([maker, taker]);
});
beforeEach(async () => {
  await clearRiskCounters([maker, taker]);
});

describe('the desk queue is bounded and its counts are not', () => {
  it('never returns more than one page, however long the backlog', async () => {
    const page = await deskQueue(operator.principal);
    expect(page.rows.length).toBeLessThanOrEqual(DESK_PAGE_SIZE);
    expect(page.pageSize).toBe(DESK_PAGE_SIZE);
    expect(page.total).toBeGreaterThanOrEqual(BACKLOG);
    expect(page.hasMore).toBe(true);
  });

  it('reports the true total, not the length of the page', async () => {
    const page = await deskQueue(operator.principal);
    const counts = await deskCounts(operator.principal);
    expect(counts.all).toBe(page.total);
    expect(counts.all).toBeGreaterThan(page.rows.length);
  });

  it('a caller cannot widen the page from outside', async () => {
    // The bound is a protection; one a query string could raise is not.
    const page = await deskQueue(operator.principal, 'ALL', { pageSize: 10_000 });
    expect(page.rows.length).toBeLessThanOrEqual(DESK_PAGE_SIZE);
  });

  it('the second page continues the first without repeating or skipping', async () => {
    const first = await deskQueue(operator.principal, 'ALL', { page: 1 });
    const second = await deskQueue(operator.principal, 'ALL', { page: 2 });

    const firstIds = new Set(first.rows.map((r) => r.dealId));
    const overlap = second.rows.filter((r) => firstIds.has(r.dealId));
    expect(overlap, 'no row appears on two pages').toHaveLength(0);
    expect(first.rows.length + second.rows.length).toBeLessThanOrEqual(first.total);
  });

  it('a nonsense page number is treated as the first, not as an error', async () => {
    for (const page of [0, -3, Number.NaN]) {
      const result = await deskQueue(operator.principal, 'ALL', { page });
      expect(result.page).toBe(1);
    }
  });

  it('filters in the database, so a narrow view is a cheap query', async () => {
    const awaiting = await deskQueue(operator.principal, 'AWAITING_PAYMENT');
    expect(awaiting.rows.every((r) => r.state === 'FIAT_PENDING')).toBe(true);
    // The total is the total FOR THAT FILTER, not for the whole desk.
    const counts = await deskCounts(operator.principal);
    expect(awaiting.total).toBe(counts.awaitingPayment);
  });

  it('is refused before any row is read, for a caller without the permission', async () => {
    const nobody = {
      userId: maker.userId,
      roles: [] as const,
      permissions: [] as const,
      mfaSatisfied: false,
      mfaEnrolled: false,
    };
    await expect(deskQueue(nobody)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(deskCounts(nobody)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
