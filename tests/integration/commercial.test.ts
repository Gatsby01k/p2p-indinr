import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getPool, withTransaction } from '@/server/db/pool';
import { newCommandId, readCommand } from '@/server/boundary/command';
import { activePolicyFor } from '@/server/commerce/feePolicy';
import {
  entitlementsFor,
  livePremium,
  normalizeReferralCode,
  referralCodeFor,
  qualifyReferral,
  selectionWins,
  verifyCommitment,
} from '@/server/commerce/entitlements';
import { priceQuote, snapshotForDeal, snapshotForQuote } from '@/server/commerce/pricing';
import { recordSignal, reproduceScore, standingFor } from '@/server/commerce/reputation';
import {
  approveFeePolicyCommand,
  claimReferralCommand,
  createDealCommand,
  draftFeePolicyCommand,
  grantPremiumCommand,
  previewQuoteCommand,
  proposeFeePolicyCommand,
  refundValueCommand,
  releaseValueCommand,
  revokePremiumCommand,
} from '@/services/commands';
import type { SessionUser } from '@/server/sandbox/service';
import type { Principal } from '@/server/identity/rbac';
import { lockedDeal, unique } from './support/rails';
import { bare, newUser, operatorPrincipal, withoutMfa } from './support/room';
import { activePolicy, expectedBaseFee, withTemporaryPolicy } from './support/feePolicy';

/**
 * DEL-07 fees, premium, referrals, rewards and reputation.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE CLAIM UNDER TEST: WHAT THE CUSTOMER WAS SHOWN IS WHAT THE     │
 * │  CUSTOMER IS CHARGED, AND NOBODY — CLIENT OR OPERATOR — CAN QUIETLY│
 * │  CHANGE IT AFTERWARDS.                                             │
 * │                                                                    │
 * │  So the tests are about immutability and refusal: a snapshot that  │
 * │  survives a policy change, a forged bearer that does nothing, a    │
 * │  fee collected exactly once, a refund that collects nothing, a     │
 * │  reward that cannot be spent twice, a referral that cannot be      │
 * │  self-dealt, and a reputation that cannot open a single door.      │
 * └────────────────────────────────────────────────────────────────────┘
 */

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
afterEach(restore);

let alice: SessionUser;
let bob: SessionUser;
let maker: Principal;
let checker: Principal;
let admin: Principal;

beforeAll(async () => {
  alice = await newUser('com-alice');
  bob = await newUser('com-bob');
  maker = await operatorPrincipal('OPERATOR', 'com-maker');
  checker = await operatorPrincipal('REVIEWER', 'com-checker');
  admin = await operatorPrincipal('ADMIN', 'com-admin');
});

async function dealWithQuote(user: SessionUser = alice) {
  const created = await createDealCommand(user, {
    commandId: newCommandId(),
    scenario: 'INR_TO_INR',
    inrAmount: '25000',
    intent: 'PAY',
  });
  if (!created.ok) throw new Error(`quote fixture: ${created.code}`);
  return created.value;
}

/* ================================================================== *
 * Versioned policy
 * ================================================================== */

