/**
 * Shared browser-harness helpers.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  WAIT FOR THE COMMITTED OUTCOME, NEVER FOR "NETWORK QUIET".      │
 * │                                                                  │
 * │  A Next.js server action commits, then navigates. `networkidle`  │
 * │  can resolve in the gap between those two, so the harness reads  │
 * │  the OLD page and reports a failure the product never had — the  │
 * │  exact reason the first DEL-10 harness said the Join was broken  │
 * │  when the Join was fine.                                         │
 * │                                                                  │
 * │  Every helper below therefore waits for something specific: a    │
 * │  URL, a role-specific control, a named deal state, or a visible  │
 * │  definitive rejection.                                           │
 * └──────────────────────────────────────────────────────────────────┘
 */

import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3210';
/**
 * The BUILT server's log — the sandbox mailbox.
 *
 * The sandbox mail adapter does not send mail; it prints the code, and
 * the harness reads it exactly as a person reads it from an email. It is
 * called SERVER_LOG rather than DEV_LOG because there is no longer a dev
 * server anywhere in this gate: `DEV_LOG` is still honoured so an older
 * invocation does not silently read nothing.
 */
export const SERVER_LOG =
  process.env.SERVER_LOG ?? process.env.DEV_LOG ?? join('artifacts', 'server.log');
export const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const OUT = process.env.E2E_OUT ?? 'artifacts/e2e';
export const RUN = process.env.E2E_RUN_ID ? `.${process.env.E2E_RUN_ID}` : '';

/** A deal-room path carries a UUID, not a public link code. */
export const DEAL_ROOM = /\/app\/deal\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

export const ACCOUNT = {
  payer: `payer${RUN}.e2e@example.in`,
  payee: `payee${RUN}.e2e@example.in`,
  buyer: `buyer${RUN}.e2e@example.in`,
  seller: `seller${RUN}.e2e@example.in`,
  maker: `maker${RUN}.e2e@example.in`,
  checker: `checker${RUN}.e2e@example.in`,
  /*
   * A THIRD operator, whose only job is to decide verification cases.
   *
   * Deliberately not `maker` or `checker`: those two exist to prove that
   * two independent people can each enrol a second factor and reach the
   * Deal Desk, and doing their enrolment early as a side effect of
   * onboarding somebody else would quietly delete that check.
   */
  reviewer: `reviewer${RUN}.e2e@example.in`,
};

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Result recording, with failure evidence
 * ------------------------------------------------------------------ */

export const results = [];

