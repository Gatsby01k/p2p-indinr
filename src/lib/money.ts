/**
 * Money primitives.
 *
 * TS-01.4 §1.1 — "amount is a signed exact integer in the asset's smallest unit
 * (USDT 6 dp, TRX 6 dp). Floating-point representation MUST NOT appear in any
 * layer that produces or validates postings."
 *
 * The UI is not a posting-producing layer, but it displays and collects money.
 * We hold every amount as a bigint of minor units so that no float ever touches
 * a value a user reads or types. Formatting is the only place a decimal string
 * is constructed, and it is constructed by digit surgery, never by division.
 */

export type AssetCode = 'INR' | 'USDT';

export const ASSET_DECIMALS: Readonly<Record<AssetCode, number>> = {
  INR: 2,
  USDT: 6,
};

/**
 * How each asset is written. **USDT is never `$`.**
 *
 * `$560` is wrong and dangerous: USDT is not US dollars, it does not trade at
 * exactly one dollar, and a customer converting INR must never be shown a
 * figure that reads as a fiat dollar amount. USDT is written as a trailing
 * ticker — `560 USDT` — and INR keeps the ₹ prefix Indian users expect.
 */
export const ASSET_SYMBOL: Readonly<Record<AssetCode, string>> = {
  INR: '₹',
  USDT: '',
};

/** `prefix` sits before the number, `suffix` after it. */
export const ASSET_AFFIX: Readonly<Record<AssetCode, { prefix: string; suffix: string }>> = {
  INR: { prefix: '₹', suffix: '' },
  USDT: { prefix: '', suffix: ' USDT' },
};

/* ------------------------------------------------------------------ *
 * PRODUCT PRECISION RULE — one rule, stated once, applied everywhere.
 *
 *   INR   is always shown with exactly 2 decimals.       ₹49,728.00
 *   USDT  is stored at 6 dp and shown at up to 2 dp,
 *         trailing zeros trimmed, and NEVER rounded up.  560 USDT
 *                                                        12.5 USDT
 *                                                        0.123456 USDT → 0.12 USDT
 *
 * Why display precision is lower than storage precision: a settlement figure
 * a person has to read, repeat to their bank, or check against a screenshot
 * must be legible. Six decimals is machine precision, not human precision.
 *
 * Why truncation and never rounding: rounding a displayed balance UP would
 * show a customer more than exists. Truncation can only ever understate, and
 * `DISPLAY_IS_APPROXIMATE` marks the value so a caller can render an exact
 * figure where exactness matters (confirmation screens, receipts).
 *
 * The stored `minor` value is untouched. This governs presentation only.
 * ------------------------------------------------------------------ */
export const DISPLAY_DECIMALS: Readonly<Record<AssetCode, number>> = {
  INR: 2,
  USDT: 2,
};

/** Assets whose display may truncate, so callers can flag approximation. */
export const DISPLAY_TRUNCATES: Readonly<Record<AssetCode, boolean>> = {
  INR: false,
  USDT: true,
};

/** An exact monetary quantity in an asset's smallest unit. */
export interface Money {
  readonly asset: AssetCode;
  /** Minor units. INR → paise. USDT → 1e-6 USDT. */
  readonly minor: bigint;
}

export function money(asset: AssetCode, minor: bigint | number | string): Money {
  return { asset, minor: BigInt(minor) };
}

export function zero(asset: AssetCode): Money {
  return { asset, minor: 0n };
}

export function isZero(m: Money): boolean {
  return m.minor === 0n;
}

export function addMoney(a: Money, b: Money): Money {
  assertSameAsset(a, b);
  return { asset: a.asset, minor: a.minor + b.minor };
}

