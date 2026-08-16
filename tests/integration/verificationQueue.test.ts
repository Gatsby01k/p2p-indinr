import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/server/db/pool';
import { clearDeliveries, lastDeliveredTo } from '@/server/adapters/emailDelivery';
import {
  beginMfaEnrolment,
  confirmMfaEnrolment,
  redeemEmailSignIn,
  startEmailSignIn,
  verifyMfaForSession,
} from '@/server/identity/auth';
import { grantRole, permissionsFor, type Principal } from '@/server/identity/rbac';
import { resolveSession } from '@/server/identity/sessions';
import { codeFor, stepFor } from '@/server/identity/totp';
import {
  decideVerification,
  listVerificationQueue,
  submitVerification,
} from '@/server/identity/verification';

/**
 * DEL-10: the verification review QUEUE, and the session that survives
 * enrolling a second factor.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHAT THESE TWO DEFECTS HAD IN COMMON.                             │
 * │                                                                    │
 * │  Both were complete, correct, tested server-side rules that no     │
 * │  person could actually get through, and neither could be seen from │
 * │  a unit test:                                                      │
 * │                                                                    │
 * │    · `decideVerification` existed and nothing could reach it, so   │
 * │      every submitted case stayed SUBMITTED, no account was ever    │
 * │      verified, and joining a protected deal was refused for        │
 * │      everybody, permanently;                                       │
 * │                                                                    │
 * │    · confirming an authenticator bumped the account's session      │
 * │      version including the session doing the confirming, so        │
 * │      enrolling signed you out on the device you enrolled from and  │
 * │      left you holding a factor you could not answer.               │
 * │                                                                    │
 * │  The tests below are about REACHABILITY, which is why they assert  │
 * │  on a queue a reviewer can read and on a session that still        │
 * │  resolves — not merely on the decision function's return value.    │
 * └────────────────────────────────────────────────────────────────────┘
 */

const unique = () => Math.random().toString(36).slice(2, 10);

beforeEach(() => {
  clearDeliveries();
});

async function account(prefix = 'acc') {
  const email = `${prefix}-${unique()}@example.com`;
  await startEmailSignIn(email);
  const secret = lastDeliveredTo(email)!.secret;
  const signedIn = await redeemEmailSignIn({ email, secret });
  if (!signedIn.ok) throw new Error('fixture: sign-in failed');
  return { ...signedIn.value, email };
}

async function enrolAndSatisfy(userId: string, sessionId: string) {
  const enrolment = await beginMfaEnrolment(userId);
  if (!enrolment.ok) throw new Error('fixture: enrolment failed');
  const confirmed = await confirmMfaEnrolment(userId, codeFor(enrolment.value.secret, stepFor()), {
    keepSessionId: sessionId,
  });
  if (!confirmed.ok) throw new Error('fixture: confirmation failed');
  await verifyMfaForSession({
    userId,
    sessionId,
    presented: codeFor(enrolment.value.secret, stepFor() + 1),
  });
  return enrolment.value;
}

async function reviewer() {
  const acct = await account('rev');
  await grantRole({
    userId: acct.userId,
    role: 'REVIEWER',
    grantedBy: null,
    via: 'CLI',
    reason: 'Verification reviewer for these tests.',
  });
  await enrolAndSatisfy(acct.userId, acct.sessionId);
  const principal: Principal = {
    userId: acct.userId,
    roles: ['REVIEWER'],
    permissions: permissionsFor(['REVIEWER']),
    mfaSatisfied: true,
    mfaEnrolled: true,
  };
  return { ...acct, principal };
}

/* ------------------------------------------------------------------ *
 * The queue
 * ------------------------------------------------------------------ */

