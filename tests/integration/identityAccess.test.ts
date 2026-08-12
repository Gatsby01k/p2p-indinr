import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/server/db/pool';
import { clearDeliveries, lastDeliveredTo } from '@/server/adapters/emailDelivery';
import {
  beginMfaEnrolment,
  confirmMfaEnrolment,
  redeemEmailSignIn,
  startEmailSignIn,
  verifyMfaForSession,
} from '@/server/identity/auth';
import {
  can,
  denialFor,
  grantRole,
  permissionsFor,
  revokeRole,
  rolesFor,
} from '@/server/identity/rbac';
import { resolveSession } from '@/server/identity/sessions';
import { codeFor, stepFor } from '@/server/identity/totp';
import { decideVerification, submitVerification } from '@/server/identity/verification';
import { sandboxRolesForEmail } from '@/server/adapters/policy';
import { AdapterUnavailableError } from '@/server/adapters/mode';

/**
 * DEL-03 access control: roles, second-factor gating, verification cases
 * and production isolation.
 */

const unique = () => Math.random().toString(36).slice(2, 10);
const original = { nodeEnv: process.env.NODE_ENV, sandbox: process.env.INRP2P_SANDBOX };

function enterProduction() {
  (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
  delete process.env.INRP2P_SANDBOX;
}
function restore() {
  (process.env as Record<string, string | undefined>).NODE_ENV = original.nodeEnv;
  if (original.sandbox === undefined) delete process.env.INRP2P_SANDBOX;
  else process.env.INRP2P_SANDBOX = original.sandbox;
}
beforeEach(() => {
  restore();
  clearDeliveries();
});
afterEach(restore);

async function account(prefix = 'acc') {
  const email = `${prefix}-${unique()}@example.com`;
  await startEmailSignIn(email);
  const secret = lastDeliveredTo(email)!.secret;
  const signedIn = await redeemEmailSignIn({ email, secret });
  if (!signedIn.ok) throw new Error('fixture');
  return { ...signedIn.value, email };
}

/** Enrol and satisfy a second factor for a session. */
async function withMfa(userId: string, sessionId: string) {
  const enrolment = await beginMfaEnrolment(userId);
  if (!enrolment.ok) throw new Error('enrolment fixture');
  await confirmMfaEnrolment(userId, codeFor(enrolment.value.secret, stepFor()));
  await verifyMfaForSession({
    userId,
    sessionId,
    presented: codeFor(enrolment.value.secret, stepFor() + 1),
  });
  return enrolment.value;
}

/* ------------------------------------------------------------------ *
 * The `ops@` prefix is gone
 * ------------------------------------------------------------------ */

describe('operator authority cannot be self-assigned', () => {
  it('an ops@ address grants nothing', async () => {
    const acct = await account('ops');
    const { rows } = await getPool().query(
      `SELECT is_operator FROM sandbox.app_user WHERE user_id = $1`,
      [acct.userId],
    );
    expect(rows[0]!.is_operator).toBe(false);
    expect(await rolesFor(acct.userId)).toEqual([]);
  });

  it('the fixture helper no longer returns operator for any spelling', () => {
    for (const email of ['ops@x.com', 'OPS@x.com', 'ops@anything.example']) {
      expect(sandboxRolesForEmail(email.toLowerCase()).isOperator).toBe(false);
    }
  });

  it('refuses a self-grant', async () => {
    const acct = await account();
    const result = await grantRole({
      userId: acct.userId,
      role: 'OPERATOR',
      grantedBy: acct.userId,
      via: 'CLI',
      reason: 'promoting myself',
    });
    expect(result.ok).toBe(false);
  });

  it('the database refuses a self-grant even if the service is bypassed', async () => {
    const acct = await account();
    await expect(
      getPool().query(
        `INSERT INTO sandbox.role_grant (user_id, role, granted_by, granted_via, reason)
         VALUES ($1,'OPERATOR',$1,'CLI','bypassing the service layer')`,
        [acct.userId],
      ),
    ).rejects.toThrow(/role_grant_not_self/);
  });

  it('the database refuses a grant claiming a web origin', async () => {
    const acct = await account();
    await expect(
      getPool().query(
        `INSERT INTO sandbox.role_grant (user_id, role, granted_by, granted_via, reason)
         VALUES ($1,'OPERATOR',NULL,'WEB','granted through a request')`,
        [acct.userId],
      ),
    ).rejects.toThrow(/role_grant_via_closed/);
  });

  it('a CLI grant works, syncs the cache and invalidates live sessions', async () => {
    const acct = await account();
    const before = await resolveSession(acct.sessionToken);
    expect(before.ok).toBe(true);

    const result = await grantRole({
      userId: acct.userId,
      role: 'OPERATOR',
      grantedBy: null,
      via: 'CLI',
      reason: 'Named operator for the launch desk.',
    });
    expect(result.ok).toBe(true);
    expect(await rolesFor(acct.userId)).toEqual(['OPERATOR']);

    const { rows } = await getPool().query(
      `SELECT is_operator FROM sandbox.app_user WHERE user_id = $1`,
      [acct.userId],
    );
    expect(rows[0]!.is_operator).toBe(true);

    // New authority does not silently upgrade a session that predates it.
    const after = await resolveSession(acct.sessionToken);
    expect(after.ok).toBe(false);
  });

  it('a revoke takes effect immediately', async () => {
    const acct = await account();
    await grantRole({
      userId: acct.userId,
      role: 'OPERATOR',
      grantedBy: null,
      via: 'CLI',
      reason: 'Temporary desk cover for the week.',
    });
    await revokeRole({ userId: acct.userId, role: 'OPERATOR', revokedBy: null });

    expect(await rolesFor(acct.userId)).toEqual([]);
    const { rows } = await getPool().query(
      `SELECT is_operator FROM sandbox.app_user WHERE user_id = $1`,
      [acct.userId],
    );
    expect(rows[0]!.is_operator).toBe(false);
  });

  it('audits both the grant and the revoke', async () => {
    const acct = await account();
    await grantRole({
      userId: acct.userId,
      role: 'OPERATOR',
      grantedBy: null,
      via: 'CLI',
      reason: 'Auditable grant for the trail.',
    });
    await revokeRole({ userId: acct.userId, role: 'OPERATOR', revokedBy: null });

    const { rows } = await getPool().query(
      `SELECT action FROM sandbox.audit_event WHERE subject_id = $1 ORDER BY audit_id`,
      [acct.userId],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('ROLE_GRANT');
    expect(actions).toContain('ROLE_REVOKE');
  });
});

/* ------------------------------------------------------------------ *
 * Operator work requires a satisfied second factor
 * ------------------------------------------------------------------ */

describe('operator permissions require 2FA in this session', () => {
  it('a granted operator without a satisfied factor may do nothing operator-shaped', async () => {
    const acct = await account();
    await grantRole({
      userId: acct.userId,
      role: 'OPERATOR',
      grantedBy: null,
      via: 'CLI',
      reason: 'Operator for the permission test.',
    });

    const principal = {
      userId: acct.userId,
      roles: ['OPERATOR'] as const,
      permissions: permissionsFor(['OPERATOR']),
      mfaSatisfied: false,
      mfaEnrolled: false,
    };
    expect(can(principal, 'deal.rule')).toBe(false);
    expect(can(principal, 'ops.queue.read')).toBe(false);
    // No factor enrolled at all, so the denial names that specifically —
    // the operator needs to set one up, not merely answer one.
    expect(denialFor(principal, 'deal.rule')).toBe('MFA_NOT_ENROLLED');
  });

  it('the same operator with a satisfied factor may act', async () => {
    const acct = await account();
    await grantRole({
      userId: acct.userId,
      role: 'OPERATOR',
      grantedBy: null,
      via: 'CLI',
      reason: 'Operator for the permission test.',
    });

    const principal = {
      userId: acct.userId,
      roles: ['OPERATOR'] as const,
      permissions: permissionsFor(['OPERATOR']),
      mfaSatisfied: true,
      mfaEnrolled: true,
    };
    expect(can(principal, 'deal.rule')).toBe(true);
    expect(denialFor(principal, 'deal.rule')).toBeNull();
  });

  it('a non-operator is denied for lack of permission, not for lack of a factor', async () => {
    const acct = await account();
    const principal = {
      userId: acct.userId,
      roles: [] as const,
      permissions: permissionsFor([]),
      mfaSatisfied: true,
      mfaEnrolled: true,
    };
    expect(denialFor(principal, 'deal.rule')).toBe('NO_PERMISSION');
  });
});

/* ------------------------------------------------------------------ *
 * Verification cases
 * ------------------------------------------------------------------ */

describe('verification is a reviewed case, not a boolean', () => {
  async function reviewer() {
    const acct = await account('rev');
    await grantRole({
      userId: acct.userId,
      role: 'REVIEWER',
      grantedBy: null,
      via: 'CLI',
      reason: 'Verification reviewer for these tests.',
    });
    await withMfa(acct.userId, acct.sessionId);
    return {
      ...acct,
      principal: {
        userId: acct.userId,
        roles: ['REVIEWER'] as const,
        permissions: permissionsFor(['REVIEWER']),
        mfaSatisfied: true,
        mfaEnrolled: true,
      },
    };
  }

  it('submitting does not verify anything', async () => {
    const subject = await account('subj');
    const submitted = await submitVerification({ userId: subject.userId, kind: 'IDENTITY' });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.state).toBe('SUBMITTED');

    const { rows } = await getPool().query(
      `SELECT identity_verified FROM sandbox.user_profile WHERE user_id = $1`,
      [subject.userId],
    );
    expect(rows[0]!.identity_verified).toBe(false);
  });

  it('a reviewer who is not the subject can approve, and the badge follows', async () => {
    const subject = await account('subj');
    const rev = await reviewer();
    const submitted = await submitVerification({ userId: subject.userId, kind: 'IDENTITY' });
    if (!submitted.ok) return;

    const decided = await decideVerification({
      reviewer: rev.principal,
      caseId: submitted.value.caseId,
      decision: 'APPROVED',
      note: 'Document matches the applicant and is in date.',
    });
    expect(decided.ok).toBe(true);

    const { rows } = await getPool().query(
      `SELECT identity_verified FROM sandbox.user_profile WHERE user_id = $1`,
      [subject.userId],
    );
    expect(rows[0]!.identity_verified).toBe(true);
  });

  it('REFUSES a self-decision — reviewer separation', async () => {
    const rev = await reviewer();
    const own = await submitVerification({ userId: rev.userId, kind: 'IDENTITY' });
    if (!own.ok) return;

    const decided = await decideVerification({
      reviewer: rev.principal,
      caseId: own.value.caseId,
      decision: 'APPROVED',
      note: 'Approving my own verification case.',
    });
    expect(decided.ok).toBe(false);
    if (decided.ok) return;
    expect(decided.code).toBe('REVIEWER_CONFLICT');
  });

  it('the database refuses a self-decision even if the service is bypassed', async () => {
    const subject = await account('subj');
    const submitted = await submitVerification({ userId: subject.userId, kind: 'UPI' });
    if (!submitted.ok) return;

    await expect(
      getPool().query(
        `UPDATE sandbox.verification_case
            SET state='APPROVED', decided_at=now(), decided_by=$2
          WHERE case_id=$1`,
        [submitted.value.caseId, subject.userId],
      ),
    ).rejects.toThrow(/reviewer_not_subject/);
  });

  it('refuses a decision from someone with no reviewer permission', async () => {
    const subject = await account('subj');
    const nobody = await account('nob');
    const submitted = await submitVerification({ userId: subject.userId, kind: 'WALLET' });
    if (!submitted.ok) return;

    const decided = await decideVerification({
      reviewer: {
        userId: nobody.userId,
        roles: [],
        permissions: permissionsFor([]),
        mfaSatisfied: true,
        mfaEnrolled: true,
      },
      caseId: submitted.value.caseId,
      decision: 'APPROVED',
      note: 'I would like this approved please.',
    });
    expect(decided.ok).toBe(false);
    if (decided.ok) return;
    expect(decided.code).toBe('PERMISSION_DENIED');
  });

  it('cannot be decided twice', async () => {
    const subject = await account('subj');
    const rev = await reviewer();
    const submitted = await submitVerification({ userId: subject.userId, kind: 'IDENTITY' });
    if (!submitted.ok) return;

    const note = 'Reviewed against the submitted document.';
    expect(
      (
        await decideVerification({
          reviewer: rev.principal,
          caseId: submitted.value.caseId,
          decision: 'APPROVED',
          note,
        })
      ).ok,
    ).toBe(true);

    const again = await decideVerification({
      reviewer: rev.principal,
      caseId: submitted.value.caseId,
      decision: 'REJECTED',
      note,
    });
    expect(again.ok).toBe(false);
  });

  it('keeps an immutable history — a decided case cannot be deleted', async () => {
    const subject = await account('subj');
    const submitted = await submitVerification({ userId: subject.userId, kind: 'IDENTITY' });
    if (!submitted.ok) return;

    await getPool().query(`DELETE FROM sandbox.verification_case WHERE case_id = $1`, [
      submitted.value.caseId,
    ]);
    const { rows } = await getPool().query(
      `SELECT 1 FROM sandbox.verification_case WHERE case_id = $1`,
      [submitted.value.caseId],
    );
    expect(rows, 'the DO INSTEAD NOTHING rule must preserve it').toHaveLength(1);
  });

  it('audits submission and decision', async () => {
    const subject = await account('subj');
    const rev = await reviewer();
    const submitted = await submitVerification({ userId: subject.userId, kind: 'IDENTITY' });
    if (!submitted.ok) return;
    await decideVerification({
      reviewer: rev.principal,
      caseId: submitted.value.caseId,
      decision: 'APPROVED',
      note: 'Checked and approved for the audit trail.',
    });

    const { rows } = await getPool().query(
      `SELECT action FROM sandbox.audit_event WHERE subject_id = $1`,
      [subject.userId],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('VERIFICATION_SUBMIT');
    expect(actions).toContain('VERIFICATION_DECIDE');
  });

  it('a concurrent second submission joins the first', async () => {
    const subject = await account('subj');
    const [a, b] = await Promise.all([
      submitVerification({ userId: subject.userId, kind: 'IDENTITY' }),
      submitVerification({ userId: subject.userId, kind: 'IDENTITY' }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.verification_case
        WHERE user_id = $1 AND kind = 'IDENTITY'`,
      [subject.userId],
    );
    expect(rows[0]!.n).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Production isolation
 * ------------------------------------------------------------------ */

describe('production isolation of identity', () => {
  it('the legacy sandbox sign-in refuses in production', async () => {
    const { signInSandbox } = await import('@/server/sandbox/service');
    enterProduction();
    await expect(signInSandbox(`prod-${unique()}@example.com`)).rejects.toThrow(
      AdapterUnavailableError,
    );
  });

  it('the sandbox role fixture refuses in production', () => {
    enterProduction();
    expect(() => sandboxRolesForEmail('anything@example.com')).toThrow(AdapterUnavailableError);
  });

  it('email delivery — and therefore sign-in — is unavailable in production', async () => {
    enterProduction();
    await expect(startEmailSignIn(`prod2-${unique()}@example.com`)).rejects.toThrow(
      AdapterUnavailableError,
    );
  });
});
