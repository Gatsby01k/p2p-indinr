import { getPool, withTransaction } from '@/server/db/pool';
import { grantRole, permissionsFor, type Principal } from '@/server/identity/rbac';
import { issueSessionIn } from '@/server/identity/sessions';
import {
  beginMfaEnrolment,
  confirmMfaEnrolment,
  verifyMfaForSession,
} from '@/server/identity/auth';
import { codeFor, stepFor } from '@/server/identity/totp';
import { signInSandbox, type SessionUser } from '@/server/sandbox/service';

/**
 * Build an operator the way DEL-03 requires one to exist.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THREE THINGS ARE NOW NEEDED, AND NONE OF THEM IS AN EMAIL.        │
 * │                                                                    │
 * │  DEL-02 suites minted an operator by signing in as                 │
 * │  `ops@sandbox.test`. DEL-03 removed that entirely, and the final   │
 * │  correction removed the migration backfill too — so authority is:  │
 * │                                                                    │
 * │    1. a `role_grant` row written out of band;                      │
 * │    2. a CONFIRMED second factor on the account;                    │
 * │    3. that factor SATISFIED in this session.                       │
 * │                                                                    │
 * │  This fixture performs all three, which is why every operator test │
 * │  is now also a test that the three are genuinely required: remove  │
 * │  any one of them and the suite fails.                              │
 * └────────────────────────────────────────────────────────────────────┘
 */

export interface OperatorFixture {
  readonly user: SessionUser;
  readonly principal: Principal;
  readonly sessionId: string;
  /** The TOTP secret, so a test can mint further codes. */
  readonly totpSecret: string;
  readonly recoveryCodes: readonly string[];
}

/** An account with a live grant, an enrolled factor and a satisfied session. */
export async function makeOperator(email: string): Promise<OperatorFixture> {
  const user = await signInSandbox(email);

  const granted = await grantRole({
    userId: user.userId,
    role: 'OPERATOR',
    grantedBy: null,
    via: 'CLI',
    reason: 'Integration fixture operator, granted out of band.',
  });
  if (!granted.ok) throw new Error(`operator fixture failed: ${granted.reason}`);

  const session = await withTransaction((tx) =>
    issueSessionIn(tx, { userId: user.userId, origin: 'EMAIL_OTP', deviceLabel: 'Fixture' }),
  );

  const enrolment = await beginMfaEnrolment(user.userId);
  if (!enrolment.ok) throw new Error('operator fixture: enrolment failed');
  const confirmed = await confirmMfaEnrolment(
    user.userId,
    codeFor(enrolment.value.secret, stepFor()),
  );
  if (!confirmed.ok) throw new Error('operator fixture: confirmation failed');

  const satisfied = await verifyMfaForSession({
    userId: user.userId,
    sessionId: session.sessionId,
    presented: codeFor(enrolment.value.secret, stepFor() + 1),
  });
  if (!satisfied.ok) throw new Error('operator fixture: factor not satisfied');

  return {
    user: await reread(user.userId),
    principal: {
      userId: user.userId,
      roles: ['OPERATOR'],
      permissions: permissionsFor(['OPERATOR']),
      mfaSatisfied: true,
      mfaEnrolled: true,
    },
    sessionId: session.sessionId,
    totpSecret: enrolment.value.secret,
    recoveryCodes: enrolment.value.recoveryCodes,
  };
}

/**
 * A principal with the grant but WITHOUT a satisfied second factor.
 *
 * Used to prove the negative: a genuinely granted operator who has not
 * answered their authenticator on this device must receive no operator
 * data and perform no ruling.
 */
export async function makeOperatorWithoutMfa(email: string): Promise<OperatorFixture> {
  const user = await signInSandbox(email);
  const granted = await grantRole({
    userId: user.userId,
    role: 'OPERATOR',
    grantedBy: null,
    via: 'CLI',
    reason: 'Integration fixture operator without a second factor.',
  });
  if (!granted.ok) throw new Error(`operator fixture failed: ${granted.reason}`);

  const session = await withTransaction((tx) =>
    issueSessionIn(tx, { userId: user.userId, origin: 'EMAIL_OTP', deviceLabel: 'Fixture' }),
  );

  return {
    user: await reread(user.userId),
    principal: {
      userId: user.userId,
      roles: ['OPERATOR'],
      permissions: permissionsFor(['OPERATOR']),
      mfaSatisfied: false,
      mfaEnrolled: false,
    },
    sessionId: session.sessionId,
    totpSecret: '',
    recoveryCodes: [],
  };
}

async function reread(userId: string): Promise<SessionUser> {
  const { rows } = await getPool().query(
    `SELECT user_id, email, display_name, is_operator, is_verified
       FROM sandbox.app_user WHERE user_id = $1`,
    [userId],
  );
  const r = rows[0]!;
  return {
    userId: r.user_id,
    email: r.email ?? null,
    displayName: r.display_name,
    isOperator: r.is_operator,
    isVerified: r.is_verified,
  };
}
