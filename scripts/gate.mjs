#!/usr/bin/env node
/**
 * The complete DEL-10 gate: one command, one exit code.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  EVERY GATE, IN ORDER, AND NOTHING SKIPPED SILENTLY.             │
 * │                                                                  │
 * │  static · unit · manifests · mutations · secrets · integration   │
 * │  · migration convergence · production build · browser gate       │
 * │  · performance budgets · recovery drill · upgrade drill          │
 * │  · dependency audit · staging rehearsal                          │
 * │                                                                  │
 * │  Each stage prints a line and the run exits non-zero on the      │
 * │  first failure that matters, with the failing output kept. There │
 * │  is no stage that warns and continues.                           │
 * │                                                                  │
 * │  ⚠ WHY SOME STAGES RUN FROM A STAGED COPY.                       │
 * │                                                                  │
 * │  This checkout's directory name contains `#`. Both `next build`  │
 * │  (through `@vercel/nft`) and `vitest` (through `vite-node`)      │
 * │  corrupt a path containing one and fail on it — reproducibly,    │
 * │  in vendored tooling, with nothing to do with this application.  │
 * │  `buildRoot()` mirrors the tree to a `#`-free path with APFS     │
 * │  clones and those stages run there, byte-identical. On any       │
 * │  ordinary checkout — CI included — `buildRoot()` IS the project  │
 * │  and nothing is copied.                                          │
 * └──────────────────────────────────────────────────────────────────┘
 *
 *   node scripts/gate.mjs
 *   node scripts/gate.mjs --fast   (skips the two long drills)
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, buildRoot, needsStaging } from './e2e/stack.mjs';

const flag = (name) => process.argv.includes(`--${name}`);

const DEV_DB = process.env.GATE_DEV_DATABASE_URL ?? 'postgres://inrp2p_sandbox:sandbox-local-only@127.0.0.1:55433/inrp2p_sandbox';

const results = [];
const lines = [];
function say(text) {
  console.log(text);
  lines.push(text);
}

function stage(name, command, args, options = {}) {
  const started = Date.now();
  process.stdout.write(`── ${name}\n`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const ok = result.status === 0;
  results.push({ name, ok, seconds, tail: out.trim().split('\n').slice(-4).join(' · ') });
  say(`   ${ok ? 'ok  ' : 'FAIL'} ${name} (${seconds}s)`);
  if (!ok) {
    say(out.trim().split('\n').slice(-25).join('\n'));
  }
  return ok;
}

const started = Date.now();
say(`INRP2P — complete gate · ${new Date().toISOString()}`);
if (needsStaging()) {
  say(`build and test stages run from ${buildRoot()} (project path contains "#")`);
}
say('');

/* ---- Static ------------------------------------------------------ */
stage('format', 'npx', ['prettier', '--check', 'src/**/*.{ts,tsx,css}', 'tests/**/*.{ts,tsx}']);
stage('lint', 'npx', ['eslint', '.']);
stage('types', 'npx', ['tsc', '--noEmit']);

/* ---- Tests ------------------------------------------------------- */
const staged = buildRoot();
stage('unit tests', 'npx', ['vitest', 'run'], { cwd: staged });

/* ---- Manifests and structural validators ------------------------- */
stage('coverage manifest', process.execPath, ['scripts/manifest-check.mjs']);
stage('outbox manifest', process.execPath, ['scripts/outbox-manifest.mjs']);
stage('mutation surface', process.execPath, ['scripts/mutation-surface.mjs']);
stage('secret scan', process.execPath, ['scripts/secret-scan.mjs']);
stage('schema check', process.execPath, ['scripts/check-schema.mjs'], {
  env: { DATABASE_URL: DEV_DB },
});
stage('boundary contracts', process.execPath, ['scripts/boundary-contracts.mjs']);

/* ---- Integration, against the development cluster ---------------- */
stage('integration tests', 'npx', ['vitest', 'run', '--config', 'vitest.integration.config.ts'], {
  cwd: staged,
  env: { DATABASE_URL: DEV_DB },
});

/* ---- Migrations -------------------------------------------------- */
stage('migration convergence', process.execPath, ['scripts/migration-convergence.mjs'], {
  env: { DATABASE_URL: DEV_DB },
});
stage('upgrade drill from the DEL-08 baseline', process.execPath, ['scripts/upgrade-drill.mjs'], {
  env: {
    SANDBOX_PG_DIR: '.sandbox-db-upgrade',
    SANDBOX_PG_PORT: '55441',
    DATABASE_URL: 'postgres://inrp2p_sandbox:sandbox-local-only@127.0.0.1:55441/inrp2p_sandbox',
  },
});

/* ---- Recovery ---------------------------------------------------- */
stage('recovery drill', process.execPath, ['scripts/recovery-drill.mjs'], {
  env: { DRILL_SOURCE_URL: DEV_DB },
});

/* ---- Supply chain ------------------------------------------------ */
stage('production dependency audit', 'npm', ['audit', '--omit=dev', '--audit-level=high']);
stage('full dependency audit', 'npm', ['audit', '--audit-level=high']);
stage('SBOM', process.execPath, ['scripts/sbom.mjs']);

/* ---- The built application --------------------------------------- *
 *
 * The browser gate builds, starts an isolated PostgreSQL, runs
 * `next start` and drives it. It produces `artifacts/build.txt` and
 * `artifacts/performance.json`, so the budgets run immediately after it
 * and against what it just measured.
 */
stage('browser gate against the built server', process.execPath, ['scripts/browser-gate.mjs', '--fresh-db']);
stage('performance budgets', process.execPath, [
  'scripts/performance-budget.mjs',
  '--build',
  'artifacts/build.txt',
]);

/* ---- The rehearsal ----------------------------------------------- */
if (flag('fast')) {
  say('   ..   staging rehearsal skipped by --fast');
} else {
  stage('eleven-step staging rehearsal', process.execPath, ['scripts/staging-rehearsal.mjs']);
}

/* ================================================================== */

const failed = results.filter((r) => !r.ok);
const total = Math.round((Date.now() - started) / 1000);
say('');
say(`${results.length - failed.length}/${results.length} gates passed in ${total}s`);
if (failed.length > 0) {
  say('');
  say('failed:');
  for (const f of failed) say(`  ${f.name} — ${f.tail}`);
}

mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
writeFileSync(join(ROOT, 'artifacts', 'gate.log'), `${lines.join('\n')}\n`);
say(`\ntranscript: artifacts/gate.log`);

process.exit(failed.length === 0 ? 0 : 1);
