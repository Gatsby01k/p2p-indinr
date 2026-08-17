#!/usr/bin/env node
/**
 * The finalisation screenshot set.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  REAL SCREENS, REAL DATA, THE BUILT SERVER.                      │
 * │                                                                  │
 * │  Every frame here is the running application at a real URL with  │
 * │  a real signed-in session and deals created through the same     │
 * │  boundaries a person uses. Nothing is mocked, stubbed or posed:  │
 * │  a lifecycle state appears in this set only because the journey  │
 * │  that produces it was actually driven.                           │
 * │                                                                  │
 * │  Each surface is captured at BOTH postures — 390 for the phone   │
 * │  and Telegram Mini App, 1440 for desktop — because the two are   │
 * │  different layouts and judging one tells you nothing about the   │
 * │  other.                                                          │
 * └──────────────────────────────────────────────────────────────────┘
 *
 *   node scripts/uiux-screens.mjs                 (build, serve, capture)
 *   node scripts/uiux-screens.mjs --no-build
 *   node scripts/uiux-screens.mjs --attach 3230   (use a server already up)
 */

import { chromium } from 'playwright-core';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GATE_DATABASE_URL,
  GATE_LOG,
  ROOT,
  buildProduction,
  startDatabase,
  startServer,
  stopServer,
} from './e2e/stack.mjs';

/*
 * ⚠ NAME THE CLUSTER BEFORE ANYTHING ELSE RUNS.
 *
 * `grantRole` shells out to `scripts/grant-role.mjs`, which falls back to
 * `.env.local` when `DATABASE_URL` is absent — and `.env.local` here
 * points at a HOSTED database. The first run of this script tried to
 * grant an operator role on it, and was saved only by the account not
 * existing there. Setting it in this process, before the harness is
 * imported, is what makes every child inherit the right target.
 */
process.env.DATABASE_URL = GATE_DATABASE_URL;

const flag = (name) => process.argv.includes(`--${name}`);
const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};

const OUT = join(ROOT, 'artifacts', 'uiux', 'screens');
const PORT = Number(argOf('attach') ?? process.env.UIUX_PORT ?? 3240);
const BASE = `http://127.0.0.1:${PORT}`;

/** The two postures. Phone first, because the product is mobile-first. */
const POSTURES = [
  { key: 'mobile', width: 390, height: 844 },
  { key: 'desktop', width: 1440, height: 900 },
];

const shots = [];
let server = null;

