import { describe, expect, it } from 'vitest';
import { getPool } from '@/server/db/pool';
import { newCommandId } from '@/server/boundary/command';
import { fundSandboxCommand, lockValueCommand } from '@/services/commands';
import { grantRole, permissionsFor, type Principal } from '@/server/identity/rbac';
import { getUser } from '@/server/sandbox/service';
import { clearDeliveries, lastDeliveredTo } from '@/server/adapters/emailDelivery';
import {
  beginMfaEnrolment,
  confirmMfaEnrolment,
  redeemEmailSignIn,
  startEmailSignIn,
  verifyMfaForSession,
} from '@/server/identity/auth';
import { codeFor, stepFor } from '@/server/identity/totp';

/**
 * Staging rehearsal, the step before the backup drill.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A RESTORE VERIFIED ON AN EMPTY LEDGER VERIFIES NOTHING.           │
 * │                                                                    │
 * │  `recovery-drill` checks that the restored copy's ledger sums to   │
 * │  zero PER ASSET and that every journal entry still has both its    │
 * │  legs — and it refuses to call a run meaningful when the source    │
 * │  had no entries at all, which is exactly right. The browser        │
 * │  journeys create deals and messages but never move protected       │
 * │  value: locking value needs an administrator to fund the sandbox   │
 * │  ledger first, and no customer can do that.                        │
 * │                                                                    │
 * │  So the rehearsal does what a staging rehearsal would: an ADMIN,   │
 * │  granted out of band and holding a satisfied second factor, funds  │
 * │  the sandbox ledger, and a real participant locks value against    │
 * │  their own deal. The drill then has a ledger with something in it. │
 * └────────────────────────────────────────────────────────────────────┘
 */

const unique = () => Math.random().toString(36).slice(2, 10);

async function admin(): Promise<Principal> {
  clearDeliveries();
  const email = `reh-admin-${unique()}@example.com`;
  await startEmailSignIn(email);
  const signedIn = await redeemEmailSignIn({ email, secret: lastDeliveredTo(email)!.secret });
  if (!signedIn.ok) throw new Error('rehearsal fixture: admin sign-in');

  await grantRole({
    userId: signedIn.value.userId,
    role: 'ADMIN',
    grantedBy: null,
    via: 'CLI',
    reason: 'Staging rehearsal: funds the sandbox ledger so the drill has data.',
  });

  const enrolment = await beginMfaEnrolment(signedIn.value.userId);
  if (!enrolment.ok) throw new Error('rehearsal fixture: admin enrolment');
  await confirmMfaEnrolment(signedIn.value.userId, codeFor(enrolment.value.secret, stepFor()), {
    keepSessionId: signedIn.value.sessionId,
  });
  await verifyMfaForSession({
    userId: signedIn.value.userId,
    sessionId: signedIn.value.sessionId,
    presented: codeFor(enrolment.value.secret, stepFor() + 1),
  });

  return {
    userId: signedIn.value.userId,
    roles: ['ADMIN'],
    permissions: permissionsFor(['ADMIN']),
    mfaSatisfied: true,
    mfaEnrolled: true,
  };
}

describe('rehearsal · protected value moves before the backup drill', () => {
  it('an administrator funds the ledger and a participant locks value', async () => {
    /*
     * A REAL deal from this rehearsal, still awaiting payment, with its
     * real paying participant — not a fixture invented here. Locking
     * value against a deal nobody is seated in would be a different
     * shape from the one that gets backed up.
     */
    const { rows } = await getPool().query(
      `SELECT d.deal_id, p.user_id
         FROM sandbox.deal d
         JOIN sandbox.participant p ON p.deal_id = d.deal_id AND p.role = 'FIAT_SIDE'
        WHERE d.state = 'FIAT_PENDING' AND d.value_locked_at IS NULL
        ORDER BY d.created_at DESC
        LIMIT 1`,
    );
    expect(rows[0], 'the rehearsal should have left an open deal behind').toBeDefined();
    const { deal_id: dealId, user_id: payerId } = rows[0]!;

    const ledgerAdmin = await admin();
    const funded = await fundSandboxCommand(ledgerAdmin, newCommandId(), {
      userId: payerId as string,
      asset: 'USDT',
      amountMinor: 40_000n,
    });
    expect(funded.ok, `funding: ${funded.ok ? '' : funded.code}`).toBe(true);

    /*
     * The lock is performed BY THE PARTICIPANT, as the product requires
     * — `lockValueCommand` takes the session user whose seat authorises
     * it, not a principal manufactured here.
     */
    const payer = await getUser(payerId as string);
    expect(payer, 'the deal has a real paying participant').not.toBeNull();
    const locked = await lockValueCommand(payer!, newCommandId(), {
      dealId: dealId as string,
      asset: 'USDT',
      amountMinor: 40_000n,
    });
    expect(locked.ok, `locking: ${locked.ok ? '' : locked.code}`).toBe(true);

    /* ---- What the drill will later verify has to exist ---- */
    const { rows: ledger } = await getPool().query(
      `SELECT (SELECT count(*)::int FROM inrp2p.journal_entry) AS entries,
              (SELECT count(*)::int FROM inrp2p.posting)       AS postings`,
    );
    expect(Number(ledger[0]!.entries), 'the ledger has entries to restore').toBeGreaterThan(0);
    expect(Number(ledger[0]!.postings)).toBeGreaterThan(0);

    // And it balances here, before anybody backs it up.
    const { rows: sums } = await getPool().query(
      `SELECT asset, sum(amount_minor)::text AS total FROM inrp2p.posting GROUP BY asset`,
    );
    for (const row of sums) {
      expect(BigInt(row.total as string), `${row.asset} must sum to zero`).toBe(0n);
    }
  });
});
