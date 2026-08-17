#!/usr/bin/env node
/**
 * The DEL-10 browser gate.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  EVERY CHECK GOES THROUGH THE RENDERED APPLICATION,              │
 * │  AND THE APPLICATION IS THE BUILT ONE.                           │
 * │                                                                  │
 * │  Real navigation, real server actions, real network, served by   │
 * │  `next start` — not `next dev`. Sign-in codes are read from the  │
 * │  sandbox mail log exactly as a person reads them from an email,  │
 * │  the second factor is answered by computing TOTP from the secret │
 * │  the enrolment screen showed, and operator roles are granted     │
 * │  through the out-of-band CLI that is the only way anybody        │
 * │  becomes an operator. Nothing is bypassed and nothing is         │
 * │  substituted.                                                    │
 * │                                                                  │
 * │  Waits are on COMMITTED OUTCOMES: an exact URL, a named deal     │
 * │  state read from the server's own view, a role-specific control, │
 * │  or a visible refusal. `networkidle` is never used after a       │
 * │  server action — it can resolve between the commit and the       │
 * │  redirect, which is how the first version of this harness        │
 * │  reported a working Join as broken.                              │
 * │                                                                  │
 * │  NOTHING IS EXEMPTED. There is no allowance for `nextjs-portal`  │
 * │  or any other development scaffolding: every context asserts     │
 * │  that none is present, and the run fails if any appears.         │
 * │                                                                  │
 * │  On failure: screenshot, DOM, console, failed requests, the      │
 * │  server-action results and a Playwright trace, for that context. │
 * └──────────────────────────────────────────────────────────────────┘
 *
 *   node scripts/browser-gate.mjs        (builds, starts, runs this)
 *   BASE_URL=… SERVER_LOG=… node scripts/browser-e2e.mjs
 */

import { chromium } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertNoDevArtefacts } from './e2e/stack.mjs';
import {
  ACCOUNT,
  BASE,
  CHROME,
  DEAL_ROOM,
  OUT,
  actor,
  captureFailure,
  claimPayment,
  clickUntil,
  confirmReceipt,
  createDeal,
  enrolAndSatisfyMfa,
  establishReviewer,
  grantRole,
  instrument,
  joinDeal,
  liveActors,
  newBucket,
  openRoomAsCreator,
  record,
  results,
  signIn,
  staleSecurityTree,
  standingReviewer,
  typeInto,
  claimTestFunds,
  verifyAccount,
  wait,
  waitForRoom,
} from './e2e/lib.mjs';

mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, 'traces'), { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const failedSoFar = () => results.filter((r) => !r.ok).length;

/** A control only an authorized operator is ever shown on the desk. */
const DESK_CONTROL = 'nav[aria-label="Queue views"] a[href="/app/ops?view=DISPUTED"]';

/*
 * The bounds the product enforces, mirrored so the gate asserts the
 * SHAPE of a page and not only how quickly it arrived. Kept in step with
 * `DESK_PAGE_SIZE` and `DEAL_ROOM_MESSAGE_LIMIT`.
 */
const DESK_PAGE_SIZE = 50;
const CHAT_PAGE_LIMIT = 100;
/** Several pages deep, so a bounded page is distinguishable from a short one. */
const BACKLOG_DEALS = 200;
const BACKLOG_MESSAGES = 140;

async function context(name, options = {}) {
  const { as, verify, ...rest } = options;
  /*
   * `as` returns the PERSISTENT context for that account, signed in
   * once and kept alive. Nothing is cloned: two actors are two
   * independently issued sessions, which is what the product does and
   * the only way a concurrency result means anything.
   */
  if (as) return actor(browser, as, { viewport: rest.viewport, verify });

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...rest });
  await ctx.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const bucket = newBucket();
  const page = await ctx.newPage();
  instrument(page, bucket);
  return { ctx, page, bucket, name };
}

/**
 * Close a context, keeping its trace only when something failed.
 *
 * A persistent actor is NOT closed here: it stays alive for its whole
 * journey and is torn down once, at the end.
 */
async function close(handle, keepTrace) {
  if (handle.email) return; // a persistent actor outlives this block
  await handle.ctx.tracing.stop(
    keepTrace ? { path: join(OUT, 'traces', `${handle.name}.zip`) } : {},
  );
  await handle.ctx.close();
}

async function closeActors(anyFailed) {
  for (const a of liveActors()) {
    await a.ctx.tracing.stop(anyFailed ? { path: join(OUT, 'traces', `actor-${a.name}.zip`) } : {});
    await a.ctx.close();
  }
}

/** Assert that the built server shipped no development scaffolding. */
async function noDevArtefacts(page, where) {
  const found = await assertNoDevArtefacts(page);
  return record(
    'build',
    `${where}: no development scaffolding in the DOM`,
    found.length === 0,
    found.join('; '),
  );
}

const perf = {};
let inrRoomPath = null;
let opsCasePath = null;

/* ================================================================== *
 * 0 · The reviewer who decides verification cases
 * ================================================================== *
 *
 * Nobody can join a protected deal until a REVIEWER — who is never the
 * subject — has decided their verification case. So the very first thing
 * the gate does is bring one up, entirely through the product: sign in,
 * grant the roles out of band, sign in again because the grant ended the
 * session, enrol a second factor and answer it.
 */

