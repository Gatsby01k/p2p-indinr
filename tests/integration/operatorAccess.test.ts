import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPool } from '@/server/db/pool';
import { newCommandId } from '@/server/boundary/command';
import { DESK_PAGE_SIZE, deskQueue, operatorCase, ruleOnDispute } from '@/server/sandbox/ops';
import { fundSandboxCommand, lockValueCommand, proposeRulingCommand } from '@/services/commands';
import type { Principal } from '@/server/identity/rbac';

/** Holds `ledger.fund`, so a disputed deal can hold real value. */
let ledgerAdmin: Principal;

/**
 * The live case behind a disputed deal.
 *
 * DEL-06 rulings are anchored to a case and its version, so the
 * authority tests below need both — and reading them from the database
 * rather than threading them through fixtures keeps each test honest
 * about what the server actually holds.
 */
async function caseFor(dealId: string): Promise<{ caseId: string; version: number }> {
  const { rows } = await getPool().query(
    `SELECT case_id, version FROM sandbox.dispute_case
      WHERE deal_id = $1 AND state IN ('OPEN','UNDER_REVIEW')`,
    [dealId],
  );
  return { caseId: rows[0]!.case_id as string, version: rows[0]!.version as number };
}
import {
  attachEvidence,
  createDealLink,
  issueProtectedQuote,
  joinDealLink,
  operatorQueue,
  raiseDispute,
  readEvidence,
  signInSandbox,
  type SessionUser,
} from '@/server/sandbox/service';
import { grantRole, permissionsFor, revokeRole } from '@/server/identity/rbac';
import { redeemRecoveryCode, verifyMfaForSession } from '@/server/identity/auth';
import { codeFor, stepFor } from '@/server/identity/totp';
import { makeOperator, makeOperatorWithoutMfa, type OperatorFixture } from './support/operator';

/**
 * The three P0 corrections, proved.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  1. No privilege survives the vulnerability that created it.       │
 * │  2. Operator boundaries use LIVE roles and session MFA, never the  │
 * │     cached `isOperator` boolean.                                   │
 * │  3. A recovery code cannot satisfy a factor that was never         │
 * │     confirmed.                                                     │
 * └────────────────────────────────────────────────────────────────────┘
 */

const unique = () => Math.random().toString(36).slice(2, 10);

let alice: SessionUser;
let bob: SessionUser;
let operator: OperatorFixture;

const bare = (u: SessionUser) => ({
  userId: u.userId,
  roles: [] as const,
  permissions: [] as const,
  mfaSatisfied: false,
  mfaEnrolled: false,
});

beforeAll(async () => {
  alice = await signInSandbox(`opa-alice-${unique()}@example.com`);
  bob = await signInSandbox(`opa-bob-${unique()}@example.com`);
  operator = await makeOperator(`opa-ops-${unique()}@example.com`);

  const admin = await makeOperator(`opa-ledger-${unique()}@example.com`);
  await grantRole({
    userId: admin.user.userId,
    role: 'ADMIN',
    grantedBy: null,
    via: 'CLI',
    reason: 'Funding fixture, so a disputed deal holds real protected value.',
  });
  ledgerAdmin = {
    ...admin.principal,
    roles: ['ADMIN'],
    permissions: permissionsFor(['ADMIN']),
  };
});

/**
 * A disputed deal with REAL value locked behind it.
 *
 * The lock is not decoration: DEL-06 refuses to recommend a disposition
 * for value that is not there, so a case on an unlocked deal is
 * unresolvable — correct behaviour, and it would make an authority test
 * pass for the wrong reason.
 */
async function disputedDeal(): Promise<string> {
  const quote = await issueProtectedQuote(alice, 300_000n);
  const link = await createDealLink(alice, quote.quoteId, 'PAY');
  const join = await joinDealLink(bob, link.publicId);

  const funded = await fundSandboxCommand(ledgerAdmin, newCommandId(), {
    userId: alice.userId,
    asset: 'USDT',
    amountMinor: 40_000n,
  });
  if (!funded.ok) throw new Error(`funding fixture: ${funded.code}`);
  const locked = await lockValueCommand(alice, newCommandId(), {
    dealId: join.dealId,
    asset: 'USDT',
    amountMinor: 40_000n,
  });
  if (!locked.ok) throw new Error(`lock fixture: ${locked.code}`);

  await raiseDispute(alice, join.dealId, 'PAYMENT_NOT_RECEIVED', 'Nothing arrived.');
  return join.dealId;
}

