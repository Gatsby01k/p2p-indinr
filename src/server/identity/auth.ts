import 'server-only';
import { createHash } from 'node:crypto';
import { getPool, withTransaction, type Tx } from '@/server/db/pool';
import { writeAudit } from '@/server/boundary/command';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { getEmailDeliveryAdapter } from '@/server/adapters/emailDelivery';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { digestsEqual, hashToken, mintNumericCode, mintToken } from './tokens';
import {
  bumpSessionVersionIn,
  issueSessionIn,
  markMfaSatisfiedIn,
  revokeAllSessions,
} from './sessions';
import { RATE_RULES, consumeRate } from './rateLimit';
import { generateSecret, verifyTotp } from './totp';
import type { TelegramUser } from '@/server/telegram/verify';

/**
 * Authentication.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHAT EACH PATH ACTUALLY PROVES.                                   │
 * │                                                                    │
 * │  EMAIL — control of the address, at this moment. A one-time code   │
 * │  is delivered out of band, stored only as a hash, and consumed by  │
 * │  a conditional UPDATE so it works exactly once. It proves nothing  │
 * │  about who the person is; it proves they receive that mailbox,     │
 * │  which is the honest claim and the one the UI now makes.           │
 * │                                                                    │
 * │  TELEGRAM — an HMAC Telegram computed with the bot token. That is  │
 * │  genuinely strong. What it lacked was single use: a captured       │
 * │  `initData` string authenticated for 24 hours (TS-00 AUD-P1-009).  │
 * │  Every accepted launch is now recorded by digest and refused a     │
 * │  second time.                                                      │
 * │                                                                    │
 * │  Neither path grants a role. Operator authority comes from         │
 * │  `role_grant` and is written out of band only.                     │
 * └────────────────────────────────────────────────────────────────────┘
 */

/** A sign-in code is short-lived by design; it is the weakest secret here. */
export const OTP_TTL_SECONDS = 10 * 60;
export const MAGIC_LINK_TTL_SECONDS = 15 * 60;

export interface StartedSignIn {
  readonly challengeId: string;
  /** The link token. Delivered by email; never returned to the browser. */
  readonly deliveredTo: string;
}

/* ------------------------------------------------------------------ *
 * Email: request a code
 * ------------------------------------------------------------------ */

/**
 * The stored hash of the TYPED code, salted with the address.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  EIGHT DIGITS CANNOT STAND ALONE IN A GLOBAL NAMESPACE.            │
 * │                                                                    │
 * │  If the code were hashed by itself, one guess would be tested      │
 * │  against every live challenge at once, and the odds of hitting     │
 * │  SOMEBODY's code would grow with the number of people signing in   │
 * │  — worst at the busiest moment. Mixing in the address it was       │
 * │  issued to pins each guess to a single mailbox, so the difficulty  │
 * │  is the same whether one person is signing in or a million.        │
 * │                                                                    │
 * │  The remaining budget is then held by the per-address verify rate  │
 * │  limit, single use and a fifteen-minute expiry — which is what     │
 * │  makes an 8-digit code acceptable at all.                          │
 * └────────────────────────────────────────────────────────────────────┘
 */
function codeHash(email: string, code: string): string {
  // The separator is a character the address cannot contain, so no pair
  // of (address, code) values can produce the same input string.
  return hashToken(`signin-code:${email} ${code}`);
}

/**
 * Begin an email sign-in.
 *
 * ⚠ THE RESULT IS THE SAME WHETHER OR NOT THE ADDRESS IS KNOWN.
 *
 * An endpoint that answered "no such account" would be an enumeration
 * oracle: anybody could test addresses against the user table. So an
 * unknown address takes the same path, consumes the same rate budget and
 * produces the same response — the code simply arrives at a mailbox whose
 * owner did not ask for it, and no account is created until one is
 * redeemed.
 */
