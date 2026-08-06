/**
 * The sandbox reference price.
 *
 * An exact rational — INR paise per USDT micro — so no floating point ever
 * participates in a figure a person reads or agrees to.
 *
 * ⚠ THIS IS NOT A MARKET FEED. It is a fixed sandbox reference so the
 * journey has a rate at all. A production deployment replaces it with a
 * priced, timestamped, expiring quote from a real source; nothing else in
 * the codebase assumes the number is constant.
 *
 * Shared by the client preview and the server. The client's figure is
 * always labelled INDICATIVE: only the server's issued quote is binding,
 * because only the server can attach an expiry to it and honour it.
 */

export const REFERENCE_RATE = {
  num: 8880n, // 88.80 INR per USDT
  den: 100n,
  source: 'SANDBOX_REFERENCE',
} as const;

/** `88.80` — the rate as a display string, never used for arithmetic. */
export function rateDisplay(num: bigint = REFERENCE_RATE.num, den: bigint = REFERENCE_RATE.den) {
  return (Number(num) / Number(den)).toFixed(2);
}

/** How long a firm quote stays valid once issued. Enforced server-side. */
export const QUOTE_TTL_SECONDS = 150;

/** How long a deal link stays open before it can no longer be joined. */
export const LINK_TTL_SECONDS = 1800;

/** How long the payer has to send the money once someone joins. */
export const PAYMENT_WINDOW_MINUTES = 15;