export function record(area, name, ok, detail = '') {
  results.push({ area, name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${area} · ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

/**
 * Capture everything a reader needs to diagnose a failure without
 * re-running it: screenshot, DOM, URL, console and failed requests.
 */
export async function captureFailure(page, label, extra = {}) {
  const slug = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60);
  const dir = join(OUT, 'failures');
  mkdirSync(dir, { recursive: true });
  try {
    await page.screenshot({ path: join(dir, `${slug}.png`), fullPage: true });
    writeFileSync(join(dir, `${slug}.html`), await page.content());
    writeFileSync(
      join(dir, `${slug}.json`),
      JSON.stringify(
        {
          url: page.url(),
          text: (await page.locator('body').innerText()).slice(0, 4000),
          ...extra,
        },
        null,
        2,
      ),
    );
  } catch {
    // A page that has already closed cannot be photographed; the
    // recorded failure still stands on its own.
  }
}

/**
 * Attach console, request-failure, HTTP-error and SERVER-ACTION listeners.
 *
 * The server-action record is what makes "the harness is wrong" and "the
 * product is wrong" tellable apart without re-running anything. A Next.js
 * server action is a POST to the current URL carrying `next-action`; its
 * response is the RSC flight payload the client then acts on. Capturing
 * the method, the status and the redirect header for each one means a
 * failed Join can be read off the evidence: a 200 with a redirect is a
 * mutation that committed and a harness that did not wait for it; a 4xx,
 * or a payload carrying a rejection code, is the product refusing.
 */
export function instrument(page, bucket) {
  page.on('console', (m) => {
    if (m.type() === 'error') bucket.console.push(m.text().slice(0, 300));
  });
  page.on('requestfailed', (r) =>
    bucket.failedRequests.push(`${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`),
  );
  page.on('response', async (r) => {
    if (r.status() >= 400) bucket.httpErrors.push(`${r.status()} ${r.url()}`);
    const request = r.request();
    if (request.method() !== 'POST') return;
    const headers = await request.allHeaders().catch(() => ({}));
    if (!headers['next-action']) return;
    const entry = {
      url: r.url(),
      status: r.status(),
      location: r.headers()['x-action-redirect'] ?? r.headers()['location'] ?? null,
    };
    /*
     * The flight payload is text. Only the tail is kept, and only for a
     * failure report: it is where a rejection code and its copy land,
     * and it is far too large to keep in full.
     */
    entry.payload = await r
      .text()
      .then((t) => t.slice(-1200))
      .catch(() => '(unreadable)');
    bucket.actions.push(entry);
  });
}

export const newBucket = () => ({
  console: [],
  failedRequests: [],
  httpErrors: [],
  actions: [],
});

/* ------------------------------------------------------------------ *
 * Typing and sign-in
 * ------------------------------------------------------------------ */

/**
 * Type like a person.
 *
 * `fill()` sets a value in one shot; several forms here enable their
 * submit button from per-keystroke validation, so a bulk set leaves the
 * button disabled for ever.
 */
export async function typeInto(page, selector, value, { enables } = {}) {
  const field = page.locator(selector);
  await field.waitFor({ state: 'visible', timeout: 20_000 });
  /*
   * A field inside a bottom sheet can be visible, enabled and stable and
   * still sit outside the viewport, because the sheet scrolls inside
   * itself. Playwright will not click what it cannot reach, and rightly
   * so — but a person scrolls the sheet, and focusing the field is the
   * same thing without a fifty-second timeout first.
   */
  await field.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
  await field.click({ timeout: 5_000 }).catch(() => field.focus({ timeout: 5_000 }));

  /*
   * ⚠ THE DOM VALUE IS NOT PROOF THAT REACT RECEIVED IT.
   *
   * Typing into an input the component is not yet controlling — the
   * window between the server's HTML arriving and hydration attaching —
   * puts the text in the DOM and leaves React's state empty. `fill()`
   * and a plain `inputValue()` check both pass happily, and then the
   * submit button, which is `disabled` on that empty state, never
   * enables. The harness waits out its timeout on a control that was
   * never going to be clickable and reports a broken sign-in.
   *
   * A BUILT server made this far more likely, not less: the document
   * arrives in milliseconds, so the typing is much more likely to win
   * the race against hydration than it was against a dev server that
   * was still compiling.
   *
   * `enables` names a control whose enabled state is derived from the
   * value — that is the only observable proof React holds it. When one
   * is given, the whole type is retried until the control comes alive.
   */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await field.press('ControlOrMeta+a');
    await field.press('Backspace');
    await field.pressSequentially(String(value), { delay: 12 });
    await field.blur();

    if ((await field.inputValue()) !== String(value)) {
      await wait(400);
      continue;
    }
    if (!enables) return;
    const live = await page
      .locator(enables)
      .first()
      .waitFor({ state: 'visible', timeout: 2_500 })
      .then(() => page.locator(enables).first().isEnabled())
      .catch(() => false);
    if (live) return;
    await wait(500);
  }
  throw new Error(
    enables
      ? `typed into ${selector} but ${enables} never became live — React did not receive the value`
      : `could not type into ${selector} — value did not stick`,
  );
}

/**
 * Every COMPLETE sign-in code logged for an address.
 *
 * ⚠ The pattern deliberately spans the address AND the code.
 *
 * The log is written by piping the server's stdout to a file, and a pipe
 * delivers whatever has arrived — including half a line. Matching on the
 * address alone accepts `…SIGN_IN code for someone@example.in` before
 * the eight digits have been written, which satisfies the "a new line
 * appeared" wait and then yields no code at all. That is a harness race
 * reported as a broken sign-in, and it is exactly what it looked like.
 */
const signInCodes = (email) => {
  const text = existsSync(SERVER_LOG) ? readFileSync(SERVER_LOG, 'utf8') : '';
  const pattern = new RegExp(
    `SIGN_IN code for ${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: (\\d{8})\\.`,
    'g',
  );
  return [...text.matchAll(pattern)].map((m) => m[1]);
};

/**
 * Request a code and wait for a NEW one to be logged.
 *
 * Sign-in is rate limited per address — correctly — so a harness that
 * re-requests for one mailbox gets refused, then reads a STALE code and
 * reports a false authentication failure. Waiting for the line count to
 * grow makes that impossible, and a refusal is raised as a refusal.
 */
export async function signIn(page, email) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  // Hydration must finish before typing, or the value never reaches React.
  await page.waitForSelector('button:has-text("Email me a code")', { timeout: 20_000 });
  await typeInto(page, 'input[type=email]', email, {
    enables: 'button:has-text("Email me a code")',
  });
  const before = signInCodes(email).length;
  await page.click('button:has-text("Email me a code")');

  try {
    await page.waitForSelector('input[placeholder="12345678"]', { timeout: 12_000 });
  } catch {
    const text = await page.locator('body').innerText();
    throw new Error(
      /too many|try again|rate/i.test(text)
        ? `sign-in rate limited for ${email}`
        : `code screen never appeared for ${email}`,
    );
  }

  for (let i = 0; i < 100 && signInCodes(email).length === before; i += 1) await wait(100);
  const code = signInCodes(email).at(-1);
  if (!code || signInCodes(email).length === before) {
    throw new Error(`no NEW sign-in code logged for ${email}`);
  }

  await typeInto(page, 'input[placeholder="12345678"]', code, {
    enables: 'button:has-text("Sign in")',
  });
  await page.click('button:has-text("Sign in")');
  // The committed outcome: no longer on /login.
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  return code;
}

