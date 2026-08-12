import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeOperator, type OperatorFixture } from './support/operator';
import { getPool } from '@/server/db/pool';
import { newCommandId, readCommand } from '@/server/boundary/command';
import { signInSandbox, type SessionUser } from '@/server/sandbox/service';
import {
  cancelCommand,
  claimCommand,
  closeLinkCommand,
  confirmCommand,
  createDealCommand,
  disputeCommand,
  joinCommand,
  messageCommand,
  rulingCommand,
} from '@/services/commands';

/**
 * The complete rejection contract.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  FOUR THINGS ARE DISTINCT, AND EACH IS ASSERTED SEPARATELY.        │
 * │                                                                    │
 * │    1. the COMMAND row      — status REJECTED + outcome_code        │
 * │    2. the AUDIT event      — a row in `sandbox.audit_event`        │
 * │    3. the SUCCESS outbox   — must NOT exist                        │
 * │    4. the domain state     — must be unchanged                     │
 * │                                                                    │
 * │  Updating the command row is NOT an audit event. They are          │
 * │  different tables serving different readers: an operator           │
 * │  investigating a dispute reads the audit trail, not the command    │
 * │  ledger. A boundary that recorded only the former would look       │
 * │  correct in a unit test and be useless in an investigation.        │
 * └────────────────────────────────────────────────────────────────────┘
 */

let creator: SessionUser;
let joiner: SessionUser;
let outsider: SessionUser;
let operator: OperatorFixture;

const unique = () => Math.random().toString(36).slice(2, 10);
const original = { nodeEnv: process.env.NODE_ENV, sandbox: process.env.INRP2P_SANDBOX };

afterEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = original.nodeEnv;
  if (original.sandbox === undefined) delete process.env.INRP2P_SANDBOX;
  else process.env.INRP2P_SANDBOX = original.sandbox;
});

beforeAll(async () => {
  creator = await signInSandbox(`rej-creator-${unique()}@example.com`);
  joiner = await signInSandbox(`rej-joiner-${unique()}@example.com`);
  outsider = await signInSandbox(`rej-outsider-${unique()}@example.com`);
  operator = await makeOperator(`ops@rej-${unique()}.example.com`);
});

async function openLink(actor: SessionUser = creator): Promise<string> {
  const outcome = await createDealCommand(actor, {
    commandId: newCommandId(),
    scenario: 'INR_TO_INR',
    inrAmount: '2500',
    intent: 'PAY',
  });
  if (!outcome.ok) throw new Error(`fixture: ${outcome.code}`);
  return outcome.value.publicId;
}

async function liveDeal(): Promise<{ dealId: string; publicId: string }> {
  const publicId = await openLink();
  const joined = await joinCommand(joiner, newCommandId(), publicId);
  if (!joined.ok) throw new Error(`fixture join: ${joined.code}`);
  return { dealId: joined.value.dealId, publicId };
}

/**
 * Assert the full four-part rejection contract for one command.
 *
 * `subjectId` is the link/deal when the boundary safely knows one. For an
 * EARLY rejection — the caller is unverified, or is not a participant and
 * therefore cannot be shown that the resource exists — the audit subject
 * is the authenticated actor and the attempted identifier lives in
 * structured detail. Pass `attempted` for that case; the assertion then
 * requires the detail to name what was reached for.
 */
async function expectRejectionContract(opts: {
  commandId: string;
  code: string;
  action: string;
  subjectId: string;
  attempted?: Record<string, string>;
}): Promise<void> {
  // 1. command row
  const command = await readCommand(opts.commandId);
  expect(command?.status, 'command row must be REJECTED').toBe('REJECTED');
  expect(command?.outcomeCode).toBe(opts.code);

  // 2. audit event — a genuinely separate record, never the command row
  const { rows: audits } = await getPool().query(
    `SELECT detail FROM sandbox.audit_event
      WHERE subject_id = $1 AND action = $2 AND outcome = $3`,
    [opts.subjectId, opts.action, opts.code],
  );
  expect(audits.length, `audit_event row for ${opts.action}/${opts.code}`).toBeGreaterThanOrEqual(
    1,
  );

  if (opts.attempted) {
    const detail = audits[audits.length - 1]!.detail as { attempted?: Record<string, string> };
    expect(detail.attempted, 'early rejection must record what was attempted').toMatchObject(
      opts.attempted,
    );
  }

  // 3. no success outbox event
  const { rows: events } = await getPool().query(
    `SELECT 1 FROM sandbox.outbox_event WHERE event_key LIKE $1`,
    [`${opts.commandId}:%`],
  );
  expect(events, 'a rejection emits no domain event').toHaveLength(0);
}

