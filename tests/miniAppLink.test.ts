/**
 * Parsing the Mini App address.
 *
 * The value a person types into a deployment setting decides whether every
 * shared deal link opens the app or dumps the recipient into a bot chat.
 * It is typed once, by hand, from memory — so the parser has to accept the
 * forms people actually write and say precisely why when it cannot.
 *
 * `vi.resetModules()` before each case because the module reads its value
 * at import time, which is what makes it a build-time constant in the app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL = process.env.NEXT_PUBLIC_TELEGRAM_MINI_APP;

async function load(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) delete process.env.NEXT_PUBLIC_TELEGRAM_MINI_APP;
  else process.env.NEXT_PUBLIC_TELEGRAM_MINI_APP = value;
  return import('@/lib/miniApp');
}

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_TELEGRAM_MINI_APP;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_TELEGRAM_MINI_APP;
  else process.env.NEXT_PUBLIC_TELEGRAM_MINI_APP = ORIGINAL;
});

describe('both ways of shipping a Mini App are accepted', () => {
  it('takes a named direct-link app', async () => {
    const m = await load('https://t.me/INRP2P_bot/app');
    expect(m.MINI_APP_BASE).toBe('https://t.me/INRP2P_bot/app');
    expect(m.miniAppDealLink('INRP-ABCDEFGHJK')).toBe(
      'https://t.me/INRP2P_bot/app?startapp=d_INRP-ABCDEFGHJK',
    );
  });

  it('takes a bot whose MAIN Mini App is configured', async () => {
    // Requiring a short name rejected this, which is an ordinary way to
    // ship a Mini App — `?startapp=` still reaches it.
    const m = await load('https://t.me/INRP2P_bot');
    expect(m.MINI_APP_BASE).toBe('https://t.me/INRP2P_bot');
    expect(m.miniAppDealLink('INRP-ABCDEFGHJK')).toBe(
      'https://t.me/INRP2P_bot?startapp=d_INRP-ABCDEFGHJK',
    );
  });
});

describe('the mistakes people actually make', () => {
  it('strips a leading @, because that is how bots are written everywhere else', async () => {
    // `t.me/@Bot` redirects rather than resolving, so left alone it produces
    // a link that quietly fails to open the app.
    const m = await load('https://t.me/@INRP2P_bot');
    expect(m.MINI_APP_BASE).toBe('https://t.me/INRP2P_bot');
    expect(m.MINI_APP_PROBLEM).toBeNull();
  });

  it('tolerates a trailing slash and surrounding whitespace', async () => {
    const m = await load('  https://t.me/INRP2P_bot/app/  ');
    expect(m.MINI_APP_BASE).toBe('https://t.me/INRP2P_bot/app');
  });
});

describe('a bad value explains itself', () => {
  it('separates "nobody set this" from "this cannot work"', async () => {
    const unset = await load(undefined);
    expect(unset.MINI_APP_BASE).toBeNull();
    expect(unset.MINI_APP_PROBLEM).toEqual({ kind: 'UNSET' });

    const bad = await load('https://example.com/INRP2P_bot');
    expect(bad.MINI_APP_BASE).toBeNull();
    expect(bad.MINI_APP_PROBLEM?.kind).toBe('INVALID');
  });

  it('names the reason rather than just refusing', async () => {
    for (const [value, fragment] of [
      ['http://t.me/INRP2P_bot', 'https'],
      ['https://example.com/bot', 't.me'],
      ['https://t.me/', 'bot username'],
      ['not a url at all', 'not a URL'],
    ] as const) {
      const m = await load(value);
      expect(m.MINI_APP_PROBLEM?.kind).toBe('INVALID');
      const reason = m.MINI_APP_PROBLEM?.kind === 'INVALID' ? m.MINI_APP_PROBLEM.reason : '';
      expect(reason.toLowerCase()).toContain(fragment.toLowerCase());
    }
  });
});

describe('the payload cannot smuggle anything', () => {
  it('refuses characters Telegram would drop', async () => {
    const m = await load('https://t.me/INRP2P_bot/app');
    // Telegram restricts startapp to A-Za-z0-9_-; anything else silently
    // vanishes, which would produce a link opening the wrong screen.
    expect(m.miniAppLink('has spaces')).toBeNull();
    expect(m.miniAppLink('../../escape')).toBeNull();
    expect(m.miniAppLink('')).toBeNull();
  });
});
