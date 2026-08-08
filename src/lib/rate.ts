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

/**
 * How long a deal link stays open before it can no longer be joined.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A DEAL LINK IS SENT INTO A CHAT, AND CHATS ARE READ LATE.         │
 * │                                                                    │
 * │  This was 30 minutes, which is roughly the worst possible value:   │
 * │  long enough to look deliberate, far too short to survive the      │
 * │  actual journey. Someone creates a deal, forwards it on WhatsApp   │
 * │  or Telegram, and the recipient opens it that evening — to be      │
 * │  told the link expired and to "ask the sender". The product's one  │
 * │  core motion failed for everybody who did not join within half an  │
 * │  hour.                                                             │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * The two windows differ because the risk differs, and the difference is
 * the whole reason there are two constants:
 *
 *   A PROTECTED PAYMENT has no rate. Nothing about it decays, so the link
 *   can live as long as a message realistically waits to be read.
 *
 *   AN EXCHANGE freezes a rate at creation. Honouring it indefinitely
 *   would mean holding a price against the market for free, which is not
 *   a product decision so much as a donation. A day is long enough for a
 *   counterparty to see the message and short enough to be defensible.
 *
 * Both are still enforced entirely server-side against the database clock.
 */
export const LINK_TTL_SECONDS_PROTECTED = 7 * 24 * 60 * 60;
export const LINK_TTL_SECONDS_EXCHANGE = 24 * 60 * 60;

/** The window for a given scenario. */
export function linkTtlSeconds(direction: 'INR_TO_INR' | 'INR_TO_USDT' | 'USDT_TO_INR'): number {
  return direction === 'INR_TO_INR' ? LINK_TTL_SECONDS_PROTECTED : LINK_TTL_SECONDS_EXCHANGE;
}

/**
 * Kept so existing callers and tests keep compiling. Prefer
 * `linkTtlSeconds`, which knows which kind of deal it is being asked about.
 */
export const LINK_TTL_SECONDS = LINK_TTL_SECONDS_EXCHANGE;

/**
 * How long the payer has to send the money once someone joins.
 *
 * Fifteen minutes assumed both people were already at their phones. A
 * bank transfer means leaving the app, opening a banking app, possibly
 * waiting for an OTP — and the deadline is what an operator later treats
 * as "the payer did not act". Two hours reflects the real task.
 */
export const PAYMENT_WINDOW_MINUTES = 120;

/**
 * How long the receiver has to check their account and confirm.
 *
 * Missing it releases nothing and refunds nothing — it only opens the deal
 * to operator review. Nothing in this product moves on a timer.
 */
export const CONFIRM_WINDOW_MINUTES = 120;