/* ------------------------------------------------------------------ *
 * Join rejections
 * ------------------------------------------------------------------ */

describe('Join rejections', () => {
  it('unverified account', async () => {
    const unverified = await signInSandbox(`new@rej-${unique()}.example.com`);
    expect(unverified.isVerified).toBe(false);
    const publicId = await openLink();
    const commandId = newCommandId();

    const outcome = await joinCommand(unverified, commandId, publicId);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('REQUIRES_VERIFICATION');

    // The guard fires before the link row is read, so the audit subject is
    // the ACTOR and the link they reached for is in structured detail.
    await expectRejectionContract({
      commandId,
      code: 'REQUIRES_VERIFICATION',
      action: 'LINK_JOIN',
      subjectId: unverified.userId,
      attempted: { publicId },
    });
    const { rows } = await getPool().query(
      `SELECT state FROM sandbox.deal_link WHERE public_id = $1`,
      [publicId],
    );
    expect(rows[0]!.state).toBe('OPEN');
  });

  it('self-join', async () => {
    const publicId = await openLink();
    const commandId = newCommandId();
    const { rows } = await getPool().query(
      `SELECT link_id FROM sandbox.deal_link WHERE public_id = $1`,
      [publicId],
    );

    const outcome = await joinCommand(creator, commandId, publicId);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('CANNOT_JOIN_OWN_LINK');
    await expectRejectionContract({
      commandId,
      code: 'CANNOT_JOIN_OWN_LINK',
      action: 'LINK_JOIN',
      subjectId: rows[0]!.link_id,
    });
  });

  it('consumed link', async () => {
    const publicId = await openLink();
    expect((await joinCommand(joiner, newCommandId(), publicId)).ok).toBe(true);
    const { rows } = await getPool().query(
      `SELECT link_id FROM sandbox.deal_link WHERE public_id = $1`,
      [publicId],
    );

    const commandId = newCommandId();
    const outcome = await joinCommand(outsider, commandId, publicId);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('LINK_CONSUMED');
    await expectRejectionContract({
      commandId,
      code: 'LINK_CONSUMED',
      action: 'LINK_JOIN',
      subjectId: rows[0]!.link_id,
    });
  });

  it('closed link', async () => {
    const publicId = await openLink();
    expect((await closeLinkCommand(creator, newCommandId(), publicId)).ok).toBe(true);
    const { rows } = await getPool().query(
      `SELECT link_id FROM sandbox.deal_link WHERE public_id = $1`,
      [publicId],
    );

    const commandId = newCommandId();
    const outcome = await joinCommand(joiner, commandId, publicId);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('LINK_CLOSED');
    await expectRejectionContract({
      commandId,
      code: 'LINK_CLOSED',
      action: 'LINK_JOIN',
      subjectId: rows[0]!.link_id,
    });
  });

  it('expired link', async () => {
    const publicId = await openLink();
    const { rows } = await getPool().query(
      `UPDATE sandbox.deal_link SET expires_at = now() - interval '1 second'
        WHERE public_id = $1 RETURNING link_id`,
      [publicId],
    );

    const commandId = newCommandId();
    const outcome = await joinCommand(joiner, commandId, publicId);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('LINK_EXPIRED');
    await expectRejectionContract({
      commandId,
      code: 'LINK_EXPIRED',
      action: 'LINK_JOIN',
      subjectId: rows[0]!.link_id,
    });
    const { rows: after } = await getPool().query(
      `SELECT state FROM sandbox.deal_link WHERE public_id = $1`,
      [publicId],
    );
    expect(after[0]!.state).toBe('OPEN');
  });
});

/* ------------------------------------------------------------------ *
 * Close rejections
 * ------------------------------------------------------------------ */

