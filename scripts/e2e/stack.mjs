/**
 * The production stack the gate and the rehearsal both run against.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  `next dev` IS NOT THE PRODUCT.                                  │
 * │                                                                  │
 * │  A development server injects a `<nextjs-portal>` element and an │
 * │  error overlay into every page, compiles routes on first request │
 * │  while the harness is already waiting on them, and serves an     │
 * │  unminified, differently-chunked bundle. Every one of those      │
 * │  shows up as a browser result that is about the dev server       │
 * │  rather than about the application: a phantom accessibility      │
 * │  finding on an element nobody ships, an aborted navigation       │
 * │  during a recompile, a load time that measures compilation.      │
 * │                                                                  │
 * │  So the gate builds the real thing and runs `next start`. The    │
 * │  overlay is not exempted anywhere — it is simply absent, and     │
 * │  `assertNoDevArtefacts` fails the run if it ever is not.         │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * Everything here is deliberately reusable: the eleven-step staging
 * rehearsal starts and stops the same stack, so a green gate and a green
 * rehearsal are talking about the same processes.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The gate's own cluster, on its own port, in its own directory.
 *
 * Not the development database. A gate that shares fixtures with the
 * integration suite reports whichever ran last.
 */
export const GATE_PG_PORT = Number(process.env.GATE_PG_PORT ?? 55450);
export const GATE_PG_DIR = process.env.GATE_PG_DIR ?? '.sandbox-db-gate';
export const GATE_DATABASE_URL =
  process.env.GATE_DATABASE_URL ??
  `postgres://inrp2p_sandbox:sandbox-local-only@127.0.0.1:${GATE_PG_PORT}/inrp2p_sandbox`;

export const GATE_PORT = Number(process.env.GATE_PORT ?? 3210);
export const GATE_BASE = `http://127.0.0.1:${GATE_PORT}`;

/** Every server this module starts logs here; sign-in codes are read from it. */
export const GATE_LOG = process.env.GATE_LOG ?? join(ROOT, 'artifacts', 'server.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function step(label) {
  console.log(`\n── ${label}`);
}

/* ------------------------------------------------------------------ *
 * Environment
 * ------------------------------------------------------------------ */

/**
 * The environment a staging process runs with.
 *
 * `INRP2P_MODE=staging` and NOT `production`, stated once here rather
 * than left to a default. Production refuses to start without six real
 * secrets and without production adapters, correctly — this machine has
 * none of them, and faking them to get a green run would test the
 * fakes. Staging exercises the same build, the same server and the same
 * fail-closed code paths against the sandbox adapters, and
 * `INRP2P_SANDBOX=true` is the explicit acknowledgement that says so.
 */
export function stagingEnv(overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: 'production',
    INRP2P_MODE: 'staging',
    INRP2P_SANDBOX: 'true',
    DATABASE_URL: GATE_DATABASE_URL,
    NEXT_TELEMETRY_DISABLED: '1',
    // The harness signs Telegram launches with the same token the server
    // verifies against. It is a test value and it is not a secret: no
    // real bot exists for it, and nothing it authenticates is real.
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? 'test-bot-token-for-verification-only',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Database
 * ------------------------------------------------------------------ */

function db(command, env = {}) {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'db.mjs'), command], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      SANDBOX_PG_DIR: GATE_PG_DIR,
      SANDBOX_PG_PORT: String(GATE_PG_PORT),
      DATABASE_URL: GATE_DATABASE_URL,
      ...env,
    },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`db.mjs ${command} exited ${result.status}`);
  }
  return result.stdout ?? '';
}

/** Start the gate's cluster and migrate it to head. */
export function startDatabase({ fresh = false } = {}) {
  if (fresh && existsSync(join(ROOT, GATE_PG_DIR))) {
    db('stop');
    rmSync(join(ROOT, GATE_PG_DIR), { recursive: true, force: true });
  }
  return db('start');
}

export function migrateDatabase() {
  return db('migrate');
}

