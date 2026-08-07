import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Telegram Mini App launch-parameter verification.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THIS IS THE AUTHENTICATION BOUNDARY.                              │
 * │                                                                    │
 * │  A Mini App receives `initData` — a query string describing who    │
 * │  opened it. The browser can set that string to anything, so it is  │
 * │  worth nothing on its own. What makes it evidence is `hash`: an    │
 * │  HMAC Telegram computed over the other fields using a key derived  │
 * │  from the BOT TOKEN, which only Telegram and this server know.     │
 * │                                                                    │
 * │  Everything downstream — which account is signed in, whose deals   │
 * │  are shown — rests on the check in this file. It therefore:        │
 * │    · fails closed on a missing or short bot token;                 │
 * │    · compares the digest in constant time;                         │
 * │    · rejects launch data older than a fixed window, so a captured  │
 * │      initData string cannot be replayed indefinitely;              │
 * │    · returns a CLOSED result union, never a boolean plus           │
 * │      out-of-band data a caller might use before checking it.       │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Deliberately free of database and framework imports so it can be tested
 * as a pure function against Telegram's published algorithm.
 */

/* ------------------------------------------------------------------ *
 * What a verified launch tells us
 * ------------------------------------------------------------------ */

export interface TelegramUser {
  readonly id: number;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly username: string | null;
  readonly languageCode: string | null;
  readonly isPremium: boolean;
  /** Telegram CDN URL. Always https, or absent. */
  readonly photoUrl: string | null;
}

export interface TelegramLaunch {
  readonly user: TelegramUser;
  /** The `startapp=` payload, when the app was opened through a deep link. */
  readonly startParam: string | null;
  readonly authDate: Date;
  /** Telegram's own chat-instance id, useful only for diagnostics. */
  readonly chatInstance: string | null;
}

export type VerifyFailure =
  | 'NO_BOT_TOKEN'
  | 'MALFORMED'
  | 'NO_HASH'
  | 'BAD_SIGNATURE'
  | 'STALE'
  | 'NO_USER';

export type VerifyResult =
  | { readonly ok: true; readonly launch: TelegramLaunch }
  | { readonly ok: false; readonly reason: VerifyFailure };

/**
 * How long a launch signature stays acceptable.
 *
 * Telegram does not expire `initData`, so this window is ours. Twenty-four
 * hours matches how long a Mini App session realistically stays open while
 * still bounding replay of a string captured from a log or a shared device.
 */
export const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;

/** Small allowance for clock skew between Telegram and this server. */
const FUTURE_SKEW_SECONDS = 60;

/**
 * Fields excluded from the signed payload.
 *
 * `hash` is the signature itself. `signature` is Telegram's separate
 * Ed25519 third-party attestation, which is not part of the bot-token
 * check and breaks it if included.
 */
const UNSIGNED_FIELDS = new Set(['hash', 'signature']);

function botToken(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  // A real token is `<digits>:<35 chars>`. Anything shorter is a
  // placeholder someone pasted, and treating it as a key would mean
  // verifying signatures against a secret an attacker can guess.
  if (!token || token.length < 20) return null;
  return token;
}

/** True when a bot token is configured, so callers can offer the flow at all. */
export function telegramConfigured(): boolean {
  return botToken() !== null;
}

/**
 * Verify `initData` and return who launched the app.
 *
 * @param initData the raw query string from `Telegram.WebApp.initData`
 * @param now      injectable clock, for tests
 */
export function verifyInitData(initData: string, now: Date = new Date()): VerifyResult {
  const token = botToken();
  if (!token) return { ok: false, reason: 'NO_BOT_TOKEN' };
  if (typeof initData !== 'string' || initData.length === 0 || initData.length > 8192) {
    return { ok: false, reason: 'MALFORMED' };
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }

  const providedHash = params.get('hash');
  if (!providedHash || !/^[0-9a-f]{64}$/i.test(providedHash)) {
    return { ok: false, reason: 'NO_HASH' };
  }

  // The data-check string: every other field as `key=value`, sorted by key,
  // joined with newlines. Sorting is what makes the digest independent of
  // the order Telegram happened to serialise them in.
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (UNSIGNED_FIELDS.has(key)) continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(providedHash.toLowerCase(), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }

  // Freshness is checked ONLY after the signature holds. Reading a claimed
  // timestamp from unverified data and acting on it would be trusting the
  // very thing we are here to verify.
  const authDateRaw = Number(params.get('auth_date'));
  if (!Number.isFinite(authDateRaw) || authDateRaw <= 0) {
    return { ok: false, reason: 'STALE' };
  }
  const ageSeconds = Math.floor(now.getTime() / 1000) - authDateRaw;
  if (ageSeconds > MAX_AUTH_AGE_SECONDS || ageSeconds < -FUTURE_SKEW_SECONDS) {
    return { ok: false, reason: 'STALE' };
  }

  const user = parseUser(params.get('user'));
  if (!user) return { ok: false, reason: 'NO_USER' };

  return {
    ok: true,
    launch: {
      user,
      startParam: sanitizeStartParam(params.get('start_param')),
      authDate: new Date(authDateRaw * 1000),
      chatInstance: params.get('chat_instance'),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

function parseUser(raw: string | null): TelegramUser | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const u = parsed as Record<string, unknown>;
  const id = typeof u.id === 'number' ? u.id : Number(u.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  const firstName = str(u.first_name)?.slice(0, 64) ?? '';
  const lastName = str(u.last_name)?.slice(0, 64) ?? null;
  const username = str(u.username)?.slice(0, 32) ?? null;

  // A person with no first name and no username still needs a label; the
  // caller decides what to show, but it never gets an empty string.
  if (!firstName && !username) return null;

  return {
    id,
    firstName,
    lastName,
    username,
    languageCode: str(u.language_code)?.slice(0, 12) ?? null,
    isPremium: u.is_premium === true,
    photoUrl: httpsOnly(str(u.photo_url)),
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Only `https:` URLs survive.
 *
 * This value is rendered as an image source, so a `javascript:` or `data:`
 * URI arriving here would be a scripting vector. The database enforces the
 * same rule, but a value should never reach it in the first place.
 */
function httpsOnly(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The deep-link payload.
 *
 * Telegram restricts `startapp` to `A-Za-z0-9_-`, and so do we: this value
 * decides where a person lands, and an unconstrained string reaching a
 * router is how an open redirect is built.
 */
function sanitizeStartParam(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(trimmed) ? trimmed : null;
}

/**
 * The display name for a Telegram account.
 *
 * Falls back through first+last, then the @username, then the numeric id —
 * so a person always has a label, and it is never blank in a deal room.
 */
export function displayNameFor(user: TelegramUser): string {
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  if (full) return full.slice(0, 60);
  if (user.username) return user.username.slice(0, 60);
  return `Telegram ${user.id}`;
}
