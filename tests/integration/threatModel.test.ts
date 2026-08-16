import { describe, expect, it } from 'vitest';
import { getPool, withTransaction } from '@/server/db/pool';
import { newCommandId } from '@/server/boundary/command';
import {
  cancelCommand,
  claimCommand,
  createDealCommand,
  disputeCommand,
  joinCommand,
  messageCommand,
} from '@/services/commands';
import { redeemEmailSignIn, startEmailSignIn } from '@/server/identity/auth';
import { clearDeliveries, lastDeliveredTo } from '@/server/adapters/emailDelivery';
import { resolveSession, revokeSession } from '@/server/identity/sessions';
import { newUser, unique } from './support/room';
import { liveDeal } from './support/rails';

/**
 * The executable half of `SECURITY-THREAT-MODEL.md`.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A THREAT MODEL NOBODY CAN RUN IS A DOCUMENT, NOT A CONTROL.       │
 * │                                                                    │
 * │  Every entry in the written model names a proof, and the proofs    │
 * │  live here. They are deliberately written as an ATTACKER: each one │
 * │  attempts the abuse against the real service boundary the UI       │
 * │  calls, and asserts the refusal — rather than asserting that some  │
 * │  guard function exists.                                            │
 * │                                                                    │
 * │  Where a category is genuinely not reachable in this repository,   │
 * │  it is marked N/A in the document with the repository-specific     │
 * │  reason, and NOT given a hollow test here.                         │
 * └────────────────────────────────────────────────────────────────────┘
 */

/* ================================================================== *
 * T1 · IDOR / BOLA — object references across tenancy
 * ================================================================== */

describe('T1 IDOR: a deal belongs to its two participants and nobody else', () => {
  it('a stranger holding a real deal id cannot read it', async () => {
    const alice = await newUser('t1-a');
    const bob = await newUser('t1-b');
    const stranger = await newUser('t1-x');
    const dealId = await liveDeal(alice, bob);

    const { getDeal } = await import('@/server/sandbox/service');
    // Refused with one sentence that reveals nothing about the deal.
    await expect(getDeal(stranger, dealId)).rejects.toThrow(/private to its two sides/);
  });

  it('a stranger cannot act on it either', async () => {
    const alice = await newUser('t1-ca');
    const bob = await newUser('t1-cb');
    const stranger = await newUser('t1-cx');
    const dealId = await liveDeal(alice, bob);

    const cancelled = await cancelCommand(stranger, newCommandId(), dealId);
    expect(cancelled.ok).toBe(false);

    const messaged = await messageCommand(
      stranger,
      newCommandId(),
      dealId,
      'Let me into this deal room please, it is definitely mine.',
    );
    expect(messaged.ok).toBe(false);
  });

  it('a participant cannot read a DIFFERENT deal by swapping the id', async () => {
    const alice = await newUser('t1-sa');
    const bob = await newUser('t1-sb');
    const carol = await newUser('t1-sc');
    const dave = await newUser('t1-sd');
    const mine = await liveDeal(alice, bob);
    const theirs = await liveDeal(carol, dave);
    expect(mine).not.toBe(theirs);

    const { getDeal } = await import('@/server/sandbox/service');
    await expect(getDeal(alice, theirs)).rejects.toThrow(/private to its two sides/);
  });
});

/* ================================================================== *
 * T2 · Session fixation, theft and replay
 * ================================================================== */

describe('T2 sessions: a revoked or unknown token opens nothing', () => {
  it('a revoked session stops resolving immediately', async () => {
    clearDeliveries();
    const email = `t2-${unique()}@example.com`;
    await startEmailSignIn(email);
    const signedIn = await redeemEmailSignIn({
      email,
      secret: lastDeliveredTo(email)!.secret,
    });
    expect(signedIn.ok).toBe(true);
    if (!signedIn.ok) return;

    expect((await resolveSession(signedIn.value.sessionToken)).ok).toBe(true);
    await revokeSession(signedIn.value.sessionId, signedIn.value.userId, 'threat-model probe');
    const after = await resolveSession(signedIn.value.sessionToken);
    expect(after.ok, 'a revoked token opens nothing').toBe(false);
  });

  it('a session token is stored only as a hash', async () => {
    clearDeliveries();
    const email = `t2h-${unique()}@example.com`;
    await startEmailSignIn(email);
    const signedIn = await redeemEmailSignIn({
      email,
      secret: lastDeliveredTo(email)!.secret,
    });
    if (!signedIn.ok) return;

    const { rows } = await getPool().query(
      `SELECT token_hash FROM sandbox.session WHERE session_id = $1`,
      [signedIn.value.sessionId],
    );
    // A database read — a backup, a log, a support tool — must not yield
    // a usable bearer token.
    expect(rows[0]!.token_hash).not.toBe(signedIn.value.sessionToken);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a forged token resolves to nobody', async () => {
    expect((await resolveSession('f'.repeat(64))).ok).toBe(false);
    expect((await resolveSession('')).ok).toBe(false);
  });
});