console.log('\n0 · standing verification reviewer');
{
  const before = failedSoFar();
  try {
    const { handle, mfa } = await establishReviewer(browser, ACCOUNT.reviewer, {
      deskControl: DESK_CONTROL,
    });
    record('review', 'the reviewer enrolled a second factor', Boolean(mfa.secret));
    record(
      'review',
      'the reviewer reached the Deal Desk',
      mfa.arrivedAt === '/app/ops' && mfa.control === true,
      String(mfa.arrivedAt),
    );
    record(
      'review',
      'a reviewer is offered the verification queue',
      (await handle.page.locator('[data-testid="verification-queue-link"]').count()) > 0,
    );

    await handle.page.goto(`${BASE}/app/ops/verification`, { waitUntil: 'domcontentloaded' });
    record(
      'review',
      'the verification queue loads for a reviewer',
      (await handle.page.locator('[data-testid="access-denied"]').count()) === 0,
    );
    await noDevArtefacts(handle.page, 'verification queue');

    /*
     * REVIEWER SEPARATION, through the screen. The reviewer submits
     * their own identity step; the queue must show it and must offer no
     * way to decide it. The database refuses a self-decision outright,
     * so a button here would be a promise the product cannot keep.
     */
    await verifyAccount(handle.page);
    await handle.page.goto(`${BASE}/app/ops/verification`, { waitUntil: 'domcontentloaded' });
    await handle.page.waitForSelector('[data-testid="verification-queue"]', { timeout: 20_000 });
    /*
     * Stronger than matching the sentence: the card must be MARKED as
     * the reviewer's own AND must offer no approve control. Copy can be
     * reworded; the absence of the button is the property that matters.
     */
    const ownCard = handle.page.locator('li:has-text("Reviewer")').first();
    const marked = /your own case/i.test(await ownCard.innerText());
    const controls = await ownCard.locator('[data-testid="verification-approve"]').count();
    record(
      'review',
      'a reviewer is offered no control over their own case',
      marked && controls === 0,
      `marked=${marked} approveControls=${controls}`,
    );
    await handle.page.screenshot({ path: join(OUT, '15-verification-queue.png'), fullPage: true });
  } catch (error) {
    record('review', 'reviewer provisioning', false, String(error).slice(0, 170));
    const r = standingReviewer();
    if (r) await captureFailure(r.page, 'reviewer', r.bucket);
  }
  if (failedSoFar() > before) console.error('  the reviewer is a prerequisite for every journey');
}

/* ================================================================== *
 * 1 · Authentication
 * ================================================================== */

console.log('\n1 · authentication');
{
  const h = await context('auth');
  const before = failedSoFar();
  try {
    const probe = `probe-${Date.now()}@example.in`;
    await h.page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await noDevArtefacts(h.page, 'login');
    await typeInto(h.page, 'input[type=email]', probe);
    await h.page.click('button:has-text("Email me a code")');
    await h.page.waitForSelector('input[placeholder="12345678"]', { timeout: 20_000 });
    record(
      'auth',
      'anti-enumeration copy for an unknown address',
      /If .* is registered/i.test(await h.page.locator('body').innerText()),
    );

    await typeInto(h.page, 'input[placeholder="12345678"]', '00000000');
    await h.page.click('button:has-text("Sign in")');
    await h.page.waitForSelector('text=/not valid/i', { timeout: 20_000 });
    record('auth', 'a wrong code is refused', true);

    await signIn(h.page, ACCOUNT.payer);
    record('auth', 'typed 8-digit code signs in', !h.page.url().includes('/login'));
    await h.page.screenshot({ path: join(OUT, '01-signed-in.png') });
  } catch (error) {
    record('auth', 'authentication', false, String(error).slice(0, 150));
    await captureFailure(h.page, 'auth', h.bucket);
  }
  await close(h, failedSoFar() > before);
}

/* ================================================================== *
 * 2 · Calculator handoff
 * ================================================================== */

console.log('\n2 · calculator handoff');
{
  const h = await context('quote');
  const before = failedSoFar();
  try {
    await h.page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await noDevArtefacts(h.page, 'landing');
    /*
     * ⚠ CLICK, THEN CONFIRM THE MODE ACTUALLY CHANGED.
     *
     * The corridor selector is a client control on a server-rendered
     * page: the button exists in the HTML before React attaches to it,
     * and on a BUILT server the document arrives fast enough that the
     * first click regularly lands in that window and is swallowed. The
     * calculator then stays on INR→INR, the word "USDT" is still on the
     * page in the hero copy, and the harness happily asserts against the
     * wrong corridor. `aria-checked` is the committed outcome.
     */
    /*
     * ⚠ SCOPED TO THE CALCULATOR, because `/` now has TWO radio groups.
     *
     * LANDING-01 gave the hero its own `Send INR / Buy USDT / Sell USDT`
     * control, which drives the demonstration and the create-deal link.
     * A page-wide `getByRole('radio', { name: /Buy USDT/i })` therefore
     * matches two elements and Playwright refuses it under strict mode —
     * so this addresses the calculator's own region by name. The hero
     * control is exercised by the accessibility sweep below like every
     * other control on the page.
     */
    const calculator = h.page.getByRole('region', { name: /Work out a protected deal/i });
    const buyUsdt = calculator.getByRole('radio', { name: /Buy USDT/i });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await buyUsdt.click({ timeout: 10_000 }).catch(() => {});
      const chosen = await buyUsdt
        .and(h.page.locator('[aria-checked="true"]'))
        .waitFor({ state: 'visible', timeout: 3_000 })
        .then(() => true)
        .catch(() => false);
      if (chosen) break;
    }
    record(
      'quote',
      'the Buy USDT corridor is selected',
      (await buyUsdt.getAttribute('aria-checked')) === 'true',
    );
    await typeInto(h.page, 'input[placeholder="0"]', '83000');
    await h.page.waitForFunction(() => /USDT/.test(document.body.innerText), { timeout: 15_000 });

    const quote = await h.page.locator('body').innerText();
    record('quote', 'fee disclosed before commitment', /protection fee|Includes ₹/i.test(quote));
    record('quote', 'USDT network named (TRC-20)', /TRC.{0,2}20/i.test(quote));
    record('quote', 'indicative, not a quote', /not a quote/i.test(quote));
    await h.page.screenshot({ path: join(OUT, '02-calculator.png') });

    await h.page.locator('button[type=submit]').first().click();
    await h.page.waitForURL(/\/login/, { timeout: 25_000 });
    await h.page.waitForSelector('text=/Carried from the calculator/i', { timeout: 20_000 });
    const carried = await h.page.locator('body').innerText();
    record('quote', 'amount carried exactly across auth', carried.includes('83,000'), '₹83,000.00');
    await h.page.screenshot({ path: join(OUT, '03-handoff.png') });
  } catch (error) {
    record('quote', 'calculator handoff', false, String(error).slice(0, 150));
    await captureFailure(h.page, 'quote', h.bucket);
  }
  await close(h, failedSoFar() > before);
}

/* ================================================================== *
 * 3 · INR → INR: create, join, instructions, claim, confirm
 * ================================================================== */

