import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Integration tests run against the REAL sandbox PostgreSQL server in a Node
 * environment (no jsdom), single-threaded so that concurrency inside a test is
 * genuine rather than competing with parallel test files for connections.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/integration/**/*.test.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    /*
     * Every test runs inside an environment snapshot. Ten files flip the
     * deployment mode to prove production fails closed, and they share
     * one `process.env` because they share one fork — so a failing
     * assertion used to leave the rest of the run in production mode and
     * scatter unrelated failures across other files.
     */
    setupFiles: ['./tests/integration/support/env-guard.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      /**
       * The 16-way race holds one connection per in-flight joiner while they
       * queue on `SELECT ... FOR UPDATE`, so the pool must be at least as large
       * as the contention being simulated. At the default max of 10 the extra
       * joiners fail with a *connect timeout* rather than a wrong answer —
       * correctness is unaffected, availability is not — but a connect timeout
       * is not the outcome under test, so the pool is sized for the scenario.
       */
      PGPOOL_MAX: '24',
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Build-time-only guard; no runtime behaviour to reproduce here.
      'server-only': fileURLToPath(
        new URL('./tests/integration/support/server-only-stub.ts', import.meta.url),
      ),
    },
  },
});