/**
 * Walk the three verification steps, through the real screen.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE PRODUCT REFUSES AN UNVERIFIED JOIN, AND IT IS RIGHT TO.       │
 * │                                                                    │
 * │  "Identity" is required to join any protected deal, "Payment       │
 * │  handle" to receive rupees and "Wallet" for an INR ⇄ USDT          │
 * │  corridor. On a shared development database every account had      │
 * │  been through this long ago, so the gate never noticed it was      │
 * │  skipping a step a real person cannot skip. On the gate's own      │
 * │  fresh cluster the refusal appeared immediately — "Your sandbox    │
 * │  account is not verified" — and that refusal is the product        │
 * │  working.                                                          │
 * │                                                                    │
 * │  So every actor walks the steps, on the real screen, with the real │
 * │  server actions. Nothing is set directly in the database: the      │
 * │  point of the gate is that a person could do this.                 │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function verifyAccount(page) {
  await page.goto(`${BASE}/app/profile/verification`, { waitUntil: 'domcontentloaded' });
  // The control says "Submit this step" — a step is not completed by
  // pressing it, it is submitted for somebody else to decide.
  const pending = page.locator(
    'button:has-text("Submit this step"), button:has-text("Submit again")',
  );
  await page.waitForSelector('h1', { timeout: 20_000 });

  // Three steps, plus a little slack for a click that lands before the
  // button is live — the outcome, not the click, is what is counted.
  for (let guard = 0; guard < 9; guard += 1) {
    const before = await pending.count();
    if (before === 0) break;
    await pending.first().click({ timeout: 10_000 }).catch(() => {});
    await page
      .waitForFunction(
        (n) =>
          [...document.querySelectorAll('button')].filter((b) =>
            /Submit this step|Submit again/.test(b.textContent ?? ''),
          ).length < n,
        before,
        { timeout: 15_000 },
      )
      .catch(() => {});
  }

  const submitted = await page.locator('[data-testid^="verification-pending-"]').count();
  const verified = await page.locator('text=Verified').count();
  if (submitted + verified === 0) {
    throw new Error('no verification step reached review or approval');
  }
  return { submitted, verified };
}

/**
 * Add a way to be paid, through the real form.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WITHOUT ONE, THE PAY SCREEN CORRECTLY REFUSES TO SHOW ANYTHING.   │
 * │                                                                    │
 * │  Payment instructions are the counterparty's own handle. An        │
 * │  account created by a real sign-in has none — only the retired     │
 * │  `signInSandbox` path ever seeded one — so the pay screen says     │
 * │  "This person has not added a way to be paid yet" and shows no     │
 * │  UPI ID. That is the product being careful, and the gate was       │
 * │  reading it as the product being broken because on the shared      │
 * │  development database every account already had a handle.          │
 * │                                                                    │
 * │  The form collects no credential — there is no PIN, CVV or         │
 * │  password field anywhere in it — and the handle used here is a     │
 * │  `@sandboxupi` address, which resolves at no bank.                 │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function addUpiMethod(page, email) {
  await page.goto(`${BASE}/app/profile/payment-methods`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1', { timeout: 20_000 });
  // Already has one: the first method added becomes the default, and a
  // second would only make the default ambiguous.
  if (/on file/i.test(await page.locator('body').innerText())) return false;

  const handle = `${email.split('@')[0].replace(/[^a-z0-9.]/g, '')}@sandboxupi`;
  const opened = await clickUntil(
    page,
    'button:has-text("Add a payment method")',
    'input#handle',
  );
  if (!opened) throw new Error('the add-payment-method sheet never opened');

  await typeInto(page, 'input#handle', handle);
  const save = page.locator('button:has-text("Save payment method")').first();
  await save.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
  await save.click({ timeout: 10_000 });
  await page.waitForFunction(() => /on file/i.test(document.body.innerText), { timeout: 20_000 });
  return true;
}

/**
 * Approve every waiting verification case, as a reviewer, on the real
 * screen.
 *
 * A case about the REVIEWER is skipped on purpose: the database refuses a
 * self-decision, so the queue offers no control for one, and a loop that
 * insisted on emptying the queue would never finish.
 */
