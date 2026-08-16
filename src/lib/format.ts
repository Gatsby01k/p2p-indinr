/**
 * Minor-unit formatting for values that arrive from the server as exact
 * integer strings.
 *
 * PRODUCT PRECISION RULE (see also src/lib/money.ts):
 *
 *   INR   exactly 2 decimals, Indian digit grouping.   49,728.00
 *   USDT  up to 2 decimals, trailing zeros trimmed,
 *         TRUNCATED never rounded up.                   560 · 12.5 · 0.12
 *
 * USDT is written with a trailing ` USDT` ticker by callers and is NEVER
 * prefixed with `$`: USDT is not US dollars and must not be displayed as if it
 * were. Truncation can only understate, never overstate, a holding.
 *
 * Everything here operates on `bigint`/decimal strings. No value passes
 * through a JavaScript `number`, so nothing is lost above 2^53.
 */

const DECIMALS = { INR: 2, USDT: 6 } as const;
const DISPLAY_DECIMALS = { INR: 2, USDT: 2 } as const;
const TRIM = { INR: false, USDT: true } as const;

export type MinorAsset = keyof typeof DECIMALS;

/** Group a whole-number string: Indian for INR, western for USDT. */
function group(whole: string, asset: MinorAsset): string {
  if (asset !== 'INR') return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (whole.length <= 3) return whole;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/**
 * Format an exact minor-unit integer string for display.
 *
 * @param minor exact integer string, e.g. "500000000" micro-USDT
 * @param asset which precision rule to apply
 * @param exact print full stored precision instead of display precision
 */
export function formatMinor(minor: string, asset: MinorAsset, exact = false): string {
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).replace(/^0+(?=\d)/, '');
  const scale = DECIMALS[asset];

  const padded = digits.padStart(scale + 1, '0');
  const whole = padded.slice(0, padded.length - scale);
  let frac = padded.slice(padded.length - scale);

  const want = exact ? scale : DISPLAY_DECIMALS[asset];
  // Truncate — never round. A displayed figure may understate, never overstate.
  if (frac.length > want) frac = frac.slice(0, want);
  if (TRIM[asset] || exact) frac = frac.replace(/0+$/, '');
  else frac = frac.padEnd(want, '0');

  const body = frac ? `${group(whole, asset)}.${frac}` : group(whole, asset);
  return `${negative ? '-' : ''}${body}`;
}

/**
 * The MACHINE form of a minor-unit value: a plain decimal, no grouping.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  USE THIS WHENEVER AN AMOUNT CROSSES A BOUNDARY THAT PARSES IT.    │
 * │                                                                    │
 * │  A URL parameter, a form value, a header, an API field. Never      │
 * │  `formatMinor` — that applies Indian digit grouping, so ₹83,000    │
 * │  becomes the string "83,000", and every reader then has to guess.  │
 * │                                                                    │
 * │  DEL-10 found exactly that. The calculator handed the display      │
 * │  string to `/login?next=…&amount=83,000`, where two consumers      │
 * │  disagreed about it: the sign-in screen matched `[0-9.]+`, stopped │
 * │  at the comma and told the person their deal was for ₹83; the      │
 * │  deal form applied an anchored pattern, rejected it outright and   │
 * │  silently lost the amount. One value, two wrong answers, no error. │
 * │                                                                    │
 * │  Full stored precision, never display precision: a value that is   │
 * │  about to be re-parsed must not be truncated on the way through.   │
 * └────────────────────────────────────────────────────────────────────┘
 */
export function plainMinor(minor: string, asset: MinorAsset): string {
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).replace(/^0+(?=\d)/, '');
  const scale = DECIMALS[asset];

  const padded = digits.padStart(scale + 1, '0');
  const whole = padded.slice(0, padded.length - scale);
  const frac = padded.slice(padded.length - scale).replace(/0+$/, '');

  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** True when `formatMinor` dropped real precision, so callers can say so. */
export function minorIsApproximate(minor: string, asset: MinorAsset): boolean {
  const scale = DECIMALS[asset];
  const digits = minor.replace(/^-/, '').padStart(scale + 1, '0');
  const frac = digits.slice(digits.length - scale).replace(/0+$/, '');
  return frac.length > DISPLAY_DECIMALS[asset];
}
