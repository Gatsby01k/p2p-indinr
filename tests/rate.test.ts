/**
 * Link lifetimes.
 *
 * These guard a defect that made the product unusable rather than merely
 * awkward: a deal link expired 30 minutes after creation, so anyone who
 * forwarded one into a chat and had it read later was told to "ask the
 * sender". The core motion of the product — create, share, someone joins —
 * failed for everybody who was not watching their phone.
 *
 * The two windows differ on purpose, so both are pinned here.
 */
import { describe, expect, it } from 'vitest';
import {
  CONFIRM_WINDOW_MINUTES,
  LINK_TTL_SECONDS_EXCHANGE,
  LINK_TTL_SECONDS_PROTECTED,
  PAYMENT_WINDOW_MINUTES,
  linkTtlSeconds,
} from '@/lib/rate';

const HOUR = 60 * 60;

describe('a shared link outlives the message carrying it', () => {
  it('gives a protected payment a week', () => {
    // No rate is frozen, so nothing decays and the only constraint is how
    // long a message realistically waits to be read.
    expect(linkTtlSeconds('INR_TO_INR')).toBe(LINK_TTL_SECONDS_PROTECTED);
    expect(LINK_TTL_SECONDS_PROTECTED).toBe(7 * 24 * HOUR);
  });

  it('gives an exchange a day, because it is holding a price', () => {
    // Honouring a frozen rate indefinitely is a donation, not a feature.
    for (const scenario of ['INR_TO_USDT', 'USDT_TO_INR'] as const) {
      expect(linkTtlSeconds(scenario)).toBe(LINK_TTL_SECONDS_EXCHANGE);
    }
    expect(LINK_TTL_SECONDS_EXCHANGE).toBe(24 * HOUR);
  });

  it('never falls back to a window shorter than an hour', () => {
    // The regression this file exists for. Any value a person could miss
    // by stepping away from their phone is the bug, whatever the number.
    for (const scenario of ['INR_TO_INR', 'INR_TO_USDT', 'USDT_TO_INR'] as const) {
      expect(linkTtlSeconds(scenario)).toBeGreaterThanOrEqual(HOUR);
    }
  });
});

describe('action windows fit the task, not the demo', () => {
  it('allows time to leave the app and make a bank transfer', () => {
    // Fifteen minutes assumed both people were already at their phones;
    // a real transfer means another app and possibly an OTP.
    expect(PAYMENT_WINDOW_MINUTES).toBeGreaterThanOrEqual(60);
  });

  it('allows time to check an account and confirm', () => {
    expect(CONFIRM_WINDOW_MINUTES).toBeGreaterThanOrEqual(60);
  });
});
