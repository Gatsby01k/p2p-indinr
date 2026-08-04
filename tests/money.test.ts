import { describe, expect, it } from 'vitest';
import {
  addMoney,
  compareMoney,
  formatMoney,
  money,
  parseAmount,
  subMoney,
  toDecimalString,
} from '@/lib/money';

describe('money — exactness', () => {
  it('parses INR to paise without float error', () => {
    expect(parseAmount('0.1', 'INR')?.minor).toBe(10n);
    expect(parseAmount('0.07', 'INR')?.minor).toBe(7n);
    expect(parseAmount('12345.67', 'INR')?.minor).toBe(1_234_567n);
  });

  it('parses USDT to 6 decimals', () => {
    expect(parseAmount('1', 'USDT')?.minor).toBe(1_000_000n);
    expect(parseAmount('0.000001', 'USDT')?.minor).toBe(1n);
    expect(parseAmount('560.5', 'USDT')?.minor).toBe(560_500_000n);
  });

  it('rejects excess precision rather than silently rounding', () => {
    expect(parseAmount('1.234', 'INR')).toBeNull();
    expect(parseAmount('1.1234567', 'USDT')).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(parseAmount('', 'INR')).toBeNull();
    expect(parseAmount('abc', 'INR')).toBeNull();
    expect(parseAmount('-5', 'INR')).toBeNull();
    expect(parseAmount('1.2.3', 'INR')).toBeNull();
  });

  it('survives the classic 0.1 + 0.2 float trap', () => {
    const a = parseAmount('0.1', 'INR');
    const b = parseAmount('0.2', 'INR');
    expect(a && b && toDecimalString(addMoney(a, b))).toBe('0.30');
  });

  it('never loses precision on very large amounts', () => {
    const big = parseAmount('99999999.99', 'INR');
    expect(big?.minor).toBe(9_999_999_999n);
    expect(big && toDecimalString(big)).toBe('99999999.99');
  });
});

describe('money — formatting', () => {
  it('groups INR the Indian way', () => {
    expect(formatMoney(money('INR', 1_234_567_00n))).toBe('₹12,34,567.00');
    expect(formatMoney(money('INR', 100_00n))).toBe('₹100.00');
  });

  it('groups USDT the western way, trims zeros, and never uses a dollar sign', () => {
    // USDT is not US dollars. It is written with a trailing ticker so a
    // customer converting INR is never shown a figure that reads as fiat.
    expect(formatMoney(money('USDT', 1_234_567_000000n))).toBe('1,234,567 USDT');
    expect(formatMoney(money('USDT', 560_500_000n))).toBe('560.5 USDT');
    expect(formatMoney(money('USDT', 560_000_000n))).toBe('560 USDT');
    expect(formatMoney(money('USDT', 560_000_000n))).not.toContain('$');
  });

  it('truncates USDT display precision rather than rounding up', () => {
    // 0.999999 must never be shown as 1: a displayed figure may understate,
    // never overstate, what someone holds.
    expect(formatMoney(money('USDT', 999_999n))).toBe('0.99 USDT');
    expect(formatMoney(money('USDT', 999_999n), { exact: true })).toBe('0.999999 USDT');
  });

  it('keeps INR at a stable 2 decimal places', () => {
    expect(formatMoney(money('INR', 5_000_000n))).toBe('₹50,000.00');
  });
});

describe('money — arithmetic guards', () => {
  it('refuses cross-asset arithmetic', () => {
    expect(() => addMoney(money('INR', 1n), money('USDT', 1n))).toThrow();
    expect(() => subMoney(money('USDT', 1n), money('INR', 1n))).toThrow();
  });

  it('compares within an asset', () => {
    expect(compareMoney(money('INR', 1n), money('INR', 2n))).toBe(-1);
    expect(compareMoney(money('INR', 2n), money('INR', 2n))).toBe(0);
    expect(compareMoney(money('INR', 3n), money('INR', 2n))).toBe(1);
  });
});