export async function startEmailSignIn(
  emailRaw: string,
  binding?: string | null,
): Promise<Outcome<StartedSignIn>> {
  const email = emailRaw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return reject('AUTH_EMAIL_INVALID', FAILURE_COPY.AUTH_EMAIL_INVALID.reason);
  }

  const verdict = await consumeRate(RATE_RULES.SIGN_IN_REQUEST, email);
  if (!verdict.allowed) {
    return reject('RATE_LIMITED', FAILURE_COPY.RATE_LIMITED.reason, {
      retryAfterSeconds: verdict.retryAfterSeconds,
    });
  }

  // Throws in production: no mail provider exists, so no code is minted
  // and no challenge row is written. Fail closed before, not after.
  const delivery = getEmailDeliveryAdapter();

  const code = mintNumericCode();
  const linkToken = mintToken();
  /*
   * The link carries the high-entropy token; the code is the typable
   * fallback. Both hash into the same row, so redeeming either consumes
   * the challenge exactly once.
   *
   * ⚠ DEL-10: the second half of that sentence used to be untrue. Only
   * `hashToken(secret)` was stored, so the concatenation was the ONLY
   * credential that matched and the typed code was always refused —
   * while the screen kept offering a field for it. The code now has its
   * own hash, salted with the address (see `codeHash`), so eight digits
   * are only ever tested against the challenge for that one mailbox.
   */
  const secret = `${code}.${linkToken}`;

  const result = await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO sandbox.auth_challenge
         (email, purpose, token_hash, code_hash, request_binding, expires_at)
       VALUES ($1,'SIGN_IN',$2,$3,$4, now() + ($5 || ' seconds')::interval)
       RETURNING challenge_id`,
      [
        email,
        hashToken(secret),
        codeHash(email, code),
        binding ?? null,
        String(MAGIC_LINK_TTL_SECONDS),
      ],
    );
    await writeAudit(tx, {
      actorId: null,
      action: 'AUTH_CHALLENGE_ISSUE',
      subjectKind: 'user',
      // No account may exist yet, so the challenge is its own subject.
      subjectId: rows[0]!.challenge_id,
      outcome: 'OK',
      detail: { purpose: 'SIGN_IN' },
    });
    return rows[0]!.challenge_id as string;
  });

  await delivery.send({
    to: email,
    purpose: 'SIGN_IN',
    secret,
    expiresInSeconds: MAGIC_LINK_TTL_SECONDS,
  });

  return accept({ challengeId: result, deliveredTo: email });
}

/* ------------------------------------------------------------------ *
 * Email: redeem
 * ------------------------------------------------------------------ */

export interface SignedIn {
  readonly userId: string;
  readonly sessionToken: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly created: boolean;
}

/**
 * Redeem a code or magic link and issue a session.
 *
 * Single use is enforced by the database, not by reading and then
 * writing: the consuming `UPDATE` carries `consumed_at IS NULL` in its
 * WHERE clause, so of two concurrent redemptions exactly one affects a
 * row. The loser is told the credential is spent — which is true.
 */
export async function redeemEmailSignIn(input: {
  readonly email: string;
  readonly secret: string;
  readonly binding?: string | null;
  readonly deviceLabel?: string | null;
}): Promise<Outcome<SignedIn>> {
  const email = input.email.trim().toLowerCase();

  const verdict = await consumeRate(RATE_RULES.SIGN_IN_VERIFY, email);
  if (!verdict.allowed) {
    return reject('RATE_LIMITED', FAILURE_COPY.RATE_LIMITED.reason, {
      retryAfterSeconds: verdict.retryAfterSeconds,
    });
  }

  return withTransaction(async (tx) => {
    /*
     * TWO CREDENTIALS, ONE CHALLENGE.
     *
     * Whatever was typed is hashed both ways — as a full magic-link
     * secret and as a typed code for this address — and the row is
     * matched on either. A person pasting the link and a person typing
     * the eight digits from it reach the same challenge and consume it
     * exactly once, which is what DEL-03 intended and did not do.
     */
    const presented = hashToken(input.secret.trim());
    const presentedCode = codeHash(email, input.secret.trim());
    const { rows } = await tx.query(
      `SELECT challenge_id, email, token_hash, code_hash, request_binding, consumed_at,
              (expires_at <= now()) AS is_expired
         FROM sandbox.auth_challenge
        WHERE (token_hash = $1 OR code_hash = $2) AND purpose = 'SIGN_IN'
        FOR UPDATE`,
      [presented, presentedCode],
    );
    const challenge = rows[0];

    /*
     * One refusal for every failure mode.
     *
     * Wrong code, expired code, already-used code and wrong address are
     * deliberately indistinguishable to the caller: telling them apart
     * would say which addresses have pending sign-ins and which codes
     * were once valid. The audit row records what really happened.
     */
    const refuse = async (why: string) => {
      await writeAudit(tx, {
        actorId: null,
        action: 'AUTH_CHALLENGE_REDEEM',
        subjectKind: 'user',
        subjectId: challenge?.challenge_id ?? '00000000-0000-0000-0000-000000000000',
        outcome: 'AUTH_CHALLENGE_INVALID',
        detail: { why, email },
      });
      return reject('AUTH_CHALLENGE_INVALID', FAILURE_COPY.AUTH_CHALLENGE_INVALID.reason);
    };

    if (!challenge) return refuse('NO_SUCH_CHALLENGE');
    /*
     * Re-verify in constant time whichever credential the lookup found.
     * Both are compared — never short-circuited on the first — so the
     * time taken does not reveal which kind of credential was presented.
     */
    const linkMatches = digestsEqual(challenge.token_hash as string, presented);
    const codeMatches =
      challenge.code_hash !== null && digestsEqual(challenge.code_hash as string, presentedCode);
    if (!linkMatches && !codeMatches) return refuse('HASH_MISMATCH');
    if (challenge.email !== email) return refuse('EMAIL_MISMATCH');
    if (challenge.consumed_at !== null) return refuse('ALREADY_CONSUMED');
    if (challenge.is_expired) return refuse('EXPIRED');
    if (
      challenge.request_binding !== null &&
      challenge.request_binding !== (input.binding ?? null)
    ) {
      return refuse('BINDING_MISMATCH');
    }

    // The account is created only once a credential has actually been
    // proved — so a stranger requesting codes for other people's
    // addresses populates nothing.
    const { rows: userRows } = await tx.query(
      `INSERT INTO sandbox.app_user (email, display_name, is_operator, is_verified)
       VALUES ($1, $2, FALSE, FALSE)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING user_id, (xmax = 0) AS created`,
      [email, displayNameForEmail(email)],
    );
    const user = userRows[0]!;

    const claimed = await tx.query(
      `UPDATE sandbox.auth_challenge
          SET consumed_at = now(), consumed_by = $2
        WHERE challenge_id = $1 AND consumed_at IS NULL`,
      [challenge.challenge_id, user.user_id],
    );
    // Lost a concurrent race for the same credential.
    if (claimed.rowCount !== 1) return refuse('CONCURRENT_CONSUME');

    const session = await issueSessionIn(tx, {
      userId: user.user_id,
      origin: 'EMAIL_OTP',
      deviceLabel: input.deviceLabel ?? null,
    });

    await ensureProfileIn(tx, user.user_id);
    await writeAudit(tx, {
      actorId: user.user_id,
      action: 'AUTH_SIGN_IN',
      subjectKind: 'user',
      subjectId: user.user_id,
      outcome: 'OK',
      detail: { method: 'EMAIL_OTP', created: user.created === true, sessionId: session.sessionId },
    });

    return accept({
      userId: user.user_id,
      sessionToken: session.token,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      created: user.created === true,
    });
  });
}

function displayNameForEmail(email: string): string {
  const local = email.split('@')[0] ?? 'member';
  return (
    local
      .replace(/[._-]+/g, ' ')
      .split(' ')
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ') || 'Member'
  );
}

async function ensureProfileIn(tx: Tx, userId: string): Promise<void> {
  await tx.query(
    `INSERT INTO sandbox.user_profile (user_id, referral_code)
     VALUES ($1, substr(md5(random()::text), 1, 10))
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
}

