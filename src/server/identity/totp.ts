import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) — a real second factor.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHY THIS IS IMPLEMENTED HERE AND NOT TAKEN FROM A PACKAGE.        │
 * │                                                                    │
 * │  RFC 6238 is HMAC-SHA1 over a counter, truncated. It is about      │
 * │  forty lines, it has no configuration surface worth arguing about, │
 * │  and `node:crypto` supplies every primitive. Adding a dependency   │
 * │  to a security boundary is a supply-chain decision, and this one   │
 * │  would buy nothing.                                                │
 * │                                                                    │
 * │  SHA-1 is correct here despite being broken for collisions: TOTP   │
 * │  uses it as an HMAC, where collision resistance is not the         │
 * │  property relied on, and every authenticator app implements the    │
 * │  SHA-1 variant. Choosing SHA-256 would be marginally stronger and  │
 * │  incompatible with the apps people actually have.                  │
 * └────────────────────────────────────────────────────────────────────┘
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Period and digits, matching what every authenticator app assumes. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

/**
 * How many steps either side of "now" are accepted.
 *
 * One step — thirty seconds — covers ordinary clock drift between a phone
 * and a server. Wider windows are a common and quiet weakening: every
 * extra step multiplies the number of codes valid at any instant.
 */
export const TOTP_DRIFT_STEPS = 1;

export function generateSecret(): string {
  const bytes = randomBytes(20); // 160 bits, the RFC 4226 recommendation
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) continue;
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** The step number for a moment. Exposed so replay protection can store it. */
export function stepFor(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

export function codeFor(secret: string, step: number): string {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac('sha1', key).update(counter).digest();
  // Dynamic truncation, RFC 4226 §5.4.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export interface TotpVerdict {
  readonly ok: boolean;
  /** The step the code belonged to. Stored to prevent replay. */
  readonly step?: number;
}

/**
 * Verify a presented code.
 *
 * `lastStep` is the highest step already accepted for this factor. A code
 * at or below it is REFUSED even though it is arithmetically valid —
 * which is what stops the same six digits being replayed inside their own
 * thirty-second window by anyone who watched them being typed.
 */
export function verifyTotp(
  secret: string,
  presented: string,
  options: { readonly lastStep?: number | null; readonly at?: Date } = {},
): TotpVerdict {
  const cleaned = presented.replace(/\D/g, '');
  if (cleaned.length !== TOTP_DIGITS) return { ok: false };

  const current = stepFor(options.at ?? new Date());
  for (let drift = -TOTP_DRIFT_STEPS; drift <= TOTP_DRIFT_STEPS; drift += 1) {
    const step = current + drift;
    if (options.lastStep !== null && options.lastStep !== undefined && step <= options.lastStep) {
      continue; // already used — replay
    }
    const expected = codeFor(secret, step);
    const a = Buffer.from(expected);
    const b = Buffer.from(cleaned);
    if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true, step };
  }
  return { ok: false };
}

/** The `otpauth://` URI an authenticator app scans. Carries no secret to us. */
export function enrolmentUri(secret: string, account: string): string {
  const label = encodeURIComponent(`INRP2P:${account}`);
  return (
    `otpauth://totp/${label}?secret=${secret}&issuer=INRP2P` +
    `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`
  );
}