export function subMoney(a: Money, b: Money): Money {
  assertSameAsset(a, b);
  return { asset: a.asset, minor: a.minor - b.minor };
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameAsset(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

function assertSameAsset(a: Money, b: Money): void {
  if (a.asset !== b.asset) {
    throw new Error(`Cross-asset arithmetic is forbidden: ${a.asset} vs ${b.asset}`);
  }
}

/**
 * Parse user input into exact minor units without float arithmetic.
 * Returns null for anything that is not a well-formed non-negative decimal
 * within the asset's precision.
 */
export function parseAmount(input: string, asset: AssetCode): Money | null {
  const decimals = ASSET_DECIMALS[asset];
  const cleaned = input.replace(/[\s,_]/g, '');
  if (cleaned === '') return null;
  if (!/^\d*(\.\d*)?$/.test(cleaned)) return null;

  const dot = cleaned.indexOf('.');
  const wholePart = dot === -1 ? cleaned : cleaned.slice(0, dot);
  const fracRaw = dot === -1 ? '' : cleaned.slice(dot + 1);
  if (fracRaw.length > decimals) return null;
  if (wholePart === '' && fracRaw === '') return null;

  const whole = wholePart === '' ? '0' : wholePart;
  const frac = fracRaw.padEnd(decimals, '0');
  const digits = `${whole}${frac}`.replace(/^0+(?=\d)/, '');
  return { asset, minor: BigInt(digits) };
}

/** Exact decimal string, no grouping. `12345` paise → "123.45". */
export function toDecimalString(m: Money): string {
  const decimals = ASSET_DECIMALS[m.asset];
  const negative = m.minor < 0n;
  const abs = negative ? -m.minor : m.minor;
  const s = abs.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals === 0 ? '' : s.slice(s.length - decimals);
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Indian digit grouping: 12,34,567 — not 1,234,567. */
function groupIndian(whole: string): string {
  if (whole.length <= 3) return whole;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

export interface FormatOptions {
  /** Show the currency symbol. Default true. */
  readonly symbol?: boolean;
  /**
   * Trim trailing zeros in the fraction. Default true for USDT, false for INR —
   * INR is shown to a stable 2 dp so amounts do not visually jitter.
   */
  readonly trim?: boolean;
  /**
   * Print the full stored precision instead of the display precision.
   *
   * Use wherever the customer is committing to or reconciling an exact figure
   * — confirmation screens, receipts, dispute evidence — so that what they
   * agree to is what is recorded.
   */
  readonly exact?: boolean;
}

/** Display form. `1234567` paise → "₹12,345.67". */
/**
 * Format a monetary quantity under the product precision rule above.
 *
 * `exact: true` opts out of USDT truncation and prints the full stored
 * precision — use it wherever a customer is committing to a figure.
 */
export function formatMoney(m: Money, options: FormatOptions = {}): string {
  const storedDecimals = ASSET_DECIMALS[m.asset];
  const exactMode = options.exact ?? false;
  const displayDecimals = exactMode ? storedDecimals : DISPLAY_DECIMALS[m.asset];
  const showSymbol = options.symbol ?? true;
  const trim = options.trim ?? m.asset === 'USDT';

  const exact = toDecimalString(m);
  const negative = exact.startsWith('-');
  const unsigned = negative ? exact.slice(1) : exact;
  const dot = unsigned.indexOf('.');
  const whole = dot === -1 ? unsigned : unsigned.slice(0, dot);
  let frac = dot === -1 ? '' : unsigned.slice(dot + 1);

  // Truncate, never round: a displayed figure may understate, never overstate.
  if (frac.length > displayDecimals) frac = frac.slice(0, displayDecimals);

  if (trim) frac = frac.replace(/0+$/, '');
  else frac = frac.padEnd(displayDecimals, '0');

  const grouped = m.asset === 'INR' ? groupIndian(whole) : groupWestern(whole);
  const body = frac ? `${grouped}.${frac}` : grouped;

  if (!showSymbol) return `${negative ? '-' : ''}${body}`;
  const { prefix, suffix } = ASSET_AFFIX[m.asset];
  return `${negative ? '-' : ''}${prefix}${body}${suffix}`;
}

/**
 * True when `formatMoney` truncated real precision away, so a caller can add
 * an "approximately" affordance or switch to `exact`.
 */
export function displayIsApproximate(m: Money): boolean {
  if (!DISPLAY_TRUNCATES[m.asset]) return false;
  const exact = toDecimalString(m);
  const dot = exact.indexOf('.');
  if (dot === -1) return false;
  const frac = exact.slice(dot + 1).replace(/0+$/, '');
  return frac.length > DISPLAY_DECIMALS[m.asset];
}

function groupWestern(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Compact accessible label, e.g. "12,345.67 rupees". */
export function moneyAriaLabel(m: Money): string {
  const noun = m.asset === 'INR' ? 'rupees' : 'USDT';
  return `${formatMoney(m, { symbol: false })} ${noun}`;
}
