#!/usr/bin/env node
/**
 * Sandbox journey — real browser, real screenshots.
 *
 * Drives the RUNNING BUILT APPLICATION with headless Chrome over the DevTools
 * Protocol, walking the whole vertical:
 *
 *   sign in → create link → public preview → second user joins →
 *   deal room → payment claim with UTR → counterparty confirms → completed
 *
 * and captures PNGs at desktop and mobile widths along the way. Every byte
 * comes from `Page.captureScreenshot` against the live server; nothing is
 * transcribed. Each capture asserts the page actually reached its state, so a
 * broken screen fails the run rather than being reported as captured.
 *
 *   node scripts/journey-screens.mjs --base http://localhost:3310
 */

import { spawn } from 'node:child_process';
import pg from 'pg';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = arg('base', 'http://localhost:3310').replace(/\/$/, '');
const OUT = path.resolve(arg('out', path.join(ROOT, 'docs/evidence/sandbox-screens')));

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p));

/**
 * The product matrix. `full` viewports walk the entire journey; the rest
 * capture the composition-critical screens, which is where a responsive
 * failure actually shows.
 */
const VIEWPORTS = [
  { name: '360x800', width: 360, height: 800, scale: 3, mobile: true, full: false },
  { name: '390x844', width: 390, height: 844, scale: 3, mobile: true, full: true },
  { name: '430x932', width: 430, height: 932, scale: 3, mobile: true, full: false },
  { name: '768x1024', width: 768, height: 1024, scale: 2, mobile: true, full: false },
  { name: '1024x1366', width: 1024, height: 1366, scale: 2, mobile: true, full: false },
  { name: '1280x800', width: 1280, height: 800, scale: 2, mobile: false, full: false },
  { name: '1440x900', width: 1440, height: 900, scale: 2, mobile: false, full: true },
  { name: '1728x1117', width: 1728, height: 1117, scale: 2, mobile: false, full: false },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Age a link past its deadline using the DATABASE clock.
 *
 * Only `expires_at` and `created_at` move. State, authorization, amounts
 * and roles are untouched, so what the page then renders is the server's
 * genuine EXPIRED verdict rather than a faked status.
 */
async function expireLink(publicId) {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query(
      `UPDATE sandbox.deal_link
          SET created_at = now() - interval '2 hours',
              expires_at = now() - interval '1 minute'
        WHERE public_id = $1`,
      [publicId],
    );
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/* ----------------------------- CDP ----------------------------------- */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (m.id === undefined) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 45_000);
    });
  }
}

