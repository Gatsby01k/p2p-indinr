import { describe, expect, it } from 'vitest';
import { formatMinor, plainMinor } from '@/lib/format';

/**
 * An amount must survive the calculator → sign-in → deal-form handoff.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE DEL-10 BROWSER RUN FOUND THIS LIVE.                           │
 * │                                                                    │
 * │  ₹83,000 was typed into the calculator. The sign-in screen said    │
 * │  the carried amount was ₹83. The deal form showed an empty field.  │
 * │                                                                    │
 * │  One root cause: the DISPLAY string was put into the URL.          │
 * │  `formatMinor` applies Indian digit grouping, so the parameter     │
 * │  read `amount=83,000`, and the two consumers disagreed about what  │
 * │  that meant — one matched the prefix before the comma, the other   │
 * │  rejected the whole thing.                                         │
 * │                                                                    │
 * │  A wrong amount shown at the moment somebody decides to commit is  │
 * │  the worst of the three outcomes, so the tests below pin all       │
 * │  three: the machine form is ungrouped, the display form is still   │
 * │  grouped, and the consumer patterns cannot partially match.        │
 * └────────────────────────────────────────────────────────────────────┘
 */

/** The pattern the deal form applies. Kept in sync deliberately. */
const DEAL_FORM = /^\d{1,12}(\.\d{1,6})?$/;
/** The pattern the sign-in screen applies, anchored to the value's end. */
const SIGN_IN = /[?&]amount=(\d{1,12}(?:\.\d{1,6})?)(?:&|$)/;

describe('the machine form of an amount is never grouped', () => {
  it.each([
    ['8300000', 'INR', '83000'],
    ['100000000', 'INR', '1000000'],
    ['12345678900', 'INR', '123456789'],
    ['12345', 'INR', '123.45'],
    ['934680000', 'USDT', '934.68'],
    ['1000000000000', 'USDT', '1000000'],
  ] as const)('%s %s → %s', (minor, asset, expected) => {
    const plain = plainMinor(minor, asset);
    expect(plain).toBe(expected);
    expect(plain, 'a grouped value breaks every consumer').not.toContain(',');
    expect(DEAL_FORM.test(plain), 'the deal form must accept it').toBe(true);
  });

  it('keeps full stored precision, unlike the display form', () => {
    // USDT displays to 2 places; a value crossing a boundary keeps all 6.
    expect(formatMinor('1234567', 'USDT')).toBe('1.23');
    expect(plainMinor('1234567', 'USDT')).toBe('1.234567');
  });

  it('does not change the display form, which stays grouped', () => {
    // The fix must not have flattened what people actually read.
    expect(formatMinor('8300000', 'INR')).toBe('83,000.00');
  });
});

describe('a carried amount reaches both consumers intact', () => {
  const carry = (plain: string) => `/app/new?scenario=INR_TO_USDT&amount=${plain}`;

  it('agrees across the sign-in screen and the deal form', () => {
    const dest = carry(plainMinor('8300000', 'INR'));
    expect(SIGN_IN.exec(dest)?.[1]).toBe('83000');
    expect(DEAL_FORM.test('83000')).toBe(true);
  });

  it('survives a trailing parameter after the amount', () => {
    const dest = `${carry('83000')}&invite=abc123`;
    expect(SIGN_IN.exec(dest)?.[1]).toBe('83000');
  });
});

describe('the sign-in screen cannot show a confidently wrong amount', () => {
  it('reads a grouped value as ABSENT rather than as its prefix', () => {
    // The exact regression: this used to yield "83".
    const dest = '/app/new?scenario=INR_TO_USDT&amount=83,000';
    expect(SIGN_IN.exec(dest)?.[1] ?? null).toBeNull();
  });

  it.each(['83abc', '8 3', '83,000.00', '', '1e5', '-83'])(
    'rejects the malformed value %j outright',
    (bad) => {
      const dest = `/app/new?scenario=INR_TO_USDT&amount=${bad}`;
      const matched = SIGN_IN.exec(dest)?.[1] ?? null;
      // Either no match at all, or — never — a truncated prefix of it.
      if (matched !== null) expect(bad).toBe(matched);
    },
  );

  it('never disagrees with the deal form about the same input', () => {
    /*
     * The invariant that actually matters. Whatever arrives, the two
     * screens either both accept it and agree on the number, or both
     * treat it as absent. They must never show different figures.
     */
    for (const candidate of ['83000', '83,000', '83000.50', 'abc', '', '9'.repeat(20), '0']) {
      const dest = `/app/new?amount=${candidate}`;
      const signIn = SIGN_IN.exec(dest)?.[1] ?? null;
      const dealForm = DEAL_FORM.test(candidate) ? candidate : null;
      expect(signIn, `disagreement on ${JSON.stringify(candidate)}`).toBe(dealForm);
    }
  });
});
