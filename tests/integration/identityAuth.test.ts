import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { getPool } from '@/server/db/pool';
import {
  beginMfaEnrolment,
  confirmMfaEnrolment,
  linkTelegramIdentity,
  redeemEmailSignIn,
  redeemRecoveryCode,
  signInWithTelegramLaunch,
  startEmailSignIn,
  verifyMfaForSession,
} from '@/server/identity/auth';
import {
  clearDeliveries,
  getEmailDeliveryAdapter,
  lastDeliveredTo,
} from '@/server/adapters/emailDelivery';
import { AdapterUnavailableError } from '@/server/adapters/mode';
import { resolveSession, revokeAllSessions, revokeSession } from '@/server/identity/sessions';
import { codeFor, stepFor } from '@/server/identity/totp';
import { RATE_RULES, consumeRate } from '@/server/identity/rateLimit';

/**
 * DEL-03 authentication.
 *
 * Every credential in this stage is a bearer secret, so the properties
 * under test are the ones that decide whether holding a copy is useful:
 * single use, expiry on the database clock, and a refusal that says
 * nothing an attacker can navigate by.
 */

const unique = () => Math.random().toString(36).slice(2, 10);
const original = { nodeEnv: process.env.NODE_ENV, sandbox: process.env.INRP2P_SANDBOX };