export async function approvePendingVerifications(page, { reason } = {}) {
  let decided = 0;
  for (let pass = 0; pass < 20; pass += 1) {
    await page.goto(`${BASE}/app/ops/verification`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h1', { timeout: 20_000 });
    const approve = page.locator('[data-testid="verification-approve"]');
    if ((await approve.count()) === 0) break;

    const note = page.locator('textarea[id^="note-"]').first();
    await note.click();
    await note.pressSequentially(reason ?? 'Sandbox gate: evidence reviewed and consistent.', {
      delay: 4,
    });
    const before = await approve.count();
    await approve.first().click({ timeout: 10_000 }).catch(() => {});
    await page
      .waitForFunction(
        (n) => document.querySelectorAll('[data-testid="verification-approve"]').length < n,
        before,
        { timeout: 15_000 },
      )
      .catch(() => {});
    decided += 1;
  }
  return decided;
}

export async function signOut(page) {
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
  const out = page.locator('button:has-text("Sign out")');
  if (await out.count()) {
    await out.first().click();
    await page.waitForURL(/\/(login)?$/, { timeout: 15_000 }).catch(() => {});
  }
}

/**
 * Click, then confirm the click actually did something.
 *
 * A button rendered by the server exists in the HTML before React
 * attaches its handler. A click in that window is swallowed silently —
 * no error, no navigation, no state change — and the harness then waits
 * out its timeout on an outcome that was never going to arrive. This
 * retries until the expected outcome appears, which is the only
 * reliable signal that the handler was live.
 */
export async function clickUntil(page, selector, expected, { attempts = 4, each = 6_000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await page.locator(selector).first().click({ timeout: 10_000 }).catch(() => {});
    const arrived = await page
      .waitForSelector(expected, { timeout: each })
      .then(() => true)
      .catch(() => false);
    if (arrived) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * TOTP, so the harness can act as the authenticator app
 * ------------------------------------------------------------------ */

function base32Decode(secret) {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of clean) bits += ALPHABET.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238, matching `src/server/identity/totp.ts`: SHA-1, 30s, 6 digits. */
export function totp(secret, step = Math.floor(Date.now() / 1000 / 30)) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * Enrol an authenticator through the REAL UI, and answer the challenge.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE RETURN CONTRACT IS CHECKED HERE, NOT ASSUMED.                 │
 * │                                                                    │
 * │  Answering the factor for a route the caller was refused must end  │
 * │  with FOUR things true at once, and this helper reports all four   │
 * │  so the gate can assert them without weakening any:                │
 * │                                                                    │
 * │    · the URL is EXACTLY the requested path;                        │
 * │    · a control only an authorized caller could be shown is         │
 * │      present on it — not merely "no error text";                   │
 * │    · the refusal that sent them here is gone;                      │
 * │    · no Security subtree is still mounted underneath.              │
 * │                                                                    │
 * │  The last one matters because the failure it catches is silent: a  │
 * │  client-side navigation may settle the new tree under the old URL, │
 * │  or answer from a router cache holding the 403 rendered a moment   │
 * │  earlier. Either way the page LOOKS right and the address bar and  │
 * │  the route disagree.                                               │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Returns the secret and recovery codes so a later step can exercise
 * recovery. Nothing is written to disk: a secret in an artefact would be
 * a secret in a screenshot.
 */
export async function enrolAndSatisfyMfa(page, { next, expect } = {}) {
  const url = next
    ? `${BASE}/app/settings/security?next=${encodeURIComponent(next)}`
    : `${BASE}/app/settings/security`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const already = page.locator('[data-testid="mfa-enrolled"]');
  const begin = page.locator('[data-testid="mfa-begin"]');
  await Promise.race([
    already.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
    begin.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
  ]);

  let secret = null;
  let recoveryCodes = [];

  if (await begin.count()) {
    const shown = await clickUntil(page, '[data-testid="mfa-begin"]', '[data-testid="mfa-secret"]');
    if (!shown) throw new Error('enrolment did not return a secret');
    secret = (await page.locator('[data-testid="mfa-secret"]').innerText()).trim();
    recoveryCodes = (
      await page.locator('[data-testid="mfa-recovery-codes"] li').allInnerTexts()
    ).map((c) => c.trim());

    /*
     * One clock reading, two adjacent steps: the confirmation burns
     * `base`, and the challenge presents `base + 1`, which is never a
     * replay of it. Reading the clock twice can straddle the 30-second
     * boundary and put the codes outside the accepted drift window.
     */
    const base = Math.floor(Date.now() / 1000 / 30);
    await typeInto(page, '#mfa-enrol-code', totp(secret, base), {
      enables: '[data-testid="mfa-confirm"]',
    });
    const confirmed = await clickUntil(
      page,
      '[data-testid="mfa-confirm"]',
      '[data-testid="mfa-enrolled"]',
    );
    if (!confirmed) throw new Error('confirmation did not reach the client');
  }

  /*
   * The challenge is rendered by the SERVER, once the account has a
   * confirmed factor. Confirming above triggers a refresh, so it arrives
   * a moment later rather than immediately — waited for, not polled by
   * counting, because a `count()` taken too early reads zero and skips
   * the whole verification.
   */
  const challenge = page.locator('[data-testid="mfa-verify"]');
  const offered = await challenge
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  const outcome = { secret, recoveryCodes, satisfied: false, arrivedAt: null, control: false };
  if (!offered || !secret) return outcome;

  await typeInto(page, '#mfa-code', totp(secret, Math.floor(Date.now() / 1000 / 30) + 1), {
    enables: '[data-testid="mfa-verify"]',
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await challenge.click({ timeout: 10_000 }).catch(() => {});
    if (next) {
      // The EXACT path, not a substring of it.
      const arrived = await page
        .waitForURL((u) => u.pathname === next, { timeout: 12_000 })
        .then(() => true)
        .catch(() => false);
      if (!arrived) continue;
      outcome.satisfied = true;
      outcome.arrivedAt = new URL(page.url()).pathname;
      if (expect) {
        outcome.control = await page
          .locator(expect)
          .first()
          .waitFor({ state: 'visible', timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
      }
      return outcome;
    }
    const settled = await page
      .waitForSelector('[data-testid="mfa-satisfied"]', { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (settled) {
      outcome.satisfied = true;
      outcome.arrivedAt = new URL(page.url()).pathname;
      return outcome;
    }
  }
  return outcome;
}

/**
 * Whether any Security-page tree is still mounted.
 *
 * Checked AFTER the return navigation. Its presence would mean the
 * router settled the destination under the old route, or left the
 * challenge behind — the ambiguity this contract exists to forbid.
 */
export async function staleSecurityTree(page) {
  return page.evaluate(
    () =>
      Boolean(
        document.querySelector(
          '[data-testid="mfa-verify"], [data-testid="mfa-begin"], [data-testid="mfa-enrolled"]',
        ),
      ) || /Answer your second factor/i.test(document.body.innerText),
  );
}

/* ------------------------------------------------------------------ *
 * The out-of-band administrative boundary
 * ------------------------------------------------------------------ */

/**
 * Grant an application role the only way the product allows.
 *
 * `scripts/grant-role.mjs` is not reachable over HTTP and is not
 * imported by any route — a grant cannot be issued by a request, and the
 * database's `granted_via` CHECK makes a web-issued one unrepresentable.
 * The gate therefore shells out to it exactly as an administrator would,
 * rather than inserting a row or teaching the app a test-only path.
 *
 * It also BUMPS `session_version`, so every live session for that
 * account stops working. The caller must sign in again afterwards —
 * which is itself worth exercising.
 */
export function grantRole(email, role, reason) {
  const result = spawnSync(
    process.execPath,
    ['scripts/grant-role.mjs', 'grant', email, role, reason],
    { encoding: 'utf8', env: process.env },
  );
  if (result.status !== 0) {
    throw new Error(
      `grant-role ${role} ${email} exited ${result.status}: ${(result.stderr || result.stdout || '').trim()}`,
    );
  }
  return (result.stdout ?? '').trim();
}

/* ------------------------------------------------------------------ *
 * Committed money-shaped outcomes
 * ------------------------------------------------------------------ */

/**
 * Claim a payment: open the sheet, confirm inside it, land on the room.
 *
 * ⚠ TWO CONTROLS, NOT ONE. `claim-open` only opens a confirmation sheet;
 * the mutation is behind `claim-submit` inside it. An earlier harness
 * clicked the first, saw the URL it was already on still matching
 * `/app/deal/`, and recorded a claim that never happened — after which
 * the payee waited out a thirty-second timeout for a Confirm control the
 * server was quite right not to render.
 */
export async function claimPayment(page, { utr, note }) {
  await typeInto(page, 'input[placeholder="428123456789"]', utr, {
    enables: '[data-testid="claim-open"]',
  });
  if (note) await typeInto(page, 'input[placeholder^="Anything"]', note);

  const opened = await clickUntil(page, '[data-testid="claim-open"]', '[data-testid="claim-submit"]');
  if (!opened) throw new Error('the claim confirmation sheet never opened');

  await page.locator('[data-testid="claim-submit"]').first().click();
  // The committed outcome: back in the room, out of the pay route.
  await page.waitForURL((u) => DEAL_ROOM.test(u.pathname) && !u.pathname.endsWith('/pay'), {
    timeout: 30_000,
  });
  return new URL(page.url()).pathname;
}

/** Confirm receipt: open the sheet, submit, wait for the terminal state. */
export async function confirmReceipt(page) {
  const opened = await clickUntil(
    page,
    '[data-testid="confirm-open"]',
    '[data-testid="confirm-submit"]',
  );
  if (!opened) throw new Error('the confirmation sheet never opened');
  await page.locator('[data-testid="confirm-submit"]').first().click();
  return page;
}

/* ------------------------------------------------------------------ *
 * Deal helpers — each waits for a committed outcome
 * ------------------------------------------------------------------ */

/** Create a deal and return its `/d/<publicId>` path. */
export async function createDeal(page, { scenario, amount, title }) {
  await page.goto(`${BASE}/app/new?scenario=${scenario}&amount=${amount}`, {
    waitUntil: 'domcontentloaded',
  });
  /*
   * The title field's placeholder is corridor-specific — "Freelance
   * design milestone" for a protected payment, "Exchange with Ananya"
   * for a crypto corridor — so it is found by POSITION rather than by
   * copy. It is the text input that is not the amount.
   */
  await page.waitForSelector('button:has-text("Review deal")', { timeout: 20_000 });
  const placeholder = await page.evaluate(() => {
    const fields = [...document.querySelectorAll('input[type="text"], input:not([type])')];
    const titleField = fields.find((f) => f.placeholder && f.placeholder !== '0');
    return titleField?.placeholder ?? null;
  });
  if (!placeholder) throw new Error('no title field on the create-deal form');
  await typeInto(page, `input[placeholder="${placeholder}"]`, title, {
    enables: 'button:has-text("Review deal")',
  });
  await page.click('button:has-text("Review deal")');
  await page.waitForSelector('button:has-text("Protect ₹"), button:has-text("Protect ")', {
    timeout: 20_000,
  });
  await page.locator('button:has-text("Protect ")').first().click();
  // Committed outcome: the link page for the new deal.
  await page.waitForURL(/\/d\/INRP-/, { timeout: 30_000 });
  return new URL(page.url()).pathname;
}

/**
 * The REFUSAL, not the first 400 characters of the page.
 *
 * ⚠ The whole document starts with the skip link, the brand, the sandbox
 * banner and the deal summary, so a truncated `body.innerText` reliably
 * cut off before the part that matters — and a check for "nothing was
 * charged" failed against a page that said exactly that, 600 characters
 * further down. Every refusal in this product is a `Notice`, and a
 * `Notice` carries its title, its reassurance and what to do next.
 */
export async function refusalText(page) {
  const notice = page.locator('[data-testid="notice"]');
  if (await notice.count()) {
    return (await notice.allInnerTexts()).join(' · ').replace(/\s+/g, ' ').slice(0, 600);
  }
  return (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 600);
}

/**
 * Join a deal.
 *
 * Returns `{ path }` for the deal room reached, or `{ path: null,
 * refusal }` when the server refuses — which is itself a valid outcome
 * and the whole point of the duplicate-Join race.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A JOIN IS ONLY "DONE" WHEN THE ROOM ITSELF SAYS SO.               │
 * │                                                                    │
 * │  `joinAction` commits and then the client pushes to                │
 * │  `/app/deal/<uuid>`. Waiting on the URL alone is not enough: the   │
 * │  push can land before the room's own tree has rendered, and        │
 * │  reading `innerText` in that window returns the LINK page that is  │
 * │  still on screen — which is how a working Join was first reported  │
 * │  as broken. So this waits for the uuid-shaped path AND for a       │
 * │  control only a seated party is shown.                             │
 * │                                                                    │
 * │  When it does not arrive, the SERVER-ACTION RESULT is read back    │
 * │  out of the instrumentation rather than guessed at, so the         │
 * │  evidence says whether the mutation committed.                     │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function joinDeal(page, linkPath, bucket) {
  const before = bucket ? bucket.actions.length : 0;
  await page.goto(`${BASE}${linkPath}`, { waitUntil: 'domcontentloaded' });

  const unavailable = page.locator('[data-testid="join-unavailable"]');
  const joinButton = page.locator('[data-testid="join-button"]');

  const offered = await Promise.race([
    joinButton.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'join'),
    unavailable.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'closed'),
  ]).catch(() => null);

  if (offered !== 'join') {
    return {
      path: null,
      refusal: await refusalText(page),
      actions: bucket ? bucket.actions.slice(before) : [],
    };
  }

  await page.locator('input[type=checkbox]').first().check();
  await joinButton.click();

  const joined = await page
    .waitForURL((u) => DEAL_ROOM.test(u.pathname), { timeout: 25_000 })
    .then(() => true)
    .catch(() => false);

  if (!joined) {
    return {
      path: null,
      refusal: await refusalText(page),
      actions: bucket ? bucket.actions.slice(before) : [],
    };
  }

  // The room's own tree, not merely its address.
  const rendered = await page
    .locator('[data-deal-room]')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);

  return {
    path: new URL(page.url()).pathname,
    rendered,
    refusal: null,
    actions: bucket ? bucket.actions.slice(before) : [],
  };
}

/** The creator's route into the room, from their link page. */
export async function openRoomAsCreator(page, linkPath) {
  await page.goto(`${BASE}${linkPath}`, { waitUntil: 'domcontentloaded' });
  const open = page.locator(
    'a:has-text("Open the deal room"), button:has-text("Open the deal room")',
  );
  await open.first().waitFor({ state: 'visible', timeout: 20_000 });
  await open.first().click();
  await page.waitForURL(/\/app\/deal\//, { timeout: 25_000 });
  return new URL(page.url()).pathname;
}

/** Wait until the room shows a named state, e.g. /Awaiting payment/. */
export async function waitForDealState(page, pattern, timeout = 20_000) {
  await page.waitForFunction(
    (src) => new RegExp(src, 'i').test(document.body.innerText),
    pattern.source ?? String(pattern),
    { timeout },
  );
}

/**
 * Wait for the room to be rendered IN A NAMED STATE, for a named role.
 *
 * The state comes from the server's own view of the deal — the same
 * value the presenter renders — so this waits on what the database
 * committed rather than on words that happen to be on the page. A
 * headline can say "Awaiting confirmation" while the previous tree is
 * still mounted; `[data-deal-state]` cannot.
 */
export async function waitForRoom(page, { state, role, timeout = 30_000 } = {}) {
  const selector = [
    '[data-deal-room]',
    state ? `[data-deal-state="${state}"]` : '',
    role ? `[data-viewer-role="${role}"]` : '',
  ].join('');
  await page.locator(selector).first().waitFor({ state: 'visible', timeout });
  return page.evaluate(() => {
    const el = document.querySelector('[data-deal-room]');
    return { state: el?.getAttribute('data-deal-state'), role: el?.getAttribute('data-viewer-role') };
  });
}

/* ------------------------------------------------------------------ *
 * Persistent, independently authenticated contexts
 * ------------------------------------------------------------------ */

const actors = new Map();

/**
 * One authenticated session belongs to ONE persistent context.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  NO CLONED `storageState`, EVER.                                   │
 * │                                                                    │
 * │  Copying one signed-in `storageState` into several contexts hands  │
 * │  the same server-side session to several "people". Even where the  │
 * │  server tolerates it today, it is not what the product does and it │
 * │  makes every result ambiguous — a rotated cookie lands in one copy │
 * │  and the others carry a stale one.                                 │
 * │                                                                    │
 * │  So each actor signs in ONCE, in its own context, and that context │
 * │  stays alive for the whole journey. Playwright keeps every rotated │
 * │  `Set-Cookie` naturally inside it; nothing is restored by hand.    │
 * │  Two concurrent actors are two independently issued sessions.      │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function actor(browser, email, { viewport, verify = true } = {}) {
  const existing = actors.get(email);
  if (existing) return existing;

  const ctx = await browser.newContext({
    viewport: viewport ?? { width: 1280, height: 900 },
  });
  await ctx.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const bucket = newBucket();
  const page = await ctx.newPage();
  instrument(page, bucket);
  await signIn(page, email);

  const handle = { ctx, page, bucket, email, name: email.split('@')[0] };
  actors.set(email, handle);

  /*
   * An actor is a person who has FINISHED onboarding, because that is
   * who takes part in a deal — and finishing means a reviewer decided
   * their cases. Both halves happen here, on the real screens: the actor
   * submits, then the standing reviewer approves. Nothing sets a
   * verification flag in the database.
   */
  if (verify) {
    await verifyAccount(page);
    if (reviewer) await approvePendingVerifications(reviewer.page);
    // And a way to be paid, which is the other half of being usable as a
    // counterparty: without it the pay screen has no handle to show.
    await addUpiMethod(page, email);
  }
  return handle;
}

/* ------------------------------------------------------------------ *
 * The standing reviewer
 * ------------------------------------------------------------------ */

let reviewer = null;

/**
 * Bring up the operator who decides verification cases.
 *
 * Four real steps, in the only order the product allows: sign in so the
 * account exists, grant the roles out of band, sign in AGAIN because the
 * grant ended the first session, then enrol and answer a second factor —
 * `verification.review` is one of the permissions that requires one.
 */
export async function establishReviewer(browser, email, { deskControl } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const bucket = newBucket();
  const page = await ctx.newPage();
  instrument(page, bucket);

  await signIn(page, email);
  grantRole(email, 'OPERATOR', 'DEL-10 browser gate: standing verification reviewer');
  grantRole(email, 'REVIEWER', 'DEL-10 browser gate: decides verification cases');
  await signIn(page, email);

  const mfa = await enrolAndSatisfyMfa(page, { next: '/app/ops', expect: deskControl });
  reviewer = { ctx, page, bucket, email, name: email.split('@')[0] };
  actors.set(email, reviewer);
  return { handle: reviewer, mfa };
}

export const standingReviewer = () => reviewer;

/** Every live actor, for teardown. */
export const liveActors = () => [...actors.values()];
export const forgetActors = () => {
  actors.clear();
  reviewer = null;
};
