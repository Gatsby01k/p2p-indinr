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

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, scale: 2, mobile: false },
  { name: 'mobile', width: 390, height: 844, scale: 3, mobile: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  }
  async settle() {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if ((await this.eval('document.readyState')) === 'complete') break;
      if (Date.now() > deadline) throw new Error('load timeout');
      await sleep(120);
    }
    await sleep(700);
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
    const ok = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({block:'center'}); el.click(); return true; })()`);
    if (!ok) throw new Error(`no element ${selector}`);
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
    await sleep(600);
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

      const capture = async (page, name, assertRe, refuteRe) => {
        const text = await page.text();
        if (assertRe && !assertRe.test(text)) {
          throw new Error(`${name}: ${assertRe} not matched.\n--- page ---\n${text.slice(0, 800)}`);
        }
        if (refuteRe && refuteRe.test(text)) {
          throw new Error(`${name}: ${refuteRe} unexpectedly matched`);
        }
        if (!/Sandbox\./i.test(text) && !/No real funds/i.test(text)) {
          throw new Error(`${name}: sandbox notice missing`);
        }
        const file = path.join(OUT, `${name}.${vp.name}.png`);
        await page.shot(file);
        shots.push({ name, file });
        console.log(`  ✓ ${name} @ ${vp.name}`);
      };

      // ---- 1. Landing / calculator -------------------------------------
      const a = await newPage(vp);
      try {
        await a.page.goto(`${BASE}/`);
        await capture(a.page, '01-landing-calculator', /You send|You receive/i);

        // ---- 2. Seller signs in and creates a link ---------------------
        await a.page.signIn(seller);
        await a.page.goto(`${BASE}/app/new`);
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
          await capture(anon.page, '02-deal-link-open', /Open/, /Expired/);
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
          await b.page.waitForText(/Where things stand/i);
          // Buyer is FIAT_SIDE: they owe the INR.
          await capture(b.page, '04-deal-active-fiat-side', /Mark the INR sent/i);

          // ---- 5. The now-consumed link, seen by a stranger ------------
          const anon2 = await newPage(vp);
          try {
            await anon2.page.goto(`${BASE}/d/${publicId}`);
            await capture(
              anon2.page,
              '03-deal-link-consumed-lost-race',
              /Someone else joined this deal first/i,
              /Open/,
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
            '05-deal-active-crypto-side',
            /USDT supplier/i,
            /Mark the INR sent/i, // the crypto side is never offered the claim
          );

          // ---- 7. Buyer submits the payment claim with a UTR ----------
          const utr = `${stamp}${vp.name === 'desktop' ? 'D' : 'M'}`.toUpperCase().slice(0, 12).padEnd(12, '0');
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
          await capture(a.page, '06-deal-completed', /Completed/i);

          // ---- 9. Persistence: reload from scratch --------------------
          const dealUrl = await a.page.eval('location.href');
          await a.page.goto(dealUrl);
          await capture(a.page, '07-deal-completed-after-reload', /Completed/i);
        } finally {
          await cdp.send('Target.closeTarget', { targetId: b.targetId }).catch(() => {});
          await cdp
            .send('Target.disposeBrowserContext', { browserContextId: b.browserContextId })
            .catch(() => {});
        }

        // ---- 10. Operator access denied (non-operator) ----------------
        await a.page.goto(`${BASE}/app/ops`);
        await capture(a.page, '09-operator-access-denied', /403|restricted to operators/i);

        // ---- 11. Operator queue, as a separate identity ---------------
        const op = await newPage(vp);
        try {
          await op.page.signIn(`ops@sandbox.test`);
          await op.page.goto(`${BASE}/app/ops`);
          await capture(op.page, '08-operator-queue', /Operator queue/i, /403/);
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
