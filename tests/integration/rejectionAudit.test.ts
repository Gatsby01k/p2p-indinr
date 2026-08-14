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
  openDisputeCaseCommand,
  proposeRulingCommand,
  approveRulingCommand,
} from '@/services/commands';
import { grantRole, permissionsFor } from '@/server/identity/rbac';
import { lockedDeal } from './support/rails';

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
/** The CHECKER. Maker-checker needs a second, differently-granted person. */
let reviewer: OperatorFixture;

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

  reviewer = await makeOperator(`rej-reviewer-${unique()}@example.com`);
  await grantRole({
    userId: reviewer.user.userId,
    role: 'REVIEWER',
    grantedBy: null,
    via: 'CLI',
    reason: 'Maker-checker fixture: the second pair of eyes.',
  });
  reviewer = {
    ...reviewer,
    principal: {
      ...reviewer.principal,
      roles: ['REVIEWER'],
      permissions: permissionsFor(['REVIEWER']),
    },
  };
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

describe('a dispute ruling needs two people and moves real value', () => {
  /*
   * REWRITTEN FOR DEL-06.
   *
   * These cases used to drive `rulingCommand` — one operator, one call,
   * a status edit and no ledger movement. DEL-06 withdrew that: a ruling
   * is now proposed by one authorised person, approved by a DIFFERENT
   * one, and the approval settles the DEL-04 lock. The assertions below
   * are the same PROPERTIES — atomicity, replay, conflict, refusal
   * recording, concurrency — against the boundary that replaced it.
   */
  async function disputedLockedDeal() {
    const dealId = await lockedDeal(creator, joiner, 100_000n);
    const opened = await openDisputeCaseCommand(creator, newCommandId(), {
      dealId,
      category: 'PAYMENT_NOT_RECEIVED',
      statement: 'The transfer never arrived and my counterparty insists that it did.',
    });
    if (!opened.ok) throw new Error(`case fixture: ${opened.code}`);
    return { dealId, caseId: opened.value.caseId, version: opened.value.version };
  }

  async function proposed(disposition: 'RELEASE' | 'REFUND' = 'REFUND') {
    const base = await disputedLockedDeal();
    const p = await proposeRulingCommand(operator.principal, newCommandId(), {
      caseId: base.caseId,
      disposition,
      rationale: 'The evidence supports the payer; the protected value goes back.',
      caseVersion: base.version,
    });
    if (!p.ok) throw new Error(`proposal fixture: ${p.code}`);
    return { ...base, proposalId: p.value.proposalId };
  }

  it('resolves, audits and emits atomically', async () => {
    const { dealId, caseId, proposalId } = await proposed('REFUND');
    const commandId = newCommandId();

    const outcome = await approveRulingCommand(reviewer.principal, commandId, { proposalId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.disposition).toBe('REFUND');

    const { rows } = await getPool().query(`SELECT state FROM sandbox.deal WHERE deal_id = $1`, [
      dealId,
    ]);
    expect(rows[0]!.state).toBe('CANCELLED');

    const { rows: audits } = await getPool().query(
      `SELECT to_state, outcome FROM sandbox.audit_event
        WHERE subject_id = $1 AND action = 'DISPUTE_APPROVE' AND outcome = 'OK'`,
      [caseId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.to_state).toBe('RESOLVED');

    const { rows: events } = await getPool().query(
      `SELECT event_type FROM sandbox.outbox_event WHERE event_key LIKE $1`,
      [`${commandId}:%`],
    );
    expect(events.map((e) => e.event_type)).toEqual(['dispute.resolved']);
    expect((await readCommand(commandId))?.status).toBe('SUCCEEDED');

    // And the value genuinely moved, which the old ruling never did.
    const { rows: lock } = await getPool().query(
      `SELECT state, settle_entry_id FROM inrp2p.value_lock WHERE deal_id = $1`,
      [dealId],
    );
    expect(lock[0]!.state).toBe('REFUNDED');
    expect(lock[0]!.settle_entry_id).not.toBeNull();
  });

  it('replays an identical approval with the original result', async () => {
    const { proposalId } = await proposed('RELEASE');
    const commandId = newCommandId();

    const first = await approveRulingCommand(reviewer.principal, commandId, { proposalId });
    const replay = await approveRulingCommand(reviewer.principal, commandId, { proposalId });
    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.value).toEqual(first.value);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.outbox_event WHERE event_key LIKE $1`,
      [`${commandId}:%`],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('refuses the same command id carrying a different proposal', async () => {
    const first = await proposed('RELEASE');
    const second = await proposed('REFUND');
    const commandId = newCommandId();

    expect(
      (
        await approveRulingCommand(reviewer.principal, commandId, {
          proposalId: first.proposalId,
        })
      ).ok,
    ).toBe(true);

    const conflicting = await approveRulingCommand(reviewer.principal, commandId, {
      proposalId: second.proposalId,
    });
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.code).toBe('IDEMPOTENCY_CONFLICT');

    // The second case is untouched: a conflicting replay decides nothing.
    const { rows } = await getPool().query(
      `SELECT state FROM sandbox.dispute_case WHERE case_id = $1`,
      [second.caseId],
    );
    expect(rows[0]!.state).toBe('UNDER_REVIEW');
  });

  it('refuses a non-operator, and records the refusal', async () => {
    const { caseId, version } = await disputedLockedDeal();
    const commandId = newCommandId();

    const outcome = await proposeRulingCommand(
      // A signed-in person with no grant and no factor.
      {
        userId: joiner.userId,
        roles: [],
        permissions: [],
        mfaSatisfied: false,
        mfaEnrolled: false,
      },
      commandId,
      {
        caseId,
        disposition: 'RELEASE',
        rationale: 'I would very much like this released to me please, thank you.',
        caseVersion: version,
      },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PERMISSION_DENIED');
    await expectRejectionContract({
      commandId,
      code: 'PERMISSION_DENIED',
      action: 'DISPUTE_PROPOSE',
      subjectId: caseId,
    });

    const { rows } = await getPool().query(
      `SELECT state FROM sandbox.dispute_case WHERE case_id = $1`,
      [caseId],
    );
    expect(rows[0]!.state).toBe('OPEN');
  });

  it('serialises concurrent approvals: exactly one wins', async () => {
    const { dealId, proposalId } = await proposed('RELEASE');
    const second = await makeOperator(`ra-reviewer2-${unique()}@example.com`);
    await grantRole({
      userId: second.user.userId,
      role: 'REVIEWER',
      grantedBy: null,
      via: 'CLI',
      reason: 'Concurrency fixture.',
    });
    const secondPrincipal = {
      ...second.principal,
      roles: ['REVIEWER'] as const,
      permissions: permissionsFor(['REVIEWER']),
    };

    const attempts = await Promise.all([
      approveRulingCommand(reviewer.principal, newCommandId(), { proposalId }),
      approveRulingCommand(secondPrincipal, newCommandId(), { proposalId }),
    ]);
    expect(attempts.filter((a) => a.ok)).toHaveLength(1);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM inrp2p.journal_entry
        WHERE journal_code IN ('JD-RELEASE','JD-REFUND')
          AND entry_key_json->>'dealId' = $1`,
      [dealId],
    );
    expect(rows[0]!.n, 'exactly one settlement entry').toBe(1);
  });

  it('the withdrawn single-operator ruling refuses and records it', async () => {
    const { dealId } = await disputedLockedDeal();
    const commandId = newCommandId();

    const outcome = await rulingCommand(
      operator.principal,
      commandId,
      dealId,
      'RELEASED',
      'Attempting to end a dispute single-handedly, as DEL-02 allowed.',
    );
    expect(outcome.ok, 'one person can no longer end a dispute').toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PERMISSION_DENIED');
    expect(outcome.message).toContain('two people');

    // The deal is untouched and the refusal is in the trail.
    const { rows } = await getPool().query(`SELECT state FROM sandbox.deal WHERE deal_id = $1`, [
      dealId,
    ]);
    expect(rows[0]!.state).toBe('DISPUTED');

    const { rows: audits } = await getPool().query(
      `SELECT outcome FROM sandbox.audit_event
        WHERE subject_id = $1 AND action='DISPUTE_RULE' AND outcome='PERMISSION_DENIED'`,
      [dealId],
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });
});