class Page {
  constructor(cdp, s) {
    this.cdp = cdp;
    this.s = s;
  }
  call(m, p) {
    return this.cdp.send(m, p, this.s);
  }
  async setViewport(v) {
    await this.call('Emulation.setDeviceMetricsOverride', {
      width: v.width,
      height: v.height,
      deviceScaleFactor: v.scale,
      mobile: v.mobile,
    });
  }
  async eval(expression) {
    const r = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.text}`);
    return r.result.value;
  }
  async goto(url) {
    await this.call('Page.navigate', { url });
    await this.settle();

    // A page still showing its skeleton after settling is stuck rather than
    // slow — usually a navigation that raced an in-flight RSC transition.
    // One clean reload resolves it. If it survives that, the per-screen
    // assertion reports the real state rather than this masking it.
    const stuck = await this.eval(
      `/\\bloading( this deal)?$/i.test(((document.body && document.body.innerText) || '').replace(/\\s+/g,' ').trim())`,
    );
    if (stuck) {
      await this.call('Page.navigate', { url });
      await this.settle();
    }
  }
  async settle() {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if ((await this.eval('document.readyState')) === 'complete') break;
      if (Date.now() > deadline) throw new Error('load timeout');
      await sleep(120);
    }
    /*
     * Next streams dynamic routes, so `readyState` reaches "complete" while
     * content is still arriving and the `loading.tsx` fallback markup
     * lingers in the streamed HTML beside it. Neither is a reliable signal,
     * and neither is "an <h1> exists" — after a client transition the
     * previous page's heading is still mounted.
     *
     * Settle on QUIESCENCE instead: poll the rendered text until it stops
     * changing. That is content-agnostic, so it holds for a static landing
     * page, a streamed dynamic route and a client-side transition alike.
     */
    let previous = null;
    let stableFor = 0;
    const quietDeadline = Date.now() + 8_000;
    for (;;) {
      const current = await this.eval(`(() => {
        const text = (document.body && document.body.innerText) || '';
        // React streams content into the document and reveals it during
        // hydration, so before hydration \`innerText\` can be nothing but the
        // Suspense fallback. Treat a page that is still only a skeleton as
        // not-yet-settled rather than as stable.
        // The skeleton page is NOT bare "Loading" — the app shell renders
        // above it, so the body reads "…Sign out Loading". Anchoring the
        // match to the whole string therefore never fired, and a skeleton
        // counted as settled. Match the trailing loading status instead.
        const flat = text.replace(/\s+/g, ' ').trim();
        const skeletonOnly = /\bloading( this deal)?$/i.test(flat);
        return skeletonOnly ? null : text;
      })()`);
      stableFor = current !== null && current === previous && current.length > 0 ? stableFor + 1 : 0;
      previous = current;
      if (stableFor >= 3) break;
      if (Date.now() > quietDeadline) break; // the per-screen assert is the gate
      await sleep(220);
    }
    await sleep(500);
  }
  async text() {
    return this.eval('document.body ? document.body.innerText : ""');
  }
  async waitForText(re, ms = 20_000) {
    const src = re.source.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const deadline = Date.now() + ms;
    for (;;) {
      if (await this.eval(`new RegExp('${src}','${re.flags}').test(document.body.innerText)`))
        return;
      if (Date.now() > deadline) {
        throw new Error(`text ${re} not found.\n--- page ---\n${(await this.text()).slice(0, 900)}`);
      }
      await sleep(200);
    }
  }
  async fill(selector, value) {
    const ok = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return true; })()`);
    if (!ok) throw new Error(`no element ${selector}`);
    await sleep(150);
  }
  async click(selector) {
    const r = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'missing';
      if (el.disabled) return 'disabled';
      el.scrollIntoView({block:'center'}); el.click(); return 'ok'; })()`);
    if (r === 'missing') throw new Error(`no element ${selector}`);
    if (r === 'disabled') throw new Error(`element ${selector} is disabled — its guard rejected the input`);
    await sleep(900);
  }
  async shot(file) {
    const { data } = await this.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(file, Buffer.from(data, 'base64'));
  }
  /** Wait until the URL path stops matching `re`. */
  async waitForPathAway(re, ms = 25_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const p = await this.eval('location.pathname');
      if (!re.test(p)) return p;
      if (Date.now() > deadline) throw new Error(`still at ${p}`);
      await sleep(200);
    }
  }

  /**
   * Sign in through the real form. The session is a signed server cookie set
   * by the server action, so this exercises the actual auth path.
   *
   * The submit is a React server action, which navigates client-side —
   * `document.readyState` never leaves "complete", so waiting on it proves
   * nothing. Wait for the pathname to change instead, and only click once the
   * form is hydrated enough to have React's action handler attached.
   */
  async signIn(email) {
    await this.goto(`${BASE}/login`);
    // Hydration gate: the hidden $ACTION_ID input is server-rendered, but the
    // click only does anything once React has attached its submit handler.
    await sleep(700);
    await this.fill('main input[name="email"]', email);
    await this.click('main form button[type="submit"]');
    await this.waitForPathAway(/^\/login/);
    // The redirect is a client-side RSC transition. Navigating again while
    // it is still in flight races it and can leave the next page stuck on
    // its skeleton, so let it finish first.
    await this.settle();
    await sleep(400);
  }
}

/* ---------------------------- runner --------------------------------- */

async function main() {
  if (!CHROME) {
    console.error('No Chrome/Chromium found. Visual QA cannot run.');
    process.exit(2);
  }
  await mkdir(OUT, { recursive: true });

  const profile = path.join(process.env.TMPDIR || '/tmp', `inrp2p-journey-${process.pid}`);
  const port = 9500 + (process.pid % 300);
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const captured = [];
  const failures = [];
  const stamp = Date.now().toString(36).toUpperCase();

  try {
    let wsUrl = null;
    const deadline = Date.now() + 30_000;
    while (!wsUrl) {
      try {
        wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
          .webSocketDebuggerUrl;
      } catch {
        if (Date.now() > deadline) throw new Error('Chrome debugger never came up');
        await sleep(300);
      }
    }
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP socket error')), { once: true });
    });
    const cdp = new Cdp(ws);

    /**
     * A page in its OWN browser context.
     *
     * Contexts are what isolate cookie jars. Without this every tab shares one
     * jar, so signing the buyer in silently replaced the seller's session and
     * both "users" became the same person — which is precisely the confusion
     * a two-party journey must not have.
     */
    const newPage = async (vp) => {
      const { browserContextId } = await cdp.send('Target.createBrowserContext', {});
      const { targetId } = await cdp.send('Target.createTarget', {
        url: 'about:blank',
        browserContextId,
      });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const p = new Page(cdp, sessionId);
      await p.call('Page.enable', {});
      await p.call('Runtime.enable', {});
      await p.setViewport(vp);
      return { page: p, targetId, browserContextId };
    };

    for (const vp of VIEWPORTS) {
      const seller = `seller-${stamp}-${vp.name}@sandbox.test`;
      const buyer = `buyer-${stamp}-${vp.name}@sandbox.test`;
      const shots = [];

      // Screens captured at every viewport: these are where a responsive
      // failure actually shows. The rest need a full journey to reach.
      const CORE = new Set([
        '01-landing',
        '02-login',
        '05-link-open',
        '08-deal-fiat-side',
        '10-deal-completed-receipt',
        '12-operator-queue',
      ]);

      const capture = async (page, name, assertRe, refuteRe) => {
        if (!vp.full && !CORE.has(name)) return;
        const text = await page.text();
        if (assertRe && !assertRe.test(text)) {
          throw new Error(`${name}: ${assertRe} not matched.\n--- page ---\n${text.slice(0, 800)}`);
        }
        if (refuteRe && refuteRe.test(text)) {
          throw new Error(`${name}: ${refuteRe} unexpectedly matched`);
        }
        if (!/Sandbox/i.test(text)) {
          throw new Error(`${name}: sandbox notice missing`);
        }
        const overflow = await page.eval(
          'document.documentElement.scrollWidth - document.documentElement.clientWidth',
        );
        if (overflow > 1) {
          throw new Error(`${name}: horizontal overflow of ${overflow}px at ${vp.name}`);
        }

        const file = path.join(OUT, `${name}.${vp.name}.png`);
        await page.shot(file);
        shots.push({ name, file, viewport: vp.name });
        console.log(`  ✓ ${name} @ ${vp.name}`);
      };

      // ---- 1. Landing / calculator -------------------------------------
      const a = await newPage(vp);
      try {
        await a.page.goto(`${BASE}/`);
        await capture(a.page, '01-landing', /You send/i);

        // Login carrying an amount, so the preserved-intent block renders.
        await a.page.goto(`${BASE}/login?next=${encodeURIComponent('/app/new?amount=500')}`);
        await capture(a.page, '02-login', /Sign in/i);

        // ---- 2. Seller signs in and creates a link ---------------------
        await a.page.signIn(seller);
        await a.page.goto(`${BASE}/app/new`);
        // Transaction home — empty first, then populated later in the run.
        await a.page.goto(`${BASE}/app`);
        await capture(a.page, '03-home-empty', /Your deals/i);

        await a.page.goto(`${BASE}/app/new`);
        await capture(a.page, '04-new-deal', /Create a deal link/i);

        await sleep(700); // hydration gate before the server action
        await a.page.fill('main input[name="usdt"]', '500');
        await a.page.click('main form button[type="submit"]');
        await a.page.waitForPathAway(/^\/app\/new/);
        await a.page.settle();
        await a.page.waitForText(/Deal link/i);

        // The creator lands on the shareable preview; read its public id.
        // Read it from the URL the redirect landed on: that is authoritative,
        // whereas scraping body text depends on presentation.
        const publicId = await a.page.eval(`(() => {
          const m = location.pathname.match(/INRP-[0-9A-HJ-NP-Z]{10}/);
          return m ? m[0] : null; })()`);
        if (!publicId) throw new Error('could not find the created link public id');

        // ---- 3. Public preview (open, joinable) ------------------------
        const anon = await newPage(vp);
        try {
          await anon.page.goto(`${BASE}/d/${publicId}`);
          await capture(anon.page, '05-link-open', /\bOpen\b/, /Expired/);
        } finally {
          await cdp.send('Target.closeTarget', { targetId: anon.targetId }).catch(() => {});
          await cdp
            .send('Target.disposeBrowserContext', { browserContextId: anon.browserContextId })
            .catch(() => {});
        }

        // ---- 4. Buyer joins (the winner) -------------------------------
        const b = await newPage(vp);
        try {
          await b.page.signIn(buyer);
          await b.page.goto(`${BASE}/d/${publicId}`);
          await sleep(700); // hydration gate
          await b.page.click('[data-testid="join-button"]');
          await b.page.settle();
          await b.page.waitForText(/The record|Mark the INR sent/i);
          // Buyer is FIAT_SIDE: they owe the INR.
          await capture(b.page, '08-deal-fiat-side', /Mark the INR sent/i);

          // ---- 5. The now-consumed link, seen by a stranger ------------
          const anon2 = await newPage(vp);
          try {
            await anon2.page.goto(`${BASE}/d/${publicId}`);
            await capture(
              anon2.page,
              '06-link-consumed',
              /Someone joined first/i,
              /\bOpen\b/,
            );
          } finally {
            await cdp.send('Target.closeTarget', { targetId: anon2.targetId }).catch(() => {});
            await cdp
              .send('Target.disposeBrowserContext', { browserContextId: anon2.browserContextId })
              .catch(() => {});
          }

          // ---- 6. Seller's view: CRYPTO_SIDE, awaiting payment --------
          await a.page.goto(`${BASE}/app`);
          await a.page.click('a[href^="/app/deal/"]');
          await a.page.settle();
          await capture(
            a.page,
            '09-deal-crypto-side',
            /USDT supplier/i,
            /Mark the INR sent/i, // the crypto side is never offered the claim
          );

          // ---- 7. Buyer submits the payment claim with a UTR ----------
          const utrAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
          const utr = Array.from(
            { length: 12 },
            () => utrAlphabet[Math.floor(Math.random() * utrAlphabet.length)],
          ).join('');
          await sleep(500); // hydration gate
          await b.page.fill('main input[aria-label="UTR"]', utr);
          await b.page.click('[data-testid="claim-submit"]');
          await b.page.settle();
          await b.page.waitForText(/Awaiting confirmation/i);

          // ---- 8. Seller confirms → COMPLETED ------------------------
          await a.page.goto(`${BASE}/app`);
          await a.page.click('a[href^="/app/deal/"]');
          await a.page.settle();
          await a.page.waitForText(/Confirm the INR arrived/i);
          await sleep(500); // hydration gate
          await a.page.click('[data-testid="confirm-submit"]');
          await a.page.settle();
          await a.page.waitForText(/Completed/i);
          await capture(a.page, '10-deal-completed-receipt', /Completed/i);

          // ---- 9. Persistence: reload from scratch --------------------
          const dealUrl = await a.page.eval('location.href');
          await a.page.goto(dealUrl);
          await capture(a.page, '11-completed-after-reload', /Completed/i);

          await a.page.goto(`${BASE}/app`);
          await capture(a.page, '14-home-populated', /Your deals/i);

          // Expired link: a second link, aged past its deadline by the
          // server clock. Reached through the product, not by faking state.
          await a.page.goto(`${BASE}/app/new`);
          await sleep(700);
          await a.page.fill('main input[name="usdt"]', '250');
          await a.page.click('main form button[type="submit"]');
          await a.page.waitForPathAway(/^\/app\/new/);
          const expiredId = await a.page.eval(
            "(() => { const m = location.pathname.match(/INRP-[0-9A-HJ-NP-Z]{10}/); return m ? m[0] : null; })()",
          );
          if (expiredId && expireLink) {
            await expireLink(expiredId);
            await a.page.goto(`${BASE}/d/${expiredId}`);
            await capture(a.page, '07-link-expired', /expired/i, /Take the other side/i);
          }

          // A recoverable error state: a deal id that is well-formed but
          // belongs to nobody. The server refuses and the page explains.
          await a.page.goto(`${BASE}/app/deal/00000000-0000-4000-8000-000000000000`);
          await capture(a.page, '15-error-not-participant', /cannot open this deal/i);
        } finally {
          await cdp.send('Target.closeTarget', { targetId: b.targetId }).catch(() => {});
          await cdp
            .send('Target.disposeBrowserContext', { browserContextId: b.browserContextId })
            .catch(() => {});
        }

        // ---- 10. Operator access denied (non-operator) ----------------
        await a.page.goto(`${BASE}/app/ops`);
        await capture(a.page, '13-operator-403', /403/);

        // ---- 11. Operator queue, as a separate identity ---------------
        const op = await newPage(vp);
        try {
          await op.page.signIn(`ops@sandbox.test`);
          await op.page.goto(`${BASE}/app/ops`);
          await capture(op.page, '12-operator-queue', /Queue/, /403/);
        } finally {
          await cdp.send('Target.closeTarget', { targetId: op.targetId }).catch(() => {});
          await cdp
            .send('Target.disposeBrowserContext', { browserContextId: op.browserContextId })
            .catch(() => {});
        }
      } catch (err) {
        failures.push(`${vp.name}: ${err.message}`);
        console.error(`  ✗ ${vp.name}: ${err.message.split('\n')[0]}`);
      } finally {
        await cdp.send('Target.closeTarget', { targetId: a.targetId }).catch(() => {});
        await cdp
          .send('Target.disposeBrowserContext', { browserContextId: a.browserContextId })
          .catch(() => {});
      }
      captured.push(...shots);
      if (failures.length) {
        await writeFile(
          path.join(OUT, 'failures.txt'),
          failures.join('\n\n========================================\n\n'),
        );
      }
    }

    await writeFile(
      path.join(OUT, 'manifest.json'),
      JSON.stringify({ base: BASE, capturedAt: new Date().toISOString(), captured, failures }, null, 2),
    );
  } finally {
    proc.kill('SIGTERM');
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${captured.length} screenshot(s) → ${OUT}`);
  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
