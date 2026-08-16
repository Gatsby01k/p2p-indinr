import { describe, expect, it } from 'vitest';
import { getPool } from '@/server/db/pool';
import { signInSandbox } from '@/server/sandbox/service';
import { submitVerification, decideVerification } from '@/server/identity/verification';
import { grantRole, permissionsFor } from '@/server/identity/rbac';

/**
 * Seed verified identities for the real browser E2E run.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THROUGH THE ACCEPTED BOUNDARY, NEVER AROUND IT.                   │
 * │                                                                    │
 * │  The first DEL-10 browser attempt stopped at "Your sandbox account │
 * │  is not verified" — the risk gate working exactly as designed.     │
 * │  Getting past it with `UPDATE app_user SET is_verified = TRUE`     │
 * │  would have tested a database I had edited rather than the         │
 * │  product, and would have skipped the very control the journey is   │
 * │  meant to exercise.                                                │
 * │                                                                    │
 * │  So each account is verified the way a real one is: a case is      │
 * │  SUBMITTED, and a reviewer holding `verification.review` APPROVES  │
 * │  it with a written reason. The flag is set by that decision.       │
 * │                                                                    │
 * │  Written as a test file so it runs under the integration config —  │
 * │  same aliases, same `server-only` stub — and so the seeding is     │
 * │  itself asserted rather than assumed to have worked.               │
 * └────────────────────────────────────────────────────────────────────┘
 */

/**
 * A run id keeps every browser run independent.
 *
 * Sign-in is rate limited PER ADDRESS, and correctly so — which means a
 * harness that reuses fixed mailboxes exhausts their budget after a few
 * runs and then reports false authentication failures. Seeding a fresh
 * set per run makes the suite repeatable in CI; leaving `E2E_RUN_ID`
 * unset keeps the stable addresses for local exploration.
 */
const RUN = process.env.E2E_RUN_ID ? `.${process.env.E2E_RUN_ID}` : '';

const ACCOUNTS = [
  { email: `payer${RUN}.e2e@example.in`, label: 'INR payer' },
  { email: `payee${RUN}.e2e@example.in`, label: 'INR payee' },
  { email: `buyer${RUN}.e2e@example.in`, label: 'USDT buyer' },
  { email: `seller${RUN}.e2e@example.in`, label: 'USDT seller' },
  // Two operators, so maker-checker is exercised by two real people.
  { email: `maker${RUN}.e2e@example.in`, label: 'operator maker', operator: true },
  { email: `checker${RUN}.e2e@example.in`, label: 'operator checker', reviewer: true },
] as const;

describe('E2E identities are verified through the review boundary', () => {
  it('verifies every journey account', async () => {
    const reviewerUser = await signInSandbox(`reviewer${RUN}.e2e@example.in`);
    await grantRole({
      userId: reviewerUser.userId,
      role: 'REVIEWER',
      grantedBy: null,
      via: 'CLI',
      reason: 'E2E fixture reviewer, granted out of band for the sandbox run.',
    });
    const reviewer = {
      userId: reviewerUser.userId,
      roles: ['REVIEWER'] as const,
      permissions: permissionsFor(['REVIEWER']),
      mfaSatisfied: true,
      mfaEnrolled: true,
    };

    for (const account of ACCOUNTS) {
      const user = await signInSandbox(account.email);

      for (const kind of ['IDENTITY', 'UPI'] as const) {
        const submitted = await submitVerification({
          userId: user.userId,
          kind,
          provider: 'sandbox-manual',
          providerDecision: 'PASS',
          evidenceRef: null,
        });
        expect(submitted.ok, `${account.email} ${kind} submit`).toBe(true);
        if (!submitted.ok) continue;
        if (submitted.value.state === 'APPROVED') continue;

        const decided = await decideVerification({
          reviewer,
          caseId: submitted.value.caseId,
          decision: 'APPROVED',
          note: 'Sandbox E2E fixture: identity accepted for the scripted journey.',
        });
        expect(decided.ok, `${account.email} ${kind} decide`).toBe(true);
      }

      /*
       * Operator authority is granted OUT OF BAND, exactly as the
       * product requires — never self-assigned, and never by the
       * browser. The second factor is then enrolled and answered
       * through the real UI by the browser harness.
       */
      if ('operator' in account && account.operator) {
        await grantRole({
          userId: user.userId,
          role: 'OPERATOR',
          grantedBy: null,
          via: 'CLI',
          reason: 'E2E fixture operator, granted out of band for the browser run.',
        });
      }
      if ('reviewer' in account && account.reviewer) {
        await grantRole({
          userId: user.userId,
          role: 'REVIEWER',
          grantedBy: null,
          via: 'CLI',
          reason: 'E2E fixture reviewer, granted out of band for the browser run.',
        });
      }

      const { rows } = await getPool().query(
        `SELECT is_verified FROM sandbox.app_user WHERE user_id = $1`,
        [user.userId],
      );
      // The decision set this, not the fixture.
      expect(rows[0]!.is_verified, `${account.email} is verified`).toBe(true);
      console.log(`  ${account.email.padEnd(26)} ${account.label.padEnd(12)} verified`);
    }
  });
});