console.log('\n3 · INR → INR full journey');
{
  const payer = await context('inr-payer', { as: ACCOUNT.payer });
  const payee = await context('inr-payee', { as: ACCOUNT.payee });
  const stranger = await context('inr-stranger');
  const before = failedSoFar();
  try {
    const link = await createDeal(payer.page, {
      scenario: 'INR_TO_INR',
      amount: '25000',
      title: 'Headless INR to INR journey',
    });
    record('journey', 'deal created with a unique link', /^\/d\/INRP-/.test(link), link);
    await payer.page.screenshot({ path: join(OUT, '04-deal-created.png') });

    await stranger.page.goto(`${BASE}${link}`, { waitUntil: 'domcontentloaded' });
    await stranger.page.waitForSelector('text=/Sign in to join/i', { timeout: 25_000 });
    const strangerText = await stranger.page.locator('body').innerText();
    record('journey', 'signed-out stranger sees terms', /Sign in to join/i.test(strangerText));
    record(
      'journey',
      'stranger is not shown bank details',
      !/UPI ID|sandboxupi/i.test(strangerText),
    );
    await stranger.page.screenshot({ path: join(OUT, '05-stranger-view.png') });

    const joined = await joinDeal(payee.page, link, payee.bucket);
    record(
      'journey',
      'verified counterparty joins',
      joined.path !== null,
      joined.refusal ?? joined.path,
    );
    record('journey', 'the room itself renders for the joiner', joined.rendered === true);
    inrRoomPath = joined.path;

    if (inrRoomPath) {
      // The committed state, read from the server's own view of the deal.
      // In an INR→INR deal the joiner takes the receiving seat, which the
      // room reports as CRYPTO_SIDE — the non-paying side of the corridor.
      const seat = await waitForRoom(payee.page, { state: 'FIAT_PENDING', role: 'CRYPTO_SIDE' });
      record(
        'journey',
        'payee is seated on the receiving side',
        seat.role === 'CRYPTO_SIDE',
        seat.role ?? 'none',
      );
      const room = await payee.page.locator('body').innerText();
      record(
        'journey',
        'payee is told it is THEIR MOVE',
        /THEIR MOVE|Waiting on|Their move/i.test(room),
      );
      record('journey', 'payee is NOT shown payment instructions', !/UPI ID/i.test(room));
      await noDevArtefacts(payee.page, 'deal room');
      await payee.page.screenshot({ path: join(OUT, '06-deal-room-payee.png'), fullPage: true });

      await openRoomAsCreator(payer.page, link);
      await payer.page.locator('a:has-text("Pay ₹"), button:has-text("Pay ₹")').first().click();
      await payer.page.waitForSelector('input[placeholder="428123456789"]', { timeout: 25_000 });

      const payView = await payer.page.locator('body').innerText();
      record('journey', 'payer IS shown payment instructions', /UPI ID/i.test(payView));
      record('journey', 'sandbox handle disclosed honestly', /resolves at no bank/i.test(payView));
      record('journey', 'pay only from your own account', /own verified account/i.test(payView));
      await payer.page.screenshot({
        path: join(OUT, '07-payment-instructions.png'),
        fullPage: true,
      });

      const utr = `E2E${Date.now().toString().slice(-9)}`;
      await claimPayment(payer.page, { utr, note: 'Sent from my verified account.' });
      // The claim is committed only when the ROOM says the deal moved.
      const claimed = await waitForRoom(payer.page, { state: 'FIAT_CLAIMED' });
      record(
        'journey',
        'payment claimed and the deal state moved',
        claimed.state === 'FIAT_CLAIMED',
        utr,
      );
      await payer.page.screenshot({ path: join(OUT, '08-claimed.png'), fullPage: true });

      await payee.page.goto(`${BASE}${inrRoomPath}`, { waitUntil: 'domcontentloaded' });
      await waitForRoom(payee.page, { state: 'FIAT_CLAIMED' });
      await confirmReceipt(payee.page);
      const settled = await waitForRoom(payee.page, { state: 'COMPLETED' });
      record('journey', 'payee confirms and the deal completes', settled.state === 'COMPLETED');
      record(
        'journey',
        'the completed room shows a receipt',
        /Deal completed/i.test(await payee.page.locator('body').innerText()),
      );
      await payee.page.screenshot({ path: join(OUT, '09-completed.png'), fullPage: true });
    }
  } catch (error) {
    record('journey', 'INR→INR journey', false, String(error).slice(0, 170));
    await captureFailure(payer.page, 'inr-payer', payer.bucket);
    await captureFailure(payee.page, 'inr-payee', payee.bucket);
  }
  const keep = failedSoFar() > before;
  await close(payer, keep);
  await close(payee, keep);
  await close(stranger, keep);
}

/* ================================================================== *
 * 4 · Crypto corridors
 * ================================================================== */

console.log('\n4 · crypto corridors');
/*
 * ⚠ THE AMOUNT IS IN THE CORRIDOR'S *FROM* LEG.
 *
 * `/app/new?amount=` fills the side the creator sends, so 83000 means
 * ₹83,000 when buying USDT and 83,000 USDT — about ₹73.7 lakh — when
 * selling it. The gate used the same number for both and the product
 * quite rightly refused the second: "That amount is above your current
 * per-deal limit." A refusal the harness caused is not a corridor
 * result, so each corridor carries an amount that means what it says.
 */