/* ------------------------------------------------------------------ *
 * Telegram: single-use launches
 * ------------------------------------------------------------------ */

/**
 * Sign in from a verified Telegram launch.
 *
 * The caller has already checked the HMAC. What happens here is the part
 * that was missing: the launch digest is INSERTed, and its primary key
 * refuses a second presentation. A captured `initData` is therefore good
 * exactly once rather than for a day.
 *
 * Account linking is deliberately conservative. `telegram_id` is UNIQUE,
 * so one Telegram account maps to one INRP2P account forever, and an
 * existing account is never re-keyed. A Telegram launch never adopts an
 * account that already has an email owner — that would be a takeover
 * dressed up as convenience.
 */
export async function signInWithTelegramLaunch(input: {
  readonly user: TelegramUser;
  readonly initDataHash: string;
  readonly authDate: Date;
  readonly deviceLabel?: string | null;
}): Promise<Outcome<SignedIn>> {
  const verdict = await consumeRate(RATE_RULES.TELEGRAM_AUTH, String(input.user.id));
  if (!verdict.allowed) {
    return reject('RATE_LIMITED', FAILURE_COPY.RATE_LIMITED.reason, {
      retryAfterSeconds: verdict.retryAfterSeconds,
    });
  }

  const launchHash = createHash('sha256').update(input.initDataHash).digest('hex');

  return withTransaction(async (tx) => {
    const claimed = await tx.query(
      `INSERT INTO sandbox.telegram_launch (launch_hash, telegram_id, auth_date)
       VALUES ($1,$2,$3)
       ON CONFLICT (launch_hash) DO NOTHING
       RETURNING launch_hash`,
      [launchHash, input.user.id, input.authDate],
    );
    if (claimed.rowCount === 0) {
      await writeAudit(tx, {
        actorId: null,
        action: 'AUTH_SIGN_IN',
        subjectKind: 'user',
        subjectId: '00000000-0000-0000-0000-000000000000',
        outcome: 'TELEGRAM_LAUNCH_REPLAYED',
        detail: { telegramId: input.user.id },
      });
      return reject('TELEGRAM_LAUNCH_REPLAYED', FAILURE_COPY.TELEGRAM_LAUNCH_REPLAYED.reason);
    }

    const displayName =
      [input.user.firstName, input.user.lastName].filter(Boolean).join(' ').trim() ||
      input.user.username ||
      `Telegram ${input.user.id}`;

    const { rows } = await tx.query(
      `INSERT INTO sandbox.app_user
         (telegram_id, telegram_username, photo_url, display_name, is_operator, is_verified)
       VALUES ($1,$2,$3,$4, FALSE, FALSE)
       ON CONFLICT (telegram_id) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             telegram_username = EXCLUDED.telegram_username,
             photo_url = EXCLUDED.photo_url
       RETURNING user_id, (xmax = 0) AS created`,
      [input.user.id, input.user.username, input.user.photoUrl, displayName.slice(0, 60)],
    );
    const user = rows[0]!;

    const session = await issueSessionIn(tx, {
      userId: user.user_id,
      origin: 'TELEGRAM',
      deviceLabel: input.deviceLabel ?? 'Telegram',
    });

    await ensureProfileIn(tx, user.user_id);
    await writeAudit(tx, {
      actorId: user.user_id,
      action: 'AUTH_SIGN_IN',
      subjectKind: 'user',
      subjectId: user.user_id,
      outcome: 'OK',
      detail: {
        method: 'TELEGRAM',
        telegramId: input.user.id,
        created: user.created === true,
        sessionId: session.sessionId,
      },
    });

    return accept({
      userId: user.user_id,
      sessionToken: session.token,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      created: user.created === true,
    });
  });
}

