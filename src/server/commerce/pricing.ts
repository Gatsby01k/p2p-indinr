import 'server-only';
import { getPool, toBigInt, type Tx } from '@/server/db/pool';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { calculateFee, summarise, type EconomicSummary, type FeeCalculation } from '@/lib/feeMath';
import type { Scenario } from '@/lib/scenario';
import { activePolicyFor, type FeePolicyRecord } from './feePolicy';
import { entitlementsFor } from './entitlements';

/**
 * Pricing a quote, and freezing the promise.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE PREVIEW AND THE ACCEPTED QUOTE RUN THE SAME CODE PATH.        │
 * │                                                                    │
 * │  `priceQuote` is called to show a customer what a deal will cost,  │
 * │  and called again to issue it. Same policy lookup, same            │
 * │  entitlement resolution, same arithmetic — so "preview equals      │
 * │  accepted" is true because there is one function, not because two  │
 * │  were kept in step.                                                │
 * │                                                                    │
 * │  `snapshotQuote` then writes the result down. After that the       │
 * │  numbers are immutable: activating a new schedule tomorrow cannot  │
 * │  reach a snapshot row, and the trigger on the table refuses even   │
 * │  a deliberate attempt.                                             │
 * └────────────────────────────────────────────────────────────────────┘
 */

export interface PricedQuote {
  readonly policy: FeePolicyRecord;
  readonly calculation: FeeCalculation;
  readonly summary: EconomicSummary;
  readonly premiumGrantId: string | null;
  readonly referralId: string | null;
  readonly rewardGrantId: string | null;
}

export async function priceQuote(
  tx: Tx,
  input: {
    readonly userId: string;
    readonly scenario: Scenario;
    readonly amountMinor: bigint;
    readonly rewardGrantId?: string | null;
    readonly rate?: string | null;
  },
): Promise<Outcome<PricedQuote>> {
  const policy = await activePolicyFor(tx, input.scenario);
  if (!policy.ok) return policy;

  const resolved = await entitlementsFor(tx, {
    userId: input.userId,
    rewardGrantId: input.rewardGrantId ?? null,
  });

  const calculated = calculateFee({
    amountMinor: input.amountMinor,
    policy: policy.value,
    entitlements: resolved.entitlements,
  });

  if (!calculated.ok) {
    if (calculated.reason === 'NET_NOT_POSITIVE') {
      return reject('AMOUNT_TOO_SMALL', FAILURE_COPY.AMOUNT_TOO_SMALL.reason, {
        amountMinor: input.amountMinor.toString(),
      });
    }
    if (calculated.reason === 'AMOUNT_INVALID') {
      return reject('AMOUNT_INVALID', FAILURE_COPY.AMOUNT_INVALID.reason);
    }
    return reject('FEE_POLICY_INVALID', FAILURE_COPY.FEE_POLICY_INVALID.reason);
  }

  return accept({
    policy: policy.value,
    calculation: calculated.value,
    summary: summarise({
      amountMinor: input.amountMinor,
      calculation: calculated.value,
      policy: policy.value,
      rate: input.rate ?? null,
    }),
    premiumGrantId: resolved.premiumGrantId,
    referralId: resolved.referralId,
    rewardGrantId: resolved.rewardGrantId,
  });
}

/**
 * Freeze the calculation onto a quote, and spend the reward.
 *
 * The reward is marked REDEEMED in the SAME transaction that writes the
 * snapshot, under the `reward_grant_quote_uq` index — so a reward is
 * single-use even if two quotes are issued concurrently, and a quote
 * that fails to commit does not consume one.
 */
export async function snapshotQuote(
  tx: Tx,
  input: {
    readonly quoteId: string;
    readonly amountMinor: bigint;
    readonly priced: PricedQuote;
  },
): Promise<Outcome<{ snapshotId: string }>> {
  const { priced } = input;
  const c = priced.calculation;

  const { rows } = await tx.query(
    `INSERT INTO sandbox.quote_fee_snapshot
       (quote_id, policy_id, policy_key, policy_version, fee_asset, fee_bearer,
        base_fee_minor, premium_discount_minor, referral_discount_minor,
        reward_discount_minor, discount_capped_minor, bounded_fee_minor,
        final_fee_minor, payer_sends_minor, payee_receives_minor,
        premium_grant_id, referral_id, reward_grant_id, components)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING snapshot_id`,
    [
      input.quoteId,
      priced.policy.policyId,
      priced.policy.policyKey,
      priced.policy.version,
      priced.policy.feeAsset,
      priced.policy.feeBearer,
      c.baseFeeMinor.toString(),
      c.premiumDiscountMinor.toString(),
      c.referralDiscountMinor.toString(),
      c.rewardDiscountMinor.toString(),
      c.discountCappedMinor.toString(),
      c.boundedFeeMinor.toString(),
      c.finalFeeMinor.toString(),
      c.payerSendsMinor.toString(),
      c.payeeReceivesMinor.toString(),
      priced.premiumGrantId,
      priced.referralId,
      priced.rewardGrantId,
      JSON.stringify({
        amountMinor: input.amountMinor.toString(),
        bps: priced.policy.bps.toString(),
        fixedMinor: priced.policy.fixedMinor.toString(),
        discountCapBps: priced.policy.discountCapBps.toString(),
        summary: priced.summary,
      }),
    ],
  );

  if (priced.rewardGrantId !== null) {
    /*
     * SINGLE USE, decided by the database.
     *
     * `state='GRANTED'` in the WHERE clause means a concurrent redemption
     * updates one row and zero rows. If this one loses, the snapshot has
     * already been written with the discount — so the row count is
     * checked and the whole transaction is refused rather than handing
     * out a benefit twice.
     */
    const { rowCount } = await tx.query(
      `UPDATE sandbox.reward_grant
          SET state='REDEEMED', redeemed_at=now(), redeemed_quote_id=$2
        WHERE grant_id=$1 AND state='GRANTED' AND expires_at > now()`,
      [priced.rewardGrantId, input.quoteId],
    );
    if (rowCount === 0) {
      return reject('REWARD_ALREADY_REDEEMED', FAILURE_COPY.REWARD_ALREADY_REDEEMED.reason);
    }
  }

  return accept({ snapshotId: rows[0]!.snapshot_id as string });
}