function say(text) {
  console.log(text);
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  if (!argOf('attach')) {
    if (!flag('no-build')) buildProduction();
    startDatabase();
    rmSync(GATE_LOG, { force: true });
    server = await startServer({ port: PORT, log: GATE_LOG, label: 'uiux-screens' });
  }

  process.env.BASE_URL = BASE;
  process.env.SERVER_LOG = GATE_LOG;
  process.env.E2E_RUN_ID = `ux${Date.now().toString(36).slice(-5)}`;
  const lib = await import('./e2e/lib.mjs');

  const browser = await chromium.launch({ executablePath: lib.CHROME, headless: true });

  /**
   * Capture one surface at both postures.
   *
   * The page is a fresh one per posture rather than a resized reuse:
   * a layout that was laid out at 1440 and then measured at 390 is not
   * the layout a phone gets.
   */
  async function capture(name, visit, { context } = {}) {
    for (const posture of POSTURES) {
      const ctx =
        context ??
        (await browser.newContext({ viewport: { width: posture.width, height: posture.height } }));
      const page = context ? await context.newPage() : await ctx.newPage();
      await page.setViewportSize({ width: posture.width, height: posture.height });
      try {
        await visit(page);
        // Fonts and any entry animation settle before the shutter.
        await page.evaluate(() => document.fonts?.ready).catch(() => {});
        await lib.wait(450);
        const file = join(OUT, `${name}.${posture.key}.png`);
        await page.screenshot({ path: file, fullPage: true });
        shots.push(`${name}.${posture.key}.png`);
        say(`  ${name} · ${posture.key}`);
      } catch (error) {
        say(`  FAILED ${name} · ${posture.key} — ${String(error).slice(0, 120)}`);
      }
      await page.close();
      if (!context) await ctx.close();
    }
  }

  const go = (path, waitFor) => async (page) => {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (waitFor) await page.locator(waitFor).first().waitFor({ state: 'visible', timeout: 25_000 });
    else await page.waitForSelector('h1, h2', { timeout: 25_000 });
  };

  /* ================= Public ================= */
  say('\npublic');
  await capture('01-landing', go('/'));
  await capture('02-calculator-usdt', async (page) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const buy = page.getByRole('radio', { name: /Buy USDT/i });
    for (let i = 0; i < 5; i += 1) {
      await buy.click({ timeout: 8_000 }).catch(() => {});
      if ((await buy.getAttribute('aria-checked')) === 'true') break;
      await lib.wait(400);
    }
    await lib.typeInto(page, 'input[placeholder="0"]', '83000');
    await page.waitForFunction(() => /USDT/.test(document.body.innerText), { timeout: 15_000 });
  });
  await capture('03-login', go('/login'));
  await capture('04-not-found', go('/d/INRP-ZZZZZZZZZZ'));

  /* ================= A real signed-in pair ================= */
  say('\nsigning in two real people');
  const payer = await lib.actor(browser, lib.ACCOUNT.payer, { verify: false });
  const reviewerSetup = await lib.establishReviewer(browser, lib.ACCOUNT.reviewer, {
    deskControl: 'nav[aria-label="Queue views"] a[href="/app/ops?view=DISPUTED"]',
  });
  await lib.verifyAccount(payer.page);
  await lib.approvePendingVerifications(reviewerSetup.handle.page);
  await lib.addUpiMethod(payer.page, lib.ACCOUNT.payer);
  const payee = await lib.actor(browser, lib.ACCOUNT.payee);

  say('\nauthenticated');
  await capture('10-home', go('/app'), { context: payer.ctx });
  await capture('11-deals-empty', go('/app/deals'), { context: payee.ctx });
  await capture('12-new-deal', go('/app/new?scenario=INR_TO_INR&amount=25000'), {
    context: payer.ctx,
  });

  /* ================= A real deal, through its lifecycle ============ */
  say('\na real deal');
  const link = await lib.createDeal(payer.page, {
    scenario: 'INR_TO_INR',
    amount: '25000',
    title: 'Website redesign, second milestone',
  });
  await capture('20-deal-link-creator', go(link), { context: payer.ctx });
  // The stranger's view: signed out, which is how a shared link arrives.
  await capture('21-deal-link-stranger', go(link, 'text=/Sign in to join/i'));

  const joined = await lib.joinDeal(payee.page, link, payee.bucket);
  const room = joined.path;
  await capture('22-deal-room-awaiting-payment', go(room, '[data-deal-room]'), {
    context: payee.ctx,
  });

  await lib.openRoomAsCreator(payer.page, link);
  await capture('23-deal-room-your-move', go(room, '[data-deal-room]'), { context: payer.ctx });
  await capture('24-payment-instructions', go(`${room}/pay`, '[data-testid="claim-open"]'), {
    context: payer.ctx,
  });

  await payer.page.goto(`${BASE}${room}/pay`, { waitUntil: 'domcontentloaded' });
  await payer.page.locator('[data-testid="claim-open"]').first().waitFor({ state: 'visible' });
  const utr = `UX${Date.now().toString().slice(-10)}`;
  await lib.claimPayment(payer.page, { utr, note: 'Sent from my own account.' });
  await lib.waitForRoom(payer.page, { state: 'FIAT_CLAIMED' });
  await capture('25-deal-room-claimed', go(room, '[data-deal-room]'), { context: payer.ctx });
  await capture('26-deal-room-confirm', go(room, '[data-testid="confirm-open"]'), {
    context: payee.ctx,
  });

  await payee.page.goto(`${BASE}${room}`, { waitUntil: 'domcontentloaded' });
  await lib.waitForRoom(payee.page, { state: 'FIAT_CLAIMED' });
  await lib.confirmReceipt(payee.page);
  await lib.waitForRoom(payee.page, { state: 'COMPLETED' });
  await capture('27-deal-room-completed', go(room, '[data-deal-room]'), { context: payee.ctx });
  await capture('28-deals-list', go('/app/deals'), { context: payer.ctx });

  /* ================= A crypto corridor ============================= */
  say('\na crypto corridor');
  const buyer = await lib.actor(browser, lib.ACCOUNT.buyer);
  const seller = await lib.actor(browser, lib.ACCOUNT.seller);
  const usdtLink = await lib.createDeal(buyer.page, {
    scenario: 'INR_TO_USDT',
    amount: '83000',
    title: 'Buying USDT from a verified desk',
  });
  await capture('30-deal-link-corridor', go(usdtLink), { context: seller.ctx });
  const usdtJoin = await lib.joinDeal(seller.page, usdtLink, seller.bucket);
  if (usdtJoin.path) {
    await capture('31-deal-room-corridor', go(usdtJoin.path, '[data-deal-room]'), {
      context: seller.ctx,
    });
  }

  /* ================= Dispute and evidence ========================== */
  say('\ndispute');
  const dLink = await lib.createDeal(payer.page, {
    scenario: 'INR_TO_INR',
    amount: '12000',
    title: 'Logo pack, disputed example',
  });
  const dJoin = await lib.joinDeal(payee.page, dLink, payee.bucket);
  if (dJoin.path) {
    await capture('40-dispute-form', go(`${dJoin.path}/dispute`, '[data-testid="dispute-open"]'), {
      context: payee.ctx,
    });
  }

  /* ================= Account surfaces ============================== */
  say('\naccount');
  await capture('50-profile', go('/app/profile'), { context: payer.ctx });
  await capture('51-verification', go('/app/profile/verification'), { context: payer.ctx });
  await capture('52-payment-methods', go('/app/profile/payment-methods'), { context: payer.ctx });
  await capture('53-security-enrolled', go('/app/settings/security'), {
    context: reviewerSetup.handle.ctx,
  });
  await capture('54-security-not-enrolled', go('/app/settings/security'), { context: payer.ctx });
  await capture('55-rewards', go('/app/rewards'), { context: payer.ctx });
  await capture('56-notifications', go('/app/notifications'), { context: payer.ctx });
  await capture('57-help', go('/app/help'), { context: payer.ctx });
  await capture('58-settings', go('/app/settings'), { context: payer.ctx });

  /* ================= Refusals ====================================== */
  say('\nrefusals');
  await capture('60-ops-refused', go('/app/ops', '[data-testid="access-denied"]'), {
    context: payer.ctx,
  });

  /* ================= Operator ====================================== */
  say('\noperator');
  const desk = 'nav[aria-label="Queue views"] a[href="/app/ops?view=DISPUTED"]';
  const rev = reviewerSetup.handle;
  await capture('70-deal-desk', go('/app/ops', desk), { context: rev.ctx });
  await capture('71-verification-queue', go('/app/ops/verification'), { context: rev.ctx });

  await rev.page.goto(`${BASE}/app/ops`, { waitUntil: 'domcontentloaded' });
  await rev.page.waitForSelector(desk, { timeout: 25_000 });
  const caseHref = await rev.page
    .locator('a[href^="/app/ops/"]:not([href*="verification"])')
    .first()
    .getAttribute('href')
    .catch(() => null);
  if (caseHref) {
    await capture('72-operator-case', go(caseHref), { context: rev.ctx });
  }

  /* ================= Under load ==================================== */
  say('\nunder a backlog');
  const { spawnSync } = await import('node:child_process');
  spawnSync(process.execPath, ['scripts/perf-backlog.mjs', '--deals', '200', '--messages', '140', ...(room ? ['--room', room.split('/').pop()] : [])], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  await capture('80-deal-desk-backlog', go('/app/ops', desk), { context: rev.ctx });
  await capture('81-deal-room-busy', go(room, '[data-deal-room]'), { context: payee.ctx });

  await browser.close();

  writeFileSync(
    join(OUT, 'index.json'),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), baseUrl: BASE, postures: POSTURES, shots },
      null,
      2,
    ),
  );
  say(`\n${shots.length} screenshots in ${OUT}`);
}

try {
  await main();
} finally {
  if (server) await stopServer(server);
}