for (const [scenario, creator, joiner, label, amount] of [
  /*
   * ⚠ THE INR LEG SHRANK WHEN THE ESCROW BECAME REAL.
   *
   * It was ₹83,000 — about 1,000 USDT the JOINER now has to put into
   * escrow. `seller` supplies the crypto in this corridor and creates it
   * in the next, so both land on one account's rolling exposure and the
   * risk policy refuses the second with `LIMIT_EXCEEDED`.
   *
   * That refusal is the policy working. The corridor is what is under
   * test here, not the cap, so the gate asks for an amount that fits
   * inside it rather than the cap being widened for a harness.
   */
  ['INR_TO_USDT', ACCOUNT.buyer, ACCOUNT.seller, 'inr-usdt', '8300'],
  ['USDT_TO_INR', ACCOUNT.seller, ACCOUNT.buyer, 'usdt-inr', '50'],
]) {
  const a = await context(`${label}-creator`, { as: creator });
  const b = await context(`${label}-joiner`, { as: joiner });

  /*
   * ⚠ THE CRYPTO SIDE HAS TO OWN THE USDT NOW.
   *
   * Joining moves that side's balance into escrow, and WHICH side that is
   * flips with the corridor: buying USDT the joiner supplies it, selling
   * it the creator does. Both are topped up rather than the harness
   * working out whose turn it is — the claim is idempotent, and a fixture
   * that has to re-derive the role is a fixture that will get it wrong.
   */
  await claimTestFunds(a.page);
  await claimTestFunds(b.page);

  const before = failedSoFar();
  try {
    const link = await createDeal(a.page, {
      scenario,
      amount,
      title: `Headless ${scenario} journey`,
    });
    record(scenario, 'deal created', /^\/d\/INRP-/.test(link), link);

    const joined = await joinDeal(b.page, link, b.bucket);
    record(
      scenario,
      'counterparty joins',
      joined.path !== null,
      joined.refusal ?? `${joined.path} · ${joined.actions.map((x) => x.status).join(',')}`,
    );

    if (joined.path) {
      record(
        scenario,
        'the joined path is a deal room uuid',
        DEAL_ROOM.test(joined.path),
        joined.path,
      );
      const seat = await waitForRoom(b.page, { timeout: 25_000 });
      record(
        scenario,
        'the room renders for the joiner with a seat',
        Boolean(seat.role),
        `${seat.state} · ${seat.role}`,
      );
      const room = await b.page.locator('body').innerText();
      record(scenario, 'both legs and the rate are shown', /USDT/i.test(room) && /₹/.test(room));
      await b.page.screenshot({ path: join(OUT, `10-${label}-room.png`), fullPage: true });

      await openRoomAsCreator(a.page, link);

      /*
       * ⚠ WHICH SIDE PAYS DEPENDS ON THE CORRIDOR.
       *
       * Buying USDT, the creator sends the rupees. SELLING it, the
       * creator RECEIVES them and the joiner pays. The gate assumed the
       * creator always pays and then waited thirty seconds on
       * `has-text("Pay")` — which, matching case-insensitively, had
       * happily resolved to the DISABLED "Waiting for payment" button
       * the product correctly shows the receiving side.
       *
       * So the paying side is identified by the control the server chose
       * to render for it, which is the only authority on who may claim.
       */
      let payer = null;
      for (const side of [a, b]) {
        await side.page.reload({ waitUntil: 'domcontentloaded' });
        await side.page.locator('[data-deal-room]').first().waitFor({ timeout: 20_000 });
        if (await side.page.locator('a[href$="/pay"]').count()) {
          payer = side;
          break;
        }
      }
      record(scenario, 'exactly one side is offered the payment control', payer !== null);

      if (payer) {
        await payer.page.locator('a[href$="/pay"]').first().click();
        await payer.page.waitForURL(/\/pay$/, { timeout: 25_000 });
        await payer.page.waitForSelector('h1', { timeout: 20_000 });
        const payText = await payer.page.locator('body').innerText();
        record(
          scenario,
          'payment surface names the asset or network',
          /TRC.{0,2}20|USDT|UPI/i.test(payText),
        );
        record(scenario, 'sandbox disclaimer present', /sandbox/i.test(payText));
        record(scenario, 'the payer is shown where to send it', /UPI ID|Account/i.test(payText));
        await payer.page.screenshot({ path: join(OUT, `11-${label}-pay.png`), fullPage: true });
      }
    }
  } catch (error) {
    record(scenario, 'corridor journey', false, String(error).slice(0, 170));
    await captureFailure(a.page, `${label}-creator`, a.bucket);
    await captureFailure(b.page, `${label}-joiner`, b.bucket);
  }
  const keep = failedSoFar() > before;
  await close(a, keep);
  await close(b, keep);
}

/* ================================================================== *
 * 5 · Duplicate Join, separate contexts
 * ================================================================== */

console.log('\n5 · duplicate join');
{
  const owner = await context('dup-owner', { as: ACCOUNT.payer });
  const first = await context('dup-first', { as: ACCOUNT.payee });
  const second = await context('dup-second', { as: ACCOUNT.buyer });
  const before = failedSoFar();
  try {
    const link = await createDeal(owner.page, {
      scenario: 'INR_TO_INR',
      amount: '25000',
      title: 'Duplicate join race',
    });

    const [a, b] = await Promise.all([
      joinDeal(first.page, link, first.bucket),
      joinDeal(second.page, link, second.bucket),
    ]);
    const winners = [a, b].filter((r) => r.path !== null);
    record(
      'concurrency',
      'exactly one of two simultaneous joiners wins',
      winners.length === 1,
      `${winners.length} joined`,
    );
    const loser = [a, b].find((r) => r.path === null);
    record('concurrency', 'the loser sees a definitive refusal', Boolean(loser?.refusal));
    record(
      'concurrency',
      'the refusal says nothing was charged',
      /nothing was charged|Nothing was charged/i.test(loser?.refusal ?? ''),
    );
    await second.page.screenshot({ path: join(OUT, '12-duplicate-join.png'), fullPage: true });
  } catch (error) {
    record('concurrency', 'duplicate join', false, String(error).slice(0, 170));
    await captureFailure(second.page, 'dup-second', second.bucket);
  }
  const keep = failedSoFar() > before;
  for (const h of [owner, first, second]) await close(h, keep);
}

/* ================================================================== *
 * 6 · Operator MFA and the return contract
 * ================================================================== */

