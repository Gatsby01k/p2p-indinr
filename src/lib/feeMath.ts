/**
 * The fee calculation — one definition, exact integers, no floats.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THIS FILE IS IN `lib` SO THE PREVIEW AND THE QUOTE CANNOT DISAGREE.│
 * │                                                                    │
 * │  A browser that previews one number and a server that charges      │
 * │  another is the single most common way a fintech misleads people,  │
 * │  and it almost never happens on purpose — it happens because two   │
 * │  implementations drift. There is one implementation.               │
 * │                                                                    │
 * │  The preview is still not binding: only the server chooses the     │
 * │  policy version and the entitlements. But given the same inputs,   │
 * │  the two produce byte-identical results, and a test asserts it.    │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * EVERYTHING IS `bigint`. Not "mostly" — a single `number` in a money
 * path is a rounding bug that appears at the amount nobody tested.
 */

export type FeeAsset = 'INR' | 'USDT';
export type FeeBearerPolicy = 'PAYER' | 'PAYEE';

/** The immutable terms of one fee policy version. */
export interface FeePolicyTerms {
  readonly policyKey: string;
  readonly version: number;
  readonly feeAsset: FeeAsset;
  readonly feeBearer: FeeBearerPolicy;
  readonly bps: bigint;
  readonly fixedMinor: bigint;
  readonly minFeeMinor: bigint;
  readonly maxFeeMinor: bigint;
  /** Ceiling on ALL discounts combined, in basis points of the base fee. */
  readonly discountCapBps: bigint;
}

/** The entitlements a specific person holds at a specific moment. */
export interface Entitlements {
  readonly premiumBps?: bigint;
  readonly referralBps?: bigint;
  readonly rewardBps?: bigint;
  /** A reward may also cap its own benefit in absolute minor units. */
  readonly rewardMaxMinor?: bigint;
}

export interface FeeCalculation {
  readonly baseFeeMinor: bigint;
  readonly premiumDiscountMinor: bigint;
  readonly referralDiscountMinor: bigint;
  readonly rewardDiscountMinor: bigint;
  /** How much discount the cap REMOVED. Zero when nothing was capped. */
  readonly discountCappedMinor: bigint;
  readonly boundedFeeMinor: bigint;
  readonly finalFeeMinor: bigint;
  readonly payerSendsMinor: bigint;
  readonly payeeReceivesMinor: bigint;
}

const BPS_DEN = 10_000n;

/**
 * Apply a basis-point rate, TRUNCATING.
 *
 * Truncation, not rounding, and always in the customer's favour: a fee
 * can be a fraction of a minor unit BELOW the advertised percentage and
 * never above it. Rounding up would charge more than the rate on the
 * page, which is a small lie repeated on every transaction.
 */
export function applyBps(amountMinor: bigint, bps: bigint): bigint {
  if (amountMinor <= 0n || bps <= 0n) return 0n;
  return (amountMinor * bps) / BPS_DEN;
}

