/**
 * Product precision rule — the display contract.
 *
 * Chiefly: USDT is NEVER shown as `$`. `$560` misrepresents a stablecoin as US
 * dollars, and a customer converting INR must not be shown a fiat-dollar
 * figure. USDT carries a trailing ticker instead.
 */
import { describe, expect, it } from 'vitest';
import { formatMinor, minorIsApproximate } from '@/lib/format';
import { ASSET_AFFIX, ASSET_SYMBOL } from '@/lib/money';

describe('USDT is never displayed as dollars', () => {
  it('has no dollar sign anywhere in its affixes', () => {
    expect(ASSET_SYMBOL.USDT).not.toContain('$');
    expect(ASSET_AFFIX.USDT.prefix).not.toContain('$');
    expect(ASSET_AFFIX.USDT.suffix).not.toContain('$');
  });

  it('writes USDT as a trailing ticker', () => {
    expect(ASSET_AFFIX.USDT.suffix.trim()).toBe('USDT');
    expect(`${formatMinor('560000000', 'USDT')}${ASSET_AFFIX.USDT.suffix}`).toBe('560 USDT');
  });

  it('keeps the rupee prefix for INR', () => {
    expect(ASSET_AFFIX.INR.prefix).toBe('₹');
  });
});

describe('INR: always exactly two decimals, Indian grouping', () => {
  it.each([
    ['4972800', '49,728.00'],
    ['100', '1.00'],
    ['0', '0.00'],
    ['123456789', '12,34,567.89'],
    ['1000000', '10,000.00'],
  ])('%s paise → ₹%s', (minor, expected) => {
    expect(formatMinor(minor, 'INR')).toBe(expected);
  });
});

describe('USDT: up to two decimals, trimmed, truncated not rounded', () => {
  it.each([
    ['560000000', '560'],
    ['12500000', '12.5'],
    ['1000000', '1'],
    ['500000', '0.5'],
    ['123456', '0.12'],
    ['999999', '0.99'],
    ['1999999', '1.99'],
  ])('%s micro → %s USDT', (minor, expected) => {
    expect(formatMinor(minor, 'USDT')).toBe(expected);
  });

  it('never rounds up, so a figure can only understate', () => {
    // 0.999999 must not become "1".
    expect(formatMinor('999999', 'USDT')).toBe('0.99');
    expect(formatMinor('1999999', 'USDT')).toBe('1.99');
  });

  it('prints full precision on demand for committing screens', () => {
    expect(formatMinor('123456', 'USDT', true)).toBe('0.123456');
    expect(formatMinor('1999999', 'USDT', true)).toBe('1.999999');
  });

  it('flags when display precision hid something', () => {
    expect(minorIsApproximate('123456', 'USDT')).toBe(true);
    expect(minorIsApproximate('560000000', 'USDT')).toBe(false);
    expect(minorIsApproximate('4972800', 'INR')).toBe(false);
  });
});

describe('exactness', () => {
  it('handles values far beyond 2^53 without loss', () => {
    const huge = '123456789012345678901';
    expect(formatMinor(huge, 'USDT', true)).toBe('123,456,789,012,345.678901');
  });
});