/* ------------------------------------------------------------------ *
 * Reading a frozen promise
 * ------------------------------------------------------------------ */

export interface QuoteSnapshot {
  readonly snapshotId: string;
  readonly quoteId: string;
  readonly policyKey: string;
  readonly policyVersion: number;
  readonly feeAsset: 'INR' | 'USDT';
  readonly feeBearer: 'PAYER' | 'PAYEE';
  readonly baseFeeMinor: string;
  readonly finalFeeMinor: string;
  readonly payerSendsMinor: string;
  readonly payeeReceivesMinor: string;
  readonly premiumDiscountMinor: string;
  readonly referralDiscountMinor: string;
  readonly rewardDiscountMinor: string;
  readonly discountCappedMinor: string;
}

/*
 * Every column is table-qualified. `snapshotForDeal` joins `deal`, which
 * also carries `quote_id`, and an unqualified list makes that ambiguous —
 * a runtime error the type system cannot see.
 */
const SNAPSHOT_COLUMNS = `s.snapshot_id, s.quote_id, s.policy_key, s.policy_version,
  s.fee_asset, s.fee_bearer,
  s.base_fee_minor::text AS base_fee_minor,
  s.final_fee_minor::text AS final_fee_minor,
  s.payer_sends_minor::text AS payer_sends_minor,
  s.payee_receives_minor::text AS payee_receives_minor,
  s.premium_discount_minor::text AS premium_discount_minor,
  s.referral_discount_minor::text AS referral_discount_minor,
  s.reward_discount_minor::text AS reward_discount_minor,
  s.discount_capped_minor::text AS discount_capped_minor`;

function mapSnapshot(r: Record<string, unknown>): QuoteSnapshot {
  return {
    snapshotId: r.snapshot_id as string,
    quoteId: r.quote_id as string,
    policyKey: r.policy_key as string,
    policyVersion: Number(r.policy_version),
    feeAsset: r.fee_asset as 'INR' | 'USDT',
    feeBearer: r.fee_bearer as 'PAYER' | 'PAYEE',
    baseFeeMinor: r.base_fee_minor as string,
    finalFeeMinor: r.final_fee_minor as string,
    payerSendsMinor: r.payer_sends_minor as string,
    payeeReceivesMinor: r.payee_receives_minor as string,
    premiumDiscountMinor: r.premium_discount_minor as string,
    referralDiscountMinor: r.referral_discount_minor as string,
    rewardDiscountMinor: r.reward_discount_minor as string,
    discountCappedMinor: r.discount_capped_minor as string,
  };
}

export async function snapshotForQuote(quoteId: string): Promise<QuoteSnapshot | null> {
  const { rows } = await getPool().query(
    `SELECT ${SNAPSHOT_COLUMNS} FROM sandbox.quote_fee_snapshot s WHERE s.quote_id = $1`,
    [quoteId],
  );
  return rows[0] ? mapSnapshot(rows[0]) : null;
}

/** The snapshot behind a deal, via the quote it consumed. */
export async function snapshotForDeal(tx: Tx, dealId: string): Promise<QuoteSnapshot | null> {
  const { rows } = await tx.query(
    `SELECT ${SNAPSHOT_COLUMNS} FROM sandbox.quote_fee_snapshot s
       JOIN sandbox.deal d ON d.quote_id = s.quote_id
      WHERE d.deal_id = $1`,
    [dealId],
  );
  return rows[0] ? mapSnapshot(rows[0]) : null;
}

/** The amount a snapshot's fee is denominated against, for verification. */
export async function snapshotAmountMinor(quoteId: string): Promise<bigint | null> {
  const { rows } = await getPool().query(
    `SELECT components->>'amountMinor' AS amount FROM sandbox.quote_fee_snapshot
      WHERE quote_id = $1`,
    [quoteId],
  );
  return rows[0]?.amount ? toBigInt(rows[0].amount as string) : null;
}