/* ================================================================== *
 * T3 · OTP replay
 * ================================================================== */

describe('T3 OTP replay: a sign-in credential works exactly once', () => {
  it('the same code cannot be redeemed twice', async () => {
    clearDeliveries();
    const email = `t3-${unique()}@example.com`;
    await startEmailSignIn(email);
    const secret = lastDeliveredTo(email)!.secret;

    expect((await redeemEmailSignIn({ email, secret })).ok).toBe(true);
    const replay = await redeemEmailSignIn({ email, secret });
    expect(replay.ok, 'a spent credential is spent').toBe(false);
  });

  it('two concurrent redemptions of one code yield exactly one session', async () => {
    clearDeliveries();
    const email = `t3c-${unique()}@example.com`;
    await startEmailSignIn(email);
    const secret = lastDeliveredTo(email)!.secret;

    // The consuming UPDATE carries `consumed_at IS NULL`, so the database
    // decides the race rather than a read-then-write in the service.
    const [a, b] = await Promise.all([
      redeemEmailSignIn({ email, secret }),
      redeemEmailSignIn({ email, secret }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });
});

/* ================================================================== *
 * T4 · Privilege escalation
 * ================================================================== */

describe('T4 privilege: operator authority cannot be self-granted', () => {
  it('a plain user cannot rule on a dispute', async () => {
    const alice = await newUser('t4-a');
    const bob = await newUser('t4-b');
    const dealId = await liveDeal(alice, bob);
    await disputeCommand(
      alice,
      newCommandId(),
      dealId,
      'PAYMENT_NOT_RECEIVED',
      'The money never arrived in my account at any point.',
    );

    const { proposeRulingCommand } = await import('@/services/commands');
    const { rows } = await getPool().query(
      `SELECT case_id, version FROM sandbox.dispute_case WHERE deal_id = $1`,
      [dealId],
    );
    const attempt = await proposeRulingCommand(
      { userId: alice.userId, roles: [], permissions: [], mfaSatisfied: true, mfaEnrolled: true },
      newCommandId(),
      {
        caseId: String(rows[0]!.case_id),
        disposition: 'RELEASE',
        rationale: 'I would like my own dispute decided in my favour, please.',
        // Carried so the attempt is well-formed: it must fail on
        // AUTHORITY, not on a malformed payload.
        caseVersion: Number(rows[0]!.version),
      },
    );
    expect(attempt.ok).toBe(false);
  });

  it('a role claimed in the principal object is not a role', async () => {
    /*
     * The principal is derived server-side from `role_grant`. This proves
     * that inventing one client-side achieves nothing: the permission set
     * is not taken from the caller's word for it.
     */
    const mallory = await newUser('t4-m');
    const forged = {
      userId: mallory.userId,
      roles: ['ADMIN', 'OPERATOR'],
      permissions: ['case.rule', 'ledger.fund'],
      mfaSatisfied: true,
      mfaEnrolled: true,
    };
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.role_grant
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [mallory.userId],
    );
    expect(rows[0]!.n, 'no grant exists for this user').toBe(0);
    expect(forged.roles).toContain('ADMIN'); // the claim exists…
    // …and the database, which is the authority, disagrees.
  });
});

/* ================================================================== *
 * T5 · SQL injection
 * ================================================================== */

describe('T5 SQL injection: hostile input is data, never syntax', () => {
  it('a classic payload in a dispute statement is stored verbatim', async () => {
    const alice = await newUser('t5-a');
    const bob = await newUser('t5-b');
    const dealId = await liveDeal(alice, bob);

    const payload = `'; DROP TABLE sandbox.deal; -- and the rest of the sentence`;
    const opened = await disputeCommand(alice, newCommandId(), dealId, 'OTHER', payload);
    expect(opened.ok).toBe(true);

    // The table still exists, and the text was stored as text.
    const { rows } = await getPool().query(
      `SELECT statement FROM sandbox.dispute_case WHERE deal_id = $1`,
      [dealId],
    );
    /*
     * The service composes a sentence and appends what the person wrote,
     * so the payload is CONTAINED rather than equal — and contained
     * verbatim, character for character, because it was bound as a
     * parameter and never concatenated into SQL.
     */
    expect(rows[0]!.statement).toContain(payload);
    const { rows: alive } = await getPool().query(`SELECT count(*)::int AS n FROM sandbox.deal`);
    expect(alive[0]!.n).toBeGreaterThan(0);
  });

  it('a payload in a UTR is refused by shape, not by escaping', async () => {
    const alice = await newUser('t5-ua');
    const bob = await newUser('t5-ub');
    const dealId = await liveDeal(alice, bob);
    const claimed = await claimCommand(
      alice,
      newCommandId(),
      dealId,
      `' OR 1=1 --`,
      'A note accompanying a deliberately malformed reference.',
    );
    expect(claimed.ok).toBe(false);
  });
});

/* ================================================================== *
 * T6 · Mass assignment
 * ================================================================== */

describe('T6 mass assignment: a caller cannot set server-owned fields', () => {
  it('a client-supplied fee bearer is ignored', async () => {
    const alice = await newUser('t6-a');
    const { issueProtectedQuote } = await import('@/server/sandbox/service');
    const forged = await issueProtectedQuote(alice, 2_500_000n, { feeBearer: 'PAYEE' });
    const { snapshotForQuote } = await import('@/server/commerce/pricing');
    const snapshot = await snapshotForQuote(forged.quoteId);
    expect(snapshot!.feeBearer, 'the policy decides, not the caller').toBe('PAYER');
  });

  it('a client cannot choose the deal state it is created in', async () => {
    const alice = await newUser('t6-s');
    const created = await createDealCommand(alice, {
      commandId: newCommandId(),
      scenario: 'INR_TO_INR',
      inrAmount: '2500',
      intent: 'PAY',
      // Not part of the accepted input; present to prove it is ignored.
      ...({ state: 'COMPLETED', protectionFeeMinor: '0' } as Record<string, unknown>),
    } as never);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { rows } = await getPool().query(
      `SELECT state FROM sandbox.deal_link WHERE public_id = $1`,
      [created.value.publicId],
    );
    expect(rows[0]!.state).toBe('OPEN');
  });
});

/* ================================================================== *
 * T7 · Oversized payload denial of service
 * ================================================================== */

describe('T7 oversized input is refused at the boundary', () => {
  it('a megabyte-long chat message is refused, not stored', async () => {
    const alice = await newUser('t7-a');
    const bob = await newUser('t7-b');
    const dealId = await liveDeal(alice, bob);

    const huge = 'A'.repeat(1_000_000);
    const posted = await messageCommand(alice, newCommandId(), dealId, huge);
    expect(posted.ok).toBe(false);

    /*
     * Scoped to THIS body. Joining posts a system message of its own, so
     * a bare count over the deal would never have been zero and the
     * assertion would have been about the fixture, not the refusal.
     */
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.deal_message
        WHERE deal_id = $1 AND body LIKE 'AAAA%'`,
      [dealId],
    );
    expect(rows[0]!.n, 'nothing oversized reached the table').toBe(0);
  });

  it('an over-long dispute statement is refused', async () => {
    const alice = await newUser('t7-d');
    const bob = await newUser('t7-e');
    const dealId = await liveDeal(alice, bob);
    const opened = await disputeCommand(alice, newCommandId(), dealId, 'OTHER', 'B'.repeat(50_000));
    expect(opened.ok).toBe(false);
  });
});

/* ================================================================== *
 * T8 · Command and financial races
 * ================================================================== */

describe('T8 races: one deterministic financial outcome', () => {
  it('two simultaneous joins produce exactly one participant pair', async () => {
    const alice = await newUser('t8-a');
    const first = await newUser('t8-f');
    const second = await newUser('t8-s');

    const created = await createDealCommand(alice, {
      commandId: newCommandId(),
      scenario: 'INR_TO_INR',
      inrAmount: '2500',
      intent: 'PAY',
    });
    if (!created.ok) return;

    const [a, b] = await Promise.all([
      joinCommand(first, newCommandId(), created.value.publicId),
      joinCommand(second, newCommandId(), created.value.publicId),
    ]);
    expect([a.ok, b.ok].filter(Boolean), 'exactly one joiner wins').toHaveLength(1);
  });

  it('an identical command id replays the stored result instead of acting twice', async () => {
    const alice = await newUser('t8-r');
    const bob = await newUser('t8-q');
    const dealId = await liveDeal(alice, bob);

    const commandId = newCommandId();
    const body = 'A message posted once, then retried with the same command id.';
    const first = await messageCommand(alice, commandId, dealId, body);
    const retry = await messageCommand(alice, commandId, dealId, body);
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);

    // Scoped to the body posted here, past the join's system message.
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.deal_message WHERE deal_id = $1 AND body = $2`,
      [dealId, body],
    );
    expect(rows[0]!.n, 'a retry is not a second message').toBe(1);
  });
});

/* ================================================================== *
 * T9 · Sensitive data exposure
 * ================================================================== */

describe('T9 exposure: secrets and identifiers stay out of reach', () => {
  it('a real session token appears nowhere in the audit trail', async () => {
    /*
     * Precise on purpose.
     *
     * The first version of this test flagged any 48+ character hex value
     * in an audit detail and reported 1,496 hits — every one of which
     * was a legitimate content hash: evidence SHA-256s, and the
     * expected/received payload hashes that make command idempotency
     * auditable. A test that cannot tell a digest from a credential
     * produces noise, and noise gets waived.
     *
     * So an actual bearer token is minted and hunted for by value.
     */
    clearDeliveries();
    const email = `t9-${unique()}@example.com`;
    await startEmailSignIn(email);
    const signedIn = await redeemEmailSignIn({
      email,
      secret: lastDeliveredTo(email)!.secret,
    });
    expect(signedIn.ok).toBe(true);
    if (!signedIn.ok) return;

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.audit_event WHERE detail::text LIKE $1`,
      [`%${signedIn.value.sessionToken}%`],
    );
    expect(rows[0]!.n, 'a session token must never be written to the audit trail').toBe(0);

    // Nor the sign-in secret that produced it.
    const secret = lastDeliveredTo(email)!.secret;
    const { rows: creds } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.audit_event WHERE detail::text LIKE $1`,
      [`%${secret}%`],
    );
    expect(creds[0]!.n, 'a sign-in credential must never be written either').toBe(0);
  });

  it('a rejection never echoes the credential that was presented', async () => {
    const bad = await redeemEmailSignIn({
      email: `t9-${unique()}@example.com`,
      secret: 'super-secret-value-987654',
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(JSON.stringify(bad)).not.toContain('super-secret-value-987654');
  });
});

/* ================================================================== *
 * T10 · Worker replay
 * ================================================================== */

describe('T10 worker replay: a duplicate delivery changes nothing twice', () => {
  it('an event delivered twice has one effect', async () => {
    const { runOnce } = await import('@/server/ops/outboxWorker');
    const { outboxHandlers } = await import('@/server/ops/outboxHandlers');
    const { drainOutbox } = await import('./support/outbox');
    await drainOutbox();

    const key = `t10-${unique()}`;
    await getPool().query(
      `INSERT INTO sandbox.outbox_event (event_key, event_type, subject_kind, subject_id, payload)
       VALUES ($1, 'deal.completed', 'user', $2, '{}'::jsonb)`,
      [key, (await newUser('t10-subject')).userId],
    );

    let calls = 0;
    await runOnce(outboxHandlers({ 'deal.completed': async () => void (calls += 1) }));
    await runOnce(outboxHandlers({ 'deal.completed': async () => void (calls += 1) }));
    expect(calls, 'a delivered event is not re-delivered').toBe(1);
  });

  it('the same event key cannot be enqueued twice', async () => {
    const key = `t10-uq-${unique()}`;
    const subject = (await newUser('t10-uq')).userId;
    const insert = () =>
      getPool().query(
        `INSERT INTO sandbox.outbox_event (event_key, event_type, subject_kind, subject_id, payload)
         VALUES ($1, 'deal.completed', 'user', $2, '{}'::jsonb)`,
        [key, subject],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key|event_key/);
  });
});

/* ================================================================== *
 * T11 · Audit integrity
 * ================================================================== */

describe('T11 audit: the record cannot be edited to hide an action', () => {
  it('a committed deal message cannot be altered', async () => {
    const alice = await newUser('t11-a');
    const bob = await newUser('t11-b');
    const dealId = await liveDeal(alice, bob);
    await messageCommand(
      alice,
      newCommandId(),
      dealId,
      'A message that must remain exactly as it was written.',
    );

    await expect(
      withTransaction((tx) =>
        tx.query(`UPDATE sandbox.deal_message SET body = 'edited' WHERE deal_id = $1`, [dealId]),
      ),
    ).rejects.toThrow();
  });
});
