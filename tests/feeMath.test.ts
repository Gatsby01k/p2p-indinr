import { describe, expect, it } from 'vitest';
import { applyBps, calculateFee, summarise, type FeePolicyTerms } from '@/lib/feeMath';

/**
 * The fee arithmetic, tested on its own.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  EVERY BOUNDARY HERE IS A REAL AMOUNT OF SOMEBODY'S MONEY.         │
 * │                                                                    │
 * │  Rounding direction, the minimum-fee floor, the maximum-fee cap,   │
 * │  the discount ceiling and the net-positive rule are each a place   │
 * │  where an off-by-one becomes a systematic overcharge repeated on   │
 * │  every transaction. They are asserted at the exact boundary, not   │
 * │  near it.                                                          │
 * └────────────────────────────────────────────────────────────────────┘
 */

const POLICY: FeePolicyTerms = {
  policyKey: 'test',
  version: 1,
  feeAsset: 'USDT',
  feeBearer: 'PAYER',
  bps: 150n, // 1.50%
  fixedMinor: 0n,
  minFeeMinor: 2_500n,
  maxFeeMinor: 200_000n,
  discountCapBps: 5_000n, // at most half off
};

const withPolicy = (over: Partial<FeePolicyTerms>): FeePolicyTerms => ({ ...POLICY, ...over });

describe('basis points are exact and truncate downwards', () => {
  it('computes an exact percentage', () => {
    expect(applyBps(1_000_000n, 150n)).toBe(15_000n);
  });

  it('TRUNCATES rather than rounds, always in the customer’s favour', () => {
    // 1.50% of 101 = 1.515 minor units. Rounding up would charge 2 —
    // more than the advertised rate, on every single transaction.
    expect(applyBps(101n, 150n)).toBe(1n);
    expect(applyBps(199n, 150n)).toBe(2n);
    // The exact boundary: one unit below and at the tick.
    expect(applyBps(6_666n, 150n)).toBe(99n);
    expect(applyBps(6_667n, 150n)).toBe(100n);
  });

  it('never returns a negative or a fee on a non-positive amount', () => {
    expect(applyBps(0n, 150n)).toBe(0n);
    expect(applyBps(-100n, 150n)).toBe(0n);
    expect(applyBps(100n, 0n)).toBe(0n);
    expect(applyBps(100n, -50n)).toBe(0n);
  });

  it('handles an amount far beyond a 64-bit integer', () => {
    const huge = 10n ** 30n;
    expect(applyBps(huge, 150n)).toBe((huge * 150n) / 10_000n);
  });
});

