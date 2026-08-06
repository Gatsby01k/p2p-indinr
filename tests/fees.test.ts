/**
 * The fee rule, and the arithmetic discipline behind it.
 *
 * Two properties matter more than any individual figure:
 *
 *   1. A fee is TRUNCATED, never rounded up. A fee that rounded up would
 *      charge more than the percentage advertised, which is the kind of
 *      defect that is discovered by a customer rather than by a developer.
 *   2. The payer's total and the payee's receipt always reconcile against
 *      the amount and the fees. A total that does not visibly equal the sum
 *      of its parts is the fastest way to lose a person's trust.
 */
import { describe, expect, it } from 'vitest';
import { feesFor, inrFromUsdt, settlementFor, usdtFromInr } from '@/lib/fees';
import { REFERENCE_RATE } from '@/lib/rate';
import { formatMinor } from '@/lib/format';

describe('protected payment fees (INR → INR)', () => {
  it('charges 1.50% between the floor and the ceiling', () => {
    // ₹85,000 → ₹1,275.00, the worked example on the review screen.
    expect(feesFor('INR_TO_INR', 8_500_000n).protectionMinor).toBe(127_500n);
    expect(formatMinor(feesFor('INR_TO_INR', 8_500_000n).protectionMinor.toString(), 'INR')).toBe(
      '1,275.00',
    );
  });

  it('applies a ₹25 floor to small deals', () => {
    // 1.5% of ₹100 is ₹1.50, which would not cover a dispute review.
    expect(feesFor('INR_TO_INR', 10_000n).protectionMinor).toBe(2_500n);
  });

  it('applies a ₹2,000 ceiling to large ones', () => {
    // 1.5% of ₹50,00,000 would be ₹75,000.
    expect(feesFor('INR_TO_INR', 500_000_000n).protectionMinor).toBe(200_000n);
  });

  it('carries no network fee — there is no crypto leg', () => {
    expect(feesFor('INR_TO_INR', 8_500_000n).networkMinor).toBe(0n);
  });

  it('truncates rather than rounding up', () => {
    // 1.5% of ₹333.33 is 499.995 paise. Rounding would take 500.
    expect(feesFor('INR_TO_INR', 33_333n).protectionMinor).toBe(2_500n); // floor applies
    // Above the floor: 1.5% of ₹2,000.01 = 3000.015 paise → 3000.
    expect(feesFor('INR_TO_INR', 200_001n).protectionMinor).toBe(3_000n);
  });
});

describe('exchange fees (INR ⇄ USDT)', () => {
  it('charges 1.25% plus a flat network fee', () => {
    const fees = feesFor('INR_TO_USDT', 10_000_000n); // ₹1,00,000
    expect(fees.protectionMinor).toBe(125_000n); // ₹1,250.00
    expect(fees.networkMinor).toBe(18_000n); // ₹180.00
    expect(fees.totalMinor).toBe(143_000n);
  });

  it('applies the same rule in both directions', () => {
    expect(feesFor('INR_TO_USDT', 5_000_000n)).toEqual(feesFor('USDT_TO_INR', 5_000_000n));
  });
});

describe('settlement reconciles', () => {
  const amount = 8_500_000n; // ₹85,000

  it('payer-borne: the payer sends amount + fees, the payee keeps the amount', () => {
    const s = settlementFor('INR_TO_INR', amount, 'PAYER');
    expect(s.payerSendsMinor).toBe(amount + s.fees.totalMinor);
    expect(s.payeeReceivesMinor).toBe(amount);
    // The identity a person checks on the review screen.
    expect(s.payerSendsMinor - s.fees.totalMinor).toBe(s.payeeReceivesMinor);
  });

  it('payee-borne: the payer sends the amount, the fee comes off the receipt', () => {
    const s = settlementFor('INR_TO_INR', amount, 'PAYEE');
    expect(s.payerSendsMinor).toBe(amount);
    expect(s.payeeReceivesMinor).toBe(amount - s.fees.totalMinor);
    expect(s.payeeReceivesMinor + s.fees.totalMinor).toBe(s.payerSendsMinor);
  });

  it('never leaves the payee owing money', () => {
    // A deal smaller than the fee floor cannot produce a negative receipt.
    const s = settlementFor('INR_TO_INR', 1_000n, 'PAYEE');
    expect(s.payeeReceivesMinor).toBe(0n);
    expect(s.payeeReceivesMinor >= 0n).toBe(true);
  });

  it('returns zero for a zero amount rather than a floor', () => {
    expect(feesFor('INR_TO_INR', 0n).totalMinor).toBe(0n);
  });
});

describe('rate conversion truncates in both directions', () => {
  const { num, den } = REFERENCE_RATE;

  it('converts USDT to INR without floating point', () => {
    // 500 USDT at 88.80 = ₹44,400.00
    expect(inrFromUsdt(500_000_000n, num, den)).toBe(4_440_000n);
  });

  it('converts INR to USDT without crediting unpaid micro-units', () => {
    const micro = usdtFromInr(4_440_000n, num, den);
    expect(micro).toBe(500_000_000n);
    // Round-tripping can only ever lose, never gain.
    expect(inrFromUsdt(micro, num, den)).toBeLessThanOrEqual(4_440_000n);
  });

  it('holds exactly above 2^53, where a JS number would not', () => {
    const huge = 9_007_199_254_740_993_000_000n; // > Number.MAX_SAFE_INTEGER
    const inr = inrFromUsdt(huge, num, den);
    expect(inr).toBe((huge * num) / (den * 10_000n));
    expect(inr.toString()).not.toContain('e');
  });
});
