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
/** Telegram usernames and Mini App short names share this alphabet. */
const NAME = /^[A-Za-z0-9_]{3,32}$/;

/**
 * Why a configured value was rejected, in words that name the fix.
 *
 * Returned alongside the parsed value so the diagnostics screen can tell
 * "nobody set this" apart from "this is set to something that cannot
 * work" — two very different situations that used to look identical.
 */
export type MiniAppProblem =
  | { readonly kind: 'UNSET' }
  | { readonly kind: 'INVALID'; readonly reason: string };

function parse(raw: string | undefined): { base: string | null; problem: MiniAppProblem | null } {
  const value = raw?.trim();
  if (!value) return { base: null, problem: { kind: 'UNSET' } };

  const invalid = (reason: string) => ({
    base: null,
    problem: { kind: 'INVALID' as const, reason },
  });

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid('It is not a URL. It should look like https://t.me/YourBot/app');
  }

  if (url.protocol !== 'https:') return invalid('It must start with https://');
  if (url.hostname !== 't.me' && url.hostname !== 'telegram.me') {
    return invalid(`The host must be t.me, not ${url.hostname}`);
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return invalid('It is missing the bot username after t.me/');
  if (segments.length > 2) return invalid('It has too many parts after t.me/');

  /*
   * A leading `@` is the single most natural mistake here, because that is
   * how a bot is written everywhere else in Telegram. But `t.me/@Bot`
   * redirects rather than resolving, so it silently produces a link that
   * does not open the app. Strip it instead of refusing: the intent is
   * unambiguous and rejecting it helps nobody.
   */
  const bot = segments[0]!.replace(/^@/, '');
  if (!NAME.test(bot)) return invalid(`"${segments[0]}" is not a valid bot username`);

  const short = segments[1];
  if (short !== undefined && !NAME.test(short)) {
    return invalid(`"${short}" is not a valid Mini App short name`);
  }

  /*
   * BOTH FORMS ARE ACCEPTED, and this is the part that was wrong before.
   *
   *   t.me/<bot>/<app>   a named direct-link Mini App, from /newapp
   *   t.me/<bot>         a bot whose MAIN Mini App is configured — Telegram
   *                      opens it directly, and `?startapp=` still arrives
   *
   * Requiring two segments rejected the second form, which is a perfectly
   * ordinary way to ship a Mini App.
   */
  const path = short ? `/${bot}/${short}` : `/${bot}`;
  return { base: `https://${url.hostname}${path}`, problem: null };
}

const PARSED = parse(RAW);

export const MINI_APP_BASE: string | null = PARSED.base;

/** Why the address is unusable, or null when it is fine. */
export const MINI_APP_PROBLEM: MiniAppProblem | null = PARSED.problem;

/** The value as configured, for a diagnostics screen. Never a secret. */
export const MINI_APP_RAW: string | null = RAW?.trim() || null;

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
