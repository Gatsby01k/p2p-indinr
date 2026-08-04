/**
 * Environment capability gate.
 *
 * UX-01 §2.1 (scenario isolation): synthetic scenarios exist only to make every
 * UI state reachable during development, automated tests and Storybook. They
 * are a **build-time capability**, not a runtime feature flag, so a production
 * bundle cannot be coerced into rendering a fake deal state by any URL.
 *
 * `NEXT_PUBLIC_ALLOW_SCENARIOS` must never be set to `true` in a production
 * deployment. The default is closed: anything other than the literal string
 * `'true'` disables scenarios entirely.
 */

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const IS_TEST = process.env.NODE_ENV === 'test';
const OPT_IN = process.env.NEXT_PUBLIC_ALLOW_SCENARIOS === 'true';

/**
 * True only where synthetic scenarios are permitted.
 *
 * Production is hard-denied regardless of the opt-in flag: a mis-set
 * environment variable in a production deploy must not be able to re-enable
 * scenario spoofing.
 */
export const SCENARIOS_ENABLED: boolean = IS_TEST || (!IS_PRODUCTION && OPT_IN);

/**
 * True when the app is running against the mock adapter rather than a
 * money-authoritative backend. Drives the mandatory `MockNotice` chrome.
 */
export const USING_MOCK_SERVICES: boolean = process.env.NEXT_PUBLIC_USE_MOCKS !== 'false';