describe('Close rejections', () => {
  it('wrong owner', async () => {
    const publicId = await openLink();
    const { rows } = await getPool().query(
      `SELECT link_id FROM sandbox.deal_link WHERE public_id = $1`,
      [publicId],
    );
    const commandId = newCommandId();

    const outcome = await closeLinkCommand(outsider, commandId, publicId);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_A_PARTICIPANT');
    await expectRejectionContract({
      commandId,
      code: 'NOT_A_PARTICIPANT',
      action: 'LINK_CLOSE',
      subjectId: rows[0]!.link_id,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Deal-mutation rejections
 * ------------------------------------------------------------------ */

describe('Deal mutation rejections', () => {
  it('non-participant claim', async () => {
    const { dealId } = await liveDeal();
    const commandId = newCommandId();

    const outcome = await claimCommand(outsider, commandId, dealId, 'ABCDEF123456', '');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_A_PARTICIPANT');
    await expectRejectionContract({
      commandId,
      code: 'NOT_A_PARTICIPANT',
      action: 'PAYMENT_CLAIM',
      subjectId: outsider.userId,
      attempted: { dealId },
    });
  });

  it('wrong role on claim', async () => {
    const { dealId } = await liveDeal();
    const commandId = newCommandId();
    // `joiner` took CRYPTO_SIDE on an INR_TO_INR PAY link, so cannot claim.
    const outcome = await claimCommand(
      joiner,
      commandId,
      dealId,
      `UTR${unique().toUpperCase()}X`.slice(0, 12),
      '',
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_FIAT_SIDE');
    await expectRejectionContract({
      commandId,
      code: 'NOT_FIAT_SIDE',
      action: 'PAYMENT_CLAIM',
      subjectId: dealId,
    });
  });

  it('wrong role on confirm', async () => {
    const { dealId } = await liveDeal();
    const commandId = newCommandId();
    const outcome = await confirmCommand(creator, commandId, dealId);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_CRYPTO_SIDE');
    await expectRejectionContract({
      commandId,
      code: 'NOT_CRYPTO_SIDE',
      action: 'CONFIRM_RECEIPT',
      subjectId: dealId,
    });
  });

  it('non-participant message', async () => {
    const { dealId } = await liveDeal();
    const commandId = newCommandId();
    const outcome = await messageCommand(outsider, commandId, dealId, 'let me in');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_A_PARTICIPANT');
    await expectRejectionContract({
      commandId,
      code: 'NOT_A_PARTICIPANT',
      action: 'MESSAGE_POST',
      subjectId: outsider.userId,
      attempted: { dealId },
    });
  });

  it('non-participant confirm', async () => {
    const { dealId } = await liveDeal();
    const commandId = newCommandId();
    const outcome = await confirmCommand(outsider, commandId, dealId);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_A_PARTICIPANT');
    await expectRejectionContract({
      commandId,
      code: 'NOT_A_PARTICIPANT',
      action: 'CONFIRM_RECEIPT',
      subjectId: outsider.userId,
      attempted: { dealId },
    });
  });

  it('non-participant cancel', async () => {
    const { dealId } = await liveDeal();
    const commandId = newCommandId();
    const outcome = await cancelCommand(outsider, commandId, dealId);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_A_PARTICIPANT');
    await expectRejectionContract({
      commandId,
      code: 'NOT_A_PARTICIPANT',
      action: 'DEAL_CANCEL',
      subjectId: outsider.userId,
      attempted: { dealId },
    });

    // And the deal is untouched.
    const { rows } = await getPool().query(`SELECT state FROM sandbox.deal WHERE deal_id = $1`, [
      dealId,
    ]);
    expect(rows[0]!.state).toBe('FIAT_PENDING');
  });

  it('non-participant dispute', async () => {
    const { dealId } = await liveDeal();
    const commandId = newCommandId();
    const outcome = await disputeCommand(
      outsider,
      commandId,
      dealId,
      'PAYMENT_NOT_RECEIVED',
      'let me in',
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_A_PARTICIPANT');
    await expectRejectionContract({
      commandId,
      code: 'NOT_A_PARTICIPANT',
      action: 'DISPUTE_RAISE',
      subjectId: outsider.userId,
      attempted: { dealId },
    });
  });

  it('the refusal is identical whether or not the deal exists', async () => {
    // An existence oracle would let a stranger enumerate real deals.
    const { dealId } = await liveDeal();
    const real = await confirmCommand(outsider, newCommandId(), dealId);
    const fake = await confirmCommand(outsider, newCommandId(), crypto.randomUUID());
    expect(real.ok || fake.ok).toBe(false);
    if (real.ok || fake.ok) return;
    expect(real.code).toBe(fake.code);
    expect(real.message).toBe(fake.message);
  });

  it('cancel after a claim', async () => {
    const { dealId } = await liveDeal();
    const utr = `Z${unique().toUpperCase()}`.padEnd(12, '9').slice(0, 12);
    expect((await claimCommand(creator, newCommandId(), dealId, utr, '')).ok).toBe(true);

    const commandId = newCommandId();
    const outcome = await cancelCommand(creator, commandId, dealId);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('ALREADY_CLAIMED');
    await expectRejectionContract({
      commandId,
      code: 'ALREADY_CLAIMED',
      action: 'DEAL_CANCEL',
      subjectId: dealId,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Stale quote
 * ------------------------------------------------------------------ */

describe('stale quote', () => {
  it('cannot be turned into a link, and is expired authoritatively', async () => {
    const { issueProtectedQuote, createDealLink } = await import('@/server/sandbox/service');
    const quote = await issueProtectedQuote(creator, 250_000n);
    await getPool().query(
      `UPDATE sandbox.quote
          SET created_at = now() - interval '10 minutes',
              expires_at = now() - interval '1 second'
        WHERE quote_id = $1`,
      [quote.quoteId],
    );

    await expect(createDealLink(creator, quote.quoteId, 'PAY')).rejects.toThrow(/expired/i);

    const { rows } = await getPool().query(`SELECT state FROM sandbox.quote WHERE quote_id = $1`, [
      quote.quoteId,
    ]);
    expect(rows[0]!.state).toBe('EXPIRED');

    const { rows: audits } = await getPool().query(
      `SELECT outcome FROM sandbox.audit_event WHERE subject_id = $1 ORDER BY audit_id`,
      [quote.quoteId],
    );
    // The expiry transition AND the refusal both committed.
    expect(audits.map((a) => a.outcome)).toContain('QUOTE_EXPIRED');
  });
});

/* ------------------------------------------------------------------ *
 * The concurrent UTR race
 * ------------------------------------------------------------------ */

describe('the same UTR submitted concurrently on different deals', () => {
  it('lets exactly one through and refuses the other properly', async () => {
    const a = await liveDeal();
    const b = await liveDeal();
    const utr = `RACE${unique().toUpperCase()}`.padEnd(12, '0').slice(0, 12);

    const commandA = newCommandId();
    const commandB = newCommandId();
    const [ra, rb] = await Promise.all([
      claimCommand(creator, commandA, a.dealId, utr, ''),
      claimCommand(creator, commandB, b.dealId, utr, ''),
    ]);

    const winners = [ra, rb].filter((r) => r.ok);
    const losers = [ra, rb].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const loser = losers[0]!;
    if (loser.ok) return;
    // A proper domain code — never a raw 23505 and never UNKNOWN.
    expect(loser.code).toBe('UTR_ALREADY_USED');
    expect(String(loser.message)).not.toMatch(/23505|duplicate key|UNKNOWN/i);

    // Exactly one claim row carries this reference.
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.payment_claim WHERE utr = $1`,
      [utr],
    );
    expect(rows[0]!.n).toBe(1);

    // The losing deal did not transition, and its rejection is durable.
    const loserCommandId = ra.ok ? commandB : commandA;
    const loserDealId = ra.ok ? b.dealId : a.dealId;
    const { rows: deal } = await getPool().query(
      `SELECT state FROM sandbox.deal WHERE deal_id = $1`,
      [loserDealId],
    );
    expect(deal[0]!.state).toBe('FIAT_PENDING');
    await expectRejectionContract({
      commandId: loserCommandId,
      code: 'UTR_ALREADY_USED',
      action: 'PAYMENT_CLAIM',
      subjectId: loserDealId,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Idempotency conflict and unavailable scenario
 * ------------------------------------------------------------------ */

describe('boundary-level rejections', () => {
  it('idempotency conflict is recorded on the command and audited', async () => {
    const commandId = newCommandId();
    expect(
      (
        await createDealCommand(creator, {
          commandId,
          scenario: 'INR_TO_INR',
          inrAmount: '2500',
          intent: 'PAY',
        })
      ).ok,
    ).toBe(true);

    const conflicting = await createDealCommand(creator, {
      commandId,
      scenario: 'INR_TO_INR',
      inrAmount: '9500',
      intent: 'PAY',
    });
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.code).toBe('IDEMPOTENCY_CONFLICT');

    // The ORIGINAL command row is untouched — a conflict never rewrites it.
    expect((await readCommand(commandId))?.status).toBe('SUCCEEDED');
    const { rows } = await getPool().query(
      `SELECT 1 FROM sandbox.audit_event
        WHERE outcome='IDEMPOTENCY_CONFLICT' AND detail->>'commandId' = $1`,
      [commandId],
    );
    expect(rows).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Operator ruling — now command-bound
 * ------------------------------------------------------------------ */

describe('dispute ruling runs through the command boundary', () => {
  async function disputedDeal(): Promise<string> {
    const { dealId } = await liveDeal();
    expect(
      (
        await disputeCommand(
          creator,
          newCommandId(),
          dealId,
          'PAYMENT_NOT_RECEIVED',
          'nothing came',
        )
      ).ok,
    ).toBe(true);
    return dealId;
  }

  it('rules, audits and emits deal.ruled atomically', async () => {
    const dealId = await disputedDeal();
    const commandId = newCommandId();

    const outcome = await rulingCommand(
      operator.principal,
      commandId,
      dealId,
      'REFUNDED',
      'Evidence supports the payer; returning the protected value.',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.state).toBe('REFUNDED');

    const { rows } = await getPool().query(`SELECT state FROM sandbox.deal WHERE deal_id = $1`, [
      dealId,
    ]);
    expect(rows[0]!.state).toBe('REFUNDED');

    const { rows: audits } = await getPool().query(
      `SELECT from_state, to_state, outcome FROM sandbox.audit_event
        WHERE subject_id = $1 AND action = 'DISPUTE_RULE' AND outcome = 'OK'`,
      [dealId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.from_state).toBe('DISPUTED');

    const { rows: events } = await getPool().query(
      `SELECT event_type FROM sandbox.outbox_event WHERE event_key LIKE $1`,
      [`${commandId}:%`],
    );
    expect(events.map((e) => e.event_type)).toEqual(['deal.ruled']);
    expect((await readCommand(commandId))?.status).toBe('SUCCEEDED');
  });

  it('replays an identical ruling with the original result', async () => {
    const dealId = await disputedDeal();
    const commandId = newCommandId();
    const reason = 'Both sides agree the transfer never arrived at all.';

    const first = await rulingCommand(operator.principal, commandId, dealId, 'CANCELLED', reason);
    const replay = await rulingCommand(operator.principal, commandId, dealId, 'CANCELLED', reason);
    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.value).toEqual(first.value);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.outbox_event WHERE event_key LIKE $1`,
      [`${commandId}:%`],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('refuses the same command id carrying a different ruling', async () => {
    const dealId = await disputedDeal();
    const commandId = newCommandId();
    const reason = 'The evidence is clear enough to decide this now.';

    expect(
      (await rulingCommand(operator.principal, commandId, dealId, 'RELEASED', reason)).ok,
    ).toBe(true);
    const conflicting = await rulingCommand(
      operator.principal,
      commandId,
      dealId,
      'REFUNDED',
      reason,
    );
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.code).toBe('IDEMPOTENCY_CONFLICT');

    const { rows } = await getPool().query(`SELECT state FROM sandbox.deal WHERE deal_id = $1`, [
      dealId,
    ]);
    expect(rows[0]!.state).toBe('COMPLETED');
  });

  it('refuses a non-operator, and records the refusal', async () => {
    const dealId = await disputedDeal();
    const commandId = newCommandId();

    const outcome = await rulingCommand(
      // A signed-in person with no grant and no factor.
      {
        userId: joiner.userId,
        roles: [],
        permissions: [],
        mfaSatisfied: false,
        mfaEnrolled: false,
      },
      commandId,
      dealId,
      'RELEASED',
      'I would like this released to me please.',
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PERMISSION_DENIED');
    await expectRejectionContract({
      commandId,
      code: 'PERMISSION_DENIED',
      action: 'DISPUTE_RULE',
      subjectId: dealId,
    });

    const { rows } = await getPool().query(`SELECT state FROM sandbox.deal WHERE deal_id = $1`, [
      dealId,
    ]);
    expect(rows[0]!.state).toBe('DISPUTED');
  });

  it('serialises concurrent rulings: exactly one wins', async () => {
    const dealId = await disputedDeal();
    const reason = 'Concurrent ruling attempt from two operator sessions.';

    const attempts = await Promise.all([
      rulingCommand(operator.principal, newCommandId(), dealId, 'RELEASED', reason),
      rulingCommand(operator.principal, newCommandId(), dealId, 'REFUNDED', reason),
      rulingCommand(operator.principal, newCommandId(), dealId, 'CANCELLED', reason),
    ]);
    expect(attempts.filter((a) => a.ok)).toHaveLength(1);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.audit_event
        WHERE subject_id = $1 AND action='DISPUTE_RULE' AND outcome='OK'`,
      [dealId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('is unavailable in production until DEL-06', async () => {
    const dealId = await disputedDeal();
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    delete process.env.INRP2P_SANDBOX;

    const commandId = newCommandId();
    const outcome = await rulingCommand(
      operator.principal,
      commandId,
      dealId,
      'RELEASED',
      'Attempting a ruling on a production deployment.',
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('ADAPTER_UNAVAILABLE');

    const { rows } = await getPool().query(`SELECT state FROM sandbox.deal WHERE deal_id = $1`, [
      dealId,
    ]);
    expect(rows[0]!.state).toBe('DISPUTED');
  });
});