describe('a reviewer can actually reach the cases they are meant to decide', () => {
  it('lists a submitted case with the subject named', async () => {
    const subject = await account('subj');
    const rev = await reviewer();
    const submitted = await submitVerification({ userId: subject.userId, kind: 'IDENTITY' });
    expect(submitted.ok).toBe(true);

    const queue = await listVerificationQueue(rev.principal);
    expect(queue.ok).toBe(true);
    if (!queue.ok) return;

    const row = queue.value.find((c) => c.userId === subject.userId);
    expect(row, 'the submitted case should be in the queue').toBeDefined();
    expect(row!.kind).toBe('IDENTITY');
    expect(row!.state).toBe('SUBMITTED');
    expect(row!.subjectName.length).toBeGreaterThan(0);
    expect(row!.isOwnCase).toBe(false);
  });

  it('carries the local part of the address and never the whole one', async () => {
    const subject = await account('subj');
    const rev = await reviewer();
    await submitVerification({ userId: subject.userId, kind: 'UPI' });

    const queue = await listVerificationQueue(rev.principal);
    if (!queue.ok) return;
    const row = queue.value.find((c) => c.userId === subject.userId)!;
    // A reviewer needs to tell two accounts apart; a queue full of
    // mailboxes is a contact list waiting to be screenshotted.
    expect(row.subjectHandle).not.toContain('@');
    expect(subject.email).toContain(row.subjectHandle);
  });

  it('flags the reviewer’s own case rather than hiding it', async () => {
    const rev = await reviewer();
    await submitVerification({ userId: rev.userId, kind: 'IDENTITY' });

    const queue = await listVerificationQueue(rev.principal);
    if (!queue.ok) return;
    const own = queue.value.find((c) => c.userId === rev.userId);
    expect(own, 'their own case is still listed').toBeDefined();
    expect(own!.isOwnCase).toBe(true);

    // And the database refuses the decision regardless of any screen.
    const decided = await decideVerification({
      reviewer: rev.principal,
      caseId: own!.caseId,
      decision: 'APPROVED',
      note: 'Trying to approve my own case.',
    });
    expect(decided.ok).toBe(false);
    if (decided.ok) return;
    expect(decided.code).toBe('REVIEWER_CONFLICT');
  });

  it('refuses a caller without the reviewer permission, before reading anything', async () => {
    const nobody = await account('nob');
    const outcome = await listVerificationQueue({
      userId: nobody.userId,
      roles: [],
      permissions: [],
      mfaSatisfied: false,
      mfaEnrolled: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PERMISSION_DENIED');
  });

  it('refuses a reviewer who has not answered their second factor', async () => {
    const acct = await account('rev2');
    await grantRole({
      userId: acct.userId,
      role: 'REVIEWER',
      grantedBy: null,
      via: 'CLI',
      reason: 'Reviewer without a satisfied factor.',
    });
    const outcome = await listVerificationQueue({
      userId: acct.userId,
      roles: ['REVIEWER'],
      permissions: permissionsFor(['REVIEWER']),
      mfaSatisfied: false,
      mfaEnrolled: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PERMISSION_DENIED');
  });

  it('a decided case leaves the queue, and the badge follows the decision', async () => {
    const subject = await account('subj');
    const rev = await reviewer();
    const submitted = await submitVerification({ userId: subject.userId, kind: 'IDENTITY' });
    if (!submitted.ok) return;

    const decided = await decideVerification({
      reviewer: rev.principal,
      caseId: submitted.value.caseId,
      decision: 'APPROVED',
      note: 'Evidence reviewed and consistent.',
    });
    expect(decided.ok).toBe(true);

    const after = await listVerificationQueue(rev.principal);
    if (!after.ok) return;
    expect(after.value.some((c) => c.caseId === submitted.value.caseId)).toBe(false);

    const { rows } = await getPool().query(
      `SELECT identity_verified FROM sandbox.user_profile WHERE user_id = $1`,
      [subject.userId],
    );
    expect(rows[0]!.identity_verified).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The session that does the enrolling
 * ------------------------------------------------------------------ */

describe('enrolling a second factor does not sign you out of the device you used', () => {
  it('keeps the confirming session and kills every other one', async () => {
    const acct = await account('mfa');

    // A second device, signed in before the enrolment.
    const other = await redeemEmailSignIn({
      email: acct.email,
      secret: await (async () => {
        await startEmailSignIn(acct.email);
        return lastDeliveredTo(acct.email)!.secret;
      })(),
    });
    if (!other.ok) throw new Error('fixture: second session');

    const enrolment = await beginMfaEnrolment(acct.userId);
    if (!enrolment.ok) return;
    const confirmed = await confirmMfaEnrolment(
      acct.userId,
      codeFor(enrolment.value.secret, stepFor()),
      { keepSessionId: acct.sessionId },
    );
    expect(confirmed.ok).toBe(true);

    // THE DEVICE THAT ENROLLED still works — otherwise the person is at a
    // login screen holding a factor they were never offered a challenge for.
    const kept = await resolveSession(acct.sessionToken);
    expect(kept.ok, 'the enrolling session survives').toBe(true);

    // EVERY OTHER DEVICE does not: the guarantee is unchanged.
    const dead = await resolveSession(other.value.sessionToken);
    expect(dead.ok).toBe(false);
    if (dead.ok) return;
    expect(dead.reason).toBe('STALE_VERSION');
  });

  it('still ends every session when no device is named', async () => {
    const acct = await account('mfa2');
    const enrolment = await beginMfaEnrolment(acct.userId);
    if (!enrolment.ok) return;
    // No `keepSessionId`: the stricter behaviour a ROLE change wants.
    const confirmed = await confirmMfaEnrolment(
      acct.userId,
      codeFor(enrolment.value.secret, stepFor()),
    );
    expect(confirmed.ok).toBe(true);

    const gone = await resolveSession(acct.sessionToken);
    expect(gone.ok).toBe(false);
  });

  it('cannot be used to rescue a session belonging to somebody else', async () => {
    const mine = await account('own');
    const theirs = await account('other');

    const enrolment = await beginMfaEnrolment(mine.userId);
    if (!enrolment.ok) return;
    // A session id from another account is named. It must not be carried
    // across MY bump, and it must not be touched at all.
    await confirmMfaEnrolment(mine.userId, codeFor(enrolment.value.secret, stepFor()), {
      keepSessionId: theirs.sessionId,
    });

    const { rows } = await getPool().query(
      `SELECT s.version, u.session_version
         FROM sandbox.session s JOIN sandbox.app_user u ON u.user_id = s.user_id
        WHERE s.session_id = $1`,
      [theirs.sessionId],
    );
    expect(Number(rows[0]!.version)).toBe(Number(rows[0]!.session_version));
    // Their session is untouched and still resolves.
    expect((await resolveSession(theirs.sessionToken)).ok).toBe(true);
    // And mine — which was NOT named — died with the bump.
    expect((await resolveSession(mine.sessionToken)).ok).toBe(false);
  });
});
