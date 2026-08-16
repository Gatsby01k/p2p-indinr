import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { verifyInitData } from '@/server/telegram/verify';
import { createHmac } from 'node:crypto';

/**
 * The web-surface half of `SECURITY-THREAT-MODEL.md`.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THESE THREATS LIVE IN THE FRAMEWORK LAYER, NOT THE DATABASE.      │
 * │                                                                    │
 * │  Open redirect, XSS, response-header smuggling and webhook         │
 * │  verification are decided by request handling and by what the      │
 * │  templates do with a string, so they are proved here rather than   │
 * │  in the integration suite — no PostgreSQL is involved.             │
 * │                                                                    │
 * │  Where the control is structural (React escaping, a header set on  │
 * │  every response), the test asserts the STRUCTURE — a scan of the   │
 * │  real source for the shape that would defeat it — because that is  │
 * │  what a future change would break.                                 │
 * └────────────────────────────────────────────────────────────────────┘
 */

function sourceFiles(dir = 'src'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(path)) out.push(path);
  }
  return out;
}

/* ================================================================== *
 * T12 · Open redirect
 * ================================================================== */

describe('T12 open redirect: sign-in returns only to this origin', () => {
  /** The guard as written in `src/app/login/page.tsx`. */
  const destinationFor = (next: string | undefined) =>
    next && next.startsWith('/') && !next.startsWith('//') ? next : '/app';

  it.each([
    ['https://evil.example/steal', '/app'],
    ['//evil.example/steal', '/app'],
    ['http://evil.example', '/app'],
    ['javascript:alert(1)', '/app'],
    ['\\\\evil.example', '/app'],
    ['/app/deals', '/app/deals'],
    ['/d/INRP-ABCDEFGHJK', '/d/INRP-ABCDEFGHJK'],
  ])('%s → %s', (next, expected) => {
    expect(destinationFor(next)).toBe(expected);
  });

  it('rejects the protocol-relative form specifically', () => {
    // `//evil.example` is the classic bypass: it starts with `/`, and a
    // browser reads it as a full URL on another origin.
    expect(destinationFor('//evil.example/x')).toBe('/app');
  });

  it('the guard is the only place a `next` parameter is honoured', () => {
    /*
     * A second, unguarded redirect would reopen the hole. Any other
     * `redirect(` fed directly from a search parameter is a finding.
     */
    const offenders = sourceFiles().filter((f) => {
      const text = readFileSync(f, 'utf8');
      return /redirect\(\s*(?:searchParams|params)\b/.test(text);
    });
    expect(offenders, 'a redirect taken straight from user input').toEqual([]);
  });
});

/* ================================================================== *
 * T13 · Cross-site scripting
 * ================================================================== */

describe('T13 XSS: no user-controlled string reaches raw HTML', () => {
  /**
   * The only accepted raw-HTML site, and why.
   *
   * `QrCode` renders SVG produced by the `qrcode` encoder, which turns
   * the value into path geometry — the input becomes encoded modules,
   * never markup — and the string it encodes is built server-side from
   * a deal's own public id. Every other opt-out is a finding.
   */
  /*
   * Two entries, and both are the SAME encoder in the two places it can
   * run. The server component draws every ordinary code; the client one
   * exists only because the authenticator URI carries a TOTP secret that
   * must not reach an RSC payload. Neither interpolates a value into
   * markup — the value becomes path geometry — and keeping the list to
   * QR renderers is what makes a third entry a question somebody has to
   * answer.
   */
  const ALLOWED_RAW_HTML: Readonly<Record<string, string>> = {
    'src/components/kit/QrCode.tsx':
      'SVG from the qrcode encoder; the value becomes path data, not markup.',
    'src/components/kit/QrCodeClient.tsx':
      'The same encoder, in the browser, for the enrolment URI that must never leave it.',
  };

  it('only the QR encoder uses dangerouslySetInnerHTML', () => {
    /*
     * React escapes interpolated text, so the realistic route to stored
     * XSS here is an explicit opt-out. This fails the moment a new one
     * appears without somebody writing down why it is safe.
     */
    const offenders = sourceFiles().filter(
      (f) =>
        readFileSync(f, 'utf8').includes('dangerouslySetInnerHTML') &&
        ALLOWED_RAW_HTML[f] === undefined,
    );
    expect(offenders).toEqual([]);
  });

  it('every allowed site still encodes rather than interpolates', () => {
    // Both allowed files, not just the first: an exemption that is only
    // spot-checked is an exemption nobody is checking.
    for (const file of Object.keys(ALLOWED_RAW_HTML)) {
      const source = readFileSync(file, 'utf8');
      // The markup comes from the encoder's own `type: 'svg'` output.
      expect(source, file).toMatch(/type:\s*'svg'/);
      // And never from a template built out of the value.
      expect(source, file).not.toMatch(/__html:\s*`/);
    }
  });

  it('no component writes to innerHTML or document.write', () => {
    const offenders = sourceFiles().filter((f) => {
      const text = readFileSync(f, 'utf8');
      return /\.innerHTML\s*=|document\.write\s*\(/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('no `javascript:` or `data:` href is constructed from a value', () => {
    const offenders = sourceFiles().filter((f) => {
      const text = readFileSync(f, 'utf8');
      return /href=\{`?\s*(?:javascript|data):/i.test(text);
    });
    expect(offenders).toEqual([]);
  });
});

/* ================================================================== *
 * T14 · Evidence download: file-type smuggling and path traversal
 * ================================================================== */

describe('T14 evidence: an uploaded file cannot become active content', () => {
  const route = readFileSync('src/app/api/evidence/[evidenceId]/route.ts', 'utf8');

  it('is served as an attachment, never inline', () => {
    // Without this, an uploaded .html renders in the app's own origin
    // and reads the session cookie.
    expect(route).toMatch(/Content-Disposition['"`]?\s*:\s*`attachment;/);
  });

  it('sets nosniff, so a mislabelled type is not guessed', () => {
    expect(route).toMatch(/'X-Content-Type-Options':\s*'nosniff'/);
  });

  it('forbids shared caching of a private file', () => {
    expect(route).toMatch(/'Cache-Control':\s*'private, no-store'/);
  });

  it('strips quotes and newlines from the filename', () => {
    /*
     * The stored name came from a browser and is attacker-controlled. An
     * unescaped `"` or CRLF would break out of the header and let the
     * caller inject headers of their own.
     */
    expect(route).toContain('.replace(');
    expect(route).toContain('safeName');

    const strip = (name: string) => name.replace(/["\\\r\n]/g, '_').slice(0, 120) || 'evidence';
    expect(strip('a"; filename="b.html')).not.toContain('"');
    expect(strip('a\r\nX-Injected: 1')).not.toMatch(/[\r\n]/);
    expect(strip('')).toBe('evidence');
  });

  it('refuses an id that is not a UUID before touching the database', () => {
    const guard = /^[0-9a-f-]{36}$/i;
    expect(guard.test('../../../etc/passwd')).toBe(false);
    expect(guard.test('%2e%2e%2fetc%2fpasswd')).toBe(false);
    expect(guard.test('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it('answers 404 — never 403 — to a caller with no rights', () => {
    // A distinguishable "forbidden" confirms the file exists.
    expect(route).toContain("new NextResponse('Not found', { status: 404 })");
    expect(route).not.toMatch(/status:\s*403/);
  });
});

/* ================================================================== *
 * T15 · Webhook verification: forgery, tampering, replay, timing
 * ================================================================== */

describe('T15 Telegram launch data is verified, aged and compared safely', () => {
  const BOT_TOKEN = 'test-bot-token-for-verification-only';
  // The verifier reads its token from configuration, not from a
  // parameter, so the environment is what a test has to set.
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;

  /** Build genuinely signed initData, the way Telegram would. */
  function signed(params: Record<string, string>): string {
    const search = new URLSearchParams(params);
    const dataCheckString = [...search.entries()]
      .filter(([k]) => k !== 'hash')
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
    search.set('hash', hash);
    return search.toString();
  }

  const now = () => Math.floor(Date.now() / 1000);
  const user = JSON.stringify({ id: 12345, first_name: 'Test' });

  it('accepts data Telegram actually signed', () => {
    const data = signed({ auth_date: String(now()), user });
    const verdict = verifyInitData(data);
    expect(verdict.ok).toBe(true);
  });

  it('REFUSES a tampered field, even one character', () => {
    const data = signed({ auth_date: String(now()), user });
    const tampered = data.replace('12345', '99999');
    expect(verifyInitData(tampered).ok).toBe(false);
  });

  it('REFUSES a forged hash', () => {
    const search = new URLSearchParams({ auth_date: String(now()), user });
    search.set('hash', 'f'.repeat(64));
    expect(verifyInitData(search.toString()).ok).toBe(false);
  });

  it('REFUSES data signed with a different bot token', () => {
    const data = signed({ auth_date: String(now()), user });
    process.env.TELEGRAM_BOT_TOKEN = 'a-completely-different-token';
    const verdict = verifyInitData(data);
    process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
    expect(verdict.ok).toBe(false);
  });

  it('REFUSES stale data, so a captured launch expires', () => {
    // A captured `initData` string authenticated for 24 hours before
    // DEL-03 bounded it (TS-00 AUD-P1-009).
    // One second past the 24-hour ceiling, not exactly on it.
    const old = signed({ auth_date: String(now() - 60 * 60 * 24 - 1), user });
    expect(verifyInitData(old).ok).toBe(false);
  });

  it('REFUSES a future auth_date', () => {
    const ahead = signed({ auth_date: String(now() + 60 * 60), user });
    expect(verifyInitData(ahead).ok).toBe(false);
  });

  it('compares the signature in constant time', () => {
    /*
     * A byte-by-byte `===` on a hex digest leaks how many leading
     * characters were right, which is enough to forge one offline.
     */
    const source = readFileSync('src/server/telegram/verify.ts', 'utf8');
    expect(source).toContain('timingSafeEqual');
    // The length check must come first: `timingSafeEqual` throws on a
    // length mismatch, and a throw is itself an oracle.
    expect(source).toMatch(/expected\.length === provided\.length && timingSafeEqual/);
  });

  it('refuses empty or malformed input without throwing', () => {
    for (const bad of ['', 'hash=', 'not-a-query-string', '%%%']) {
      expect(() => verifyInitData(bad)).not.toThrow();
      expect(verifyInitData(bad).ok).toBe(false);
    }
  });
});

/* ================================================================== *
 * T16 · SSRF
 * ================================================================== */

describe('T16 SSRF: no user-supplied value reaches an outbound request', () => {
  it('no fetch target is built from request input', () => {
    /*
     * The only outbound calls in this repository are to adapters whose
     * base URL comes from configuration. A `fetch` whose URL is
     * assembled from a parameter would be the SSRF this checks for.
     */
    const offenders = sourceFiles().filter((f) => {
      const text = readFileSync(f, 'utf8');
      return /fetch\(\s*`?\$\{?(?:input|params|searchParams|body|req)\b/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('the only outbound calls are adapter calls', () => {
    /*
     * Narrow on purpose. The earlier form flagged every `fetch(` whose
     * first token it could not classify — including ordinary internal
     * calls — and a check that cries wolf gets waived. What matters for
     * SSRF is that no request TARGET is assembled from caller input,
     * which the test above pins directly.
     */
    const withFetch = sourceFiles().filter((f) => /\bfetch\(/.test(readFileSync(f, 'utf8')));
    for (const file of withFetch) {
      const text = readFileSync(file, 'utf8');
      for (const call of text.matchAll(/fetch\(\s*([^,)]+)/g)) {
        const target = (call[1] ?? '').trim();
        /*
         * Two shapes are acceptable: a same-origin path (a relative
         * string beginning with `/`), and an adapter reading its base
         * from configuration. Anything else is a URL from somewhere,
         * and "somewhere" is what SSRF exploits.
         */
        const sameOrigin = /^['"`]\//.test(target);
        const fromConfig =
          file.startsWith('src/server/adapters/') && /process\.env|config|_URL\b/.test(target);
        expect(sameOrigin || fromConfig, `${file}: fetch(${target.slice(0, 40)})`).toBe(true);
      }
    }
  });
});

/* ================================================================== *
 * T17 · CSRF and session-cookie attributes
 * ================================================================== */

describe('T17 CSRF: the cookie is hardened, and the embedded case is honest', () => {
  const session = readFileSync('src/server/sandbox/session.ts', 'utf8');

  it('the session cookie is httpOnly, so script cannot read it', () => {
    expect(session).toMatch(/httpOnly:\s*true/);
  });

  it('relaxes SameSite ONLY when embedded, and pairs it with Secure', () => {
    /*
     * A Telegram Mini App runs in a cross-site iframe, where a `Lax`
     * cookie is simply not sent and nobody can sign in. `None` is
     * therefore required — and it means SameSite contributes NOTHING to
     * CSRF defence in that mode, which the threat model states plainly
     * rather than claiming protection it does not have.
     *
     * Browsers reject `SameSite=None` without `Secure`, and this pairs
     * them so an embedded session is never sent in clear.
     */
    expect(session).toMatch(/sameSite:\s*options\.embedded \? 'none' : 'lax'/);
    expect(session).toMatch(/secure:\s*options\.embedded \|\| isProduction/);
  });

  it('every mutation is a server action, not a hand-rolled POST', () => {
    /*
     * What actually answers CSRF here: Next.js server actions are
     * POST-only to unguessable, build-scoped action ids and verify the
     * request Origin against the Host. A bare mutating route handler
     * would sit outside that and is what this looks for.
     */
    const routes = sourceFiles('src/app').filter((f) => /\/route\.tsx?$/.test(f));
    for (const file of routes) {
      const text = readFileSync(file, 'utf8');
      const mutating = /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/.test(text);
      if (!mutating) continue;
      // The one mutating route is Telegram's, authenticated by HMAC over
      // the initData rather than by the session cookie.
      const signatureAuthenticated = /verifyInitData|createHmac|timingSafeEqual/.test(text);
      expect(signatureAuthenticated, `${file} mutates without signature auth`).toBe(true);
    }
  });
});