console.log('\n6 · operator MFA through the UI');
for (const [who, email, roles] of [
  ['maker', ACCOUNT.maker, ['OPERATOR']],
  ['checker', ACCOUNT.checker, ['OPERATOR', 'REVIEWER']],
]) {
  // An operator does not take part in deals, so no verification is
  // submitted for these two: they exist to exercise the second factor.
  const h = await context(`mfa-${who}`, { as: email, verify: false });
  const before = failedSoFar();
  try {
    /*
     * The account exists because it just signed in through the real
     * login form. The ROLE is granted the only way the product allows:
     * out of band, by an administrator, with a written reason. That also
     * bumps the session version, so the live session stops working —
     * which is itself the control being exercised.
     */
    for (const role of roles) {
      grantRole(email, role, `DEL-10 browser gate: ${who} operator journey`);
    }
    await h.page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
    record(
      'mfa',
      `${who}: granting a role ends the live session`,
      /\/login/.test(h.page.url()) || /Sign in/i.test(await h.page.locator('body').innerText()),
      h.page.url().replace(BASE, ''),
    );
    await signIn(h.page, email);

    await h.page.goto(`${BASE}/app/ops`, { waitUntil: 'domcontentloaded' });
    const refused = await h.page
      .locator('[data-testid="access-denied"]')
      .waitFor({ state: 'visible', timeout: 25_000 })
      .then(() => true)
      .catch(() => false);
    record('mfa', `${who}: the desk refuses before the factor is answered`, refused);
    record(
      'mfa',
      `${who}: the refusal carries no operator data`,
      !(await h.page.locator(DESK_CONTROL).count()),
    );

    const mfa = await enrolAndSatisfyMfa(h.page, { next: '/app/ops', expect: DESK_CONTROL });
    record('mfa', `${who}: enrolled an authenticator through the UI`, Boolean(mfa.secret));
    record(
      'mfa',
      `${who}: recovery codes shown once`,
      mfa.recoveryCodes.length > 0,
      `${mfa.recoveryCodes.length} codes`,
    );

    /* ---- The return contract, all four parts ---- */
    record('mfa', `${who}: the challenge is satisfied`, mfa.satisfied);
    record(
      'mfa',
      `${who}: the URL is exactly /app/ops`,
      mfa.arrivedAt === '/app/ops',
      String(mfa.arrivedAt),
    );
    record('mfa', `${who}: a Deal Desk operator control is present`, mfa.control === true);
    record(
      'mfa',
      `${who}: the desk is not the refusal page`,
      (await h.page.locator('[data-testid="access-denied"]').count()) === 0,
    );
    record(
      'mfa',
      `${who}: no Security tree survives the return`,
      !(await staleSecurityTree(h.page)),
    );
    await noDevArtefacts(h.page, 'deal desk');

    if (who === 'maker') {
      await h.page.screenshot({ path: join(OUT, '13-ops-desk.png'), fullPage: true });
      const firstCase = h.page.locator('a[href^="/app/ops/"]:not([href*="verification"])').first();
      if (await firstCase.count()) opsCasePath = await firstCase.getAttribute('href');

      /*
       * An OPERATOR is not a REVIEWER. The maker holds `ops.queue.read`
       * and not `verification.review`, and the split is what makes
       * maker-checker mean anything — so the desk must not offer them
       * the queue, and the queue itself must refuse them.
       */
      record(
        'review',
        'an operator without the reviewer role is not offered the queue',
        (await h.page.locator('[data-testid="verification-queue-link"]').count()) === 0,
      );
      await h.page.goto(`${BASE}/app/ops/verification`, { waitUntil: 'domcontentloaded' });
      record(
        'review',
        'the verification queue refuses an operator who may not review',
        (await h.page.locator('[data-testid="access-denied"]').count()) === 1,
      );
      record(
        'review',
        'the refusal contains nobody else’s case',
        (await h.page.locator('[data-testid="verification-queue"]').count()) === 0,
      );
      await h.page.goto(`${BASE}/app/ops`, { waitUntil: 'domcontentloaded' });
    }

    const storage = await h.page.evaluate(() => ({
      local: Object.entries(localStorage)
        .map(([k, v]) => `${k}=${v}`)
        .join('|'),
      session: Object.entries(sessionStorage)
        .map(([k, v]) => `${k}=${v}`)
        .join('|'),
    }));
    const leaked =
      Boolean(mfa.secret) &&
      (storage.local.includes(mfa.secret) ||
        storage.session.includes(mfa.secret) ||
        h.page.url().includes(mfa.secret));
    record('mfa', `${who}: the secret is not in the URL or browser storage`, !leaked);
  } catch (error) {
    record('mfa', `${who} enrolment`, false, String(error).slice(0, 170));
    await captureFailure(h.page, `mfa-${who}`, h.bucket);
  }
  await close(h, failedSoFar() > before);
}

/* ================================================================== *
 * 7 · Telegram Mini App initData
 * ================================================================== */

console.log('\n7 · Telegram initData');
{
  const h = await context('telegram');
  const before = failedSoFar();
  try {
    await h.page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const { sign } = await import('./e2e/telegram.mjs');

    const post = (initData) =>
      h.page.evaluate(async (data) => {
        const r = await fetch('/api/telegram/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData: data }),
        });
        return { status: r.status, body: (await r.text()).slice(0, 160) };
      }, initData);

    const now = Math.floor(Date.now() / 1000);
    const user = JSON.stringify({ id: 987654, first_name: 'E2E' });

    const valid = await post(sign({ auth_date: String(now), user }));
    record('telegram', 'valid initData is accepted', valid.status < 400, `HTTP ${valid.status}`);

    const t = await post(sign({ auth_date: String(now), user }).replace('987654', '111111'));
    record('telegram', 'tampered initData is refused', t.status >= 400, `HTTP ${t.status}`);

    const e = await post(sign({ auth_date: String(now - 60 * 60 * 25), user }));
    record('telegram', 'expired initData is refused', e.status >= 400, `HTTP ${e.status}`);

    const replayData = sign({
      auth_date: String(now),
      user: JSON.stringify({ id: 55501, first_name: 'Replay' }),
    });
    const first = await post(replayData);
    const again = await post(replayData);
    record(
      'telegram',
      'replayed initData is refused the second time',
      first.status < 400 && again.status >= 400,
      `first ${first.status}, replay ${again.status}`,
    );
  } catch (error) {
    record('telegram', 'initData', false, String(error).slice(0, 170));
    await captureFailure(h.page, 'telegram', h.bucket);
  }
  await close(h, failedSoFar() > before);
}

/* ================================================================== *
 * 8 · Responsive, including authenticated surfaces
 * ================================================================== */

/**
 * Seven widths, SEQUENTIALLY, each on its own page.
 *
 * A fresh page per width, closed before the next one opens, so a
 * navigation cancelled by the next width's `goto` cannot be reported as
 * an aborted request against the route it was leaving. Every navigation
 * carries a bounded timeout and is retried once, and anything still
 * failing after that is treated as a real finding.
 */
