/**
 * The Mini App's public address.
 *
 * A Telegram Mini App is reachable at `https://t.me/<bot>/<short-name>`,
 * and appending `?startapp=<payload>` both opens it and hands it a token.
 * That is the mechanism behind every deep link in this product: a deal
 * link shared inside Telegram opens the app on the deal, not a browser on
 * a web page.
 *
 * Configured through `NEXT_PUBLIC_TELEGRAM_MINI_APP` because the client
 * needs it to build a share URL. It is not a secret — it is the address
 * people are meant to send each other. The BOT TOKEN, which is secret,
 * lives only in `TELEGRAM_BOT_TOKEN` and never leaves the server.
 *
 * Everything degrades cleanly when it is unset: `miniAppLink` returns null
 * and the product shares its ordinary web URL instead.
 */

const RAW = process.env.NEXT_PUBLIC_TELEGRAM_MINI_APP;

/**
 * The configured base address, or null.
 *
 * Validated rather than trusted: a misconfigured value would otherwise be
 * interpolated into a share message and sent to a counterparty, which is
 * the worst possible place to discover a typo.
 */
function base(): string | null {
  const value = RAW?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (url.hostname !== 't.me' && url.hostname !== 'telegram.me') return null;
    // Expect `/<bot>/<app>`; anything shorter is not a Mini App address.
    if (url.pathname.split('/').filter(Boolean).length < 2) return null;
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return null;
  }
}

export const MINI_APP_BASE: string | null = base();

/** True when this deployment can produce Telegram deep links at all. */
export function miniAppConfigured(): boolean {
  return MINI_APP_BASE !== null;
}

/**
 * A deep link that opens the Mini App carrying `payload`.
 *
 * Telegram restricts `startapp` to `A-Za-z0-9_-` and silently drops a
 * value containing anything else, so an invalid payload returns null
 * rather than producing a link that opens the app on the wrong screen.
 */
export function miniAppLink(payload: string): string | null {
  if (!MINI_APP_BASE) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(payload)) return null;
  return `${MINI_APP_BASE}?startapp=${payload}`;
}

/** The deep link that opens a specific deal link inside Telegram. */
export function miniAppDealLink(publicId: string): string | null {
  return miniAppLink(`d_${publicId}`);
}

/** The deep link that carries a referral code through sign-up. */
export function miniAppReferralLink(code: string): string | null {
  return miniAppLink(`r_${code}`);
}
