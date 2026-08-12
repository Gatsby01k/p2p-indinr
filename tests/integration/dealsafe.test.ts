/**
 * DealSafe behaviour — scenarios, chat, evidence, disputes and rulings.
 *
 * Against the real database, through the same service functions the UI
 * calls. The properties under test are the ones a person's money depends on:
 *
 *   · a protected payment carries no crypto leg, structurally;
 *   · a dispute PAUSES release and nothing but a ruling moves the deal;
 *   · an outsider gets nothing — not a message, not a file, not a byte;
 *   · an operator sees a blocked deal and never a settled private one.
 *
 * Requires the sandbox database:  npm run db:start
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { makeOperator, type OperatorFixture } from './support/operator';
import { getPool } from '@/server/db/pool';
import {
  SandboxFailure,
  attachEvidence,
  cancelDeal,
  confirmReceipt,
  createDealLink,
  getDeal,
  issueProtectedQuote,
  joinDealLink,
  postMessage,
  raiseDispute,
  readEvidence,
  signInSandbox,
  submitPaymentClaim,
  type SessionUser,
} from '@/server/sandbox/service';
import { deskQueue, operatorCase, ruleOnDispute } from '@/server/sandbox/ops';

let payer: SessionUser;
let payee: SessionUser;
let outsider: SessionUser;
let operator: OperatorFixture;

/** A principal with no roles — what an ordinary signed-in person carries. */
const bare = (u: SessionUser) => ({
  userId: u.userId,
  roles: [] as const,
  permissions: [] as const,
  mfaSatisfied: false,
  mfaEnrolled: false,
});

beforeAll(async () => {
  payer = await signInSandbox('ds-payer@sandbox.test');
  payee = await signInSandbox('ds-payee@sandbox.test');
  outsider = await signInSandbox('ds-outsider@sandbox.test');
  operator = await makeOperator('ops@sandbox.test');
});

const code = (c: string) => ({ code: c });

let utrSeq = 0;
function utr(): string {
  utrSeq += 1;
  const stamp = Date.now().toString(36).toUpperCase().slice(-7);
  return `DS${stamp}${String(utrSeq).padStart(3, '0')}`.slice(0, 12).padEnd(12, '0');
}

/**
 * A joined INR → INR deal. The creator asked to RECEIVE, so they hold
 * CRYPTO_SIDE (the seat that receives the rupees) and the joiner pays.
 */
async function protectedDeal(inrMinor = 2_500_000n): Promise<string> {
  const quote = await issueProtectedQuote(payee, inrMinor, {
    feeBearer: 'PAYER',
    title: 'Freelance design milestone',
  });
  const link = await createDealLink(payee, quote.quoteId, 'RECEIVE');
  const joined = await joinDealLink(payer, link.publicId);
  return joined.dealId;
}

describe('protected payments (INR → INR)', () => {
  it('carries no USDT leg at all', async () => {
    const dealId = await protectedDeal();
    const deal = await getDeal(payee, dealId);
    expect(deal.direction).toBe('INR_TO_INR');
    // Null, not zero: a null cannot be mistaken for an amount.
    expect(deal.usdtMinor).toBeNull();
  });

  it('is refused by the database if a USDT figure is forced onto it', async () => {
    const dealId = await protectedDeal();
    await expect(
      getPool().query(`UPDATE sandbox.deal SET usdt_minor = 1 WHERE deal_id = $1`, [dealId]),
    ).rejects.toMatchObject({ constraint: 'deal_usdt_scenario' });
  });

  it('freezes the fee at creation and seats the two sides correctly', async () => {
    const dealId = await protectedDeal(2_500_000n); // ₹25,000
    const asPayer = await getDeal(payer, dealId);
    const asPayee = await getDeal(payee, dealId);

    expect(asPayer.viewerRole).toBe('FIAT_SIDE');
    expect(asPayee.viewerRole).toBe('CRYPTO_SIDE');
    // 1.50% of ₹25,000 = ₹375.00
    expect(asPayer.protectionFeeMinor).toBe('37500');
    expect(asPayer.networkFeeMinor).toBe('0');
    expect(asPayer.feeBearer).toBe('PAYER');
    expect(asPayer.title).toBe('Freelance design milestone');
  });

  it('rejects an amount below the minimum before anything is created', async () => {
    await expect(issueProtectedQuote(payee, 500n)).rejects.toMatchObject(code('AMOUNT_TOO_SMALL'));
  });

  it('gives every deal a distinct human-readable code', async () => {
    const a = await getDeal(payee, await protectedDeal());
    const b = await getDeal(payee, await protectedDeal());
    expect(a.dealCode).toMatch(/^INR-[0-9A-HJ-NP-Z]{4}$/);
    expect(a.dealCode).not.toBe(b.dealCode);
  });
});

