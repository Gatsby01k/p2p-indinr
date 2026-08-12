import 'server-only';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Credential material: minting, hashing and constant-time comparison.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  NOTHING IN THIS PRODUCT STORES A CREDENTIAL IN CLEAR.             │
 * │                                                                    │
 * │  Session tokens, one-time sign-in codes and recovery codes are all │
 * │  bearer secrets: whoever holds one is the account for as long as   │
 * │  it lives. So the database holds a SHA-256 and the secret exists   │
 * │  only in the response that delivered it.                           │
 * │                                                                    │
 * │  SHA-256 without a work factor is deliberate and is only correct   │
 * │  BECAUSE these are high-entropy machine-generated secrets, not     │
 * │  passwords. A 256-bit random token has nothing to brute-force; a   │
 * │  human-chosen password would need argon2id, which is why this      │
 * │  system has no password column for anyone to be tempted by.        │
 * │                                                                    │
 * │  The 8-digit OTP is the one lower-entropy case, and it is defended │
 * │  by three things instead: a five-minute life, an attempt counter   │
 * │  on the row, and a rate bucket on the address.                     │
 * └────────────────────────────────────────────────────────────────────┘
 */

/** A 256-bit URL-safe secret. Used for sessions and magic links. */
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * An 8-digit numeric code, uniformly distributed.
 *
 * `randomInt` rather than `Math.random` — the latter is not a CSPRNG, and
 * a predictable sign-in code is a sign-in for whoever predicts it. Eight
 * digits rather than six because the extra two decimal digits cost the
 * person nothing and multiply an attacker's work by a hundred.
 */
export function mintNumericCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, '0');
}

/** Recovery codes, in a shape a person can read off paper without errors. */
export function mintRecoveryCode(): string {
  // Crockford-ish: no I, O, U — the characters people mistranscribe.
  const alphabet = '0123456789ABCDEFGHJKLMNPQRSTVWXYZ';
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    if (i === 5) out += '-';
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

export function hashToken(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Compare two hex digests without leaking where they diverge.
 *
 * A `===` on a digest is a timing oracle: it returns as soon as two bytes
 * differ, so an attacker who can measure the response learns the prefix
 * one character at a time. The lengths are equal by construction here,
 * but they are still checked because `timingSafeEqual` throws rather than
 * returning false when they are not.
 */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