function clamp(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export type FeeFailure = 'AMOUNT_INVALID' | 'NET_NOT_POSITIVE' | 'POLICY_INCOHERENT';

export type FeeResult =
  | { readonly ok: true; readonly value: FeeCalculation }
  | { readonly ok: false; readonly reason: FeeFailure };

/**
 * The canonical calculation order.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  1. BASE      — bps of the amount, plus any fixed component.       │
 * │  2. PREMIUM   — a discount off the base.                           │
 * │  3. REFERRAL  — a discount off the base.                           │
 * │  4. REWARD    — a single-use discount off the base, itself capped. │
 * │  5. CAP       — total discount limited by the POLICY, not by the   │
 * │                 promotions. Stacking cannot exceed what the        │
 * │                 schedule allows, however many are held.            │
 * │  6. BOUNDS    — min and max fee from the policy.                   │
 * │  7. NET       — the deal must leave both sides positive.           │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * The order is fixed and total, so the same inputs always produce the
 * same output — which is what makes a retry safe and a dispute
 * answerable. Every discount is computed off the BASE rather than
 * off the running total, because sequential percentages depend on order
 * and would make "premium then referral" differ from "referral then
 * premium" for no defensible reason.
 */
export function calculateFee(input: {
  readonly amountMinor: bigint;
  readonly policy: FeePolicyTerms;
  readonly entitlements?: Entitlements;
}): FeeResult {
  const { amountMinor, policy } = input;
  const ent = input.entitlements ?? {};

  if (amountMinor <= 0n) return { ok: false, reason: 'AMOUNT_INVALID' };
  if (policy.bps < 0n || policy.minFeeMinor < 0n || policy.maxFeeMinor < policy.minFeeMinor) {
    return { ok: false, reason: 'POLICY_INCOHERENT' };
  }

  /* 1. Base */
  const baseFeeMinor = applyBps(amountMinor, policy.bps) + policy.fixedMinor;

  /* 2–4. Discounts, each measured against the BASE */
  const premiumDiscountMinor = applyBps(baseFeeMinor, ent.premiumBps ?? 0n);
  const referralDiscountMinor = applyBps(baseFeeMinor, ent.referralBps ?? 0n);
  const rawReward = applyBps(baseFeeMinor, ent.rewardBps ?? 0n);
  const rewardDiscountMinor =
    ent.rewardMaxMinor === undefined || ent.rewardMaxMinor < 0n
      ? rawReward
      : rawReward < ent.rewardMaxMinor
        ? rawReward
        : ent.rewardMaxMinor;

  const requested = premiumDiscountMinor + referralDiscountMinor + rewardDiscountMinor;

  /* 5. The policy's cap on the TOTAL */
  const allowed = applyBps(baseFeeMinor, policy.discountCapBps);
  const granted = requested < allowed ? requested : allowed;
  const discountCappedMinor = requested - granted;

  /* 6. Bounds */
  const afterDiscount = baseFeeMinor - granted;
  const boundedFeeMinor = clamp(
    afterDiscount > 0n ? afterDiscount : 0n,
    policy.minFeeMinor,
    policy.maxFeeMinor,
  );

  /*
   * The min-fee floor can hand back some of a discount, and that is
   * intentional: a schedule with a floor means the floor, and quietly
   * charging below it would be a different (unapproved) schedule.
   */
  const finalFeeMinor = boundedFeeMinor;

  /* 7. Net */
  const payerSendsMinor = policy.feeBearer === 'PAYER' ? amountMinor + finalFeeMinor : amountMinor;
  const payeeReceivesMinor =
    policy.feeBearer === 'PAYER' ? amountMinor : amountMinor - finalFeeMinor;

  if (payerSendsMinor <= 0n || payeeReceivesMinor <= 0n) {
    // A fee that consumes the whole amount is not a fee, it is a
    // confiscation. Refused rather than floored at zero.
    return { ok: false, reason: 'NET_NOT_POSITIVE' };
  }

  return {
    ok: true,
    value: {
      baseFeeMinor,
      premiumDiscountMinor,
      referralDiscountMinor,
      rewardDiscountMinor,
      discountCappedMinor,
      boundedFeeMinor,
      finalFeeMinor,
      payerSendsMinor,
      payeeReceivesMinor,
    },
  };
}

/**
 * The user-facing summary line, assembled from the calculation.
 *
 * `FROM → AMOUNT → TO → RATE → FEE → FINAL RESULT`, as required, built
 * from the same numbers that were charged rather than re-derived for
 * display — a display that recomputes is a display that can disagree.
 */
export interface EconomicSummary {
  readonly amountMinor: string;
  readonly rate: string | null;
  readonly feeMinor: string;
  readonly feeBearer: FeeBearerPolicy;
  readonly payerSendsMinor: string;
  readonly payeeReceivesMinor: string;
  readonly discounts: readonly { readonly source: string; readonly amountMinor: string }[];
}

export function summarise(input: {
  readonly amountMinor: bigint;
  readonly calculation: FeeCalculation;
  readonly policy: FeePolicyTerms;
  readonly rate?: string | null;
}): EconomicSummary {
  const c = input.calculation;
  const discounts: { source: string; amountMinor: string }[] = [];
  if (c.premiumDiscountMinor > 0n) {
    discounts.push({ source: 'PREMIUM', amountMinor: c.premiumDiscountMinor.toString() });
  }
  if (c.referralDiscountMinor > 0n) {
    discounts.push({ source: 'REFERRAL', amountMinor: c.referralDiscountMinor.toString() });
  }
  if (c.rewardDiscountMinor > 0n) {
    discounts.push({ source: 'REWARD', amountMinor: c.rewardDiscountMinor.toString() });
  }
  return {
    amountMinor: input.amountMinor.toString(),
    rate: input.rate ?? null,
    feeMinor: c.finalFeeMinor.toString(),
    feeBearer: input.policy.feeBearer,
    payerSendsMinor: c.payerSendsMinor.toString(),
    payeeReceivesMinor: c.payeeReceivesMinor.toString(),
    discounts,
  };
}
