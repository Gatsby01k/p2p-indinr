/**
 * Canonical forms for external references.
 *
 * This lives in `lib` rather than `server` deliberately: these are pure
 * string rules with no secrets and no I/O, and the browser needs the
 * SAME ones. A UTR field that accepts something the server will refuse,
 * or refuses something the server would accept, is a form that lies to
 * the person filling it in. One definition, both sides.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  UNIQUENESS IS ONLY AS GOOD AS NORMALIZATION.                      │
 * │                                                                    │
 * │  `utr123456`, `UTR123456` and ` UTR123456 ` are one bank           │
 * │  reference. A unique index over the raw strings sees three, and a  │
 * │  system that sees three will happily credit one transfer three     │
 * │  times. Every reference is therefore normalized BEFORE it is       │
 * │  stored, compared, or looked up — never after, and never only on   │
 * │  one of those paths.                                               │
 * │                                                                    │
 * │  Normalization here is deliberately lossless-or-refuse. It trims   │
 * │  and cases; it does not "fix" a reference by stripping characters  │
 * │  it does not recognise, because a reference that needed fixing is  │
 * │  a reference somebody mistyped.                                    │
 * └────────────────────────────────────────────────────────────────────┘
 */

export type Normalized<T extends string> = { readonly ok: true; readonly value: T };
export type NormalizeFailure = { readonly ok: false; readonly reason: string };
export type NormalizeResult<T extends string> = Normalized<T> | NormalizeFailure;

const fail = (reason: string): NormalizeFailure => ({ ok: false, reason });

/**
 * A UTR: the 12-to-22 character reference an Indian bank puts on a
 * transfer. Upper-cased and trimmed; internal spaces are a rejection
 * rather than something to silently remove, because a UTR with a space in
 * it is not a UTR that was read correctly.
 */
export function normalizeUtr(raw: string): NormalizeResult<string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fail('A bank reference is required.');
  if (/\s/.test(trimmed)) return fail('A bank reference contains no spaces.');
  const upper = trimmed.toUpperCase();
  if (!/^[A-Z0-9]{6,32}$/.test(upper)) {
    return fail('A bank reference is 6 to 32 letters and digits.');
  }
  return { ok: true, value: upper };
}

/**
 * A TRON transaction hash: 32 bytes, hex, no `0x` prefix.
 *
 * TRON writes hashes bare while Ethereum writes them `0x`-prefixed, and
 * the same transfer copied from two explorers gives two strings. The
 * prefix is therefore accepted on input and removed in the canonical
 * form, so `0xAB…` and `ab…` collapse to one value and the uniqueness
 * index actually catches the duplicate.
 */
export function normalizeTxHash(raw: string): NormalizeResult<string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fail('A transaction hash is required.');
  const bare = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed;
  const lower = bare.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(lower)) {
    return fail('A transaction hash is 64 hexadecimal characters.');
  }
  return { ok: true, value: lower };
}

/**
 * A TRC20 address.
 *
 * Base58 alphabet — no `0`, `O`, `I` or `l`, because those are the
 * characters people confuse when copying by hand, and the alphabet
 * excluding them is the reason base58 exists. Length and leading `T` are
 * checked; the checksum is a chain concern and a production adapter's
 * job, which is stated rather than silently skipped.
 */
export function normalizeTronAddress(raw: string): NormalizeResult<string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fail('An address is required.');
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(trimmed)) {
    return fail('That is not a TRC20 address.');
  }
  return { ok: true, value: trimmed };
}

/**
 * Parse a rail amount into integer minor units.
 *
 * ACCEPTS ONLY AN INTEGER STRING. Not a number, not a decimal, not a
 * float. A decimal amount arriving from a provider means the provider
 * speaks major units and the caller has to decide the conversion
 * explicitly — silently multiplying by 10^decimals here is how a payment
 * of 1.5 USDT becomes 15, or 1.
 */
export function parseMinor(raw: unknown, label: string): NormalizeResult<string> {
  if (typeof raw === 'bigint') {
    return raw > 0n ? { ok: true, value: raw.toString() } : fail(`${label} must be positive.`);
  }
  if (typeof raw !== 'string') return fail(`${label} must be an integer string.`);
  const trimmed = raw.trim();
  if (!/^[1-9][0-9]{0,24}$/.test(trimmed)) {
    return fail(`${label} must be a positive integer in minor units.`);
  }
  return { ok: true, value: trimmed };
}

/** The networks each rail may legally use. Asked, never assumed. */
export const RAIL_NETWORKS = {
  INR: ['UPI', 'IMPS', 'NEFT'] as const,
  USDT: ['TRC20'] as const,
} as const;

export type Rail = keyof typeof RAIL_NETWORKS;
export type Network = (typeof RAIL_NETWORKS)[Rail][number];

/**
 * Is this network valid for this rail?
 *
 * The check is exhaustive rather than "not obviously wrong": an unknown
 * network string is refused, so a typo in a provider payload cannot fall
 * through to a default. This is the guard that stops a TRC20 transfer
 * being reconciled against a UPI intent.
 */
export function networkBelongsToRail(rail: string, network: string): boolean {
  const allowed = RAIL_NETWORKS[rail as Rail];
  return allowed !== undefined && (allowed as readonly string[]).includes(network);
}

/** The asset a rail moves. There is exactly one per rail, by design. */
export function assetForRail(rail: Rail): 'INR' | 'USDT' {
  return rail === 'INR' ? 'INR' : 'USDT';
}

/**
 * Normalize whatever reference this rail uses.
 *
 * One entry point, so no caller can normalize a UTR with the hash rule or
 * vice versa — a mistake that would produce references that never match
 * anything and payments that never settle.
 */
export function normalizeReference(rail: Rail, raw: string): NormalizeResult<string> {
  return rail === 'INR' ? normalizeUtr(raw) : normalizeTxHash(raw);
}

/**
 * Redact a reference for logging.
 *
 * A UTR is a payment credential in practice: quoting it to a bank is
 * often enough to ask questions about the transfer. Logs get the shape
 * and the ends, which is enough to correlate two log lines and not enough
 * to reuse.
 */
export function redactReference(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
}

/** Redact a destination — an account number, VPA or address. */
export function redactDestination(value: string): string {
  const at = value.indexOf('@');
  if (at > 0) {
    // A VPA: keep the handle, hide the identifier.
    return `${'*'.repeat(Math.min(at, 6))}${value.slice(at)}`;
  }
  return redactReference(value);
}
