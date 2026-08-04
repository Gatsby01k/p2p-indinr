import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { getUser, type SessionUser } from './service';

/**
 * Sandbox session.
 *
 * A signed cookie carrying a user id. The signature stops a visitor editing
 * the cookie to become another user or an operator, which is the property the
 * authorization tests depend on.
 *
 * ⚠ This is NOT an authentication system. It verifies no password, no second
 * factor and no identity document, and it must never be reused for anything
 * that holds value. It exists so the sandbox has a real, server-enforced
 * notion of "who is asking" instead of a client-supplied claim.
 */

const COOKIE = 'inrp2p_sandbox_session';

/**
 * The cookie signing key.
 *
 * FAILS CLOSED IN PRODUCTION. The development fallback below is committed to
 * a public repository, so anyone can read it. A deployment that signed
 * cookies with it would let a visitor forge any session — including one
 * carrying `isOperator` — simply by computing the HMAC themselves. That is
 * not a weak default; it is no authentication at all.
 *
 * So production refuses to start rather than degrade quietly, exactly as the
 * escrow adapter does. Development keeps the fallback because a local
 * sandbox guards nothing.
 */
function secret(): string {
  const configured = process.env.SANDBOX_SESSION_SECRET;
  if (configured && configured.length >= 16) return configured;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'SANDBOX_SESSION_SECRET is not set (or is shorter than 16 characters).\n' +
        'Refusing to sign session cookies with the public development fallback: it is\n' +
        'committed to this repository, so anyone could forge a session — including an\n' +
        'operator one. Set it to a long random value, e.g.\n' +
        '  openssl rand -base64 32',
    );
  }

  return 'sandbox-development-secret-not-for-production';
}

function sign(userId: string): string {
  const mac = createHmac('sha256', secret()).update(userId).digest('base64url');
  return `${userId}.${mac}`;
}

function verify(token: string | undefined): string | null {
  if (!token) return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const userId = token.slice(0, idx);
  const provided = token.slice(idx + 1);
  const expected = createHmac('sha256', secret()).update(userId).digest('base64url');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? userId : null;
}

export async function setSessionCookie(userId: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, sign(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 8,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/** The signed-in user, or null. Never trusts a client-supplied identity. */
export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const userId = verify(jar.get(COOKIE)?.value);
  if (!userId) return null;
  return getUser(userId);
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