export function stopDatabase() {
  try {
    db('stop');
  } catch {
    // A cluster that is already down is the state we wanted.
  }
}

/* ------------------------------------------------------------------ *
 * Where the build runs
 * ------------------------------------------------------------------ */

/**
 * A build root Next's file tracer can actually walk.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  THIS CHECKOUT LIVES IN A DIRECTORY WHOSE NAME CONTAINS `#`.     │
 * │                                                                  │
 * │  `next build` runs `@vercel/nft` to collect build traces, and    │
 * │  that step corrupts a path containing `#` — it hands `readlink`  │
 * │  a string with a NUL byte spliced in where the `#` is and dies:  │
 * │                                                                  │
 * │    TypeError: The argument 'path' must be a string, Uint8Array,  │
 * │    or URL without null bytes. Received                           │
 * │    '…/inrp2p \x00#1 fintech india/node_modules/next/dist/…'      │
 * │                                                                  │
 * │  It is reproducible, it is in the bundler's vendored tracer, and │
 * │  it has nothing whatever to do with this application: the same   │
 * │  bytes build cleanly one directory up. CI is unaffected — a      │
 * │  checkout there is `…/inrp2p`, with no `#` in it.                │
 * │                                                                  │
 * │  So when — and ONLY when — the project path contains a character │
 * │  known to break the tracer, the build runs from a staged copy at │
 * │  a safe path. The copy is made with APFS clones, so it is a      │
 * │  couple of seconds and near-zero disk, and the SOURCE is         │
 * │  byte-identical: nothing is transformed, excluded or stubbed.    │
 * │  `next start` then serves that same build, so the browser gate   │
 * │  is talking to the artefact the build produced.                  │
 * └──────────────────────────────────────────────────────────────────┘
 */
