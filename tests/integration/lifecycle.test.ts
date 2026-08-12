import { beforeAll, describe, expect, it } from 'vitest';
import { getPool, withTransaction } from '@/server/db/pool';
import { boundaryContextFor, newCommandId, runCommand } from '@/server/boundary/command';
import {
  cancelDealIn,
  createDealIntentIn,
  getDeal,
  issueProtectedQuote,
  createDealLink,
  joinDealLink,
  runLifecycleSweep,
  signInSandbox,
  submitPaymentClaimIn,
  type SessionUser,
} from '@/server/sandbox/service';
import { PAYMENT_WINDOW_MINUTES } from '@/lib/rate';
import { settlementFor } from '@/lib/fees';

/**
 * DEL-02 lifecycle corrections: exact database-clock expiry, authoritative
 * transitions, audited state changes, and the zero-net fee refusal.
 */

let alice: SessionUser;
let bob: SessionUser;

const unique = () => Math.random().toString(36).slice(2, 10);

beforeAll(async () => {
  alice = await signInSandbox(`life-a-${unique()}@example.com`);
  bob = await signInSandbox(`life-b-${unique()}@example.com`);
});

/** A live protected deal with both seats filled. */
async function liveDeal(): Promise<{ dealId: string; publicId: string }> {
  const quote = await issueProtectedQuote(alice, 300_000n);
  const link = await createDealLink(alice, quote.quoteId, 'PAY');
  const join = await joinDealLink(bob, link.publicId);
  return { dealId: join.dealId, publicId: link.publicId };
}

/** Push a deal's deadline into the past without touching its state. */
async function backdateDeadline(dealId: string, interval: string): Promise<void> {
  await getPool().query(
    `UPDATE sandbox.deal SET action_deadline = now() - $2::interval WHERE deal_id = $1`,
    [dealId, interval],
  );
}

/* ------------------------------------------------------------------ *
 * Exact deadline arithmetic
 * ------------------------------------------------------------------ */