describe('the deal thread', () => {
  it('lets both participants write and read', async () => {
    const dealId = await protectedDeal();
    await postMessage(payer, dealId, 'Sending the transfer now.');
    await postMessage(payee, dealId, 'Thanks, watching for it.');

    const seen = await getDeal(payee, dealId);
    const chat = seen.messages.filter((m) => m.kind === 'CHAT');
    expect(chat).toHaveLength(2);
    expect(chat[0]!.body).toBe('Sending the transfer now.');
    // Authorship is resolved per viewer, so "you" is never the wrong person.
    expect(chat[0]!.authorIsViewer).toBe(false);
    expect(chat[1]!.authorIsViewer).toBe(true);
  });

  it('records system lines that no one can author', async () => {
    const dealId = await protectedDeal();
    const deal = await getDeal(payer, dealId);
    const system = deal.messages.filter((m) => m.kind === 'SYSTEM');
    expect(system.length).toBeGreaterThan(0);
    expect(system.every((m) => m.authorName === null)).toBe(true);

    // The database refuses a system line with an author, so a participant
    // cannot forge one by any route.
    await expect(
      getPool().query(
        `INSERT INTO sandbox.deal_message (deal_id, author_id, kind, body)
         VALUES ($1,$2,'SYSTEM','₹25,000 secured')`,
        [dealId, payer.userId],
      ),
    ).rejects.toMatchObject({ constraint: 'deal_message_author_rule' });
  });

  it('refuses an outsider', async () => {
    const dealId = await protectedDeal();
    await expect(postMessage(outsider, dealId, 'hello')).rejects.toMatchObject(
      code('NOT_A_PARTICIPANT'),
    );
  });

  it('refuses an empty message', async () => {
    const dealId = await protectedDeal();
    await expect(postMessage(payer, dealId, '   ')).rejects.toMatchObject(code('MESSAGE_EMPTY'));
  });

  it('closes the thread once the deal is finished', async () => {
    const dealId = await protectedDeal();
    await submitPaymentClaim(payer, dealId, utr());
    await confirmReceipt(payee, dealId);
    await expect(postMessage(payer, dealId, 'one more thing')).rejects.toMatchObject(
      code('DEAL_TERMINAL'),
    );
  });
});

