import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getPool } from '@/server/db/pool';
import {
  beginMfaEnrolment,
  confirmMfaEnrolment,
  mfaEnrolled,
  verifyMfaForSession,
} from '@/server/identity/auth';
import { issueSessionIn } from '@/server/identity/sessions';
import { withTransaction } from '@/server/db/pool';
import { codeFor, stepFor } from '@/server/identity/totp';
import { signInSandbox } from '@/server/sandbox/service';
import { unique } from './support/room';

/**
 * A committed MFA mutation must survive a failed presentation render.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE DEFECT THIS PINS SHUT.                                        │
 * │                                                                    │
 * │  Every MFA action used to end with                                 │
 * │  `revalidatePath('/app/settings/security')`, and that page         │
 * │  resolved the caller TWICE — once through the non-throwing         │
 * │  `currentCaller()`, and again through `getChrome()`, which throws. │
 * │                                                                    │
 * │  So a post-commit RSC render that could not resolve the session    │
 * │  produced an error payload, and the client never received the      │
 * │  result of an action that had ALREADY COMMITTED. A confirmed       │
 * │  enrolment looked like a failure. Worse, the one-time secret and   │
 * │  the recovery codes went with it — spent, and reported as broken.  │
 * │                                                                    │
 * │  The rule these tests hold: THE DATABASE IS THE AUTHORITY, AND     │
 * │  RENDERING IS NOT ALLOWED TO CONTRADICT IT.                        │
 * └────────────────────────────────────────────────────────────────────┘
 */

async function freshUser(prefix: string) {
  const user = await signInSandbox(`${prefix}-${unique()}@example.com`);
  const session = await withTransaction((tx) =>
    issueSessionIn(tx, { userId: user.userId, origin: 'EMAIL_OTP', deviceLabel: 'Test' }),
  );
  return { user, session };
}

