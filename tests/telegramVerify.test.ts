/**
 * The Telegram authentication boundary.
 *
 * `verifyInitData` decides who is signed in, so these tests are about
 * FORGERY, not formatting. Each one constructs launch data the way Telegram
 * does, then changes one thing an attacker controls and asserts the result
 * is refused.
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_AUTH_AGE_SECONDS,
  displayNameFor,
  telegramConfigured,
  verifyInitData,
} from '@/server/telegram/verify';

const BOT_TOKEN = '7654321098:AAH9testtokenvaluewithenoughlength01';
const OTHER_TOKEN = '1234567890:AAGdifferenttokenvaluewithlength012';

const NOW = new Date('2026-08-07T12:00:00.000Z');
const AUTH_DATE = Math.floor(NOW.getTime() / 1000) - 30;

const USER = {
  id: 8_100_200_300,
  first_name: 'Arjun',
  last_name: 'Mehta',
  username: 'arjun_m',
  language_code: 'en',
  photo_url: 'https://cdn5.telegram-cdn.org/file/arjun.jpg',
};

/** Build signed launch data exactly as Telegram does. */
function sign(fields: Record<string, string>, token = BOT_TOKEN): string {
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  const params = new URLSearchParams(fields);
  params.set('hash', hash);
  return params.toString();
}

function launchFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    user: JSON.stringify(USER),
    auth_date: String(AUTH_DATE),
    chat_instance: '-1234567890',
    ...overrides,
  };
}

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
});

afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
});

describe('a genuine launch', () => {
  it('is accepted and yields the Telegram user', () => {
    const result = verifyInitData(sign(launchFields()), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.launch.user.id).toBe(USER.id);
    expect(result.launch.user.username).toBe('arjun_m');
    expect(result.launch.user.firstName).toBe('Arjun');
    expect(result.launch.authDate.getTime()).toBe(AUTH_DATE * 1000);
  });

  it('carries a valid start_param through', () => {
    const data = sign(launchFields({ start_param: 'd_INRP-ABCDEFGHJK' }));
    const result = verifyInitData(data, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.launch.startParam).toBe('d_INRP-ABCDEFGHJK');
  });

  it('drops a start_param that is not in Telegram’s permitted alphabet', () => {
    // A payload containing a slash or a colon could otherwise be built into
    // a path or an absolute URL by a careless caller downstream.
    const data = sign(launchFields({ start_param: '../../admin' }));
    const result = verifyInitData(data, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.launch.startParam).toBeNull();
  });
});

describe('forged launches are refused', () => {
  it('rejects data signed with a different bot token', () => {
    const data = sign(launchFields(), OTHER_TOKEN);
    expect(verifyInitData(data, NOW)).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('rejects a tampered user id even though every other field is intact', () => {
    // The whole attack in one line: keep Telegram's signature, swap the
    // account. If this ever passes, anyone can be anyone.
    const genuine = sign(launchFields());
    const params = new URLSearchParams(genuine);
    params.set('user', JSON.stringify({ ...USER, id: 999 }));
    expect(verifyInitData(params.toString(), NOW)).toMatchObject({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  });

  it('rejects an added field that was not signed', () => {
    const params = new URLSearchParams(sign(launchFields()));
    params.set('is_operator', 'true');
    expect(verifyInitData(params.toString(), NOW)).toMatchObject({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  });

  it('rejects a missing or malformed hash', () => {
    const params = new URLSearchParams(launchFields());
    expect(verifyInitData(params.toString(), NOW)).toMatchObject({ ok: false, reason: 'NO_HASH' });

    params.set('hash', 'not-a-digest');
    expect(verifyInitData(params.toString(), NOW)).toMatchObject({ ok: false, reason: 'NO_HASH' });
  });

  it('rejects empty and oversized input', () => {
    expect(verifyInitData('', NOW)).toMatchObject({ ok: false, reason: 'MALFORMED' });
    expect(verifyInitData('x'.repeat(9000), NOW)).toMatchObject({ ok: false, reason: 'MALFORMED' });
  });
});

describe('replay is bounded', () => {
  it('rejects launch data older than the window', () => {
    const stale = Math.floor(NOW.getTime() / 1000) - MAX_AUTH_AGE_SECONDS - 60;
    const data = sign(launchFields({ auth_date: String(stale) }));
    expect(verifyInitData(data, NOW)).toMatchObject({ ok: false, reason: 'STALE' });
  });

  it('accepts launch data just inside the window', () => {
    const fresh = Math.floor(NOW.getTime() / 1000) - MAX_AUTH_AGE_SECONDS + 60;
    const data = sign(launchFields({ auth_date: String(fresh) }));
    expect(verifyInitData(data, NOW).ok).toBe(true);
  });

  it('rejects a timestamp implausibly far in the future', () => {
    const future = Math.floor(NOW.getTime() / 1000) + 3600;
    const data = sign(launchFields({ auth_date: String(future) }));
    expect(verifyInitData(data, NOW)).toMatchObject({ ok: false, reason: 'STALE' });
  });
});

describe('fails closed on configuration', () => {
  it('refuses everything when no bot token is set', () => {
    const data = sign(launchFields());
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(verifyInitData(data, NOW)).toMatchObject({ ok: false, reason: 'NO_BOT_TOKEN' });
    expect(telegramConfigured()).toBe(false);
  });

  it('treats a placeholder token as no token at all', () => {
    // A signature verified against a guessable secret is not a signature.
    process.env.TELEGRAM_BOT_TOKEN = 'changeme';
    expect(telegramConfigured()).toBe(false);
    expect(verifyInitData('anything', NOW)).toMatchObject({ ok: false, reason: 'NO_BOT_TOKEN' });
  });
});

describe('user parsing', () => {
  it('refuses a launch with no user object', () => {
    const data = sign({ auth_date: String(AUTH_DATE) });
    expect(verifyInitData(data, NOW)).toMatchObject({ ok: false, reason: 'NO_USER' });
  });

  it('discards a photo URL that is not https', () => {
    const hostile = { ...USER, photo_url: 'javascript:alert(1)' };
    const data = sign(launchFields({ user: JSON.stringify(hostile) }));
    const result = verifyInitData(data, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.launch.user.photoUrl).toBeNull();
  });

  it('always produces a display name', () => {
    expect(displayNameFor({ ...toUser(USER) })).toBe('Arjun Mehta');
    expect(displayNameFor({ ...toUser(USER), firstName: '', lastName: null })).toBe('arjun_m');
    expect(displayNameFor({ ...toUser(USER), firstName: '', lastName: null, username: null })).toBe(
      `Telegram ${USER.id}`,
    );
  });
});

function toUser(raw: typeof USER) {
  return {
    id: raw.id,
    firstName: raw.first_name,
    lastName: raw.last_name,
    username: raw.username,
    languageCode: raw.language_code,
    isPremium: false,
    photoUrl: raw.photo_url,
  };
}