/* ------------------------------------------------------------------ *
 * Account linking
 * ------------------------------------------------------------------ */

/**
 * Attach a Telegram identity to the signed-in account.
 *
 * Two collisions are possible and both are refused rather than resolved:
 *
 *   · the Telegram id already belongs to ANOTHER account — linking would
 *     hand this caller that account's history, so it is a takeover;
 *   · this account already carries a DIFFERENT Telegram id — re-keying
 *     would orphan the first.
 *
 * Neither is a merge this stage is competent to perform, so both stop.
 */
export async function linkTelegramIdentity(input: {
  readonly userId: string;
  readonly telegramId: number;
  readonly telegramUsername: string | null;
}): Promise<Outcome<{ readonly linked: boolean }>> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT user_id, telegram_id FROM sandbox.app_user WHERE user_id = $1 FOR UPDATE`,
      [input.userId],
    );
    const me = rows[0];
    if (!me) return reject('NOT_FOUND', 'That account does not exist.');

    const refuse = async (code: 'ACCOUNT_LINK_CONFLICT', why: string) => {
      await writeAudit(tx, {
        actorId: input.userId,
        action: 'ACCOUNT_LINK',
        subjectKind: 'user',
        subjectId: input.userId,
        outcome: code,
        detail: { why, telegramId: input.telegramId },
      });
      return reject(code, FAILURE_COPY.ACCOUNT_LINK_CONFLICT.reason);
    };

    if (me.telegram_id !== null && Number(me.telegram_id) !== input.telegramId) {
      return refuse('ACCOUNT_LINK_CONFLICT', 'ACCOUNT_ALREADY_LINKED');
    }
    if (me.telegram_id !== null) return accept({ linked: false }); // already this one

    const { rows: taken } = await tx.query(
      `SELECT user_id FROM sandbox.app_user WHERE telegram_id = $1`,
      [input.telegramId],
    );
    if (taken[0] && taken[0].user_id !== input.userId) {
      return refuse('ACCOUNT_LINK_CONFLICT', 'TELEGRAM_ID_TAKEN');
    }

    await tx.query(
      `UPDATE sandbox.app_user SET telegram_id = $2, telegram_username = $3 WHERE user_id = $1`,
      [input.userId, input.telegramId, input.telegramUsername],
    );
    await writeAudit(tx, {
      actorId: input.userId,
      action: 'ACCOUNT_LINK',
      subjectKind: 'user',
      subjectId: input.userId,
      outcome: 'OK',
      detail: { telegramId: input.telegramId },
    });
    return accept({ linked: true });
  });
}

/* ------------------------------------------------------------------ *
 * Second factor
 * ------------------------------------------------------------------ */

export interface Enrolment {
  readonly factorId: string;
  readonly secret: string;
  readonly recoveryCodes: readonly string[];
}

/**
 * Begin TOTP enrolment.
 *
 * The factor is created UNCONFIRMED. It grants nothing until a code has
 * been proved once, so a half-finished enrolment cannot lock somebody out
 * of their own account.
 */
export async function beginMfaEnrolment(userId: string): Promise<Outcome<Enrolment>> {
  const { mintRecoveryCode } = await import('./tokens');
  const secret = generateSecret();
  const codes = Array.from({ length: 8 }, () => mintRecoveryCode());

  return withTransaction(async (tx) => {
    /*
     * Clear only a PENDING enrolment, never a working one.
     *
     * A confirmed factor stays live until the replacement is confirmed,
     * so abandoning this enrolment leaves the account exactly as
     * protected as it was. `mfa_factor_pending_uq` allows one pending
     * secret at a time and this is what keeps it to one.
     */
    await tx.query(
      `UPDATE sandbox.mfa_factor SET disabled_at = now()
        WHERE user_id = $1 AND kind = 'TOTP' AND disabled_at IS NULL AND confirmed_at IS NULL`,
      [userId],
    );
    const { rows } = await tx.query(
      `INSERT INTO sandbox.mfa_factor (user_id, kind, secret) VALUES ($1,'TOTP',$2)
       RETURNING factor_id`,
      [userId, secret],
    );
    /*
     * Recovery codes are stored hashed, shown exactly once here, and
     * bound to THIS enrolment.
     *
     * They must be minted now — they are printed alongside the secret,
     * before anything has been proved — so the binding is what stops
     * that being a bypass: redemption requires the factor to be
     * confirmed, and an abandoned enrolment leaves codes attached to a
     * factor that never will be.
     */
    for (const code of codes) {
      await tx.query(
        `INSERT INTO sandbox.mfa_recovery_code (user_id, factor_id, code_hash)
         VALUES ($1,$2,$3)
         ON CONFLICT (code_hash) DO NOTHING`,
        [userId, rows[0]!.factor_id, hashToken(code)],
      );
    }
    await writeAudit(tx, {
      actorId: userId,
      action: 'MFA_ENROL_BEGIN',
      subjectKind: 'user',
      subjectId: userId,
      outcome: 'OK',
      detail: { factorId: rows[0]!.factor_id },
    });
    return accept({ factorId: rows[0]!.factor_id, secret, recoveryCodes: codes });
  });
}

/** Prove a code once to complete enrolment. */
export async function confirmMfaEnrolment(
  userId: string,
  presented: string,
  /**
   * The session that is doing the enrolling, if any.
   *
   * Kept alive across the version bump below. Every other session still
   * dies — see `bumpSessionVersionIn` for why the enrolling device is
   * not one of the sessions that must re-establish itself.
   */
  options?: { readonly keepSessionId?: string | null },
): Promise<Outcome<{ readonly confirmed: true }>> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT factor_id, secret, last_step FROM sandbox.mfa_factor
        WHERE user_id = $1 AND kind = 'TOTP' AND disabled_at IS NULL AND confirmed_at IS NULL
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [userId],
    );
    const factor = rows[0];
    if (!factor) return reject('MFA_REQUIRED', 'Start enrolment before confirming it.');

    const verdict = verifyTotp(factor.secret as string, presented, {
      lastStep: factor.last_step === null ? null : Number(factor.last_step),
    });
    if (!verdict.ok) {
      await writeAudit(tx, {
        actorId: userId,
        action: 'MFA_ENROL_CONFIRM',
        subjectKind: 'user',
        subjectId: userId,
        outcome: 'MFA_INVALID',
      });
      return reject('MFA_INVALID', FAILURE_COPY.MFA_INVALID.reason);
    }

    /*
     * The replacement takes over here, and the old factor retires in the
     * same transaction — so there is never a moment with two live
     * confirmed factors, and never a moment with none.
     */
    await tx.query(
      `UPDATE sandbox.mfa_factor SET disabled_at = now()
        WHERE user_id = $1 AND kind = 'TOTP' AND disabled_at IS NULL
          AND confirmed_at IS NOT NULL AND factor_id <> $2`,
      [userId, factor.factor_id],
    );
    await tx.query(
      `UPDATE sandbox.mfa_factor SET confirmed_at = now(), last_step = $2 WHERE factor_id = $1`,
      [factor.factor_id, verdict.step],
    );
    /*
     * Enrolling changes what this account can do, so live sessions must
     * re-establish themselves rather than inherit the new authority —
     * every session EXCEPT the one that just proved possession of the
     * new factor. Signing that device out is not a stronger control, it
     * is a dead end: it leaves the person at a login screen holding an
     * authenticator whose challenge they were never offered.
     */
    await bumpSessionVersionIn(tx, userId, options?.keepSessionId ?? null);
    await writeAudit(tx, {
      actorId: userId,
      action: 'MFA_ENROL_CONFIRM',
      subjectKind: 'user',
      subjectId: userId,
      outcome: 'OK',
    });
    return accept({ confirmed: true as const });
  });
}

/** Satisfy the second factor for THIS session. */
export async function verifyMfaForSession(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly presented: string;
}): Promise<Outcome<{ readonly satisfied: true }>> {
  const verdict = await consumeRate(RATE_RULES.MFA_VERIFY, input.userId);
  if (!verdict.allowed) {
    return reject('RATE_LIMITED', FAILURE_COPY.RATE_LIMITED.reason, {
      retryAfterSeconds: verdict.retryAfterSeconds,
    });
  }

  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT factor_id, secret, last_step FROM sandbox.mfa_factor
        WHERE user_id = $1 AND kind='TOTP' AND disabled_at IS NULL AND confirmed_at IS NOT NULL
        FOR UPDATE`,
      [input.userId],
    );
    const factor = rows[0];
    if (!factor) return reject('MFA_NOT_ENROLLED', FAILURE_COPY.MFA_NOT_ENROLLED.reason);

    const result = verifyTotp(factor.secret as string, input.presented, {
      lastStep: factor.last_step === null ? null : Number(factor.last_step),
    });
    if (!result.ok) {
      await writeAudit(tx, {
        actorId: input.userId,
        action: 'MFA_VERIFY',
        subjectKind: 'user',
        subjectId: input.userId,
        outcome: 'MFA_INVALID',
        detail: { sessionId: input.sessionId },
      });
      return reject('MFA_INVALID', FAILURE_COPY.MFA_INVALID.reason);
    }

    // Burn the step: the same code cannot be presented twice.
    await tx.query(`UPDATE sandbox.mfa_factor SET last_step = $2 WHERE factor_id = $1`, [
      factor.factor_id,
      result.step,
    ]);
    await markMfaSatisfiedIn(tx, input.sessionId);
    await writeAudit(tx, {
      actorId: input.userId,
      action: 'MFA_VERIFY',
      subjectKind: 'user',
      subjectId: input.userId,
      outcome: 'OK',
      detail: { sessionId: input.sessionId },
    });
    return accept({ satisfied: true as const });
  });
}

