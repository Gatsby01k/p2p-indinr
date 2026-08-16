import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * The staging rehearsal's typed steps.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A SEPARATE CONFIG, ON PURPOSE.                                    │
 * │                                                                    │
 * │  These are not integration tests and must not run with them. They  │
 * │  pause the platform, provision operators and orphan outbox leases  │
 * │  — deliberate, destructive-looking things that belong to a         │
 * │  rehearsal against a rehearsal cluster, not to a suite a developer │
 * │  runs against their own database on every change.                  │
 * │                                                                    │
 * │  `scripts/staging-rehearsal.mjs` is the only caller, and it points │
 * │  `DATABASE_URL` at the cluster it created for this run.            │
 * └────────────────────────────────────────────────────────────────────┘
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/rehearsal/**/*.test.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 60_000,
    hookTimeout: 60_000,
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
