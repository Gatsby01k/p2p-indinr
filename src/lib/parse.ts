/**
 * Typed-amount parsing, shared by the client preview and the server.
 *
 * One implementation, used on both sides, so a figure the person saw and the
 * figure the server priced can never disagree about what they typed. No
 * floating point participates: the result is exact minor units as a bigint.
 *
 * Every function returns `null` rather than throwing, and `null` means "not a
 * well-formed amount" — the caller decides what to say about it, because the
 * right message differs between a live preview and a submitted form.
 */

/** Digits a person might paste: grouping separators and spaces are tolerated. */
function clean(input: string): string {
  return input.replace(/[\s,_ ]/g, '');
}

/**
 * Rupees → paise. Up to two decimal places.
 *
 * `"1,25,000.50"` → `12500050n`. A third decimal is rejected rather than
 * silently truncated: a person typing `100.005` means something, and quietly
 * dropping it would price a deal they did not ask for.
 */
export function parseInrToMinor(input: string): bigint | null {
  const text = clean(input);
  if (text === '') return null;
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? '').padEnd(2, '0'));
  const minor = whole * 100n + frac;
  return minor > 0n ? minor : null;
}

/** USDT → micro-USDT. Up to six decimal places. */
export function parseUsdtToMicro(input: string): bigint | null {
  const text = clean(input);
  if (text === '') return null;
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(text);
  if (!m) return null;
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? '').padEnd(6, '0'));
  const micro = whole * 1_000_000n + frac;
  return micro > 0n ? micro : null;
}

/**
 * Why an amount was rejected, in words a person can act on.
 *
 * Returns `null` when the amount is fine. Kept beside the parsers so the two
 * can never drift into disagreeing about what is valid.
 */
export function amountProblem(input: string, asset: 'INR' | 'USDT'): string | null {
  const text = clean(input);
  if (text === '') return null; // empty is "not yet", not "wrong"
  if (!/^[\d.]+$/.test(text)) return 'Digits only — no symbols or letters.';
  if ((text.match(/\./g) ?? []).length > 1) return 'That has more than one decimal point.';

  const parsed = asset === 'INR' ? parseInrToMinor(text) : parseUsdtToMicro(text);
  if (parsed !== null) return null;

  const dot = text.indexOf('.');
  if (dot >= 0) {
    const places = text.length - dot - 1;
    const max = asset === 'INR' ? 2 : 6;
    if (places > max) {
      return asset === 'INR'
        ? 'Rupees go to two decimal places.'
        : 'USDT goes to six decimal places at most.';
    }
  }
  if (/^0*(\.0*)?$/.test(text)) return 'Enter an amount greater than zero.';
  return 'That amount is too large.';
}

/**
 * The UTR shape, defined once.
 *
 * Twelve alphanumerics, matching a real bank reference. Case and surrounding
 * whitespace are normalised rather than punished — someone copying a
 * reference out of an SMS in lowercase has still given the right reference.
 */
export const UTR_LENGTH = 12;

export function normaliseUtr(input: string): string {
  return input.trim().toUpperCase().replace(/\s/g, '');
}

export function isValidUtr(input: string): boolean {
  return /^[0-9A-Z]{12}$/.test(normaliseUtr(input));
}
