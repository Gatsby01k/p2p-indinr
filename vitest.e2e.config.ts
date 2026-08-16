import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Fixtures and assertions that support the REAL BROWSER run.
 *
 * Kept out of `vitest.integration.config.ts` deliberately: these files
 * seed named, fixed identities that the browser journeys sign in as, so
 * they are run on demand before a browser session rather than as part of
 * the ordinary suite — which owns its fixtures and must not depend on
 * anybody having run this first.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/e2e/**/*.test.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(
        new URL('./tests/integration/support/server-only-stub.ts', import.meta.url),
      ),
    },
  },
});
