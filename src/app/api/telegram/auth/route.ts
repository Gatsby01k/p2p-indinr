import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import {
  attachReferrer,
  destinationForStartParam,
  setSessionCookie,
  signInWithTelegramLaunch,
  verifyInitData,
  type VerifyFailure,
} from '@/services';

export const dynamic = 'force-dynamic';
/** Node, not Edge: the verification uses `node:crypto`. */
export const runtime = 'nodejs';

/**
 * Exchange a Telegram Mini App launch for a session.
 *
 * The ONLY endpoint that can create a session from Telegram, and it does
 * exactly three things in order: verify the HMAC, resolve the account,
 * issue the cookie. Nothing is read from the request body except the
 * `initData` string itself, so there is no field a caller could add to
 * influence which account they become.
 *
 * ⚠ WHY THIS IS A ROUTE HANDLER AND NOT A SERVER ACTION.
 * A server action is invoked through the React runtime, which applies its
 * own origin checks — sensible for a mutation from our own page, wrong
 * here. This request legitimately originates inside Telegram's webview and
 * must be judged on its signature alone, not on where it came from.
 */

const FAILURE_STATUS: Readonly<Record<VerifyFailure, number>> = {
  // The deployment is missing its bot token: our fault, not the caller's.
  NO_BOT_TOKEN: 503,
  MALFORMED: 400,
  NO_HASH: 400,
  BAD_SIGNATURE: 401,
  STALE: 401,
  NO_USER: 400,
};

/**
 * What the browser is told.
 *
 * The message stays plain, but the REASON CODE now travels with it.
 *
 * It was withheld as an oracle risk, and that judgement was wrong on the
 * balance of harms. Nobody can brute-force an HMAC-SHA256 keyed by the bot
 * token, so learning "stale" versus "bad signature" buys an attacker
 * nothing they could act on. Meanwhile it cost a real user a dead end and
 * cost us the ability to tell those two apart from a screenshot — which is
 * the only diagnostic anyone actually has when a Mini App fails on someone
 * else's phone.
 */
const FAILURE_MESSAGE: Readonly<Record<VerifyFailure, string>> = {
  NO_BOT_TOKEN: 'Telegram sign-in is not configured on this deployment.',
  MALFORMED: 'That launch could not be read.',
  NO_HASH: 'That launch could not be read.',
  BAD_SIGNATURE: 'This launch could not be verified. Open the app from Telegram again.',
  STALE: 'This launch could not be verified. Open the app from Telegram again.',
  NO_USER: 'That launch could not be read.',
};

export async function POST(request: Request): Promise<NextResponse> {
  let initData = '';
  try {
    const body: unknown = await request.json();
    if (typeof body === 'object' && body !== null && 'initData' in body) {
      const raw = (body as { initData: unknown }).initData;
      if (typeof raw === 'string') initData = raw;
    }
  } catch {
    return NextResponse.json({ ok: false, message: 'Expected a JSON body.' }, { status: 400 });
  }

  const result = verifyInitData(initData);
  if (!result.ok) {
    console.warn('[telegram] launch rejected:', result.reason);
    return NextResponse.json(
      { ok: false, code: result.reason, message: FAILURE_MESSAGE[result.reason] },
      { status: FAILURE_STATUS[result.reason] },
    );
  }

  const { user: tgUser, startParam, authDate } = result.launch;

  /*
   * SINGLE USE, not merely fresh.
   *
   * The HMAC above proves Telegram produced this string. It does not
   * prove the string has not been presented before — and it used to be
   * accepted for a full 24 hours (TS-00 `AUD-P1-009`), so a copy taken
   * from a log or a shared device authenticated all day. The launch
   * digest is now recorded, and its primary key refuses a second use.
   */
  const signIn = await signInWithTelegramLaunch({
    user: tgUser,
    initDataHash: initData,
    authDate,
    deviceLabel: 'Telegram',
  });
  if (!signIn.ok) {
    console.warn('[telegram] sign-in refused:', signIn.code);
    return NextResponse.json(
      { ok: false, code: signIn.code, message: signIn.message },
      { status: signIn.code === 'RATE_LIMITED' ? 429 : 401 },
    );
  }
  const { userId, sessionToken, expiresAt, created } = signIn.value;
  const user = { userId, displayName: tgUser.firstName || tgUser.username || 'Telegram' };

  // A referral is recorded on the FIRST launch only. `attachReferrer` is
  // additionally guarded by UNIQUE(invitee_id), so a person cannot be
  // re-attributed later by relaunching with someone else's code.
  if (created && startParam?.startsWith('r_')) {
    await attachReferrer(userId, startParam.slice(2));
  }

  /*
   * `embedded: true` issues the cookie as `SameSite=None; Secure`, which is
   * the only form Telegram Web and Desktop will send back from their
   * cross-site iframe. See the comment on `setSessionCookie`.
   */
  await setSessionCookie(sessionToken, { embedded: true, expiresAt });

  const forwardedProto = (await headers()).get('x-forwarded-proto');
  const insecure = forwardedProto !== null && forwardedProto !== 'https';

  return NextResponse.json({
    ok: true,
    created,
    displayName: user.displayName,
    destination: destinationForStartParam(startParam),
    /*
     * A `Secure` cookie is silently dropped over plain HTTP, so the sign-in
     * would appear to succeed and then not stick. Saying so explicitly beats
     * letting the client loop on an invisible failure.
     */
    warning: insecure
      ? 'This deployment is not served over HTTPS, so the session cookie will be discarded.'
      : null,
  });
}