const TRACER_HOSTILE = /[#?]/;

/** Everything the build needs. `.next`, `.git` and artefacts stay put. */
const STAGED = [
  'src',
  'public',
  'db',
  'scripts',
  'tests',
  'next.config.ts',
  'tsconfig.json',
  'package.json',
  'package-lock.json',
  'postcss.config.mjs',
  'eslint.config.mjs',
  'next-env.d.ts',
  // The test configs carry the `@/` alias, so the suites resolve exactly
  // as they do in the working tree.
  'vitest.config.ts',
  'vitest.integration.config.ts',
  'vitest.e2e.config.ts',
  'vitest.rehearsal.config.ts',
  '.prettierrc.json',
];

export const STAGE_DIR =
  process.env.GATE_STAGE ?? join(process.env.TMPDIR ?? '/tmp', 'inrp2p-gate-stage');

export const needsStaging = () => TRACER_HOSTILE.test(ROOT);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}\n${result.stderr ?? ''}`.trim(),
    );
  }
  return result.stdout ?? '';
}

/**
 * Sync the staged tree and return its path.
 *
 * `node_modules` is cloned once and then left alone — it is 636 MB and
 * the lockfile is what decides its contents, so re-copying it on every
 * run would cost minutes to reproduce a directory that did not change.
 * A changed lockfile re-clones it.
 */
export function buildRoot() {
  if (!needsStaging()) return ROOT;

  mkdirSync(STAGE_DIR, { recursive: true });
  const modules = join(STAGE_DIR, 'node_modules');
  const lock = join(STAGE_DIR, '.staged-lock-sha');
  const currentLock = readFileSync(join(ROOT, 'package-lock.json'));
  const stampedLock = existsSync(lock) ? readFileSync(lock) : null;

  if (!existsSync(modules) || stampedLock === null || !stampedLock.equals(currentLock)) {
    rmSync(modules, { recursive: true, force: true });
    // `-c` asks APFS for a clone: copy-on-write, so this is seconds and
    // costs no real disk until something diverges.
    try {
      run('cp', ['-Rc', join(ROOT, 'node_modules'), modules]);
    } catch {
      run('cp', ['-R', join(ROOT, 'node_modules'), modules]);
    }
    writeFileSync(lock, currentLock);
  }

  for (const entry of STAGED) {
    const from = join(ROOT, entry);
    if (!existsSync(from)) continue;
    // `rsync --delete` so a file deleted in the working tree is deleted
    // here too; a stale module left behind would be built into the
    // artefact the gate then measures. A directory needs the trailing
    // slash that means "the contents of"; a file must not have one.
    const source = statSync(from).isDirectory() ? `${from}/` : from;
    run('rsync', ['-a', '--delete', source, join(STAGE_DIR, entry)]);
  }
  return STAGE_DIR;
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

/**
 * Build the application exactly as a deployment would, keeping the
 * report.
 *
 * The route table it prints is the ONLY honest source for bundle-size
 * budgets: adding up `.next/static/chunks` counts every route's chunk
 * plus build artefacts, which is a number nobody downloads.
 */
export function buildProduction({ out = join(ROOT, 'artifacts', 'build.txt') } = {}) {
  mkdirSync(dirname(out), { recursive: true });
  const cwd = buildRoot();
  if (cwd !== ROOT) console.log(`  building from ${cwd} (project path contains "#")`);
  const result = spawnSync('npx', ['next', 'build'], {
    cwd,
    encoding: 'utf8',
    env: stagingEnv(),
    maxBuffer: 32 * 1024 * 1024,
  });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  // Synchronous: a failed build throws two lines below, and a stream that
  // had not flushed would leave the report empty at the one moment
  // somebody needs to read it.
  writeFileSync(out, text);
  if (result.status !== 0) {
    process.stderr.write(text);
    throw new Error(`next build exited ${result.status}`);
  }
  console.log(`  built — report in ${out}`);
  return text;
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

/**
 * Start `next start` and wait until READINESS says it may take traffic.
 *
 * Not "the port accepts a connection": a server that is listening but
 * whose database is unmigrated will serve a 500 to the first journey and
 * the harness would blame the journey. `/api/health/ready` is the same
 * check a load balancer would use.
 */
export async function startServer({
  port = GATE_PORT,
  log = GATE_LOG,
  env = {},
  label = 'web',
  timeoutMs = 90_000,
  /**
   * Wait for readiness before returning.
   *
   * The rehearsal turns this off for ONE case: a process started in
   * genuine production mode with no provider adapters, which is
   * SUPPOSED to serve 503 for ever. There, refusing to become ready is
   * the result being measured, so the caller waits for the port to
   * answer and reads the verdict itself.
   */
  waitForReady = true,
} = {}) {
  /*
   * ⚠ REFUSE TO START ON AN OCCUPIED PORT.
   *
   * Without this the gate has a silent, very expensive failure mode: a
   * leftover server from an earlier run still holds the port, the new
   * child dies with EADDRINUSE, the readiness probe is answered by the
   * STALE process — and the whole suite then runs against yesterday's
   * build and yesterday's log file, reporting failures that belong to
   * neither. Better to stop and say which port.
   */
  const occupied = await probeLive(`http://127.0.0.1:${port}`);
  if (occupied.reachable) {
    throw new Error(
      `port ${port} is already serving. Stop it before starting the gate, or set GATE_PORT.`,
    );
  }

  /*
   * ⚠ THE LOG IS A FILE DESCRIPTOR, NOT A PIPE THIS PROCESS DRAINS.
   *
   * The server's stdout is the sandbox MAILBOX — it is where sign-in
   * codes appear, and the harness reads them from it the way a person
   * reads an email. Piping it through this process made that mailbox
   * depend on this process's event loop, and the gate then runs the
   * harness with a BLOCKING `spawnSync`: for the entire run nothing was
   * drained, so every code the server printed sat in a pipe buffer and
   * arrived only at teardown. Every sign-in in the suite failed, and it
   * looked exactly like the application not sending them.
   *
   * Handing the child the descriptor makes the kernel do the writing.
   * Nothing this process does — blocking or otherwise — can delay it.
   */
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, 'a');
  writeSync(fd, `\n=== ${label} start ${new Date().toISOString()} port ${port} ===\n`);

  // Served from wherever the build landed: a `next start` in one tree
  // against a `.next` produced in another is a different application.
  const child = spawn('npx', ['next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: buildRoot(),
    env: stagingEnv({ PORT: String(port), ...env }),
    stdio: ['ignore', fd, fd],
  });

  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `${label} exited before becoming ready (code ${exited.code} signal ${exited.signal}); see ${log}`,
      );
    }
    const verdict = await probeReady(base);
    if (waitForReady ? verdict.ready : verdict.reachable) {
      console.log(`  ${label} ${waitForReady ? 'ready' : 'answering'} on ${base}`);
      return { child, port, base, log, label };
    }
    await sleep(400);
  }
  child.kill('SIGKILL');
  throw new Error(`${label} did not become ready within ${timeoutMs}ms; see ${log}`);
}

