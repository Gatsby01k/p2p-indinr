#!/usr/bin/env node
/**
 * CI-enforced performance budgets, from MEASURED values.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  THESE ARE REGRESSION FENCES, NOT SERVICE-LEVEL PROMISES.        │
 * │                                                                  │
 * │  Every threshold below is derived from a real measurement taken  │
 * │  on this repository — the build report for bundle sizes, and the │
 * │  headless browser run against the BUILT server for latency and   │
 * │  layout shift. Each is set with deliberate headroom so ordinary  │
 * │  variation does not fail CI, and so a breach means something     │
 * │  genuinely changed.                                              │
 * │                                                                  │
 * │  NO SLA OR CORE WEB VITALS CLAIM IS MADE. These numbers came     │
 * │  from one developer machine; they say "this did not get          │
 * │  materially worse", nothing more.                                │
 * │                                                                  │
 * │  ⚠ TWO KINDS OF BUDGET, AND THE SECOND IS THE IMPORTANT ONE.     │
 * │                                                                  │
 * │  A LATENCY budget on a fast machine can stay green through the   │
 * │  exact regression it exists to catch — an unbounded query, an    │
 * │  N+1, a render that scales with the platform's whole open        │
 * │  volume. So the operator queue and the deal room are also        │
 * │  measured under a BACKLOG several pages deep, and the shape      │
 * │  budgets below assert what the page actually rendered: at most   │
 * │  one page of queue rows, at most one page of transcript. Those   │
 * │  cannot be satisfied by a faster CPU.                            │
 * └──────────────────────────────────────────────────────────────────┘
 *
 *   node scripts/performance-budget.mjs
 *     --build artifacts/build.txt      (the build report)
 *     --perf  artifacts/performance.json
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const PERF_PATH = argOf('perf', 'artifacts/performance.json');
/**
 * `--bundle-only` checks what the BUILD REPORT alone can prove.
 *
 * CI builds on every pull request but does not drive a browser in that
 * job, so the weight budgets — the ones a careless import breaks — are
 * enforced there, and the latency and shape budgets are enforced by the
 * browser gate, which produces the measurements they need. Neither set
 * is optional; they run in the job that can actually measure them.
 */
const BUNDLE_ONLY = process.argv.includes('--bundle-only');
const measuredFromBuild = {};

/**
 * The page sizes the product enforces. Mirrored here deliberately: if
 * somebody raises `DESK_PAGE_SIZE` these budgets should be a
 * conversation, not a silent adjustment.
 */
const DESK_PAGE_SIZE = 50;
const DEAL_ROOM_MESSAGE_LIMIT = 100;

/**
 * The budgets.
 *
 * `measured` records what the value actually was when the budget was
 * set, so a future reader can see the headroom rather than guess at it.
 */
const BUDGETS = {
  /* ---- What every visitor downloads ---- */
  sharedJsKb: { limit: 130, measured: 103, why: 'shared First Load JS across all routes' },
  largestRouteKb: {
    limit: 170,
    measured: 134,
    why: 'heaviest route First Load JS (/app/deal/[dealId])',
  },

  /* ---- Public surfaces, built server ---- */
  landingLoadMs: { limit: 900, measured: 145, why: 'landing page load, next start' },
  loginLoadMs: { limit: 900, measured: 153, why: 'login page load, next start' },
  quoteMs: { limit: 500, measured: 72, why: 'calculator recompute after typing an amount' },
  landingCls: { limit: 0.1, measured: 0, why: 'cumulative layout shift, landing' },
  loginCls: { limit: 0.1, measured: 0, why: 'cumulative layout shift, login' },

  /* ---- Authenticated surfaces ---- */
  dealsListLoadMs: { limit: 900, measured: 145, why: 'the deals list' },
  dealRoomLoadMs: { limit: 900, measured: 147, why: 'the deal room, ordinary transcript' },

  /* ---- Operator surfaces, quiet desk ---- */
  opsQueueLoadMs: { limit: 900, measured: 150, why: 'Deal Desk, quiet queue' },
  opsFilteredLoadMs: { limit: 900, measured: 149, why: 'Deal Desk, filtered view' },
  opsCaseLoadMs: { limit: 900, measured: 149, why: 'one operator case' },

  /*
   * ---- The same surfaces UNDER A BACKLOG ----
   *
   * Measured with ~200 open deals and a full page of transcript. The
   * headroom is wider than for a quiet page because the fixture size is
   * what it is: what these guard is the SHAPE of the growth, not a
   * millisecond.
   */
  opsQueueBacklogMs: {
    limit: 1500,
    measured: 214,
    why: `Deal Desk with a multi-page backlog`,
  },
  opsFilteredBacklogMs: {
    limit: 1500,
    measured: 219,
    why: 'Deal Desk, filtered, with a multi-page backlog',
  },
  opsSecondPageMs: { limit: 1500, measured: 214, why: 'the second page of the desk' },
  dealRoomBusyMs: { limit: 1500, measured: 178, why: 'deal room with a full transcript' },
};

/**
 * Shape budgets: what the page RENDERED, not how fast it did it.
 *
 * A machine cannot make these pass by being quick.
 */