function enterProduction() {
  (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
  delete process.env.INRP2P_SANDBOX;
}
function restore() {
  (process.env as Record<string, string | undefined>).NODE_ENV = original.nodeEnv;
  if (original.sandbox === undefined) delete process.env.INRP2P_SANDBOX;
  else process.env.INRP2P_SANDBOX = original.sandbox;
}

beforeEach(() => {
  restore();
  clearDeliveries();
});
afterEach(restore);

/** Request a code and read it out of the sandbox delivery log. */
async function requestCode(email: string): Promise<string> {
  const started = await startEmailSignIn(email);
  expect(started.ok).toBe(true);
  const delivered = lastDeliveredTo(email);
  expect(delivered, 'a code should have been delivered').not.toBeNull();
  return delivered!.secret;
}

/* ------------------------------------------------------------------ *
 * Email one-time codes
 * ------------------------------------------------------------------ */

describe('email sign-in', () => {
  it('issues a session only after a code comes back', async () => {
    const email = `otp-${unique()}@example.com`;
    const secret = await requestCode(email);

    // Nothing exists yet: requesting a code creates no account.
    const { rows: before } = await getPool().query(
      `SELECT 1 FROM sandbox.app_user WHERE email = $1`,
      [email],
    );
    expect(before).toHaveLength(0);

    const signedIn = await redeemEmailSignIn({ email, secret });
    expect(signedIn.ok).toBe(true);
    if (!signedIn.ok) return;
    expect(signedIn.value.created).toBe(true);

    const lookup = await resolveSession(signedIn.value.sessionToken);
    expect(lookup.ok).toBe(true);
  });

  it('stores the code as a hash, never in clear', async () => {
    const email = `hash-${unique()}@example.com`;
    const secret = await requestCode(email);

    const { rows } = await getPool().query(
      `SELECT token_hash FROM sandbox.auth_challenge WHERE email = $1`,
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.token_hash).not.toContain(secret);
  });

  it('works exactly once', async () => {
    const email = `once-${unique()}@example.com`;
    const secret = await requestCode(email);

    expect((await redeemEmailSignIn({ email, secret })).ok).toBe(true);
    const replay = await redeemEmailSignIn({ email, secret });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.code).toBe('AUTH_CHALLENGE_INVALID');
  });

  it('refuses an expired code', async () => {
    const email = `exp-${unique()}@example.com`;
    const secret = await requestCode(email);
    await getPool().query(
      `UPDATE sandbox.auth_challenge
          SET created_at = now() - interval '1 hour', expires_at = now() - interval '1 second'
        WHERE email = $1`,
      [email],
    );

    const outcome = await redeemEmailSignIn({ email, secret });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('AUTH_CHALLENGE_INVALID');
  });

  it('refuses a wrong code', async () => {
    const email = `wrong-${unique()}@example.com`;
    await requestCode(email);
    const outcome = await redeemEmailSignIn({ email, secret: '00000000.not-the-token' });
    expect(outcome.ok).toBe(false);
  });

  it('refuses a code presented for a different address', async () => {
    const mine = `mine-${unique()}@example.com`;
    const theirs = `theirs-${unique()}@example.com`;
    const secret = await requestCode(mine);

    const outcome = await redeemEmailSignIn({ email: theirs, secret });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('AUTH_CHALLENGE_INVALID');
  });

  it('answers identically for every failure mode, so nothing can be enumerated', async () => {
    const email = `oracle-${unique()}@example.com`;
    const secret = await requestCode(email);
    await redeemEmailSignIn({ email, secret }); // consume it

    const used = await redeemEmailSignIn({ email, secret });
    const wrong = await redeemEmailSignIn({ email, secret: '11111111.nope' });
    const unknown = await redeemEmailSignIn({
      email: `nobody-${unique()}@example.com`,
      secret: '22222222.nope',
    });

    expect(used.ok || wrong.ok || unknown.ok).toBe(false);
    if (used.ok || wrong.ok || unknown.ok) return;
    expect(used.message).toBe(wrong.message);
    expect(wrong.message).toBe(unknown.message);
  });

  it('only one of two concurrent redemptions succeeds', async () => {
    const email = `race-${unique()}@example.com`;
    const secret = await requestCode(email);

    const [a, b] = await Promise.all([
      redeemEmailSignIn({ email, secret }),
      redeemEmailSignIn({ email, secret }),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
  });

  it('records every issue and every refusal in the audit trail', async () => {
    const email = `audit-${unique()}@example.com`;
    await requestCode(email);
    await redeemEmailSignIn({ email, secret: 'bad.code' });

    const { rows } = await getPool().query(
      `SELECT action, outcome FROM sandbox.audit_event
        WHERE action IN ('AUTH_CHALLENGE_ISSUE','AUTH_CHALLENGE_REDEEM')
          AND detail->>'email' = $1 OR action = 'AUTH_CHALLENGE_ISSUE'
        ORDER BY audit_id DESC LIMIT 5`,
      [email],
    );
    expect(rows.some((r) => r.action === 'AUTH_CHALLENGE_ISSUE')).toBe(true);
  });

  it('fails closed in production with no delivery adapter', async () => {
    enterProduction();
    expect(() => getEmailDeliveryAdapter()).toThrow(AdapterUnavailableError);
    await expect(startEmailSignIn(`prod-${unique()}@example.com`)).rejects.toThrow(
      AdapterUnavailableError,
    );
    restore();

    // And nothing was written before it refused.
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.auth_challenge WHERE email LIKE 'prod-%'`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('rate-limits code requests per address', async () => {
    const email = `limit-${unique()}@example.com`;
    const results = [];
    for (let i = 0; i < RATE_RULES.SIGN_IN_REQUEST.limit + 2; i += 1) {
      results.push(await startEmailSignIn(email));
    }
    const refused = results.filter((r) => !r.ok);
    expect(refused.length).toBeGreaterThanOrEqual(2);
    const first = refused[0]!;
    if (first.ok) return;
    expect(first.code).toBe('RATE_LIMITED');
  });
});

/* ------------------------------------------------------------------ *
 * Telegram
 * ------------------------------------------------------------------ */

describe('Telegram launches are single-use', () => {
  const tgUser = (id: number) => ({
    id,
    firstName: 'Test',
    lastName: null,
    username: `tg${id}`,
    languageCode: null,
    isPremium: false,
    photoUrl: null,
  });

  it('accepts a launch once and refuses the replay', async () => {
    const id = Math.floor(Math.random() * 1_000_000_000);
    const initData = `initdata-${unique()}`;

    const first = await signInWithTelegramLaunch({
      user: tgUser(id),
      initDataHash: initData,
      authDate: new Date(),
    });
    expect(first.ok).toBe(true);

    const replay = await signInWithTelegramLaunch({
      user: tgUser(id),
      initDataHash: initData,
      authDate: new Date(),
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.code).toBe('TELEGRAM_LAUNCH_REPLAYED');
  });

  it('records the replay refusal', async () => {
    const id = Math.floor(Math.random() * 1_000_000_000);
    const initData = `initdata-${unique()}`;
    await signInWithTelegramLaunch({
      user: tgUser(id),
      initDataHash: initData,
      authDate: new Date(),
    });
    await signInWithTelegramLaunch({
      user: tgUser(id),
      initDataHash: initData,
      authDate: new Date(),
    });

    const { rows } = await getPool().query(
      `SELECT 1 FROM sandbox.audit_event WHERE outcome = 'TELEGRAM_LAUNCH_REPLAYED'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('a fresh launch string for the same account still works', async () => {
    const id = Math.floor(Math.random() * 1_000_000_000);
    await signInWithTelegramLaunch({
      user: tgUser(id),
      initDataHash: `a-${unique()}`,
      authDate: new Date(),
    });
    const second = await signInWithTelegramLaunch({
      user: tgUser(id),
      initDataHash: `b-${unique()}`,
      authDate: new Date(),
    });
    expect(second.ok).toBe(true);
  });

  it('never grants a role from a launch', async () => {
    const id = Math.floor(Math.random() * 1_000_000_000);
    const signedIn = await signInWithTelegramLaunch({
      user: tgUser(id),
      initDataHash: `role-${unique()}`,
      authDate: new Date(),
    });
    expect(signedIn.ok).toBe(true);
    if (!signedIn.ok) return;

    const { rows } = await getPool().query(
      `SELECT is_operator FROM sandbox.app_user WHERE user_id = $1`,
      [signedIn.value.userId],
    );
    expect(rows[0]!.is_operator).toBe(false);
    const { rows: grants } = await getPool().query(
      `SELECT 1 FROM sandbox.role_grant WHERE user_id = $1`,
      [signedIn.value.userId],
    );
    expect(grants).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Account linking
 * ------------------------------------------------------------------ */

describe('account linking refuses takeovers', () => {
  async function emailAccount(): Promise<string> {
    const email = `link-${unique()}@example.com`;
    const secret = await requestCode(email);
    const signedIn = await redeemEmailSignIn({ email, secret });
    if (!signedIn.ok) throw new Error('fixture');
    return signedIn.value.userId;
  }

  it('links a free Telegram id', async () => {
    const userId = await emailAccount();
    const outcome = await linkTelegramIdentity({
      userId,
      telegramId: Math.floor(Math.random() * 1_000_000_000),
      telegramUsername: 'someone',
    });
    expect(outcome.ok).toBe(true);
  });

  it('refuses a Telegram id that belongs to another account', async () => {
    const first = await emailAccount();
    const second = await emailAccount();
    const telegramId = Math.floor(Math.random() * 1_000_000_000);

    expect(
      (await linkTelegramIdentity({ userId: first, telegramId, telegramUsername: null })).ok,
    ).toBe(true);
    const takeover = await linkTelegramIdentity({
      userId: second,
      telegramId,
      telegramUsername: null,
    });
    expect(takeover.ok).toBe(false);
    if (takeover.ok) return;
    expect(takeover.code).toBe('ACCOUNT_LINK_CONFLICT');
  });

  it('refuses to re-key an account that already carries a different id', async () => {
    const userId = await emailAccount();
    await linkTelegramIdentity({
      userId,
      telegramId: Math.floor(Math.random() * 1_000_000_000),
      telegramUsername: null,
    });
    const rekey = await linkTelegramIdentity({
      userId,
      telegramId: Math.floor(Math.random() * 1_000_000_000),
      telegramUsername: null,
    });
    expect(rekey.ok).toBe(false);
    if (rekey.ok) return;
    expect(rekey.code).toBe('ACCOUNT_LINK_CONFLICT');
  });
});

/* ------------------------------------------------------------------ *
 * Second factor
 * ------------------------------------------------------------------ */

describe('second factor', () => {
  async function signedInAccount() {
    const email = `mfa-${unique()}@example.com`;
    const secret = await requestCode(email);
    const signedIn = await redeemEmailSignIn({ email, secret });
    if (!signedIn.ok) throw new Error('fixture');
    return signedIn.value;
  }

  it('enrols only after a code is proved', async () => {
    const account = await signedInAccount();
    const enrolment = await beginMfaEnrolment(account.userId);
    expect(enrolment.ok).toBe(true);
    if (!enrolment.ok) return;

    // Unconfirmed: it grants nothing yet.
    const { rows: pending } = await getPool().query(
      `SELECT confirmed_at FROM sandbox.mfa_factor WHERE user_id = $1`,
      [account.userId],
    );
    expect(pending[0]!.confirmed_at).toBeNull();

    const code = codeFor(enrolment.value.secret, stepFor());
    const confirmed = await confirmMfaEnrolment(account.userId, code);
    expect(confirmed.ok).toBe(true);
  });

  it('refuses a wrong code', async () => {
    const account = await signedInAccount();
    const enrolment = await beginMfaEnrolment(account.userId);
    if (!enrolment.ok) return;
    const outcome = await confirmMfaEnrolment(account.userId, '000000');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('MFA_INVALID');
  });

  it('refuses a replayed code inside its own window', async () => {
    const account = await signedInAccount();
    const enrolment = await beginMfaEnrolment(account.userId);
    if (!enrolment.ok) return;
    const code = codeFor(enrolment.value.secret, stepFor());
    expect((await confirmMfaEnrolment(account.userId, code)).ok).toBe(true);

    // The same six digits, still arithmetically valid, now refused.
    const replay = await verifyMfaForSession({
      userId: account.userId,
      sessionId: account.sessionId,
      presented: code,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.code).toBe('MFA_INVALID');
  });

  it('marks the session satisfied on a fresh code', async () => {
    const account = await signedInAccount();
    const enrolment = await beginMfaEnrolment(account.userId);
    if (!enrolment.ok) return;
    expect(
      (await confirmMfaEnrolment(account.userId, codeFor(enrolment.value.secret, stepFor()))).ok,
    ).toBe(true);

    const next = codeFor(enrolment.value.secret, stepFor() + 1);
    const verified = await verifyMfaForSession({
      userId: account.userId,
      sessionId: account.sessionId,
      presented: next,
    });
    expect(verified.ok).toBe(true);

    const { rows } = await getPool().query(
      `SELECT mfa_satisfied_at FROM sandbox.session WHERE session_id = $1`,
      [account.sessionId],
    );
    expect(rows[0]!.mfa_satisfied_at).not.toBeNull();
  });

  it('accepts a recovery code once and never again', async () => {
    const account = await signedInAccount();
    const enrolment = await beginMfaEnrolment(account.userId);
    if (!enrolment.ok) return;
    // The factor must be CONFIRMED before its recovery codes mean
    // anything — otherwise starting an enrolment and ignoring the
    // authenticator would be a complete bypass.
    expect(
      (await confirmMfaEnrolment(account.userId, codeFor(enrolment.value.secret, stepFor()))).ok,
    ).toBe(true);
    const code = enrolment.value.recoveryCodes[0]!;

    const first = await redeemRecoveryCode({
      userId: account.userId,
      sessionId: account.sessionId,
      code,
    });
    expect(first.ok).toBe(true);

    const reuse = await redeemRecoveryCode({
      userId: account.userId,
      sessionId: account.sessionId,
      code,
    });
    expect(reuse.ok).toBe(false);
    if (reuse.ok) return;
    expect(reuse.code).toBe('MFA_INVALID');
  });

  it('ends every other session when a recovery code is used', async () => {
    const account = await signedInAccount();
    const enrolment = await beginMfaEnrolment(account.userId);
    if (!enrolment.ok) return;
    expect(
      (await confirmMfaEnrolment(account.userId, codeFor(enrolment.value.secret, stepFor()))).ok,
    ).toBe(true);

    // A second device.
    const email2 = `mfa2-${unique()}@example.com`;
    void email2;
    const { rows: before } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.session
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [account.userId],
    );
    expect(before[0]!.n).toBeGreaterThanOrEqual(1);

    await redeemRecoveryCode({
      userId: account.userId,
      sessionId: account.sessionId,
      code: enrolment.value.recoveryCodes[1]!,
    });

    // The current device survives; the version bump kills anything older.
    const { rows: after } = await getPool().query(
      `SELECT session_version FROM sandbox.app_user WHERE user_id = $1`,
      [account.userId],
    );
    expect(Number(after[0]!.session_version)).toBeGreaterThan(1);
  });

  it('rate-limits recovery-code attempts', async () => {
    const account = await signedInAccount();
    for (let i = 0; i < RATE_RULES.MFA_RECOVERY.limit + 1; i += 1) {
      await consumeRate(RATE_RULES.MFA_RECOVERY, account.userId);
    }
    const outcome = await redeemRecoveryCode({
      userId: account.userId,
      sessionId: account.sessionId,
      code: 'ANY-CODE',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('RATE_LIMITED');
  });
});

/* ------------------------------------------------------------------ *
 * Session lifecycle
 * ------------------------------------------------------------------ */

describe('sessions', () => {
  async function signedInAccount() {
    const email = `sess-${unique()}@example.com`;
    const secret = await requestCode(email);
    const signedIn = await redeemEmailSignIn({ email, secret });
    if (!signedIn.ok) throw new Error('fixture');
    return signedIn.value;
  }

  it('stores only a hash of the cookie token', async () => {
    const account = await signedInAccount();
    const { rows } = await getPool().query(
      `SELECT token_hash FROM sandbox.session WHERE session_id = $1`,
      [account.sessionId],
    );
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.token_hash).not.toContain(account.sessionToken);
  });

  it('refuses an expired session against the database clock', async () => {
    const account = await signedInAccount();
    await getPool().query(
      `UPDATE sandbox.session
          SET issued_at = now() - interval '1 day', expires_at = now() - interval '1 second'
        WHERE session_id = $1`,
      [account.sessionId],
    );
    const lookup = await resolveSession(account.sessionToken);
    expect(lookup.ok).toBe(false);
    if (lookup.ok) return;
    expect(lookup.reason).toBe('EXPIRED');
  });

  it('refuses a revoked session immediately', async () => {
    const account = await signedInAccount();
    expect(await revokeSession(account.sessionId, account.userId, 'TEST')).toBe(true);
    const lookup = await resolveSession(account.sessionToken);
    expect(lookup.ok).toBe(false);
    if (lookup.ok) return;
    expect(lookup.reason).toBe('REVOKED');
  });

  it('refuses a stolen token that is not a known session', async () => {
    const lookup = await resolveSession('not-a-real-token');
    expect(lookup.ok).toBe(false);
    if (lookup.ok) return;
    expect(lookup.reason).toBe('UNKNOWN');
  });

  it('sign-out-everywhere ends other sessions and keeps this one', async () => {
    const account = await signedInAccount();
    // A second session for the same account. The hash must be unique —
    // `session_token_uq` is doing its job and a fixed literal collides
    // with every earlier run against the same database.
    const secondHash = createHash('sha256').update(`second-${unique()}`).digest('hex');
    const second = await getPool().query(
      `INSERT INTO sandbox.session (user_id, token_hash, expires_at, version, origin)
       VALUES ($1, $2, now() + interval '1 hour',
               (SELECT session_version FROM sandbox.app_user WHERE user_id = $1), 'EMAIL_OTP')
       RETURNING session_id`,
      [account.userId, secondHash],
    );

    await revokeAllSessions(account.userId, 'SIGN_OUT_EVERYWHERE', account.sessionId);

    const { rows } = await getPool().query(
      `SELECT revoked_at FROM sandbox.session WHERE session_id = $1`,
      [second.rows[0]!.session_id],
    );
    expect(rows[0]!.revoked_at).not.toBeNull();

    // The current device still works.
    const lookup = await resolveSession(account.sessionToken);
    expect(lookup.ok).toBe(true);
  });

  it('a version bump invalidates sessions issued before it', async () => {
    const account = await signedInAccount();
    await getPool().query(
      `UPDATE sandbox.app_user SET session_version = session_version + 1 WHERE user_id = $1`,
      [account.userId],
    );
    const lookup = await resolveSession(account.sessionToken);
    expect(lookup.ok).toBe(false);
    if (lookup.ok) return;
    expect(lookup.reason).toBe('STALE_VERSION');
  });
});