describe('payment window is the window the interface shows', () => {
  it('sets the deadline exactly PAYMENT_WINDOW_MINUTES after the join', async () => {
    const { dealId } = await liveDeal();
    const { rows } = await getPool().query(
      `SELECT EXTRACT(EPOCH FROM (action_deadline - created_at)) / 60 AS minutes
         FROM sandbox.deal WHERE deal_id = $1`,
      [dealId],
    );
    expect(Math.round(Number(rows[0]!.minutes))).toBe(PAYMENT_WINDOW_MINUTES);
  });

  it('does NOT expire one second before the deadline', async () => {
    const { dealId } = await liveDeal();
    // Thirty seconds in the FUTURE: the window has not closed.
    await getPool().query(
      `UPDATE sandbox.deal SET action_deadline = now() + interval '30 seconds' WHERE deal_id = $1`,
      [dealId],
    );

    /*
     * The assertion is about THIS deal, not the sweep's total.
     *
     * `runLifecycleSweep()` is a global operation and the suite shares one
     * database, so a sibling test's lapsed deal legitimately raises the
     * count. Asserting `dealsExpired === 0` measured the other tests and
     * failed the moment the suite grew — a flaky assertion masquerading as
     * a strict one.
     */
    await runLifecycleSweep();

    const { rows } = await getPool().query(
      `SELECT state, action_deadline FROM sandbox.deal WHERE deal_id = $1`,
      [dealId],
    );
    expect(rows[0]!.state).toBe('FIAT_PENDING');
    expect(rows[0]!.action_deadline).not.toBeNull();
  });

  it('expires at the deadline itself, not two hours after it', async () => {
    const { dealId } = await liveDeal();
    // One second past the deadline. The previous implementation compared
    // `action_deadline <= now() - interval '2 hours'`, so this row would
    // have survived for another two hours.
    await backdateDeadline(dealId, '1 second');

    const swept = await runLifecycleSweep();
    expect(swept.dealsExpired).toBeGreaterThanOrEqual(1);

    const { rows } = await getPool().query(
      `SELECT state, closed_at, action_deadline FROM sandbox.deal WHERE deal_id = $1`,
      [dealId],
    );
    expect(rows[0]!.state).toBe('EXPIRED');
    expect(rows[0]!.closed_at).not.toBeNull();
    expect(rows[0]!.action_deadline).toBeNull();
  });

  it('never expires a deal on which a payment was claimed', async () => {
    const { dealId } = await liveDeal();
    await withTransaction((tx) =>
      submitPaymentClaimIn(
        boundaryContextFor(tx, newCommandId()),
        bob,
        dealId,
        `UTR${unique().toUpperCase().padEnd(9, 'X').slice(0, 9)}`,
      ),
    ).catch(() => undefined);

    // Whichever seat may claim, force the state and backdate it.
    await getPool().query(
      `UPDATE sandbox.deal SET state='FIAT_CLAIMED', action_deadline = now() - interval '1 day'
        WHERE deal_id = $1`,
      [dealId],
    );
    const swept = await runLifecycleSweep();
    const { rows } = await getPool().query(`SELECT state FROM sandbox.deal WHERE deal_id = $1`, [
      dealId,
    ]);
    expect(rows[0]!.state).toBe('FIAT_CLAIMED');
    expect(swept.dealsExpired).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Expiry is audited
 * ------------------------------------------------------------------ */

describe('every expiry transition carries its audit row', () => {
  it('audits a deal expiry in the same transaction', async () => {
    const { dealId } = await liveDeal();
    await backdateDeadline(dealId, '5 minutes');
    await runLifecycleSweep();

    const { rows } = await getPool().query(
      `SELECT action, from_state, to_state, outcome FROM sandbox.audit_event
        WHERE subject_id = $1 AND action = 'DEAL_EXPIRE'`,
      [dealId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.from_state).toBe('FIAT_PENDING');
    expect(rows[0]!.to_state).toBe('EXPIRED');
    expect(rows[0]!.outcome).toBe('OK');
  });

  it('emits a domain event for the expiry', async () => {
    const { dealId } = await liveDeal();
    await backdateDeadline(dealId, '5 minutes');
    await runLifecycleSweep();
    const { rows } = await getPool().query(
      `SELECT event_type FROM sandbox.outbox_event WHERE subject_id = $1`,
      [dealId],
    );
    expect(rows.map((r) => r.event_type)).toContain('deal.expired');
  });

  it('tells both sides, and says nothing was transferred', async () => {
    const { dealId } = await liveDeal();
    await backdateDeadline(dealId, '5 minutes');
    await runLifecycleSweep();
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.notification WHERE deal_id = $1
        AND title = 'Payment window closed'`,
      [dealId],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it('expires a lapsed quote authoritatively, with an audit row', async () => {
    const quote = await issueProtectedQuote(alice, 200_000n);
    /*
     * Both timestamps move, because `quote_expiry_after_issue` requires
     * `expires_at > created_at` and is right to. Backdating the issue time
     * as well is what a genuinely old quote looks like; moving only the
     * expiry would fabricate a row the schema forbids — and the constraint
     * catching that is the schema doing its job.
     */
    await getPool().query(
      `UPDATE sandbox.quote
          SET created_at = now() - interval '10 minutes',
              expires_at = now() - interval '1 second'
        WHERE quote_id = $1`,
      [quote.quoteId],
    );

    const swept = await runLifecycleSweep();
    expect(swept.quotesExpired).toBeGreaterThanOrEqual(1);

    const { rows } = await getPool().query(`SELECT state FROM sandbox.quote WHERE quote_id = $1`, [
      quote.quoteId,
    ]);
    expect(rows[0]!.state).toBe('EXPIRED');

    const { rows: audits } = await getPool().query(
      `SELECT to_state FROM sandbox.audit_event WHERE subject_id = $1 AND action = 'QUOTE_EXPIRE'`,
      [quote.quoteId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.to_state).toBe('EXPIRED');
  });

  it('is idempotent: a second sweep changes nothing', async () => {
    const { dealId } = await liveDeal();
    await backdateDeadline(dealId, '5 minutes');
    await runLifecycleSweep();
    await runLifecycleSweep();
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.audit_event
        WHERE subject_id = $1 AND action = 'DEAL_EXPIRE'`,
      [dealId],
    );
    // One expiry, one audit row — a second sweep adds nothing for this deal.
    expect(rows[0]!.n).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Boundaries close their own window
 * ------------------------------------------------------------------ */

describe('a boundary refuses to act on a lapsed deal', () => {
  it('refuses a cancel after the window closed, and expires the deal doing it', async () => {
    const { dealId } = await liveDeal();
    await backdateDeadline(dealId, '1 minute');

    const outcome = await runCommand({
      commandId: newCommandId(),
      commandType: 'DEAL_CANCEL',
      actorId: alice.userId,
      payload: { dealId },
      body: (ctx) => cancelDealIn(ctx, alice, dealId),
      encodeResult: (v) => ({ dealId: v.dealId }),
      decodeResult: (r) => ({ dealId: String(r.dealId) }),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('WINDOW_LAPSED');

    const { rows } = await getPool().query(`SELECT state FROM sandbox.deal WHERE deal_id = $1`, [
      dealId,
    ]);
    expect(rows[0]!.state).toBe('EXPIRED');
  });
});

/* ------------------------------------------------------------------ *
 * Zero-net PAYEE fee — AUD-P1-005
 * ------------------------------------------------------------------ */

describe('a quote that leaves the receiver nothing is refused', () => {
  it('confirms the arithmetic the refusal is protecting against', () => {
    const settlement = settlementFor('INR_TO_USDT', 10_000n, 'PAYEE');
    expect(settlement.fees.totalMinor).toBeGreaterThan(10_000n);
    // The presentation floor stays: no screen renders a negative figure.
    expect(settlement.payeeReceivesMinor).toBe(0n);
  });

  it('refuses the quote rather than issuing it', async () => {
    const outcome = await runCommand({
      commandId: newCommandId(),
      commandType: 'DEAL_INTENT_CREATE',
      actorId: alice.userId,
      payload: { scenario: 'INR_TO_USDT', inrMinor: '10000', feeBearer: 'PAYEE' },
      body: (ctx) =>
        createDealIntentIn(ctx, alice, {
          scenario: 'INR_TO_USDT',
          inrMinor: 10_000n,
          intent: 'PAY',
          feeBearer: 'PAYEE',
        }),
      encodeResult: (v) => ({ publicId: v.publicId }),
      decodeResult: (r) => ({ publicId: String(r.publicId), quoteId: '' }),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('FEE_EXCEEDS_AMOUNT');
  });

  it('still accepts the same amount when the payer bears the fees', async () => {
    const outcome = await runCommand({
      commandId: newCommandId(),
      commandType: 'DEAL_INTENT_CREATE',
      actorId: alice.userId,
      payload: { scenario: 'INR_TO_USDT', inrMinor: '10000', feeBearer: 'PAYER' },
      body: (ctx) =>
        createDealIntentIn(ctx, alice, {
          scenario: 'INR_TO_USDT',
          inrMinor: 10_000n,
          intent: 'PAY',
          feeBearer: 'PAYER',
        }),
      encodeResult: (v) => ({ publicId: v.publicId, quoteId: v.quoteId }),
      decodeResult: (r) => ({ publicId: String(r.publicId), quoteId: String(r.quoteId) }),
    });
    expect(outcome.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Chat auditing — AUD-P1-011
 * ------------------------------------------------------------------ */

describe('chat is inside the audit trail', () => {
  it('records who spoke and when, without copying the message body', async () => {
    const { dealId } = await liveDeal();
    const { postMessage } = await import('@/server/sandbox/service');
    await postMessage(alice, dealId, 'A private sentence that must not be duplicated.');

    const { rows } = await getPool().query(
      `SELECT actor_id, outcome, detail FROM sandbox.audit_event
        WHERE subject_id = $1 AND action = 'MESSAGE_POST'`,
      [dealId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe(alice.userId);
    expect(rows[0]!.outcome).toBe('OK');
    expect(rows[0]!.detail).toHaveProperty('messageId');
    expect(JSON.stringify(rows[0]!.detail)).not.toContain('private sentence');
  });
});

/* ------------------------------------------------------------------ *
 * Payment instructions require a locked-value fact
 * ------------------------------------------------------------------ */

describe('bank instructions follow the locked-value fact', () => {
  it('records a simulated lock at join, and never a custodial one', async () => {
    const { dealId } = await liveDeal();
    const { rows } = await getPool().query(
      `SELECT value_locked_at, value_lock_ref FROM sandbox.deal WHERE deal_id = $1`,
      [dealId],
    );
    expect(rows[0]!.value_locked_at).not.toBeNull();
    expect(String(rows[0]!.value_lock_ref)).toMatch(/^SBX-LOCK-/);
  });

  it('shows instructions to the paying seat once value is locked', async () => {
    const { dealId } = await liveDeal();
    const view = await getDeal(alice, dealId);
    expect(view.viewerRole).toBe('FIAT_SIDE');
    expect(view.valueLocked).toBe(true);
    expect(view.payTo).not.toBeNull();
  });

  it('never shows them to the receiving seat', async () => {
    const { dealId } = await liveDeal();
    const view = await getDeal(bob, dealId);
    expect(view.viewerRole).toBe('CRYPTO_SIDE');
    expect(view.payTo).toBeNull();
  });

  it('withholds them entirely when no lock fact exists', async () => {
    const { dealId } = await liveDeal();
    // Simulate a deal that reached the room without a value lock — which is
    // exactly what a production deployment would produce today.
    await getPool().query(
      `UPDATE sandbox.deal SET value_locked_at = NULL, value_lock_ref = NULL WHERE deal_id = $1`,
      [dealId],
    );
    const view = await getDeal(alice, dealId);
    expect(view.valueLocked).toBe(false);
    expect(view.payTo).toBeNull();
  });

  it('keeps them out of the public link preview entirely', async () => {
    const { publicId } = await liveDeal();
    const { getLinkPreview } = await import('@/server/sandbox/service');
    const anonymous = await getLinkPreview(publicId);
    expect(anonymous).not.toBeNull();
    expect(JSON.stringify(anonymous)).not.toMatch(/sandboxupi|ifsc|handle/i);
  });
});