const SHAPE = {
  opsQueueRenderedRows: {
    limit: DESK_PAGE_SIZE,
    why: `the desk renders at most one page of ${DESK_PAGE_SIZE} rows, whatever the backlog`,
  },
  dealRoomRenderedMessages: {
    limit: DEAL_ROOM_MESSAGE_LIMIT,
    why: `the room renders at most ${DEAL_ROOM_MESSAGE_LIMIT} messages, however long the dispute`,
  },
};

/**
 * The backlog these were measured against. A shape budget passes
 * trivially if the fixture never ran, so the fixture size is itself a
 * budget — a floor rather than a ceiling.
 */
const MIN_BACKLOG_OPEN_DEALS = DESK_PAGE_SIZE * 2;

const problems = [];
const note = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label} — ${detail}`);
  if (!ok) problems.push(label);
};

/* ---- Bundle sizes, read from the build report ---- */

function chunkNote() {
  const dir = '.next/static/chunks';
  if (!existsSync(dir)) return null;
  let total = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isFile() && f.endsWith('.js')) total += statSync(p).size;
  }
  return Math.round(total / 1024);
}

console.log('performance budgets (measured thresholds, no SLA claim)\n');

const onDisk = chunkNote();
if (onDisk) console.log(`  note: ${onDisk} kB of client chunks on disk (uncompressed)`);

/*
 * Bundle figures come from the BUILD REPORT, not from adding up files on
 * disk: `.next/static/chunks` includes every route's chunk plus build
 * artefacts, so summing it measures something nobody downloads.
 */
const buildLog = argOf('build', 'artifacts/build.txt');
if (buildLog && existsSync(buildLog)) {
  const text = readFileSync(buildLog, 'utf8');
  const shared = /First Load JS shared by all\s+([\d.]+)\s*kB/.exec(text);
  if (shared) measuredFromBuild.sharedJsKb = Math.round(Number(shared[1]));

  /*
   * Every route line ends with its First Load JS; the budget guards the
   * heaviest, because that is what the worst-off visitor downloads.
   *
   * ⚠ `┌` is in the set. It was not, so the FIRST route in the table —
   * the landing page, the one most people actually hit — was silently
   * excluded from the "heaviest route" figure.
   */
  const routes = [...text.matchAll(/^[┌├└]\s+[ƒ○●]\s+\S+\s+[\d.]+\s*kB\s+([\d.]+)\s*kB/gm)].map(
    (m) => Number(m[1]),
  );
  if (routes.length > 0) {
    measuredFromBuild.largestRouteKb = Math.round(Math.max(...routes));
    console.log(`  note: ${routes.length} routes in the build report`);
  }
} else {
  console.error(`\nno build report at ${buildLog} — run the production build first.`);
  process.exit(1);
}

/* ---- Browser measurements ---- */

if (BUNDLE_ONLY) {
  console.log('\nweight, from the build report');
  for (const key of ['sharedJsKb', 'largestRouteKb']) {
    const budget = BUDGETS[key];
    const value = measuredFromBuild[key];
    if (value === undefined) note(false, key, 'not present in the build report');
    else note(value <= budget.limit, key, `${value} ≤ ${budget.limit} · ${budget.why}`);
  }
  console.log('');
  if (problems.length > 0) {
    console.error(`${problems.length} budget(s) exceeded: ${problems.join(', ')}`);
    process.exit(1);
  }
  console.log('every weight budget is within its limit');
  console.log('latency and shape budgets run in the browser gate, which measures them.');
  process.exit(0);
}

if (!existsSync(PERF_PATH)) {
  console.error(`\nno measurements at ${PERF_PATH} — run scripts/browser-gate.mjs first.`);
  process.exit(1);
}
const measured = { ...JSON.parse(readFileSync(PERF_PATH, 'utf8')), ...measuredFromBuild };

console.log('\nlatency and weight');
for (const [key, budget] of Object.entries(BUDGETS)) {
  const value = measured[key];
  if (value === undefined) {
    // A budget with nothing to measure is not a pass.
    note(false, key, `no measurement present (budget ${budget.limit})`);
    continue;
  }
  note(value <= budget.limit, key, `${value} ≤ ${budget.limit} · ${budget.why}`);
}

console.log('\nthe backlog those were measured against');
const backlog = measured.backlogOpenDeals;
note(
  typeof backlog === 'number' && backlog >= MIN_BACKLOG_OPEN_DEALS,
  'backlogOpenDeals',
  `${backlog ?? 'none'} ≥ ${MIN_BACKLOG_OPEN_DEALS} · a shape budget measured against an empty queue proves nothing`,
);

console.log('\nshape: what the page rendered');
for (const [key, budget] of Object.entries(SHAPE)) {
  const value = measured[key];
  if (value === undefined) {
    note(false, key, `no measurement present (budget ${budget.limit})`);
    continue;
  }
  note(value <= budget.limit, key, `${value} ≤ ${budget.limit} · ${budget.why}`);
}

console.log('');
if (problems.length > 0) {
  console.error(`${problems.length} budget(s) exceeded: ${problems.join(', ')}`);
  console.error('If the change is deliberate, raise the budget AND record the new measurement.');
  process.exit(1);
}
console.log('every measured value is within its budget');