/** `{ reachable, ready, status }` — never throws. */
export async function probeReady(base) {
  try {
    const response = await fetch(`${base}/api/health/ready`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4_000),
    });
    const body = await response.json().catch(() => ({}));
    return { reachable: true, ready: body.ready === true, status: response.status, body };
  } catch {
    return { reachable: false, ready: false, status: 0, body: {} };
  }
}

export async function probeLive(base) {
  try {
    const response = await fetch(`${base}/api/health/live`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4_000),
    });
    return { reachable: true, status: response.status, body: await response.json() };
  } catch {
    return { reachable: false, status: 0, body: {} };
  }
}

/** Stop a server, waiting for the process to actually be gone. */
export async function stopServer(handle, { signal = 'SIGTERM' } = {}) {
  if (!handle?.child || handle.child.exitCode !== null) return;
  const ended = new Promise((r) => handle.child.once('exit', r));
  handle.child.kill(signal);
  const killer = setTimeout(() => handle.child.kill('SIGKILL'), 8_000);
  await ended;
  clearTimeout(killer);
}

/* ------------------------------------------------------------------ *
 * The dev-artefact assertion
 * ------------------------------------------------------------------ */

/**
 * Prove the page carries no development scaffolding.
 *
 * ⚠ THE POINT IS THAT NOTHING IS EXEMPTED.
 *
 * The previous run allowed `<nextjs-portal>` through the accessibility
 * rules because a dev server injects one. An exemption like that is
 * indistinguishable from a bug being waved past, and it would stay in
 * the rules long after the reason for it had gone. Running the built
 * application removes the element instead, and this check fails the run
 * if it, the error overlay, or the HMR socket ever reappears.
 */
export async function assertNoDevArtefacts(page) {
  return page.evaluate(() => {
    const found = [];
    if (document.querySelector('nextjs-portal')) found.push('nextjs-portal');
    if (document.querySelector('[data-nextjs-dialog], [data-nextjs-toast]')) {
      found.push('next-error-overlay');
    }
    if (document.querySelector('#__next-build-watcher')) found.push('build-watcher');
    /*
     * Only DEVELOPMENT-ONLY bundles count.
     *
     * `chunks/webpack-<hash>.js` is the production runtime and belongs
     * here; a build that shipped without it would be broken. What must
     * never appear is the Fast Refresh runtime, the unhashed dev
     * `webpack.js`, or anything served out of `static/development`.
     */
    for (const s of document.querySelectorAll('script[src]')) {
      const src = s.getAttribute('src') ?? '';
      if (
        /react-refresh/.test(src) ||
        /_next\/static\/development\//.test(src) ||
        /_next\/static\/chunks\/webpack\.js/.test(src) ||
        /webpack-hmr/.test(src)
      ) {
        found.push(src);
      }
    }
    return found;
  });
}

/** The tail of the server log, for a failure report. */
export function serverLogTail(lines = 60, log = GATE_LOG) {
  if (!existsSync(log)) return '';
  return readFileSync(log, 'utf8').split('\n').slice(-lines).join('\n');
}