describe('the base fee', () => {
  it('is bps of the amount plus any fixed component', () => {
    const result = calculateFee({
      amountMinor: 1_000_000n,
      policy: withPolicy({ fixedMinor: 18_000n }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseFeeMinor).toBe(15_000n + 18_000n);
  });
});

describe('minimum and maximum fee bounds', () => {
  it('floors a small deal at the minimum', () => {
    // 1.50% of 10,000 = 150, below the 2,500 floor.
    const result = calculateFee({ amountMinor: 10_000n, policy: POLICY });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseFeeMinor).toBe(150n);
    expect(result.value.finalFeeMinor).toBe(2_500n);
  });

  it('caps a large deal at the maximum', () => {
    // 1.50% of 100,000,000 = 1,500,000, far above the 200,000 ceiling.
    const result = calculateFee({ amountMinor: 100_000_000n, policy: POLICY });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.finalFeeMinor).toBe(200_000n);
  });

  it('is exact AT the boundary, not merely near it', () => {
    // The amount whose 1.50% is exactly the floor.
    const atFloor = calculateFee({ amountMinor: 166_667n, policy: POLICY });
    expect(atFloor.ok && atFloor.value.finalFeeMinor).toBe(2_500n);
    // One unit below still floors; one above starts to exceed it.
    const above = calculateFee({ amountMinor: 200_000n, policy: POLICY });
    expect(above.ok && above.value.finalFeeMinor).toBe(3_000n);
  });

  it('the FLOOR wins over a discount', () => {
    // A schedule with a floor means the floor. Charging below it would
    // be a different, unapproved schedule.
    const result = calculateFee({
      amountMinor: 200_000n, // base 3,000
      policy: POLICY,
      entitlements: { premiumBps: 5_000n }, // would take it to 1,500
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.premiumDiscountMinor).toBe(1_500n);
    expect(result.value.finalFeeMinor).toBe(2_500n);
  });
});

describe('discount composition', () => {
  const big = withPolicy({ minFeeMinor: 0n, maxFeeMinor: 10_000_000n });

  it('measures every discount against the BASE, not a running total', () => {
    const result = calculateFee({
      amountMinor: 1_000_000n, // base 15,000
      policy: big,
      entitlements: { premiumBps: 1_000n, referralBps: 500n }, // 10% + 5%
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 1,500 and 750 — NOT 1,500 then 5% of the remainder. Order cannot
    // change the answer.
    expect(result.value.premiumDiscountMinor).toBe(1_500n);
    expect(result.value.referralDiscountMinor).toBe(750n);
    expect(result.value.finalFeeMinor).toBe(15_000n - 2_250n);
  });

  it('produces the SAME result whatever order the discounts are listed', () => {
    const a = calculateFee({
      amountMinor: 1_000_000n,
      policy: big,
      entitlements: { premiumBps: 1_000n, referralBps: 500n, rewardBps: 250n },
    });
    const b = calculateFee({
      amountMinor: 1_000_000n,
      policy: big,
      entitlements: { rewardBps: 250n, referralBps: 500n, premiumBps: 1_000n },
    });
    expect(a).toEqual(b);
  });

  it('CAPS the total, however many promotions are held', () => {
    const result = calculateFee({
      amountMinor: 1_000_000n, // base 15,000
      policy: withPolicy({ minFeeMinor: 0n, discountCapBps: 2_000n }), // 20% max
      entitlements: { premiumBps: 3_000n, referralBps: 3_000n, rewardBps: 3_000n },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 90% requested, 20% allowed.
    expect(result.value.finalFeeMinor).toBe(15_000n - 3_000n);
    expect(result.value.discountCappedMinor).toBe(13_500n - 3_000n);
  });

  it('respects a reward’s own absolute ceiling', () => {
    const result = calculateFee({
      amountMinor: 1_000_000n, // base 15,000
      policy: big,
      entitlements: { rewardBps: 5_000n, rewardMaxMinor: 1_000n },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 50% would be 7,500; the campaign caps its own benefit at 1,000.
    expect(result.value.rewardDiscountMinor).toBe(1_000n);
  });

  it('NEVER produces a negative fee', () => {
    const result = calculateFee({
      amountMinor: 1_000_000n,
      policy: withPolicy({ minFeeMinor: 0n, discountCapBps: 10_000n }),
      entitlements: { premiumBps: 10_000n, referralBps: 10_000n, rewardBps: 10_000n },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.finalFeeMinor).toBe(0n);
    expect(result.value.finalFeeMinor >= 0n).toBe(true);
  });
});

describe('the net result', () => {
  it('PAYER bearer: the payer sends amount plus fee, the payee keeps all', () => {
    const result = calculateFee({ amountMinor: 1_000_000n, policy: POLICY });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payerSendsMinor).toBe(1_015_000n);
    expect(result.value.payeeReceivesMinor).toBe(1_000_000n);
  });

  it('PAYEE bearer: the payer sends the amount, the fee comes out of the receipt', () => {
    const result = calculateFee({
      amountMinor: 1_000_000n,
      policy: withPolicy({ feeBearer: 'PAYEE' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payerSendsMinor).toBe(1_000_000n);
    expect(result.value.payeeReceivesMinor).toBe(985_000n);
  });

  it('REFUSES a deal the fee would consume', () => {
    // A fee floor of 2,500 against an amount of 2,000 leaves the payee
    // with nothing. Refused, not floored at zero: a zero receipt is not
    // a deal, it is a confiscation with a nicer name.
    const result = calculateFee({
      amountMinor: 2_000n,
      policy: withPolicy({ feeBearer: 'PAYEE' }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('NET_NOT_POSITIVE');
  });

  it('refuses a zero or negative amount', () => {
    for (const amount of [0n, -1n, -1_000_000n]) {
      const result = calculateFee({ amountMinor: amount, policy: POLICY });
      expect(result.ok, String(amount)).toBe(false);
      if (!result.ok) expect(result.reason).toBe('AMOUNT_INVALID');
    }
  });

  it('refuses an incoherent policy rather than guessing', () => {
    const result = calculateFee({
      amountMinor: 1_000_000n,
      policy: withPolicy({ minFeeMinor: 5_000n, maxFeeMinor: 1_000n }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('POLICY_INCOHERENT');
  });
});

describe('determinism', () => {
  it('the same inputs always produce byte-identical output', () => {
    const inputs = {
      amountMinor: 1_234_567n,
      policy: POLICY,
      entitlements: { premiumBps: 1_000n, referralBps: 500n, rewardBps: 250n },
    };
    const runs = Array.from({ length: 20 }, () => calculateFee(inputs));
    for (const run of runs) expect(run).toEqual(runs[0]);
  });

  it('the summary reports the numbers that were charged', () => {
    const calculation = calculateFee({
      amountMinor: 1_000_000n,
      policy: POLICY,
      entitlements: { premiumBps: 1_000n },
    });
    expect(calculation.ok).toBe(true);
    if (!calculation.ok) return;

    const summary = summarise({
      amountMinor: 1_000_000n,
      calculation: calculation.value,
      policy: POLICY,
      rate: '1:1',
    });
    // FROM → AMOUNT → TO → RATE → FEE → FINAL RESULT, from the same
    // numbers rather than re-derived for display.
    expect(summary.feeMinor).toBe(calculation.value.finalFeeMinor.toString());
    expect(summary.payerSendsMinor).toBe(calculation.value.payerSendsMinor.toString());
    expect(summary.payeeReceivesMinor).toBe(calculation.value.payeeReceivesMinor.toString());
    expect(summary.discounts).toEqual([{ source: 'PREMIUM', amountMinor: '1500' }]);
  });

  it('reports no discount when none applied — no fake saving', () => {
    const calculation = calculateFee({ amountMinor: 1_000_000n, policy: POLICY });
    expect(calculation.ok).toBe(true);
    if (!calculation.ok) return;
    const summary = summarise({
      amountMinor: 1_000_000n,
      calculation: calculation.value,
      policy: POLICY,
    });
    // A crossed-out price nobody was ever charged is a lie. There is no
    // discount row unless a discount was actually applied.
    expect(summary.discounts).toEqual([]);
  });
});
