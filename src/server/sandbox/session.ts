import 'server-only';
import { cookies } from 'next/headers';
import { getUser, type SessionUser } from './service';
import {
  SESSION_ROTATE_AFTER_SECONDS,
  resolveSession,
  rotateSession,
  touchSession,
  type ResolvedSession,
} from '@/server/identity/sessions';
import { mfaEnrolled, permissionsFor, rolesFor, type Principal } from '@/server/identity/rbac';

/**
 * The session cookie.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE COOKIE NO LONGER CARRIES AUTHORITY — IT CARRIES A HANDLE.     │
 * │                                                                    │
 * │  It used to be `userId.HMAC(userId)`: self-describing, unbounded,  │
 * │  unrevocable. Anyone holding it was that user forever, and there   │
 * │  was nothing to take away (TS-00 `AUD-P0-003`).                    │
 * │                                                                    │
 * │  It now holds an opaque 256-bit token whose SHA-256 identifies a   │
 * │  row. Every property that matters — who, until when, still valid,  │
 * │  still current — is read from the database on each request, so     │
 * │  revoking a session revokes it everywhere immediately.             │
 * │                                                                    │
 * │  There is no signing key here any more, and therefore no           │
 * │  `SANDBOX_SESSION_SECRET` to leak. The token IS the secret, it is  │
 * │  stored only as a hash, and it is issued by the database.          │
 * └────────────────────────────────────────────────────────────────────┘
 */

const COOKIE = 'inrp2p_session';

interface CookieOptions {
  readonly embedded: boolean;
  readonly expiresAt: Date;
}

/**
 * Write the session cookie.
 *
 * `embedded` marks a Telegram Mini App session. Telegram Web and Desktop
 * host a Mini App in a CROSS-SITE IFRAME, and a `SameSite=Lax` cookie is
 * not sent from one — the person would sign in and immediately appear
 * signed out. `SameSite=None` is the only value browsers send there, and
 * browsers require `Secure` with it.
 *
 * The CSRF objection is answered elsewhere rather than ignored: every
 * mutation is a Next.js server action, which verifies the request Origin
 * against the Host before running.
 */
export async function setSessionCookie(token: string, options: CookieOptions): Promise<void> {
  const jar = await cookies();
  const isProduction = process.env.NODE_ENV === 'production';
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: options.embedded ? 'none' : 'lax',
    secure: options.embedded || isProduction,
    path: '/',
    // Bounded, and bounded by the SERVER's expiry rather than a number
    // chosen here — the row is the authority, this is only a hint that
    // stops the browser holding a cookie that cannot work.
    expires: options.expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export async function readSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(COOKIE)?.value;
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

export interface AuthenticatedCaller {
  readonly user: SessionUser;
  readonly session: ResolvedSession;
  readonly principal: Principal;
}

/**
 * Who is asking, with their live authority.
 *
 * Roles are read from `role_grant` on every request rather than from the
 * cached `is_operator` column, so a revoked grant stops working at once
 * instead of when a cache happens to be refreshed.
 */
export async function currentCaller(): Promise<AuthenticatedCaller | null> {
  const token = await readSessionToken();
  const lookup = await resolveSession(token);
  if (!lookup.ok) return null;

  const user = await getUser(lookup.session.userId);
  if (!user) return null;

  const roles = await rolesFor(user.userId);
  const principal: Principal = {
    userId: user.userId,
    roles,
    permissions: permissionsFor(roles),
    mfaSatisfied: lookup.session.mfaSatisfied,
    mfaEnrolled: await mfaEnrolled(user.userId),
  };

  // Best-effort bookkeeping; never gates the request.
  void touchSession(lookup.session.sessionId).catch(() => undefined);

  return { user, session: lookup.session, principal };
}

/** The signed-in user, or null. Preserved for existing read paths. */
export async function currentUser(): Promise<SessionUser | null> {
  return (await currentCaller())?.user ?? null;
}

/** The signed-in user, or throw. For routes that require authentication. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) {
    const err = new Error('Sign in to continue.') as Error & { code: string };
    err.code = 'UNAUTHENTICATED';
    throw err;
  }
  return user;
}

/** The full caller, or throw. For anything that needs authority or a session. */
export async function requireCaller(): Promise<AuthenticatedCaller> {
  const caller = await currentCaller();
  if (!caller) {
    const err = new Error('Sign in to continue.') as Error & { code: string };
    err.code = 'UNAUTHENTICATED';
    throw err;
  }
  return caller;
}

/**
 * Rotate the cookie if the session has been in use for a while.
 *
 * Rotation bounds how long a stolen cookie stays useful without asking
 * anybody to sign in again. It is called from the authenticated layout,
 * where a failure is harmless — the current cookie keeps working until
 * its own expiry.
 */
export async function rotateSessionIfDue(): Promise<void> {
  const token = await readSessionToken();
  if (!token) return;
  const lookup = await resolveSession(token);
  if (!lookup.ok) return;

  const ageSeconds = (Date.now() - lookup.session.issuedAt.getTime()) / 1000;
  if (ageSeconds < SESSION_ROTATE_AFTER_SECONDS) return;

  const next = await rotateSession(token);
  if (!next) return;
  await setSessionCookie(next.token, { embedded: false, expiresAt: next.expiresAt });
}