console.log('\n8 · responsive');
{
  const before = failedSoFar();
  const surfaces = [
    ['landing', '/'],
    ['login', '/login'],
    ['deals', '/app/deals'],
    ['deal-room', inrRoomPath ?? '/app'],
    ['security', '/app/settings/security'],
    ['ops', '/app/ops'],
  ];
  const owner = await context('responsive', { as: ACCOUNT.payer });

  /*
   * ⚠ 768 AND 1024 ARE IN THE LIST NOW.
   *
   * They were the two widths nobody tested and the two where this
   * layout actually changes: 768 is where the desktop rail and the
   * multi-column compositions begin to apply, and 1024 is the small
   * laptop the operator desk has to fit in. Everything below them was a
   * phone and everything above was comfortable, so the gate was testing
   * either side of the interesting part.
   */
  for (const width of [360, 375, 390, 430, 768, 1024, 1280, 1440, 1920]) {
    const page = await owner.ctx.newPage();
    instrument(page, owner.bucket);
    await page.setViewportSize({ width, height: 900 });
    try {
      for (const [name, route] of surfaces) {
        let landed = false;
        for (let attempt = 0; attempt < 2 && !landed; attempt += 1) {
          landed = await page
            .goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
            .then(() => true)
            .catch(() => false);
        }
        if (!landed) {
          record('responsive', `${width}px ${name}`, false, 'navigation never completed');
          continue;
        }
        // Layout settles after fonts; a shot taken before that measures
        // a page nobody sees.
        await page.evaluate(() => document.fonts?.ready).catch(() => {});
        await wait(250);
        await page.screenshot({
          path: join(OUT, `responsive-${width}-${name}.png`),
          fullPage: true,
        });
        const overflow = await page.evaluate(() => {
          const doc = document.documentElement;
          if (doc.scrollWidth <= window.innerWidth + 1) return null;
          // Name the widest offender, so a failure is actionable.
          let worst = null;
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.right > window.innerWidth + 1 && (!worst || r.right > worst.right)) {
              worst = {
                right: Math.round(r.right),
                tag: el.tagName.toLowerCase(),
                cls: (el.className?.toString?.() ?? '').slice(0, 60),
              };
            }
          }
          return { scrollWidth: doc.scrollWidth, inner: window.innerWidth, worst };
        });
        record(
          'responsive',
          `${width}px ${name}`,
          overflow === null,
          overflow
            ? `${overflow.scrollWidth}>${overflow.inner} ${overflow.worst?.tag} ${overflow.worst?.cls}`
            : '',
        );
      }
      /*
       * ⚠ AND A DIALOG MUST FIT ON THE SCREEN IT OPENS ON.
       *
       * Horizontal overflow was the only thing measured here, and a
       * defect that cost a person the ability to add a payment method
       * was VERTICAL: the centred dialog lost its `translate(-50%,-50%)`
       * to an animation's fill mode, so it hung off the bottom of the
       * window with its submit button unreachable and nothing to
       * scroll. A control that is off-screen is not a control.
       */
      await page.goto(`${BASE}/app/profile/payment-methods`, {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      });
      const opened = await clickUntil(
        page,
        'button:has-text("Add a payment method")',
        'input#handle',
      );
      if (opened) {
        await wait(500);
        const fit = await page.evaluate(() => {
          const sheet = document.querySelector('.sheet');
          if (!sheet) return { ok: false, why: 'no sheet' };
          const r = sheet.getBoundingClientRect();
          const submit = [...sheet.querySelectorAll('button[type=submit]')].pop();
          const s = submit?.getBoundingClientRect();
          const within = (b) => b && b.top >= -1 && b.bottom <= window.innerHeight + 1;
          // Either the whole dialog fits, or it scrolls to reach the end.
          const scrollable = sheet.scrollHeight > sheet.clientHeight + 1;
          return {
            ok: within(r) && (within(s) || scrollable),
            why: `sheet ${Math.round(r.top)}–${Math.round(r.bottom)} of ${window.innerHeight}, submit ${s ? `${Math.round(s.top)}–${Math.round(s.bottom)}` : 'none'}, scrollable ${scrollable}`,
          };
        });
        record('responsive', `${width}px dialog fits the window`, fit.ok, fit.why);
      } else {
        record('responsive', `${width}px dialog fits the window`, false, 'the dialog never opened');
      }
    } catch (error) {
      record('responsive', `${width}px`, false, String(error).slice(0, 150));
      await captureFailure(page, `responsive-${width}`, owner.bucket);
    }
    await page.close();
  }
  if (failedSoFar() > before) await captureFailure(owner.page, 'responsive-owner', owner.bucket);
}

/* ================================================================== *
 * 9 · Accessibility, including authenticated and operator surfaces
 * ================================================================== */

console.log('\n9 · accessibility');
{
  const h = await context('a11y', { as: ACCOUNT.payer });
  const operator = await context('a11y-ops', { as: ACCOUNT.maker });
  const before = failedSoFar();
  try {
    const { auditPage } = await import('./e2e/a11y.mjs');

    const audit = async (page, name, route) => {
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      await wait(250);
      const a = await auditPage(page);
      record(
        'a11y',
        `${name}: controls have accessible names`,
        a.unnamed.length === 0,
        a.unnamed.slice(0, 3).join('; '),
      );
      record(
        'a11y',
        `${name}: target sizes ≥ 24px`,
        a.smallTargets.length === 0,
        a.smallTargets.slice(0, 3).join('; '),
      );
      record('a11y', `${name}: language declared`, Boolean(a.lang), a.lang);
      record('a11y', `${name}: exactly one h1`, a.h1 === 1, `h1=${a.h1}`);
      record(
        'a11y',
        `${name}: headings do not skip a level`,
        a.headingSkips.length === 0,
        a.headingSkips.slice(0, 2).join('; '),
      );
      record(
        'a11y',
        `${name}: form fields are labelled`,
        a.unlabelledFields.length === 0,
        a.unlabelledFields.slice(0, 3).join('; '),
      );
      await noDevArtefacts(page, name);
    };

    for (const [name, route] of [
      ['landing', '/'],
      ['login', '/login'],
      ['home', '/app'],
      ['deals', '/app/deals'],
      ['deal-room', inrRoomPath ?? '/app'],
      ['new-deal', '/app/new?scenario=INR_TO_INR&amount=25000'],
      ['security', '/app/settings/security'],
      ['notifications', '/app/notifications'],
      ['help', '/app/help'],
    ]) {
      await audit(h.page, name, route);
    }

    // The operator surfaces, behind a satisfied second factor.
    await audit(operator.page, 'deal-desk', '/app/ops');
    if (opsCasePath) await audit(operator.page, 'ops-case', opsCasePath);
    await operator.page.screenshot({ path: join(OUT, '14-ops-case.png'), fullPage: true });

    await h.page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    const stops = [];
    for (let i = 0; i < 8; i += 1) {
      await h.page.keyboard.press('Tab');
      stops.push(
        await h.page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const s = getComputedStyle(el);
          /*
           * A focus indicator may be an outline OR a ring drawn with
           * box-shadow. `outlineStyle` alone misses the ring, and an
           * outline of zero width is not an indicator either.
           */
          const outlined = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
          const ringed = s.boxShadow !== 'none' && s.boxShadow !== '';
          return {
            visible: outlined || ringed,
            tag: `${el.tagName.toLowerCase()}"${(el.textContent ?? '').trim().slice(0, 16)}"`,
          };
        }),
      );
    }
    const focusable = stops.filter(Boolean);
    record(
      'a11y',
      'keyboard reaches the sign-in form',
      focusable.length >= 3,
      `${focusable.length} stops`,
    );
    record(
      'a11y',
      'focus is visible at every stop',
      focusable.every((f) => f.visible),
      focusable
        .filter((f) => !f.visible)
        .map((f) => f.tag)
        .join('; '),
    );

    /*
     * The skip link is exempt from the 24px target rule while it is
     * visually hidden — it is not a pointer target then. That exemption
     * has to be EARNED: focused, it must become a real, hittable target.
     */
    await h.page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await h.page.keyboard.press('Tab');
    const skip = await h.page.evaluate(() => {
      const el = document.activeElement;
      if (!el || !/skip/i.test(el.textContent ?? '')) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), text: el.textContent.trim() };
    });
    record(
      'a11y',
      'the skip link becomes a real target when focused',
      Boolean(skip) && skip.w >= 24 && skip.h >= 24,
      skip ? `${skip.w}×${skip.h}` : 'not focused first',
    );

    const reduced = await browser.newContext({ reducedMotion: 'reduce' });
    const rp = await reduced.newPage();
    await rp.goto(BASE, { waitUntil: 'domcontentloaded' });
    const animated = await rp.evaluate(
      () =>
        [...document.querySelectorAll('*')].filter((el) => {
          const s = getComputedStyle(el);
          return s.animationName !== 'none' && parseFloat(s.animationDuration) > 0.3;
        }).length,
    );
    record('a11y', 'reduced motion: no long animations', animated === 0, `${animated} animated`);
    await reduced.close();
  } catch (error) {
    record('a11y', 'accessibility', false, String(error).slice(0, 170));
    await captureFailure(h.page, 'a11y', h.bucket);
  }
  await close(h, failedSoFar() > before);
  await close(operator, failedSoFar() > before);
}