/* ------------------------------------------------------------------ *
 * 1. The legacy `ops@` backfill is gone
 * ------------------------------------------------------------------ */

describe('legacy operator flags are revoked, never converted to grants', () => {
  it('migration 0006 contains no grant backfill', () => {
    const sql = readFileSync(join(process.cwd(), 'db/migrations/0006_del03_identity.sql'), 'utf8');
    // The only INSERT into role_grant would be a backfill. There is none.
    expect(sql).not.toMatch(/INSERT INTO sandbox\.role_grant/i);
    // And the flags are explicitly cleared.
    expect(sql).toMatch(/UPDATE sandbox\.app_user SET is_operator = FALSE/i);
  });

  it('a legacy ops@ account left over from before DEL-03 has no authority', async () => {
    /*
     * Simulate exactly what migration 0006 met: an account carrying the
     * cached flag the `ops@` rule used to set. The migration ran when
     * this database was created, so the correct end state is a flag that
     * is FALSE and no grant at all — which is what a legacy operator
     * looks like after the fix.
     */
    const legacy = await signInSandbox(`legacy-ops-${unique()}@example.com`);
    await getPool().query(`UPDATE sandbox.app_user SET is_operator = TRUE WHERE user_id = $1`, [
      legacy.userId,
    ]);

    // Re-running the migration's revocation step is what an upgrade did.
    await getPool().query(`UPDATE sandbox.app_user SET is_operator = FALSE WHERE user_id = $1`, [
      legacy.userId,
    ]);

    const { rows: grants } = await getPool().query(
      `SELECT 1 FROM sandbox.role_grant WHERE user_id = $1 AND revoked_at IS NULL`,
      [legacy.userId],
    );
    expect(grants, 'no grant may be inferred from the cached boolean').toHaveLength(0);

    // And no operator surface admits them.
    await expect(deskQueue(bare(legacy))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('the migration records which accounts lost legacy authority', () => {
    const sql = readFileSync(join(process.cwd(), 'db/migrations/0006_del03_identity.sql'), 'utf8');
    expect(sql).toContain('LEGACY_OPERATOR_REVOKED');
    // Enough detail to find the accounts afterwards.
    expect(sql).toMatch(/'email',\s+email/);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Live RBAC + MFA on every operator boundary
 * ------------------------------------------------------------------ */

describe('operator boundaries require a live grant AND a satisfied factor', () => {
  it('a granted operator without MFA cannot read the desk queue', async () => {
    const weak = await makeOperatorWithoutMfa(`opa-nomfa-${unique()}@example.com`);
    await expect(deskQueue(weak.principal)).rejects.toMatchObject({ code: 'MFA_NOT_ENROLLED' });
  });

  it('a granted operator without MFA cannot read the legacy queue either', async () => {
    const weak = await makeOperatorWithoutMfa(`opa-nomfa2-${unique()}@example.com`);
    await expect(operatorQueue(weak.principal)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('a granted operator without MFA cannot open a case', async () => {
    const dealId = await disputedDeal();
    const weak = await makeOperatorWithoutMfa(`opa-nomfa3-${unique()}@example.com`);
    await expect(operatorCase(weak.principal, dealId)).rejects.toMatchObject({
      code: 'MFA_NOT_ENROLLED',
    });
  });

  it('a granted operator without MFA cannot read disputed evidence', async () => {
    const dealId = await disputedDeal();
    await attachEvidence(alice, dealId, {
      name: 'receipt.png',
      type: 'image/png',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    const { rows } = await getPool().query(
      `SELECT evidence_id FROM sandbox.deal_evidence WHERE deal_id = $1`,
      [dealId],
    );
    const evidenceId = rows[0]!.evidence_id as string;

    const weak = await makeOperatorWithoutMfa(`opa-nomfa4-${unique()}@example.com`);
    const denied = await readEvidence(weak.user, evidenceId, weak.principal);
    expect(denied, 'no bytes without a satisfied factor').toBeNull();

    // The same file IS readable to a fully authorised operator.
    const allowed = await readEvidence(operator.user, evidenceId, operator.principal);
    expect(allowed).not.toBeNull();
  });

  it('a granted operator without MFA cannot rule', async () => {
    const dealId = await disputedDeal();
    const weak = await makeOperatorWithoutMfa(`opa-nomfa5-${unique()}@example.com`);
    const commandId = newCommandId();

    /*
     * Asserted against the DEL-06 PROPOSE boundary. The old
     * `rulingCommand` now refuses everybody, so it can no longer
     * distinguish "no factor" from "no authority" — and a test that
     * cannot tell those apart is not testing the factor.
     */
    const { caseId, version } = await caseFor(dealId);
    const outcome = await proposeRulingCommand(weak.principal, commandId, {
      caseId,
      disposition: 'RELEASE',
      rationale: 'Attempting a ruling without a second factor enrolled at all.',
      caseVersion: version,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('MFA_NOT_ENROLLED');

    // The deal is untouched and the refusal is recorded.
    const { rows } = await getPool().query(`SELECT state FROM sandbox.deal WHERE deal_id = $1`, [
      dealId,
    ]);
    expect(rows[0]!.state).toBe('DISPUTED');
    const { rows: audits } = await getPool().query(
      `SELECT 1 FROM sandbox.audit_event
        WHERE subject_id = $1 AND action='DISPUTE_PROPOSE' AND outcome='MFA_NOT_ENROLLED'`,
      [caseId],
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('ENROLLED but NOT satisfied in this session is still denied', async () => {
    /*
     * The distinction that matters: the account has a confirmed factor,
     * but this device has not answered it. Authority is per-session.
     */
    const dealId = await disputedDeal();
    const halfway = {
      ...operator.principal,
      mfaEnrolled: true,
      mfaSatisfied: false,
    };
    await expect(deskQueue(halfway)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    await expect(operatorCase(halfway, dealId)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });

    const { caseId, version } = await caseFor(dealId);
    const outcome = await proposeRulingCommand(halfway, newCommandId(), {
      caseId,
      disposition: 'RELEASE',
      rationale: 'The account has a factor but this session has not answered it.',
      caseVersion: version,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('MFA_REQUIRED');
  });

  it('a confirmed AND satisfied operator is allowed', async () => {
    const dealId = await disputedDeal();
    // A bounded PAGE now, not the whole queue: rows plus the true total.
    await expect(deskQueue(operator.principal)).resolves.toMatchObject({
      rows: expect.any(Array),
      total: expect.any(Number),
      pageSize: DESK_PAGE_SIZE,
    });
    await expect(operatorCase(operator.principal, dealId)).resolves.toMatchObject({ dealId });

    const { caseId, version } = await caseFor(dealId);
    const outcome = await proposeRulingCommand(operator.principal, newCommandId(), {
      caseId,
      disposition: 'REFUND',
      rationale: 'Evidence supports the payer; recommending the protected value returns.',
      caseVersion: version,
    });
    expect(outcome.ok).toBe(true);
  });

  it('a plain signed-in person is denied for lack of permission', async () => {
    const dealId = await disputedDeal();
    await expect(deskQueue(bare(alice))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(operatorCase(bare(alice), dealId)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(
      ruleOnDispute(bare(alice), dealId, 'RELEASED', 'I would like this released to me.'),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('revoking the role removes access immediately', async () => {
    const temp = await makeOperator(`opa-temp-${unique()}@example.com`);
    // A page, not a bare array: `rows` plus the true total behind it.
    await expect(deskQueue(temp.principal)).resolves.toMatchObject({
      rows: expect.any(Array),
      total: expect.any(Number),
    });

    await revokeRole({ userId: temp.user.userId, role: 'OPERATOR', revokedBy: null });

    /*
     * The PRINCIPAL is rebuilt from live state on every request, which is
     * the point of the correction: the stale object still says OPERATOR,
     * but a freshly resolved one does not.
     */
    const { rolesFor } = await import('@/server/identity/rbac');
    const live = await rolesFor(temp.user.userId);
    expect(live).toEqual([]);

    const rebuilt = { ...temp.principal, roles: live, permissions: permissionsFor(live) };
    await expect(deskQueue(rebuilt)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    // The cached column agrees, so no reader can disagree with the grant.
    const { rows } = await getPool().query(
      `SELECT is_operator FROM sandbox.app_user WHERE user_id = $1`,
      [temp.user.userId],
    );
    expect(rows[0]!.is_operator).toBe(false);
  });

  it('a re-granted operator must satisfy the factor again', async () => {
    const temp = await makeOperator(`opa-regrant-${unique()}@example.com`);
    await revokeRole({ userId: temp.user.userId, role: 'OPERATOR', revokedBy: null });
    await grantRole({
      userId: temp.user.userId,
      role: 'OPERATOR',
      grantedBy: null,
      via: 'CLI',
      reason: 'Re-granted after a review of the desk roster.',
    });

    // The grant is back; the session-level factor is a separate fact.
    const withoutSession = { ...temp.principal, mfaSatisfied: false };
    await expect(deskQueue(withoutSession)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
});

/* ------------------------------------------------------------------ *
 * 3. The unconfirmed-MFA recovery bypass
 * ------------------------------------------------------------------ */

describe('recovery codes cannot precede the factor they recover', () => {
  it('a code from an UNCONFIRMED enrolment is refused', async () => {
    const user = await signInSandbox(`rec-unconf-${unique()}@example.com`);
    const { withTransaction } = await import('@/server/db/pool');
    const { issueSessionIn } = await import('@/server/identity/sessions');
    const session = await withTransaction((tx) =>
      issueSessionIn(tx, { userId: user.userId, origin: 'EMAIL_OTP' }),
    );

    const { beginMfaEnrolment } = await import('@/server/identity/auth');
    const enrolment = await beginMfaEnrolment(user.userId);
    expect(enrolment.ok).toBe(true);
    if (!enrolment.ok) return;

    // The factor was never confirmed — the authenticator was ignored.
    const outcome = await redeemRecoveryCode({
      userId: user.userId,
      sessionId: session.sessionId,
      code: enrolment.value.recoveryCodes[0]!,
    });
    expect(outcome.ok, 'an unconfirmed factor must not be recoverable').toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('MFA_INVALID');

    // And the session is emphatically NOT satisfied.
    const { rows } = await getPool().query(
      `SELECT mfa_satisfied_at FROM sandbox.session WHERE session_id = $1`,
      [session.sessionId],
    );
    expect(rows[0]!.mfa_satisfied_at).toBeNull();
  });

  it('the same code works once the factor IS confirmed', async () => {
    const temp = await makeOperator(`rec-conf-${unique()}@example.com`);
    const outcome = await redeemRecoveryCode({
      userId: temp.user.userId,
      sessionId: temp.sessionId,
      code: temp.recoveryCodes[0]!,
    });
    expect(outcome.ok).toBe(true);
  });

  it('and never a second time', async () => {
    const temp = await makeOperator(`rec-once-${unique()}@example.com`);
    const code = temp.recoveryCodes[1]!;
    expect(
      (
        await redeemRecoveryCode({
          userId: temp.user.userId,
          sessionId: temp.sessionId,
          code,
        })
      ).ok,
    ).toBe(true);

    const reuse = await redeemRecoveryCode({
      userId: temp.user.userId,
      sessionId: temp.sessionId,
      code,
    });
    expect(reuse.ok).toBe(false);
    if (reuse.ok) return;
    expect(reuse.code).toBe('MFA_INVALID');
  });

  it('an unconfirmed factor cannot satisfy MFA through the normal path either', async () => {
    const user = await signInSandbox(`rec-totp-${unique()}@example.com`);
    const { withTransaction } = await import('@/server/db/pool');
    const { issueSessionIn } = await import('@/server/identity/sessions');
    const session = await withTransaction((tx) =>
      issueSessionIn(tx, { userId: user.userId, origin: 'EMAIL_OTP' }),
    );
    const { beginMfaEnrolment } = await import('@/server/identity/auth');
    const enrolment = await beginMfaEnrolment(user.userId);
    if (!enrolment.ok) return;

    const outcome = await verifyMfaForSession({
      userId: user.userId,
      sessionId: session.sessionId,
      presented: codeFor(enrolment.value.secret, stepFor()),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('MFA_NOT_ENROLLED');
  });

  it('the confirmed flow still works end to end', async () => {
    /*
     * The fixture IS the end-to-end flow: enrol, confirm, satisfy. Its
     * success is the assertion — re-presenting a code here would be
     * refused by replay protection, which is a different property and is
     * covered separately.
     */
    const temp = await makeOperator(`rec-flow-${unique()}@example.com`);

    const { rows } = await getPool().query(
      `SELECT s.mfa_satisfied_at, f.confirmed_at
         FROM sandbox.session s
         JOIN sandbox.mfa_factor f
           ON f.user_id = s.user_id AND f.disabled_at IS NULL AND f.confirmed_at IS NOT NULL
        WHERE s.session_id = $1`,
      [temp.sessionId],
    );
    expect(rows[0]!.confirmed_at, 'the factor is confirmed').not.toBeNull();
    expect(rows[0]!.mfa_satisfied_at, 'and satisfied in this session').not.toBeNull();

    // And that is exactly what authorises the operator surfaces.
    // A page, not a bare array: `rows` plus the true total behind it.
    await expect(deskQueue(temp.principal)).resolves.toMatchObject({
      rows: expect.any(Array),
      total: expect.any(Number),
    });
  });
});