describe('evidence', () => {
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
    'hex',
  );

  it('stores a file and hands it back only to a participant', async () => {
    const dealId = await protectedDeal();
    const after = await attachEvidence(payer, dealId, {
      name: 'receipt.png',
      type: 'image/png',
      bytes: png,
    });
    expect(after.evidence).toHaveLength(1);
    const id = after.evidence[0]!.evidenceId;
    expect(after.evidence[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);

    await expect(readEvidence(payer, id)).resolves.toMatchObject({ filename: 'receipt.png' });
    await expect(readEvidence(payee, id)).resolves.toMatchObject({ filename: 'receipt.png' });
    // Knowing the id grants nothing.
    await expect(readEvidence(outsider, id)).resolves.toBeNull();
  });

  it('refuses a type outside the closed catalogue', async () => {
    const dealId = await protectedDeal();
    await expect(
      attachEvidence(payer, dealId, {
        name: 'payload.svg',
        type: 'image/svg+xml',
        bytes: png,
      }),
    ).rejects.toMatchObject(code('EVIDENCE_TYPE_REJECTED'));
  });

  it('refuses a file over 5 MB', async () => {
    const dealId = await protectedDeal();
    await expect(
      attachEvidence(payer, dealId, {
        name: 'huge.pdf',
        type: 'application/pdf',
        bytes: Buffer.alloc(5 * 1024 * 1024 + 1),
      }),
    ).rejects.toMatchObject(code('EVIDENCE_TOO_LARGE'));
  });

  it('strips any path the browser sent with the filename', async () => {
    const dealId = await protectedDeal();
    const after = await attachEvidence(payer, dealId, {
      name: '../../etc/passwd.png',
      type: 'image/png',
      bytes: png,
    });
    expect(after.evidence[0]!.filename).toBe('passwd.png');
  });
});

describe('cancellation', () => {
  it('is allowed only before a payment is claimed', async () => {
    const dealId = await protectedDeal();
    const cancelled = await cancelDeal(payer, dealId);
    expect(cancelled.state).toBe('CANCELLED');
    expect(cancelled.permitted.canClaim).toBe(false);
  });

  it('is refused once a payment has been marked sent', async () => {
    const dealId = await protectedDeal();
    await submitPaymentClaim(payer, dealId, utr());
    // Cancelling here would strand a real transfer. The route is a dispute.
    await expect(cancelDeal(payee, dealId)).rejects.toMatchObject(code('ALREADY_CLAIMED'));
  });
});

describe('disputes pause release', () => {
  it('stops both confirmation and cancellation, and cannot be raised twice', async () => {
    const dealId = await protectedDeal();
    await submitPaymentClaim(payer, dealId, utr());

    const disputed = await raiseDispute(payer, dealId, 'PAYMENT_NOT_RECEIVED', 'Nothing arrived.');
    expect(disputed.state).toBe('DISPUTED');
    expect(disputed.dispute?.reason).toBe('PAYMENT_NOT_RECEIVED');
    expect(disputed.permitted.canConfirm).toBe(false);
    expect(disputed.permitted.canCancel).toBe(false);
    // The thread stays open — that is when it matters most.
    expect(disputed.permitted.canMessage).toBe(true);

    await expect(confirmReceipt(payee, dealId)).rejects.toMatchObject(code('DEAL_DISPUTED'));
    await expect(raiseDispute(payee, dealId, 'WRONG_AMOUNT')).rejects.toMatchObject(
      code('ALREADY_DISPUTED'),
    );
  });

  it('shows both sides the same case', async () => {
    const dealId = await protectedDeal();
    await raiseDispute(payer, dealId, 'NOT_AS_AGREED', 'The files were never delivered.');

    const asRaiser = await getDeal(payer, dealId);
    const asOther = await getDeal(payee, dealId);
    expect(asRaiser.dispute?.raisedByViewer).toBe(true);
    expect(asOther.dispute?.raisedByViewer).toBe(false);
    expect(asOther.dispute?.detail).toBe('The files were never delivered.');
  });

  it('refuses an outsider', async () => {
    const dealId = await protectedDeal();
    await expect(raiseDispute(outsider, dealId, 'OTHER')).rejects.toMatchObject(
      code('NOT_A_PARTICIPANT'),
    );
  });
});

