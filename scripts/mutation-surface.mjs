#!/usr/bin/env node
/**
 * Inventory every reachable mutation and prove each one is gated.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  THE FAILURE THIS CATCHES IS A NEW ACTION THAT FORGOT A GATE.    │
 * │                                                                  │
 * │  Every server action, route handler and worker entry point is a  │
 * │  door. A review finds the doors that exist today; this finds the │
 * │  one somebody adds next month without `requireUser`, without a   │
 * │  command id, or writing SQL directly instead of going through an │
 * │  accepted boundary.                                              │
 * │                                                                  │
 * │  It is deliberately MECHANICAL and slightly blunt. A check that  │
 * │  needs judgement is a check that gets waived; these are          │
 * │  structural facts about the source text, and a genuine exception │
 * │  is declared in `ALLOWED_PUBLIC` where a person had to write     │
 * │  down why.                                                       │
 * └──────────────────────────────────────────────────────────────────┘
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Mutations that legitimately run without a session, each with the
 * reason. Anything not on this list must authenticate.
 */
const ALLOWED_PUBLIC = {
  requestSignInCodeAction:
    'Sign-in itself. Rate-limited per address; reveals nothing about whether an account exists.',
  verifySignInCodeAction:
    'Presents a code to obtain a session. Rate-limited and constant-time compared.',
  signOutAction: 'Destroys the caller’s own session. Safe without one.',
  setTwoFactorAction:
    'A stub that mutates nothing: it returns the sentence explaining that the second factor is an authenticator app. Kept so the accepted screen compiles.',
  'api/telegram/auth':
    'Telegram launch verification. Authenticated by an HMAC over the initData, not by a session.',
};

/**
 * Mutations that are authorised by something OTHER than a user session,
 * and what that something is.
 */
const NON_SESSION_AUTH = {
  ingestRailEventCommand: 'Provider signature (HMAC + freshness + event-id uniqueness).',
  runOnce: 'Worker entry point. Runs under the worker role; claims by lease.',
  recoverStaleLeases: 'Worker maintenance. Touches only lease columns.',
};

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) out.push(path);
  }
  return out;
}

/** Split a file into top-level exported function bodies. */
function exportedFunctions(text) {
  const found = [];
  const re = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;
  const starts = [...text.matchAll(re)].map((m) => ({ name: m[1], at: m.index }));
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].at : text.length;
    found.push({ name: s.name, body: text.slice(s.at, end) });
  });
  return found;
}

const problems = [];
const surface = [];

/* ================= 1. Server actions ================= */

const actionFiles = walk('src').filter((f) => readFileSync(f, 'utf8').includes("'use server'"));

for (const file of actionFiles) {
  const text = readFileSync(file, 'utf8');
  for (const fn of exportedFunctions(text)) {
    if (!/Action$/.test(fn.name)) continue;

    /*
     * `requireCaller` is the DEL-03 helper that resolves the user, the
     * session AND the live principal together. It was missing from this
     * list on the first run and flagged six correctly-gated actions —
     * a validator that cries wolf gets waived, so the list is kept
     * exhaustive rather than representative.
     */
    const authenticated =
      /\brequireCaller\(|\brequireUser\(|\brequireOperator\(|\brequirePrincipal\(|\brequireSession\(/.test(
        fn.body,
      );
    const publicReason = ALLOWED_PUBLIC[fn.name];

    if (!authenticated && publicReason === undefined) {
      problems.push(
        `${file}: ${fn.name} has no authentication boundary and is not declared public`,
      );
    }

    /*
     * A mutation must not reach the database directly. Going through a
     * command or a service boundary is what supplies idempotency, the
     * audit row and the outbox event — a raw query in an action has
     * none of them.
     */
    if (/\bgetPool\(\)|\bwithTransaction\(/.test(fn.body)) {
      problems.push(`${file}: ${fn.name} touches the database directly instead of a boundary`);
    }

    // Errors must be funnelled, so a stack trace never reaches a client.
    if (!/catch\s*\(/.test(fn.body) && !/return\s+\{\s*ok:/.test(fn.body)) {
      problems.push(`${file}: ${fn.name} has no error boundary`);
    }

    surface.push({
      kind: 'server-action',
      name: fn.name,
      file,
      auth: authenticated ? 'session' : `public: ${publicReason}`,
      commandId: /commandId/.test(fn.body) ? 'yes' : 'n/a',
    });
  }
}

/* ================= 2. Route handlers ================= */

const routeFiles = walk('src/app').filter((f) => /\/route\.tsx?$/.test(f));

for (const file of routeFiles) {
  const text = readFileSync(file, 'utf8');
  const methods = [
    ...text.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g),
  ].map((m) => m[1]);
  const routeKey = file.replace(/^src\/app\//, '').replace(/\/route\.tsx?$/, '');

  const authenticated = /\brequireUser\(|\bresolveSession\(|\bcurrentUser\(/.test(text);
  const signatureAuth = /verifyTelegram|verifyDelivery|createHmac|timingSafeEqual/.test(text);
  const publicReason = ALLOWED_PUBLIC[routeKey];

  for (const method of methods) {
    const mutating = method !== 'GET';
    if (mutating && !authenticated && !signatureAuth && publicReason === undefined) {
      problems.push(`${file}: ${method} mutates without an authentication boundary`);
    }
    surface.push({
      kind: 'route',
      name: `${method} /${routeKey}`,
      file,
      auth: authenticated
        ? 'session'
        : signatureAuth
          ? 'signature'
          : `public: ${publicReason ?? '—'}`,
      commandId: /commandId/.test(text) ? 'yes' : 'n/a',
    });
  }
}

/* ================= 3. Worker entry points ================= */

for (const [name, reason] of Object.entries(NON_SESSION_AUTH)) {
  surface.push({ kind: 'non-session', name, file: '—', auth: reason, commandId: 'n/a' });
}

/* ================= 4. Direct SQL outside the server layer ================= */

for (const file of walk('src')) {
  if (file.startsWith('src/server/') || file.startsWith('src/services/')) continue;
  const text = readFileSync(file, 'utf8');
  if (/\bgetPool\(\)|\bwithTransaction\(/.test(text)) {
    problems.push(`${file}: database access outside the server layer`);
  }
}

/* ================= 5. Production imports of test fixtures ================= */

for (const file of walk('src')) {
  const text = readFileSync(file, 'utf8');
  if (/from\s+['"][^'"]*(?:__mocks__|\/fixtures?\/|\/mock|\.test)['"]/.test(text)) {
    problems.push(`${file}: production source imports a test fixture`);
  }
}

/* ================= Report ================= */

console.log(`mutation surface: ${surface.length} entries`);
const byKind = surface.reduce((acc, s) => ({ ...acc, [s.kind]: (acc[s.kind] ?? 0) + 1 }), {});
for (const [kind, count] of Object.entries(byKind)) console.log(`  ${kind}: ${count}`);

if (process.argv.includes('--list')) {
  console.log('');
  for (const s of surface.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    console.log(`  ${s.kind.padEnd(14)} ${s.name.padEnd(34)} auth=${s.auth}`);
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log('\nevery mutation has an authentication boundary and goes through a service boundary');
