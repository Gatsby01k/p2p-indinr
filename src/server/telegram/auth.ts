import 'server-only';
import { randomBytes } from 'node:crypto';
import { getPool } from '@/server/db/pool';
import type { SessionUser } from '@/lib/sandboxContract';
import { displayNameFor, type TelegramUser } from './verify';

/**
 * Turning a verified Telegram launch into an INRP2P account.
 *
 * Called ONLY from the route that has already checked the initData HMAC.
 * Nothing in this file re-derives trust — it takes an already-proven
 * `TelegramUser` and finds or creates the account it maps to.
 *
 * ⚠ TWO PRIVILEGES ARE NEVER GRANTED HERE.
 *
 *   `is_operator` is never set and never updated. Operator access is
 *   granted deliberately, out of band; a value arriving from a client
 *   launch — however well signed — must not be able to create an operator.
 *
 *   An existing account is never RE-KEYED to a different Telegram id.
 *   `UNIQUE(telegram_id)` plus matching on that column alone means one
 *   Telegram account resolves to exactly one INRP2P account, forever.
 */

/** A referral code that is pronounceable enough to type from a screenshot. */
function newReferralCode(seed: string): string {
  const base =
    seed
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 8) || 'inrp2p';
  return `${base}${randomBytes(3).toString('hex')}`.slice(0, 16);
}

/**
 * A UPI-shaped sandbox handle, so the payment screens have something to
 * address from the very first deal instead of demanding setup first.
 *
 * Must satisfy the same pattern the payment-method validator enforces:
 * `name@bank`, letters, digits, dot, dash and underscore only.
 */
function sandboxUpiHandle(user: TelegramUser): string {
  const local = (user.username ?? `tg${user.id}`).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return `${local || `tg${user.id}`}@sandboxupi`;
}

export interface TelegramSignIn {
  readonly user: SessionUser;
  /** True the first time this Telegram account was seen. */
  readonly created: boolean;
}

export async function signInWithTelegram(tg: TelegramUser): Promise<TelegramSignIn> {
  const displayName = displayNameFor(tg);

  /*
   * One statement, so a race between two simultaneous launches of the same
   * Mini App cannot create two accounts. `ON CONFLICT (telegram_id)`
   * refreshes only the profile fields Telegram owns — the display name,
   * the @username and the avatar — and touches nothing else.
   *
   * `xmax = 0` is PostgreSQL's own signal that the row came from the INSERT
   * rather than the UPDATE branch, which is how we know whether to welcome
   * someone or simply let them back in.
   */
  const { rows } = await getPool().query(
    `INSERT INTO sandbox.app_user
       (telegram_id, telegram_username, photo_url, display_name, is_operator, is_verified)
     VALUES ($1,$2,$3,$4, FALSE, TRUE)
     ON CONFLICT (telegram_id) DO UPDATE
       SET display_name      = EXCLUDED.display_name,
           telegram_username = EXCLUDED.telegram_username,
           photo_url         = EXCLUDED.photo_url
     RETURNING user_id, email, display_name, is_operator, is_verified,
               telegram_username, (xmax = 0) AS created`,
    [tg.id, tg.username, tg.photoUrl, displayName],
  );
  const r = rows[0]!;

  // Same bootstrap the email sign-in performs: a profile so the trust
  // surface has a row, and one addressable handle so the pay screen works.
  // Neither holds a credential.
  await getPool().query(
    `INSERT INTO sandbox.user_profile (user_id, referral_code, identity_verified)
     VALUES ($1,$2,TRUE)
     ON CONFLICT (user_id) DO NOTHING`,
    [r.user_id, newReferralCode(tg.username ?? `tg${tg.id}`)],
  );
  await getPool().query(
    `INSERT INTO sandbox.payment_method (user_id, kind, label, handle, is_default, verified)
     SELECT $1, 'UPI', 'Primary UPI', $2, TRUE, TRUE
      WHERE NOT EXISTS (SELECT 1 FROM sandbox.payment_method WHERE user_id = $1)`,
    [r.user_id, sandboxUpiHandle(tg)],
  );

  await getPool().query(
    `INSERT INTO sandbox.audit_event
       (actor_id, action, subject_kind, subject_id, outcome, detail)
     VALUES ($1,'TELEGRAM_SIGN_IN','user',$1,'OK',$2)`,
    [r.user_id, JSON.stringify({ telegramId: tg.id, created: r.created === true })],
  );

  return {
    created: r.created === true,
    user: {
      userId: r.user_id,
      email: r.email ?? null,
      displayName: r.display_name,
      isOperator: r.is_operator,
      isVerified: r.is_verified,
    },
  };
}

/**
 * Where a `startapp=` payload should land.
 *
 * Telegram deep links carry one opaque token, so the product encodes its
 * destination in it:
 *
 *   `d_INRP-XXXXXXXXXX`  → the public page for that deal link
 *   `r_<code>`           → sign-up carrying a referral code
 *   anything else        → home
 *
 * Every branch returns a HARD-CODED relative path with a validated
 * fragment interpolated. The payload never becomes a path itself, so it
 * cannot be used to build an open redirect or to reach another origin.
 */
export function destinationForStartParam(startParam: string | null): string {
  if (!startParam) return '/app';

  const dealMatch = /^d_(INRP-[0-9A-HJ-NP-Z]{10})$/.exec(startParam);
  if (dealMatch) return `/d/${dealMatch[1]}`;

  const referralMatch = /^r_([a-z0-9]{6,16})$/.exec(startParam);
  if (referralMatch) return `/app?invite=${referralMatch[1]}`;

  return '/app';
}

/** The inverse: the `startapp` token that opens a given deal link. */
export function startParamForDeal(publicId: string): string {
  return `d_${publicId}`;
}

export function startParamForReferral(code: string): string {
  return `r_${code}`;
}