describe('operator disclosure is tiered', () => {
  it('refuses the desk to a non-operator before any row is read', async () => {
    await expect(deskQueue(bare(payer))).rejects.toBeInstanceOf(SandboxFailure);
    await expect(operatorCase(bare(payer), 'whatever')).rejects.toBeInstanceOf(SandboxFailure);
  });

  it('never exposes an email, a UTR or a payment handle in the queue', async () => {
    const dealId = await protectedDeal();
    const reference = utr();
    await submitPaymentClaim(payer, dealId, reference);

    const text = JSON.stringify(await deskQueue(operator.principal));
    expect(text).not.toContain(reference);
    expect(text).not.toContain(payer.email);
    expect(text).not.toContain(payee.email);
    expect(text).not.toMatch(/sandboxupi|ifsc/i);
  });

  it('opens a blocked case, with the payment reference, and audits the opening', async () => {
    const dealId = await protectedDeal();
    const reference = utr();
    await submitPaymentClaim(payer, dealId, reference);

    const kase = await operatorCase(operator.principal, dealId);
    expect(kase.claim?.utr).toBe(reference);
    expect(kase.parties).toHaveLength(2);

    const { rows } = await getPool().query(
      `SELECT 1 FROM sandbox.audit_event
        WHERE subject_id = $1 AND action = 'OPERATOR_CASE_OPEN' AND actor_id = $2`,
      [dealId, operator.user.userId],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('refuses a settled private deal', async () => {
    const dealId = await protectedDeal();
    await submitPaymentClaim(payer, dealId, utr());
    await confirmReceipt(payee, dealId);
    // Completed is nobody's business but the two sides'.
    await expect(operatorCase(operator.principal, dealId)).rejects.toMatchObject(
      code('NOT_A_PARTICIPANT'),
    );
  });
});

describe('rulings are the only way out of a dispute', () => {
  it('requires a written reason', async () => {
    const dealId = await protectedDeal();
    await raiseDispute(payer, dealId, 'WRONG_AMOUNT');
    await expect(
      ruleOnDispute(operator.principal, dealId, 'RELEASED', 'nope'),
    ).rejects.toBeInstanceOf(SandboxFailure);
  });

  it('releases, records the reason for both sides, and closes the case', async () => {
    const dealId = await protectedDeal();
    await submitPaymentClaim(payer, dealId, utr());
    await raiseDispute(payee, dealId, 'PROOF_MISMATCH', 'Reference does not match.');

    await ruleOnDispute(
      operator.principal,
      dealId,
      'RELEASED',
      'Bank statement confirms the credit against the stated reference.',
    );

    const after = await getDeal(payer, dealId);
    expect(after.state).toBe('COMPLETED');
    expect(after.dispute?.state).toBe('RESOLVED');
    expect(after.dispute?.resolution).toBe('RELEASED');
    // The reason reaches both sides as a system line on the thread.
    expect(
      after.messages.some((m) => m.kind === 'SYSTEM' && m.body.includes('Bank statement')),
    ).toBe(true);
  });

  it('refunds without completing the deal', async () => {
    const dealId = await protectedDeal();
    await submitPaymentClaim(payer, dealId, utr());
    await raiseDispute(payer, dealId, 'PAYMENT_NOT_RECEIVED', 'Money left but never landed.');

    await ruleOnDispute(
      operator.principal,
      dealId,
      'REFUNDED',
      'No credit found on the receiving account.',
    );

    const after = await getDeal(payer, dealId);
    expect(after.state).toBe('REFUNDED');
    expect(after.completedAt).toBeNull();
  });

  it('is refused on a deal that is not under dispute', async () => {
    const dealId = await protectedDeal();
    await expect(
      ruleOnDispute(operator.principal, dealId, 'RELEASED', 'Nothing to rule on here at all.'),
    ).rejects.toMatchObject(code('DEAL_TERMINAL'));
  });

  it('is refused to a non-operator', async () => {
    const dealId = await protectedDeal();
    await raiseDispute(payer, dealId, 'OTHER', 'Something is wrong.');
    await expect(
      ruleOnDispute(bare(payee), dealId, 'RELEASED', 'I would like my money please.'),
    ).rejects.toMatchObject(code('PERMISSION_DENIED'));
  });
});