describe('an MFA mutation commits independently of any render', () => {
  it('begin enrolment commits and returns the secret to its caller', async () => {
    const { user } = await freshUser('mfa-begin');
    const started = await beginMfaEnrolment(user.userId);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // The definitive result: a secret and recovery codes, in the return
    // value — not something the caller must re-read a page to discover.
    expect(started.value.secret).toMatch(/^[A-Z2-7]{16,}$/);
    expect(started.value.recoveryCodes.length).toBeGreaterThan(0);

    // And it is durable: the row exists whatever a render does next.
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.mfa_factor WHERE user_id = $1`,
      [user.userId],
    );
    expect(rows[0]!.n).toBeGreaterThan(0);
  });

  it('confirmation commits, and the committed state is readable afterwards', async () => {
    const { user } = await freshUser('mfa-confirm');
    const started = await beginMfaEnrolment(user.userId);
    if (!started.ok) return;

    const base = stepFor();
    const confirmed = await confirmMfaEnrolment(user.userId, codeFor(started.value.secret, base));
    expect(confirmed.ok, 'the confirmation is the definitive result').toBe(true);

    /*
     * The property that matters: enrolment is true in the DATABASE. A
     * page that failed to render cannot make this false, which is why
     * the client must take its answer from the action's return value.
     */
    expect(await mfaEnrolled(user.userId)).toBe(true);
  });

  it('an UNCONFIRMED enrolment grants nothing', async () => {
    const { user, session } = await freshUser('mfa-unconfirmed');
    const started = await beginMfaEnrolment(user.userId);
    if (!started.ok) return;

    // Enrolment begun but never confirmed: no factor is live.
    expect(await mfaEnrolled(user.userId)).toBe(false);

    const satisfied = await verifyMfaForSession({
      userId: user.userId,
      sessionId: session.sessionId,
      presented: codeFor(started.value.secret, stepFor()),
    });
    expect(satisfied.ok, 'an unconfirmed factor cannot satisfy a session').toBe(false);
  });

  it('verification commits and marks THIS session, deterministically', async () => {
    const { user, session } = await freshUser('mfa-verify');
    const started = await beginMfaEnrolment(user.userId);
    if (!started.ok) return;

    const base = stepFor();
    await confirmMfaEnrolment(user.userId, codeFor(started.value.secret, base));
    const satisfied = await verifyMfaForSession({
      userId: user.userId,
      sessionId: session.sessionId,
      presented: codeFor(started.value.secret, base + 1),
    });
    expect(satisfied.ok).toBe(true);

    const { rows } = await getPool().query(
      `SELECT mfa_satisfied_at FROM sandbox.session WHERE session_id = $1`,
      [session.sessionId],
    );
    expect(rows[0]!.mfa_satisfied_at, 'the session carries the answer').not.toBeNull();
  });

  it('TWO independently issued sessions each answer for themselves', async () => {
    /*
     * Not two copies of one cookie: two sessions the server issued
     * separately. Answering the factor on one must not silently satisfy
     * the other — the challenge is per session, per device.
     */
    const { user, session: first } = await freshUser('mfa-two');
    const second = await withTransaction((tx) =>
      issueSessionIn(tx, { userId: user.userId, origin: 'EMAIL_OTP', deviceLabel: 'Second' }),
    );
    expect(second.sessionId).not.toBe(first.sessionId);

    const started = await beginMfaEnrolment(user.userId);
    if (!started.ok) return;
    const base = stepFor();
    await confirmMfaEnrolment(user.userId, codeFor(started.value.secret, base));
    expect(
      (
        await verifyMfaForSession({
          userId: user.userId,
          sessionId: first.sessionId,
          presented: codeFor(started.value.secret, base + 1),
        })
      ).ok,
    ).toBe(true);

    const { rows } = await getPool().query(
      `SELECT session_id, mfa_satisfied_at FROM sandbox.session WHERE session_id = ANY($1)`,
      [[first.sessionId, second.sessionId]],
    );
    const byId = new Map(rows.map((r) => [String(r.session_id), r.mfa_satisfied_at]));
    expect(byId.get(first.sessionId)).not.toBeNull();
    expect(byId.get(second.sessionId), 'the other device still has to answer').toBeNull();
  });
});

describe('the secret is never written anywhere it could be read again', () => {
  it('appears in no audit detail and no outbox payload', async () => {
    const { user } = await freshUser('mfa-leak');
    const started = await beginMfaEnrolment(user.userId);
    if (!started.ok) return;
    const secret = started.value.secret;

    for (const table of ['audit_event', 'outbox_event']) {
      const column = table === 'audit_event' ? 'detail' : 'payload';
      const { rows } = await getPool().query(
        `SELECT count(*)::int AS n FROM sandbox.${table} WHERE ${column}::text LIKE $1`,
        [`%${secret}%`],
      );
      expect(rows[0]!.n, `${table} must not contain the enrolment secret`).toBe(0);
    }

    // Nor may a recovery code be readable back out in clear.
    for (const code of started.value.recoveryCodes) {
      const { rows } = await getPool().query(
        `SELECT count(*)::int AS n FROM sandbox.mfa_recovery_code WHERE code_hash = $1`,
        [code],
      );
      expect(rows[0]!.n, 'a recovery code is stored hashed, never in clear').toBe(0);
    }
  });
});

describe('the presentation path cannot swallow a committed MFA result', () => {
  /**
   * Comments are prose, not behaviour.
   *
   * These files EXPLAIN the defect they fixed, so they mention
   * `revalidatePath` and `getChrome` in their reasoning. A check that
   * matched the raw text would fail on the explanation and pass on the
   * silent removal of it — precisely backwards. Only code is read.
   */
  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const actions = stripComments(readFileSync('src/services/actions.ts', 'utf8'));
  const page = stripComments(readFileSync('src/app/app/settings/security/page.tsx', 'utf8'));

  /** The body of a named exported action, up to the next export. */
  const bodyOf = (name: string) => {
    const start = actions.indexOf(`export async function ${name}`);
    if (start < 0) throw new Error(`no action named ${name}`);
    const next = actions.indexOf('\nexport ', start + 1);
    return actions.slice(start, next < 0 ? actions.length : next);
  };

  it.each([
    'beginMfaEnrolmentAction',
    'confirmMfaEnrolmentAction',
    'verifyMfaAction',
    'redeemRecoveryCodeAction',
  ])('%s does not revalidate a route on its response path', (name) => {
    /*
     * A revalidation here re-renders a page before the client has the
     * result. If that render throws, a committed mutation is reported
     * as a failure and a one-time secret is lost with it.
     */
    expect(bodyOf(name)).not.toMatch(/revalidatePath\(/);
  });

  it('the Security page resolves the caller exactly once, without throwing', () => {
    expect(page).toContain('currentCaller()');
    // `getChrome()` throws; it must not be the second resolver here.
    expect(page).not.toContain('getChrome(');
    expect((page.match(/currentCaller\(\)/g) ?? []).length).toBe(1);
  });

  it('an unauthenticated arrival is redirected and renders no MFA content', () => {
    // Redirect happens before any Security or MFA markup is produced.
    const redirectAt = page.indexOf('redirect(`/login?next=');
    const mfaAt = page.indexOf('<MfaEnrolment');
    expect(redirectAt).toBeGreaterThan(-1);
    expect(redirectAt, 'the redirect must precede any MFA markup').toBeLessThan(mfaAt);
    expect(page).toContain("encodeURIComponent('/app/settings/security')");
  });

  it('the client updates its own state from the definitive result', () => {
    const flow = readFileSync('src/components/flows/MfaFlow.tsx', 'utf8');
    // State is set from the action's return value, then navigation.
    expect(flow).toMatch(/setEnrolment\(value\)/);
    expect(flow).toMatch(/router\.replace\(destination\)/);
    // A same-origin guard stands between `next` and any navigation.
    expect(flow).toMatch(/safeNext/);
  });
});