describe('fees come from an active versioned schedule', () => {
  it('prices a quote and freezes the complete calculation', async () => {
    const created = await dealWithQuote();
    const snapshot = await snapshotForQuote(created.quoteId);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;

    /*
     * Asserted against the schedule that is actually LIVE, not against
     * version 1. The property under test is that a quote is priced by
     * the active schedule and frozen with the complete calculation —
     * which version happens to be active is the fixture's business, and
     * hard-coding it made this test fail on every run after the first.
     */
    const live = await activePolicy('INR_TO_INR');
    const base = expectedBaseFee(live, 2_500_000n);

    expect(snapshot.policyKey).toBe(live.policyKey);
    expect(snapshot.policyVersion).toBe(live.version);
    expect(snapshot.baseFeeMinor).toBe(base.toString());
    expect(snapshot.finalFeeMinor).toBe(base.toString());
    // The payer sends the amount plus the fee; the payee is kept whole.
    expect(snapshot.payerSendsMinor).toBe((2_500_000n + base).toString());
    expect(snapshot.payeeReceivesMinor).toBe('2500000');
  });

  it('the PREVIEW equals the accepted quote', async () => {
    const amountMinor = 2_500_000n;
    const preview = await previewQuoteCommand(alice, {
      scenario: 'INR_TO_INR',
      amountMinor,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const created = await dealWithQuote();
    const snapshot = await snapshotForQuote(created.quoteId);
    // Same code path, same policy, same entitlements → same numbers.
    expect(preview.value.feeMinor).toBe(snapshot!.finalFeeMinor);
    expect(preview.value.payerSendsMinor).toBe(snapshot!.payerSendsMinor);
    expect(preview.value.payeeReceivesMinor).toBe(snapshot!.payeeReceivesMinor);
  });

  it('a client CANNOT choose the fee bearer', async () => {
    const { issueProtectedQuote } = await import('@/server/sandbox/service');
    // The option still exists so old callers compile; it does nothing.
    const forged = await issueProtectedQuote(alice, 2_500_000n, { feeBearer: 'PAYEE' });
    const snapshot = await snapshotForQuote(forged.quoteId);
    expect(snapshot!.feeBearer, 'the POLICY decides who bears the fee').toBe('PAYER');
    expect(snapshot!.payeeReceivesMinor).toBe('2500000');
  });

  it('production FAILS CLOSED with no production-enabled schedule', async () => {
    enterProduction();
    const outcome = await withTransaction((tx) => activePolicyFor(tx, 'USDT_TO_INR'));
    restore();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('FEE_POLICY_UNAVAILABLE');
  });

  it('a policy is IMMUTABLE in its terms', async () => {
    const { rows } = await getPool().query(
      `SELECT policy_id FROM sandbox.fee_policy WHERE policy_key='protected-inr'`,
    );
    await expect(
      withTransaction((tx) =>
        tx.query(`UPDATE sandbox.fee_policy SET bps = 999 WHERE policy_id = $1`, [
          rows[0]!.policy_id,
        ]),
      ),
    ).rejects.toThrow(/immutable; publish a new version/);

    await expect(
      withTransaction((tx) =>
        tx.query(`DELETE FROM sandbox.fee_policy WHERE policy_id = $1`, [rows[0]!.policy_id]),
      ),
    ).rejects.toThrow(/permanent/);
  });

  it('an INR fee schedule cannot be marked production-collectible', async () => {
    const outcome = await draftFeePolicyCommand(maker, newCommandId(), {
      policyKey: `inr-collectible-${unique()}`,
      scenario: 'INR_TO_INR',
      feeAsset: 'INR',
      feeBearer: 'PAYER',
      bps: 150n,
      fixedMinor: 0n,
      minFeeMinor: 0n,
      maxFeeMinor: 100_000n,
      discountCapBps: 0n,
      productionEnabled: true,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('FEE_ASSET_UNSUPPORTED');
  });
});

/* ================================================================== *
 * Activation under maker-checker
 * ================================================================== */

describe('activating a schedule takes two people', () => {
  async function drafted(bps = 200n) {
    const key = `test-schedule-${unique()}`;
    const draft = await draftFeePolicyCommand(maker, newCommandId(), {
      policyKey: key,
      scenario: 'INR_TO_USDT',
      feeAsset: 'USDT',
      feeBearer: 'PAYER',
      bps,
      fixedMinor: 0n,
      minFeeMinor: 0n,
      maxFeeMinor: 1_000_000n,
      discountCapBps: 5_000n,
    });
    if (!draft.ok) throw new Error(`draft fixture: ${draft.code}`);
    return { key, policyId: draft.value.policyId };
  }

  it('a customer cannot draft, propose or approve', async () => {
    const customer = bare(alice);
    const draft = await draftFeePolicyCommand(customer, newCommandId(), {
      policyKey: `hostile-${unique()}`,
      scenario: 'INR_TO_INR',
      feeAsset: 'USDT',
      feeBearer: 'PAYER',
      bps: 0n,
      fixedMinor: 0n,
      minFeeMinor: 0n,
      maxFeeMinor: 1n,
      discountCapBps: 0n,
    });
    expect(draft.ok).toBe(false);
    if (!draft.ok) expect(draft.code).toBe('PERMISSION_DENIED');
  });

  it('an unproved second factor cannot propose', async () => {
    const { policyId } = await drafted();
    const outcome = await proposeFeePolicyCommand(withoutMfa(maker), newCommandId(), {
      policyId,
      rationale: 'Attempting an activation without answering the second factor.',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('MFA_REQUIRED');
  });

  it('SELF-APPROVAL is impossible even holding both permissions', async () => {
    const dual = await operatorPrincipal('OPERATOR', `com-dual-${unique()}`);
    const { grantRole, permissionsFor } = await import('@/server/identity/rbac');
    await grantRole({
      userId: dual.userId,
      role: 'REVIEWER',
      grantedBy: null,
      via: 'CLI',
      reason: 'Deliberately over-privileged, to prove maker-checker holds anyway.',
    });
    const both = {
      ...dual,
      roles: ['OPERATOR', 'REVIEWER'] as const,
      permissions: permissionsFor(['OPERATOR', 'REVIEWER']),
    };

    const { policyId } = await drafted();
    const proposed = await proposeFeePolicyCommand(both, newCommandId(), {
      policyId,
      rationale: 'I hold both permissions and I will try to activate this alone.',
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    const approved = await approveFeePolicyCommand(both, newCommandId(), {
      activationId: proposed.value.activationId,
    });
    expect(approved.ok).toBe(false);
    if (approved.ok) return;
    expect(approved.code).toBe('SELF_APPROVAL_FORBIDDEN');

    // And the database would have refused it too.
    await expect(
      withTransaction((tx) =>
        tx.query(
          `UPDATE sandbox.fee_policy_activation
              SET state='APPROVED', approved_by=proposed_by, decided_at=now()
            WHERE activation_id=$1`,
          [proposed.value.activationId],
        ),
      ),
    ).rejects.toThrow(/no_self_approval|check constraint/i);
  });

  it('a different reviewer activates it, retiring the previous version', async () => {
    const { key, policyId } = await drafted(300n);
    const proposed = await proposeFeePolicyCommand(maker, newCommandId(), {
      policyId,
      rationale: 'Raising the exchange fee after the pricing review in August.',
    });
    if (!proposed.ok) return;

    const approved = await approveFeePolicyCommand(checker, newCommandId(), {
      activationId: proposed.value.activationId,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.value.policyKey).toBe(key);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.fee_policy
        WHERE scenario='INR_TO_USDT' AND state='ACTIVE'`,
    );
    // Never two live schedules for one CORRIDOR: otherwise the price a
    // customer sees depends on which row a query ordered first.
    expect(rows[0]!.n).toBe(1);
  });

  it('an ACCEPTED quote is untouched by a later activation', async () => {
    const created = await dealWithQuote();
    const before = await snapshotForQuote(created.quoteId);

    /**
     * Publish, activate, then ROLL BACK the protected-INR schedule.
     *
     * The rollback is not tidiness — an activation changes the live
     * price for the whole deployment, so a test that left a punitive
     * schedule behind would be silently re-pricing every case that runs
     * after it. Restoring the original terms is what a real operator
     * would do, and it keeps this test's blast radius to this test.
     */
    const activate = async (terms: {
      bps: bigint;
      fixedMinor: bigint;
      minFeeMinor: bigint;
      maxFeeMinor: bigint;
      rationale: string;
    }) => {
      const draft = await draftFeePolicyCommand(maker, newCommandId(), {
        policyKey: 'protected-inr',
        scenario: 'INR_TO_INR',
        feeAsset: 'INR',
        feeBearer: 'PAYER',
        bps: terms.bps,
        fixedMinor: terms.fixedMinor,
        minFeeMinor: terms.minFeeMinor,
        maxFeeMinor: terms.maxFeeMinor,
        discountCapBps: 5_000n,
      });
      if (!draft.ok) throw new Error(`draft: ${draft.code}`);
      const proposed = await proposeFeePolicyCommand(maker, newCommandId(), {
        policyId: draft.value.policyId,
        rationale: terms.rationale,
      });
      if (!proposed.ok) throw new Error(`propose: ${proposed.code}`);
      const approved = await approveFeePolicyCommand(checker, newCommandId(), {
        activationId: proposed.value.activationId,
      });
      if (!approved.ok) throw new Error(`approve: ${approved.code}`);
      return approved.value;
    };

    /*
     * The rollback now runs in a `finally`.
     *
     * It used to be the line after these assertions, so a failure
     * anywhere above left the PUNITIVE schedule live for every test and
     * every later run — which is how the fixture drifted to 900bps and
     * stayed there. Restoration must survive the failure it is there to
     * clean up after.
     *
     * Versions are asserted RELATIVE to whatever was live, because this
     * table only grows and absolute numbers are true exactly once.
     */
    const before_policy = await activePolicy('INR_TO_INR');

    await withTemporaryPolicy(
      'INR_TO_INR',
      activate,
      {
        bps: 900n,
        fixedMinor: 50_000n,
        minFeeMinor: 10_000n,
        maxFeeMinor: 900_000n,
        rationale: 'A deliberately punitive schedule, to prove old quotes are safe.',
      },
      async (punitive, baseline) => {
        expect(punitive.version).toBe(baseline.version + 1);

        const after = await snapshotForQuote(created.quoteId);
        expect(after, 'a frozen promise does not move').toEqual(before);

        // A NEW quote gets the NEW schedule, as it should.
        const fresh = await dealWithQuote();
        const freshSnapshot = await snapshotForQuote(fresh.quoteId);
        expect(freshSnapshot!.policyVersion).toBe(punitive.version);
        // 9% of 2,500,000 = 225,000 plus the 50,000 fixed component.
        expect(freshSnapshot!.baseFeeMinor).toBe('275000');

        return { fresh, freshSnapshot };
      },
    ).then(async ({ fresh, freshSnapshot }) => {
      // Checked AFTER restoration: a frozen promise is frozen in both
      // directions, so the punitive quote keeps its terms even once the
      // original schedule is live again.
      expect(await snapshotForQuote(fresh.quoteId)).toEqual(freshSnapshot);
    });

    /*
     * The corridor is priced by whatever was live BEFORE this test,
     * compared against the captured baseline rather than the seeded
     * numbers — another suite may legitimately own this corridor by the
     * time this runs, and the guarantee is "unchanged", not "150bps".
     */
    const restored = await activePolicy('INR_TO_INR');
    expect(restored.bps).toBe(before_policy.bps);
    expect(restored.fixedMinor).toBe(before_policy.fixedMinor);
  });

  it('a snapshot cannot be edited or deleted', async () => {
    const created = await dealWithQuote();
    await expect(
      withTransaction((tx) =>
        tx.query(`UPDATE sandbox.quote_fee_snapshot SET final_fee_minor = 1 WHERE quote_id = $1`, [
          created.quoteId,
        ]),
      ),
    ).rejects.toThrow(/the promise made to a customer/);
  });
});

/* ================================================================== *
 * Collection
 * ================================================================== */

describe('a fee is collected once, at success, from real value', () => {
  it('collects on RELEASE and credits platform revenue', async () => {
    const dealId = await lockedDeal(alice, bob, 100_000n);
    // The lock is USDT; the snapshot for an INR_TO_INR deal is INR-
    // denominated, so this exercises the honest-refusal branch below.
    const released = await releaseValueCommand(alice, newCommandId(), {
      dealId,
      beneficiaryId: bob.userId,
    });
    expect(released.ok).toBe(true);

    const { rows } = await getPool().query(
      `SELECT collected, uncollectible_reason, amount_minor::text AS amount
         FROM sandbox.fee_collection WHERE deal_id = $1`,
      [dealId],
    );
    expect(rows).toHaveLength(1);
    /*
     * THE HONEST REFUSAL. The fee is quoted in INR and INRP2P holds no
     * rupees, so there is nothing to take it from. Recorded as an
     * uncollectible shortfall — never as a receivable, which would
     * assert somebody owes money they never agreed to owe.
     */
    expect(rows[0]!.collected).toBe(false);
    expect(rows[0]!.uncollectible_reason).toContain('no custodial INR balance');
  });

  it('a REFUND collects no success fee at all', async () => {
    const dealId = await lockedDeal(alice, bob, 100_000n);
    const refunded = await refundValueCommand(alice, newCommandId(), {
      dealId,
      beneficiaryId: alice.userId,
    });
    expect(refunded.ok).toBe(true);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.fee_collection WHERE deal_id = $1`,
      [dealId],
    );
    // Not a zero collection — NO collection. A refund is not an
    // economic success and charging for one is charging for nothing.
    expect(rows[0]!.n).toBe(0);
  });

  it('a replayed release collects exactly once', async () => {
    const dealId = await lockedDeal(alice, bob, 100_000n);
    const commandId = newCommandId();
    await releaseValueCommand(alice, commandId, { dealId, beneficiaryId: bob.userId });
    await releaseValueCommand(alice, commandId, { dealId, beneficiaryId: bob.userId });

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.fee_collection WHERE deal_id = $1`,
      [dealId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('CONCURRENT settlement collects exactly once', async () => {
    const dealId = await lockedDeal(alice, bob, 100_000n);
    await Promise.all([
      releaseValueCommand(alice, newCommandId(), { dealId, beneficiaryId: bob.userId }),
      releaseValueCommand(alice, newCommandId(), { dealId, beneficiaryId: bob.userId }),
    ]);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.fee_collection WHERE deal_id = $1`,
      [dealId],
    );
    expect(rows[0]!.n).toBe(1);

    const { rows: entries } = await getPool().query(
      `SELECT count(*)::int AS n FROM inrp2p.journal_entry
        WHERE journal_code='JD-FEE' AND entry_key_json->>'dealId' = $1`,
      [dealId],
    );
    expect(entries[0]!.n).toBeLessThanOrEqual(1);
  });

  it('the collected amount matches the SNAPSHOT exactly', async () => {
    const dealId = await lockedDeal(alice, bob, 100_000n);
    const snapshot = await withTransaction((tx) => snapshotForDeal(tx, dealId));
    await releaseValueCommand(alice, newCommandId(), { dealId, beneficiaryId: bob.userId });

    const { rows } = await getPool().query(
      `SELECT amount_minor::text AS amount FROM sandbox.fee_collection WHERE deal_id = $1`,
      [dealId],
    );
    // Never recomputed at settlement: recomputation is how a customer
    // ends up paying a rate activated after they agreed.
    expect(rows[0]!.amount).toBe(snapshot!.finalFeeMinor);
  });

  it('never creates an INR ledger account', async () => {
    const dealId = await lockedDeal(alice, bob, 100_000n);
    await releaseValueCommand(alice, newCommandId(), { dealId, beneficiaryId: bob.userId });
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM inrp2p.ledger_account WHERE asset::text = 'INR'`,
    );
    expect(rows[0]!.n).toBe(0);
  });
});

/* ================================================================== *
 * Premium
 * ================================================================== */

describe('premium is server-authoritative', () => {
  it('reduces the fee only through the active policy', async () => {
    const user = await newUser('com-premium');
    /*
     * This test OWNS the schedule it prices against.
     *
     * It used to pick USDT_TO_INR on the grounds that "this suite does
     * not republish it" — true, and irrelevant: `atomicJoin` publishes
     * a schedule for that corridor with `discountCapBps: 0`, so by the
     * time this ran the live policy forbade any discount at all and the
     * fee could not move. The comment described a coupling the test
     * could not actually control.
     *
     * Establishing a known schedule with a real discount cap makes the
     * measurement independent of what any other file did.
     */
    await withTemporaryPolicy(
      'USDT_TO_INR',
      async (terms) => {
        const draft = await draftFeePolicyCommand(maker, newCommandId(), {
          policyKey: `premium-probe-${unique()}`,
          scenario: 'USDT_TO_INR',
          feeAsset: 'INR',
          feeBearer: 'PAYER',
          bps: terms.bps,
          fixedMinor: terms.fixedMinor,
          minFeeMinor: terms.minFeeMinor,
          maxFeeMinor: terms.maxFeeMinor,
          discountCapBps: 5_000n,
        });
        if (!draft.ok) throw new Error(`draft: ${draft.code}`);
        const proposed = await proposeFeePolicyCommand(maker, newCommandId(), {
          policyId: draft.value.policyId,
          rationale: terms.rationale,
        });
        if (!proposed.ok) throw new Error(`propose: ${proposed.code}`);
        const approved = await approveFeePolicyCommand(checker, newCommandId(), {
          activationId: proposed.value.activationId,
        });
        if (!approved.ok) throw new Error(`approve: ${approved.code}`);
        return approved.value;
      },
      {
        bps: 125n,
        fixedMinor: 18_000n,
        minFeeMinor: 2_500n,
        maxFeeMinor: 250_000n,
        rationale: 'A schedule with a real discount cap, so premium can be measured.',
      },
      async () => {
        const before = await previewQuoteCommand(user, {
          scenario: 'USDT_TO_INR',
          amountMinor: 2_500_000n,
        });

        expect(
          (
            await grantPremiumCommand(admin, newCommandId(), {
              userId: user.userId,
              source: 'REWARD_CAMPAIGN',
              discountBps: 2_000n,
              days: 30,
            })
          ).ok,
        ).toBe(true);

        const after = await previewQuoteCommand(user, {
          scenario: 'USDT_TO_INR',
          amountMinor: 2_500_000n,
        });
        expect(before.ok && after.ok).toBe(true);
        if (!before.ok || !after.ok) return;
        expect(BigInt(after.value.feeMinor)).toBeLessThan(BigInt(before.value.feeMinor));
        // 20% off a base of (1.25% of 2,500,000 = 31,250) + 18,000 = 49,250.
        expect(after.value.discounts).toContainEqual({ source: 'PREMIUM', amountMinor: '9850' });
      },
    );
  });

  it('stops mattering the moment it EXPIRES', async () => {
    const user = await newUser('com-expiry');
    const granted = await grantPremiumCommand(admin, newCommandId(), {
      userId: user.userId,
      source: 'REWARD_CAMPAIGN',
      discountBps: 2_000n,
      days: 30,
    });
    if (!granted.ok) return;

    // Age it the way time would: both endpoints move.
    await getPool().query(
      `UPDATE sandbox.premium_grant
          SET starts_at = now() - interval '60 days', expires_at = now() - interval '1 day'
        WHERE grant_id = $1`,
      [granted.value.grantId],
    );

    const live = await withTransaction((tx) => livePremium(tx, user.userId));
    expect(live, 'an expired grant is invisible, not filtered').toBeNull();
  });

  it('stops mattering the moment it is REVOKED', async () => {
    const user = await newUser('com-revoke');
    const granted = await grantPremiumCommand(admin, newCommandId(), {
      userId: user.userId,
      source: 'REWARD_CAMPAIGN',
      discountBps: 2_000n,
      days: 30,
    });
    if (!granted.ok) return;

    expect(
      (
        await revokePremiumCommand(admin, newCommandId(), {
          grantId: granted.value.grantId,
          reason: 'Granted in error during a support conversation.',
        })
      ).ok,
    ).toBe(true);

    expect(await withTransaction((tx) => livePremium(tx, user.userId))).toBeNull();

    // The revocation is recorded as an adjustment, not just a flag.
    const { rows } = await getPool().query(
      `SELECT kind FROM sandbox.benefit_adjustment WHERE premium_grant_id = $1`,
      [granted.value.grantId],
    );
    expect(rows[0]!.kind).toBe('PREMIUM_REVOKED');
  });

  it('a SUBSCRIPTION grant is refused — nobody has paid', async () => {
    const user = await newUser('com-sub');
    const outcome = await grantPremiumCommand(admin, newCommandId(), {
      userId: user.userId,
      source: 'SUBSCRIPTION',
      discountBps: 2_000n,
      days: 30,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PREMIUM_UNAVAILABLE');
  });

  it('a SANDBOX_MANUAL grant is unavailable in production', async () => {
    const user = await newUser('com-prodpremium');
    enterProduction();
    const outcome = await grantPremiumCommand(admin, newCommandId(), {
      userId: user.userId,
      source: 'SANDBOX_MANUAL',
      discountBps: 2_000n,
      days: 30,
    });
    restore();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PREMIUM_UNAVAILABLE');
  });

  it('a customer cannot grant themselves premium', async () => {
    const outcome = await grantPremiumCommand(bare(alice), newCommandId(), {
      userId: alice.userId,
      source: 'REWARD_CAMPAIGN',
      discountBps: 10_000n,
      days: 3650,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PERMISSION_DENIED');
  });
});

/* ================================================================== *
 * Referrals
 * ================================================================== */

describe('referral attribution is decided once', () => {
  it('normalizes a code before comparing it', () => {
    // Case, surrounding space and grouping dashes all collapse to one
    // canonical form, so a code read aloud or pasted with formatting
    // finds the same referrer.
    expect(normalizeReferralCode(' ab23cd45ef ')).toBe('AB23CD45EF');
    expect(normalizeReferralCode('AB23CD45EF')).toBe('AB23CD45EF');
    expect(normalizeReferralCode('AB23-CD45-EF')).toBe('AB23CD45EF');
    // The ambiguous characters are excluded from the alphabet entirely,
    // so `0`/`O` and `1`/`I` cannot become a DIFFERENT valid code.
    expect(normalizeReferralCode('AB0OCD1IEF')).toBe(null);
    expect(normalizeReferralCode('SHORT')).toBe(null);
  });

  it('mints a stable unguessable code per person', async () => {
    const user = await newUser('com-code');
    const first = await withTransaction((tx) => referralCodeFor(tx, user.userId));
    const again = await withTransaction((tx) => referralCodeFor(tx, user.userId));
    expect(first).toBe(again);
    expect(first).toMatch(/^[2-9A-HJ-NP-Z]{10}$/);
  });

  it('REFUSES self-referral', async () => {
    const user = await newUser('com-selfref');
    const code = await withTransaction((tx) => referralCodeFor(tx, user.userId));
    const outcome = await claimReferralCommand(user, newCommandId(), { code });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('REFERRAL_SELF');
  });

  it('REFUSES a cycle', async () => {
    const a = await newUser('com-cyc-a');
    const b = await newUser('com-cyc-b');
    const c = await newUser('com-cyc-c');
    const codeA = await withTransaction((tx) => referralCodeFor(tx, a.userId));
    const codeB = await withTransaction((tx) => referralCodeFor(tx, b.userId));
    const codeC = await withTransaction((tx) => referralCodeFor(tx, c.userId));

    expect((await claimReferralCommand(b, newCommandId(), { code: codeA })).ok).toBe(true);
    expect((await claimReferralCommand(c, newCommandId(), { code: codeB })).ok).toBe(true);

    // a ← b ← c, so a claiming c's code would close the loop.
    const outcome = await claimReferralCommand(a, newCommandId(), { code: codeC });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('REFERRAL_CYCLE');
  });

  it('a referrer is recorded ONCE and never overwritten', async () => {
    const referee = await newUser('com-referee');
    const first = await newUser('com-ref1');
    const second = await newUser('com-ref2');
    const code1 = await withTransaction((tx) => referralCodeFor(tx, first.userId));
    const code2 = await withTransaction((tx) => referralCodeFor(tx, second.userId));

    expect((await claimReferralCommand(referee, newCommandId(), { code: code1 })).ok).toBe(true);
    const overwrite = await claimReferralCommand(referee, newCommandId(), { code: code2 });
    expect(overwrite.ok).toBe(false);
    if (overwrite.ok) return;
    expect(overwrite.code).toBe('REFERRAL_ALREADY_ATTRIBUTED');

    const { rows } = await getPool().query(
      `SELECT referrer_id FROM sandbox.referral_attribution WHERE referee_id = $1`,
      [referee.userId],
    );
    expect(rows[0]!.referrer_id).toBe(first.userId);
  });

  it('CONCURRENT attribution produces exactly one referrer', async () => {
    const referee = await newUser('com-race-referee');
    const a = await newUser('com-race-a');
    const b = await newUser('com-race-b');
    const codeA = await withTransaction((tx) => referralCodeFor(tx, a.userId));
    const codeB = await withTransaction((tx) => referralCodeFor(tx, b.userId));

    const [x, y] = await Promise.all([
      claimReferralCommand(referee, newCommandId(), { code: codeA }),
      claimReferralCommand(referee, newCommandId(), { code: codeB }),
    ]);
    expect([x, y].filter((r) => r.ok)).toHaveLength(1);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.referral_attribution WHERE referee_id = $1`,
      [referee.userId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('refuses an unknown code', async () => {
    const user = await newUser('com-badcode');
    const outcome = await claimReferralCommand(user, newCommandId(), { code: 'ZZZZZZZZZZ' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('REFERRAL_CODE_INVALID');
  });

  it('SELF-DEALING does not qualify', async () => {
    const referrer = await newUser('com-selfdeal-r');
    const referee = await newUser('com-selfdeal-e');
    const code = await withTransaction((tx) => referralCodeFor(tx, referrer.userId));
    expect((await claimReferralCommand(referee, newCommandId(), { code })).ok).toBe(true);

    // A deal between the referrer and their own referee is one person
    // with two accounts, not two people finding the platform.
    const dealId = await lockedDeal(referee, referrer, 50_000n);
    await releaseValueCommand(referee, newCommandId(), {
      dealId,
      beneficiaryId: referrer.userId,
    });
    await getPool().query(
      `UPDATE sandbox.deal SET state='COMPLETED', completed_at=now()
                            WHERE deal_id=$1`,
      [dealId],
    );

    const outcome = await withTransaction((tx) => qualifyReferral(tx, { dealId }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('REFERRAL_NOT_ELIGIBLE');
    expect(outcome.detail).toMatchObject({ reason: 'SELF_DEALING' });
  });

  it('a REFUNDED deal does not qualify', async () => {
    const referee = await newUser('com-refund-e');
    const referrer = await newUser('com-refund-r');
    const code = await withTransaction((tx) => referralCodeFor(tx, referrer.userId));
    await claimReferralCommand(referee, newCommandId(), { code });

    const dealId = await lockedDeal(referee, bob, 50_000n);
    await refundValueCommand(referee, newCommandId(), {
      dealId,
      beneficiaryId: referee.userId,
    });
    const outcome = await withTransaction((tx) => qualifyReferral(tx, { dealId }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('REFERRAL_NOT_ELIGIBLE');
  });
});

/* ================================================================== *
 * Rewards
 * ================================================================== */

describe('reward selection is committed in advance and verifiable', () => {
  it('verifies a revealed seed against its commitment', async () => {
    const { createHash } = await import('node:crypto');
    const seed = `seed-${unique()}`;
    const commitment = createHash('sha256').update(seed).digest('hex');

    expect(verifyCommitment(commitment, seed)).toBe(true);
    // A seed chosen AFTER seeing who entered will not match.
    expect(verifyCommitment(commitment, `${seed}-tampered`)).toBe(false);
    expect(verifyCommitment('not-a-hash', seed)).toBe(false);
  });

  it('selects deterministically from the seed, never from the client', async () => {
    const seed = 'a-published-seed';
    const subject = 'user-123';
    // Same inputs, same answer, every time — so anybody holding the seed
    // can recompute every outcome and check the operator did not choose.
    const runs = Array.from({ length: 10 }, () => selectionWins(seed, subject, 5_000n));
    expect(new Set(runs).size).toBe(1);
    // A different threshold is a different, still-deterministic answer.
    expect(selectionWins(seed, subject, 0n)).toBe(false);
    expect(selectionWins(seed, subject, 10_000n)).toBe(true);
  });

  it('a reward is SINGLE USE across concurrent quotes', async () => {
    const user = await newUser('com-reward');
    const { rows: campaign } = await getPool().query(
      `INSERT INTO sandbox.reward_campaign
         (campaign_key, version, benefit_kind, discount_bps, max_benefit_minor,
          eligible_from, eligible_to)
       VALUES ($1, 1, 'FEE_DISCOUNT', 2000, 1000000, now() - interval '1 day',
               now() + interval '30 days')
       RETURNING campaign_id`,
      [`campaign-${unique()}`],
    );
    const { rows: grant } = await getPool().query(
      `INSERT INTO sandbox.reward_grant (campaign_id, user_id, expires_at)
       VALUES ($1,$2, now() + interval '30 days') RETURNING grant_id`,
      [campaign[0]!.campaign_id, user.userId],
    );
    const grantId = grant[0]!.grant_id as string;

    const price = () =>
      withTransaction(async (tx) => {
        const priced = await priceQuote(tx, {
          userId: user.userId,
          scenario: 'INR_TO_INR',
          amountMinor: 2_500_000n,
          rewardGrantId: grantId,
        });
        if (!priced.ok) return priced;
        const { rows } = await tx.query(
          `INSERT INTO sandbox.quote
             (issued_to, direction, usdt_minor, inr_minor, rate_num, rate_den,
              pricing_source, observed_at, expires_at)
           VALUES ($1,'INR_TO_INR',NULL,2500000,1,1,'test', now(), now() + interval '1 hour')
           RETURNING quote_id`,
          [user.userId],
        );
        const { snapshotQuote } = await import('@/server/commerce/pricing');
        return snapshotQuote(tx, {
          quoteId: rows[0]!.quote_id as string,
          amountMinor: 2_500_000n,
          priced: priced.value,
        });
      });

    const [a, b] = await Promise.all([price(), price()]);
    /*
     * BOTH quotes are issued — the loser is not blocked from trading, it
     * simply does not carry the discount. `FOR UPDATE` on the grant
     * serialises the two, and the second re-reads it as REDEEMED and
     * resolves no reward at all.
     */
    expect([a, b].filter((r) => r.ok)).toHaveLength(2);

    const { rows: after } = await getPool().query(
      `SELECT state FROM sandbox.reward_grant WHERE grant_id = $1`,
      [grantId],
    );
    expect(after[0]!.state).toBe('REDEEMED');

    // EXACTLY ONE snapshot spent it. A reward applies to one deal.
    const { rows: spent } = await getPool().query(
      `SELECT count(*)::int AS n, sum(reward_discount_minor)::text AS total
         FROM sandbox.quote_fee_snapshot WHERE reward_grant_id = $1`,
      [grantId],
    );
    expect(spent[0]!.n).toBe(1);
    expect(BigInt(spent[0]!.total as string)).toBeGreaterThan(0n);
  });

  it('an EXPIRED reward is worth nothing', async () => {
    const user = await newUser('com-expired-reward');
    const { rows: campaign } = await getPool().query(
      `INSERT INTO sandbox.reward_campaign
         (campaign_key, version, benefit_kind, discount_bps, max_benefit_minor,
          eligible_from, eligible_to)
       VALUES ($1, 1, 'FEE_DISCOUNT', 5000, 1000000, now() - interval '60 days',
               now() + interval '30 days')
       RETURNING campaign_id`,
      [`expired-${unique()}`],
    );
    const { rows: grant } = await getPool().query(
      `INSERT INTO sandbox.reward_grant (campaign_id, user_id, expires_at)
       VALUES ($1,$2, now() - interval '1 day') RETURNING grant_id`,
      [campaign[0]!.campaign_id, user.userId],
    );

    const resolved = await withTransaction((tx) =>
      entitlementsFor(tx, { userId: user.userId, rewardGrantId: grant[0]!.grant_id as string }),
    );
    expect(resolved.entitlements.rewardBps).toBe(0n);
    expect(resolved.rewardGrantId).toBeNull();
  });

  it('a reward belonging to SOMEBODY ELSE is worth nothing', async () => {
    const owner = await newUser('com-owner');
    const thief = await newUser('com-thief');
    const { rows: campaign } = await getPool().query(
      `INSERT INTO sandbox.reward_campaign
         (campaign_key, version, benefit_kind, discount_bps, max_benefit_minor,
          eligible_from, eligible_to)
       VALUES ($1, 1, 'FEE_DISCOUNT', 5000, 1000000, now(), now() + interval '30 days')
       RETURNING campaign_id`,
      [`theft-${unique()}`],
    );
    const { rows: grant } = await getPool().query(
      `INSERT INTO sandbox.reward_grant (campaign_id, user_id, expires_at)
       VALUES ($1,$2, now() + interval '30 days') RETURNING grant_id`,
      [campaign[0]!.campaign_id, owner.userId],
    );

    const resolved = await withTransaction((tx) =>
      entitlementsFor(tx, { userId: thief.userId, rewardGrantId: grant[0]!.grant_id as string }),
    );
    expect(resolved.entitlements.rewardBps).toBe(0n);
    expect(resolved.rewardGrantId).toBeNull();
  });
});

/* ================================================================== *
 * Reputation
 * ================================================================== */

describe('reputation is computed, never set', () => {
  it('deduplicates a replayed signal', async () => {
    const user = await newUser('com-rep');
    const key = `deal-completed:${unique()}`;
    const first = await withTransaction((tx) =>
      recordSignal(tx, { userId: user.userId, signal: 'DEAL_COMPLETED', dedupKey: key }),
    );
    const replay = await withTransaction((tx) =>
      recordSignal(tx, { userId: user.userId, signal: 'DEAL_COMPLETED', dedupKey: key }),
    );
    expect(first.ok && first.value.eventId).not.toBeNull();
    expect(replay.ok && replay.value.eventId, 'a redelivered signal is a no-op').toBeNull();

    expect((await standingFor(user.userId)).points).toBe(10);
  });

  it('is REPRODUCIBLE from its source events', async () => {
    const user = await newUser('com-repro');
    for (const signal of ['DEAL_COMPLETED', 'PAID_ON_TIME', 'ACCOUNT_VERIFIED'] as const) {
      await withTransaction((tx) =>
        recordSignal(tx, { userId: user.userId, signal, dedupKey: `${signal}:${unique()}` }),
      );
    }
    const standing = await standingFor(user.userId);
    const reproduced = await reproduceScore(user.userId);
    // The view and a replay of the log must agree, always.
    expect(reproduced).toBe(standing.points);
    expect(standing.points).toBe(10 + 5 + 15);
  });

  it('corrects ADDITIVELY, never by deletion', async () => {
    const user = await newUser('com-correct');
    const key = `completed:${unique()}`;
    const recorded = await withTransaction((tx) =>
      recordSignal(tx, { userId: user.userId, signal: 'DEAL_COMPLETED', dedupKey: key }),
    );
    if (!recorded.ok || recorded.value.eventId === null) return;

    const { correctSignal } = await import('@/server/commerce/reputation');
    await withTransaction((tx) =>
      correctSignal(tx, {
        userId: user.userId,
        correctsEventId: recorded.value.eventId!,
        dedupKey: `correction:${key}`,
        reason: 'The deal was reversed by a chain reorganisation.',
      }),
    );

    expect((await standingFor(user.userId)).points).toBe(0);
    // BOTH events survive: what was believed, and when it stopped.
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.reputation_event WHERE user_id = $1`,
      [user.userId],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it('history cannot be edited or deleted', async () => {
    const user = await newUser('com-immutable-rep');
    await withTransaction((tx) =>
      recordSignal(tx, {
        userId: user.userId,
        signal: 'DEAL_COMPLETED',
        dedupKey: `immutable:${unique()}`,
      }),
    );
    await expect(
      withTransaction((tx) =>
        tx.query(`UPDATE sandbox.reputation_event SET points = 9999 WHERE user_id = $1`, [
          user.userId,
        ]),
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      withTransaction((tx) =>
        tx.query(`DELETE FROM sandbox.reputation_event WHERE user_id = $1`, [user.userId]),
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('exposes a BAND publicly, not the raw signal', async () => {
    const user = await newUser('com-band');
    await withTransaction((tx) =>
      recordSignal(tx, {
        userId: user.userId,
        signal: 'DISPUTE_LOST',
        dedupKey: `lost:${unique()}`,
      }),
    );
    const { publicReputation } = await import('@/server/commerce/reputation');
    const shown = await publicReputation(user.userId);
    expect(shown.band).toBe('AT_RISK');
    // The internal signal stays internal: no points, no adverse detail.
    expect(Object.keys(shown).sort()).toEqual(['band', 'completedDeals', 'memberSince']);
  });

  it('GRANTS NOTHING — it cannot open a single door', async () => {
    const user = await newUser('com-rep-power');
    for (let i = 0; i < 40; i += 1) {
      await withTransaction((tx) =>
        recordSignal(tx, {
          userId: user.userId,
          signal: 'DEAL_COMPLETED',
          dedupKey: `power:${user.userId}:${i}`,
        }),
      );
    }
    expect((await standingFor(user.userId)).band).toBe('TRUSTED');

    /*
     * A spotless reputation is still an ordinary customer. It confers no
     * permission, and it certainly does not let somebody rule on a
     * dispute or skip a value lock.
     */
    const { caseQueue } = await import('@/server/room/disputes');
    const queue = await caseQueue(bare(user));
    expect(queue.ok).toBe(false);
    if (queue.ok) return;
    expect(queue.code).toBe('PERMISSION_DENIED');

    const { dealRoom } = await import('@/server/room/dealRoom');
    const someoneElsesDeal = await lockedDeal(alice, bob, 10_000n);
    const room = await dealRoom(bare(user), someoneElsesDeal);
    expect(room.ok).toBe(false);
  });
});

/* ================================================================== *
 * Atomicity
 * ================================================================== */

describe('commercial writes commit with everything else', () => {
  it('a fee-policy activation writes command, policy, audit and outbox together', async () => {
    const draft = await draftFeePolicyCommand(maker, newCommandId(), {
      policyKey: `atomic-${unique()}`,
      scenario: 'USDT_TO_INR',
      feeAsset: 'USDT',
      feeBearer: 'PAYER',
      bps: 100n,
      fixedMinor: 0n,
      minFeeMinor: 0n,
      maxFeeMinor: 1_000_000n,
      discountCapBps: 0n,
    });
    if (!draft.ok) return;
    const proposed = await proposeFeePolicyCommand(maker, newCommandId(), {
      policyId: draft.value.policyId,
      rationale: 'Atomicity fixture: a schedule activated through the real path.',
    });
    if (!proposed.ok) return;

    const commandId = newCommandId();
    const approved = await approveFeePolicyCommand(checker, commandId, {
      activationId: proposed.value.activationId,
    });
    expect(approved.ok).toBe(true);

    expect((await readCommand(commandId))?.status).toBe('SUCCEEDED');
    const { rows: audits } = await getPool().query(
      `SELECT outcome FROM sandbox.audit_event
        WHERE subject_kind='policy' AND subject_id=$1 AND action='FEE_POLICY_APPROVE'`,
      [draft.value.policyId],
    );
    expect(audits.map((a) => a.outcome)).toEqual(['OK']);

    const { rows: events } = await getPool().query(
      `SELECT event_type FROM sandbox.outbox_event WHERE event_key LIKE $1`,
      [`${commandId}:%`],
    );
    expect(events.map((e) => e.event_type)).toEqual(['fee.policy_activated']);
  });

  it('an injected failure during pricing leaves no quote and no snapshot', async () => {
    const user = await newUser('com-rollback');
    const commandId = newCommandId();
    const { runCommand } = await import('@/server/boundary/command');

    await expect(
      runCommand({
        commandId,
        commandType: 'QUOTE_PROBE',
        actorId: user.userId,
        payload: { probe: true },
        body: async (ctx) => {
          const priced = await priceQuote(ctx.tx, {
            userId: user.userId,
            scenario: 'INR_TO_INR',
            amountMinor: 2_500_000n,
          });
          throw new Error('injected failure during pricing');
          return priced;
        },
        encodeResult: () => ({}),
        decodeResult: () => null,
      }),
    ).rejects.toThrow('injected failure during pricing');

    expect(await readCommand(commandId)).toBeNull();
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.quote WHERE issued_to = $1`,
      [user.userId],
    );
    expect(rows[0]!.n).toBe(0);
  });
});