/* ================================================================== *
 * 10 · Performance, including the authenticated and operator surfaces
 * ================================================================== */

console.log('\n10 · performance');
{
  const h = await context('perf', { as: ACCOUNT.payer });
  const operator = await context('perf-ops', { as: ACCOUNT.maker });
  const before = failedSoFar();
  try {
    for (const [name, route] of [
      ['landing', '/'],
      ['login', '/login'],
    ]) {
      const started = Date.now();
      await h.page.goto(`${BASE}${route}`, { waitUntil: 'load' });
      perf[`${name}LoadMs`] = Date.now() - started;
      perf[`${name}Cls`] = Number(
        (
          await h.page.evaluate(
            () =>
              new Promise((resolve) => {
                let total = 0;
                new PerformanceObserver((list) => {
                  for (const entry of list.getEntries()) {
                    if (!entry.hadRecentInput) total += entry.value;
                  }
                }).observe({ type: 'layout-shift', buffered: true });
                setTimeout(() => resolve(total), 1200);
              }),
          )
        ).toFixed(4),
      );
      record('perf', `${name} load`, true, `${perf[`${name}LoadMs`]}ms CLS ${perf[`${name}Cls`]}`);
    }

    await h.page.goto(BASE, { waitUntil: 'load' });
    const amount = h.page.locator('input[placeholder="0"]');
    await amount.click();
    const q0 = Date.now();
    await amount.pressSequentially('50000', { delay: 8 });
    await h.page.waitForFunction(() => document.body.innerText.includes('50,000'), {
      timeout: 10_000,
    });
    perf.quoteMs = Date.now() - q0;
    record('perf', 'quote recompute', true, `${perf.quoteMs}ms`);

    if (inrRoomPath) {
      const r0 = Date.now();
      await h.page.goto(`${BASE}${inrRoomPath}`, { waitUntil: 'load' });
      await h.page
        .locator('[data-deal-room]')
        .first()
        .waitFor({ state: 'visible', timeout: 25_000 });
      perf.dealRoomLoadMs = Date.now() - r0;
      record('perf', 'deal room load', true, `${perf.dealRoomLoadMs}ms`);
    }

    const d0 = Date.now();
    await h.page.goto(`${BASE}/app/deals`, { waitUntil: 'load' });
    await h.page.waitForSelector('h1', { timeout: 20_000 });
    perf.dealsListLoadMs = Date.now() - d0;
    record('perf', 'deals list load', true, `${perf.dealsListLoadMs}ms`);

    /* ---- Operator surfaces: the pagination-shaped ones ---- */
    const o0 = Date.now();
    await operator.page.goto(`${BASE}/app/ops`, { waitUntil: 'load' });
    await operator.page.waitForSelector(DESK_CONTROL, { timeout: 25_000 });
    perf.opsQueueLoadMs = Date.now() - o0;
    record('perf', 'operator queue load', true, `${perf.opsQueueLoadMs}ms`);

    const f0 = Date.now();
    await operator.page.goto(`${BASE}/app/ops?view=AWAITING_CONFIRM`, { waitUntil: 'load' });
    await operator.page.waitForSelector(DESK_CONTROL, { timeout: 25_000 });
    perf.opsFilteredLoadMs = Date.now() - f0;
    record('perf', 'operator queue, filtered view', true, `${perf.opsFilteredLoadMs}ms`);

    if (opsCasePath) {
      const c0 = Date.now();
      await operator.page.goto(`${BASE}${opsCasePath}`, { waitUntil: 'load' });
      await operator.page.waitForSelector('h1', { timeout: 25_000 });
      perf.opsCaseLoadMs = Date.now() - c0;
      record('perf', 'operator case load', true, `${perf.opsCaseLoadMs}ms`);
    }

    /* ================================================================ *
     * Under a REAL backlog
     * ================================================================ *
     *
     * Everything above was measured against the handful of deals the
     * journeys created, which is an empty queue wearing a queue's
     * clothes. The numbers that guard against an unbounded query, an
     * N+1 or a render that scales with the platform's whole open volume
     * have to be taken with the queue several pages deep and the room
     * full of messages. The fixture writes rows out of band into this
     * gate's own throwaway cluster; nothing is asserted on it as
     * product behaviour.
     */
    const seeded = spawnSync(
      process.execPath,
      [
        'scripts/perf-backlog.mjs',
        '--deals',
        String(BACKLOG_DEALS),
        '--messages',
        String(BACKLOG_MESSAGES),
        ...(inrRoomPath ? ['--room', inrRoomPath.split('/').pop()] : []),
      ],
      { encoding: 'utf8', env: process.env },
    );
    if (seeded.status !== 0) {
      // The whole message, not a stub: a fixture failure that reads
      // "error: cannot" tells the next reader nothing at all.
      record(
        'perf',
        'backlog fixture',
        false,
        `${seeded.stdout ?? ''}${seeded.stderr ?? ''}`.replace(/\s+/g, ' ').slice(0, 400),
      );
    } else {
      perf.backlogOpenDeals = Number(/OPEN_DEALS=(\d+)/.exec(seeded.stdout ?? '')?.[1] ?? 0);
      record('perf', 'backlog seeded', true, `${perf.backlogOpenDeals} open deals`);

      const b0 = Date.now();
      await operator.page.goto(`${BASE}/app/ops`, { waitUntil: 'load' });
      await operator.page.waitForSelector(DESK_CONTROL, { timeout: 30_000 });
      perf.opsQueueBacklogMs = Date.now() - b0;
      record('perf', 'operator queue under backlog', true, `${perf.opsQueueBacklogMs}ms`);

      /*
       * THE PAGINATION INVARIANT, measured in the DOM.
       *
       * A budget on time alone would stay green while the page quietly
       * rendered four hundred rows on a fast machine. What must hold is
       * that the page is BOUNDED — and that it still tells the operator
       * how many there really are.
       */
      const rendered = await operator.page.evaluate(() => ({
        rows: document.querySelectorAll('tbody tr[data-queue-row]').length,
        pager: document.querySelector('[data-testid="desk-pager"]')?.textContent?.trim() ?? '',
      }));
      perf.opsQueueRenderedRows = rendered.rows;
      record(
        'perf',
        'the desk renders one bounded page, not the whole backlog',
        rendered.rows > 0 && rendered.rows <= DESK_PAGE_SIZE,
        `${rendered.rows} rows`,
      );
      record(
        'perf',
        'the desk states the true total behind the page',
        new RegExp(`of\\s*${perf.backlogOpenDeals}\\b`).test(rendered.pager),
        rendered.pager.replace(/\s+/g, ' ').slice(0, 80),
      );

      const f1 = Date.now();
      await operator.page.goto(`${BASE}/app/ops?view=AT_RISK`, { waitUntil: 'load' });
      await operator.page.waitForSelector(DESK_CONTROL, { timeout: 30_000 });
      perf.opsFilteredBacklogMs = Date.now() - f1;
      record(
        'perf',
        'operator queue, filtered, under backlog',
        true,
        `${perf.opsFilteredBacklogMs}ms`,
      );

      const p2 = Date.now();
      await operator.page.goto(`${BASE}/app/ops?page=2`, { waitUntil: 'load' });
      await operator.page.waitForSelector(DESK_CONTROL, { timeout: 30_000 });
      perf.opsSecondPageMs = Date.now() - p2;
      record('perf', 'the second page of the desk is reachable', true, `${perf.opsSecondPageMs}ms`);
      await operator.page.screenshot({ path: join(OUT, '16-ops-backlog.png'), fullPage: true });

      if (inrRoomPath) {
        const r1 = Date.now();
        await h.page.goto(`${BASE}${inrRoomPath}`, { waitUntil: 'load' });
        await h.page
          .locator('[data-deal-room]')
          .first()
          .waitFor({ state: 'visible', timeout: 30_000 });
        perf.dealRoomBusyMs = Date.now() - r1;
        record('perf', 'deal room with a full transcript', true, `${perf.dealRoomBusyMs}ms`);
        perf.dealRoomRenderedMessages = await h.page.evaluate(
          () => document.querySelectorAll('[data-chat-message]').length,
        );
        record(
          'perf',
          'the room renders a bounded transcript',
          perf.dealRoomRenderedMessages <= CHAT_PAGE_LIMIT,
          `${perf.dealRoomRenderedMessages} messages`,
        );
        await h.page.screenshot({ path: join(OUT, '17-deal-room-busy.png'), fullPage: true });
      }
    }
  } catch (error) {
    record('perf', 'performance', false, String(error).slice(0, 170));
    await captureFailure(h.page, 'perf', h.bucket);
  }
  await close(h, failedSoFar() > before);
  await close(operator, failedSoFar() > before);
}