/** Use a recovery code. Single-use, and it ends every other session. */
export async function redeemRecoveryCode(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly code: string;
}): Promise<Outcome<{ readonly satisfied: true }>> {
  const verdict = await consumeRate(RATE_RULES.MFA_RECOVERY, input.userId);
  if (!verdict.allowed) {
    return reject('RATE_LIMITED', FAILURE_COPY.RATE_LIMITED.reason, {
      retryAfterSeconds: verdict.retryAfterSeconds,
    });
  }

  const consumed = await withTransaction(async (tx) => {
    /*
     * ────────────────────────────────────────────────────────────────
     * A RECOVERY CODE CANNOT PRECEDE THE FACTOR IT RECOVERS.
     *
     * Codes are handed out when enrolment BEGINS. Without the join
     * below, anybody could start an enrolment, ignore the
     * authenticator entirely, and immediately present one of the
     * printed codes — satisfying MFA with a factor they had never
     * proved they held. That is a complete bypass of the second factor
     * dressed as a recovery path.
     *
     * Redemption therefore requires the owning factor to be CONFIRMED
     * and still live. An abandoned enrolment leaves codes that are
     * permanently unusable, and re-enrolling disables the old factor
     * and with it every code printed for it.
     * ────────────────────────────────────────────────────────────────
     */
    const { rowCount } = await tx.query(
      `UPDATE sandbox.mfa_recovery_code c
          SET used_at = now()
         FROM sandbox.mfa_factor f
        WHERE c.factor_id = f.factor_id
          AND c.user_id = $1
          AND c.code_hash = $2
          AND c.used_at IS NULL
          AND f.confirmed_at IS NOT NULL
          AND f.disabled_at IS NULL`,
      [input.userId, hashToken(input.code.trim().toUpperCase())],
    );
    if (rowCount !== 1) {
      await writeAudit(tx, {
        actorId: input.userId,
        action: 'MFA_RECOVERY',
        subjectKind: 'user',
        subjectId: input.userId,
        outcome: 'MFA_INVALID',
      });
      return false;
    }
    await markMfaSatisfiedIn(tx, input.sessionId);
    await writeAudit(tx, {
      actorId: input.userId,
      action: 'MFA_RECOVERY',
      subjectKind: 'user',
      subjectId: input.userId,
      outcome: 'OK',
      detail: { sessionId: input.sessionId },
    });
    return true;
  });

  if (!consumed) return reject('MFA_INVALID', FAILURE_COPY.MFA_INVALID.reason);

  /*
   * A recovery code is used when the factor is lost — which is also what
   * a successful attacker looks like. Ending every other session limits
   * the damage either way, and the person keeps the device they are on.
   */
  await revokeAllSessions(input.userId, 'MFA_RECOVERY_USED', input.sessionId);
  return accept({ satisfied: true as const });
}

export async function mfaEnrolled(userId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM sandbox.mfa_factor
      WHERE user_id = $1 AND kind='TOTP' AND disabled_at IS NULL AND confirmed_at IS NOT NULL`,
    [userId],
  );
  return rows.length > 0;
}
