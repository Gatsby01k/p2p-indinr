import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/server/db/pool';
import { redeemEmailSignIn, startEmailSignIn } from '@/server/identity/auth';
import { clearDeliveries, lastDeliveredTo } from '@/server/adapters/emailDelivery';
import { unique } from './support/room';

/**
 * The typed sign-in code must work. It did not.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  FOUND BY DRIVING THE REAL BROWSER IN DEL-10.                      │
 * │                                                                    │
 * │  The screen asks for a code, the placeholder reads `12345678`, the │
 * │  copy promises "a one-time code" by email. Typing that code was    │
 * │  refused every time with "That sign-in code is not valid."         │
 * │                                                                    │
 * │  DEL-03 minted `secret = "<code>.<link token>"` and stored one     │
 * │  hash — of the concatenation. Nothing ever hashed the code alone,  │
 * │  so the ONLY credential that could match was the whole internal    │
 * │  string, which no person ever sees. The primary advertised route   │
 * │  into the product was closed.                                      │
 * │                                                                    │
 * │  These tests pin BOTH credentials open, and pin shut the ways the  │
 * │  weaker of the two could be abused.                                │
 * └────────────────────────────────────────────────────────────────────┘
 */

beforeEach(clearDeliveries);

/** The two halves a person may be holding, from one issued challenge. */
async function issue(prefix = 'code') {
  const email = `${prefix}-${unique()}@example.com`;
  await startEmailSignIn(email);
  const secret = lastDeliveredTo(email)!.secret;
  const [code, linkToken] = secret.split('.');
  return { email, secret, code: code!, linkToken: linkToken! };
}

describe('either credential redeems the same challenge', () => {
  it('the TYPED CODE alone signs a person in', async () => {
    // The exact regression. This returned AUTH_CHALLENGE_INVALID.
    const { email, code } = await issue();
    expect(code).toMatch(/^\d{8}$/);

    const signedIn = await redeemEmailSignIn({ email, secret: code });
    expect(signedIn.ok, 'the code shown on screen must be accepted').toBe(true);
    if (!signedIn.ok) return;
    expect(signedIn.value.sessionToken.length).toBeGreaterThan(0);
  });

  it('the FULL LINK SECRET still signs a person in', async () => {
    const { email, secret } = await issue();
    const signedIn = await redeemEmailSignIn({ email, secret });
    expect(signedIn.ok).toBe(true);
  });

  it('consumes the challenge EXACTLY ONCE across both credentials', async () => {
    /*
     * The property that makes two credentials safe: they are two doors
     * into one room, not two rooms. Redeeming the code must spend the
     * link as well, or a leaked link would outlive its own sign-in.
     */
    const { email, code, secret } = await issue();

    const first = await redeemEmailSignIn({ email, secret: code });
    expect(first.ok).toBe(true);

    const second = await redeemEmailSignIn({ email, secret });
    expect(second.ok, 'the link must be spent too').toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('AUTH_CHALLENGE_INVALID');
  });

  it('the link is spent when the link is used', async () => {
    const { email, secret, code } = await issue();
    expect((await redeemEmailSignIn({ email, secret })).ok).toBe(true);
    expect((await redeemEmailSignIn({ email, secret: code })).ok).toBe(false);
  });
});

describe('eight digits cannot be attacked across the whole table', () => {
  it("a code is NOT valid for a different person's address", async () => {
    /*
     * The reason the stored hash is salted with the address. Without it
     * one guess would be tested against every live challenge at once,
     * and the odds of hitting somebody's code would rise with traffic —
     * worst exactly when the product is busiest.
     */
    const mine = await issue('victim');
    const theirs = await issue('attacker');

    const crossed = await redeemEmailSignIn({ email: theirs.email, secret: mine.code });
    expect(crossed.ok, 'a code must belong to one mailbox').toBe(false);
  });

  it('two live challenges keep separate codes', async () => {
    const a = await issue('a');
    const b = await issue('b');
    expect(a.code).not.toBe(b.code);

    const { rows } = await getPool().query(
      `SELECT count(DISTINCT code_hash)::int AS n
         FROM sandbox.auth_challenge
        WHERE email IN ($1,$2) AND code_hash IS NOT NULL`,
      [a.email, b.email],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it('stores the code only as a hash, never in clear', async () => {
    const { email, code } = await issue();
    const { rows } = await getPool().query(
      `SELECT token_hash, code_hash FROM sandbox.auth_challenge WHERE email = $1`,
      [email],
    );
    const row = rows[0]!;
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    // The digits themselves must appear nowhere in the stored row.
    expect(JSON.stringify(row)).not.toContain(code);
  });

  it('a wrong code is refused indistinguishably from an unknown one', async () => {
    const { email } = await issue();
    const wrong = await redeemEmailSignIn({ email, secret: '00000000' });
    const unknown = await redeemEmailSignIn({
      email: `nobody-${unique()}@example.com`,
      secret: '00000000',
    });
    expect(wrong.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    if (wrong.ok || unknown.ok) return;
    // Same code, same sentence: neither reveals whether a challenge exists.
    expect(wrong.code).toBe(unknown.code);
    expect(wrong.message).toBe(unknown.message);
  });

  it('an expired code is refused', async () => {
    const { email, code } = await issue();
    // `expires_at > created_at` is a CHECK, so both move together —
    // the row must stay one a live system could actually have written.
    await getPool().query(
      `UPDATE sandbox.auth_challenge
          SET created_at = now() - interval '2 hours',
              expires_at = now() - interval '1 hour'
        WHERE email = $1`,
      [email],
    );
    expect((await redeemEmailSignIn({ email, secret: code })).ok).toBe(false);
  });
});