await closeActors(results.some((r) => !r.ok));
await browser.close();

/* ================================================================== *
 * Report
 * ================================================================== */

const failed = results.filter((r) => !r.ok);
mkdirSync('artifacts', { recursive: true });
writeFileSync(
  join(OUT, 'e2e-results.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      baseUrl: BASE,
      server: 'next start (production build)',
      total: results.length,
      failed: failed.length,
      performance: perf,
      results,
    },
    null,
    2,
  ),
);
writeFileSync('artifacts/performance.json', JSON.stringify(perf, null, 2));

/*
 * The accessibility result, on its own.
 *
 * Release-blocking rules only — an unnamed control, an unlabelled field,
 * a heading jump, a missing language, a target nobody can hit. Written
 * separately because it is read by somebody asking one question ("does
 * this ship?") who should not have to filter it out of two hundred other
 * results, and because it names the SURFACES it covered: an
 * accessibility pass that quietly skipped the authenticated screens is
 * the one worth being suspicious of.
 */
const a11y = results.filter((r) => r.area === 'a11y');
const surfaces = [
  ...new Set(a11y.map((r) => r.name.split(':')[0]).filter((n) => !n.includes(' '))),
];
writeFileSync(
  'artifacts/accessibility.json',
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      baseUrl: BASE,
      server: 'next start (production build)',
      rules: [
        'controls have accessible names',
        'target sizes >= 24x24 CSS px (WCAG 2.2 AA 2.5.8)',
        'language declared',
        'exactly one h1',
        'headings do not skip a level',
        'form fields are labelled',
        'focus is visible at every stop',
        'the skip link becomes a real target when focused',
        'reduced motion: no long animations',
      ],
      surfaces,
      total: a11y.length,
      failed: a11y.filter((r) => !r.ok).length,
      results: a11y,
    },
    null,
    2,
  ),
);

console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
if (failed.length > 0) {
  console.error('\nfailed:');
  for (const f of failed) console.error(`  ${f.area} · ${f.name} ${f.detail}`);
  console.error(`\nevidence: ${join(OUT, 'failures')} · traces: ${join(OUT, 'traces')}`);
  process.exit(1);
}
console.log(`artifacts in ${OUT}`);
