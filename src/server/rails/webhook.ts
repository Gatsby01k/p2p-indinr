import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { WEBHOOK_FRESHNESS_SECONDS, webhookSecretFor } from '@/server/adapters/railSecrets';

/**
 * Webhook authenticity.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A WEBHOOK URL IS PUBLIC. THE SIGNATURE IS THE ONLY THING THAT     │
 * │  DISTINGUISHES THE PROVIDER FROM ANYBODY ELSE ON THE INTERNET.     │
 * │                                                                    │
 * │  So three things are checked, and all three are necessary:         │
 * │                                                                    │
 * │  1. THE SIGNATURE, over `timestamp.body`. Signing the body alone   │
 * │     would let a captured request be replayed with a fresh          │
 * │     timestamp header, which defeats check 2 entirely.              │
 * │  2. THE TIMESTAMP, within a narrow window. A valid signature stays │
 * │     valid forever; freshness is what bounds the value of a         │
 * │     captured request.                                              │
 * │  3. THE EVENT ID, unique in the database. Freshness alone still    │
 * │     permits a replay inside the window, and 300 seconds is plenty  │
 * │     of time to send the same request twice.                        │
 * │                                                                    │
 * │  Comparison is constant-time. A byte-by-byte early return leaks    │
 * │  the expected signature one character at a time to anybody         │
 * │  willing to measure.                                               │
 * └────────────────────────────────────────────────────────────────────┘
 */

export type WebhookFailure =
  | 'SIGNATURE_MISSING'
  | 'SIGNATURE_MALFORMED'
  | 'SIGNATURE_INVALID'
  | 'TIMESTAMP_MISSING'
  | 'TIMESTAMP_MALFORMED'
  | 'TIMESTAMP_STALE'
  | 'TIMESTAMP_FUTURE'
  | 'BODY_MALFORMED';

export type WebhookVerification =
  | { readonly ok: true; readonly digest: Buffer; readonly eventAt: Date }
  | { readonly ok: false; readonly reason: WebhookFailure };

export interface SignedDelivery {
  readonly providerKey: string;
  /** The EXACT bytes received. Re-serialising before verifying breaks it. */
  readonly rawBody: string;
  readonly signatureHeader: string | null;
  readonly timestampHeader: string | null;
}

/** The signing input, defined once so signer and verifier cannot drift. */
function signingPayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/**
 * Produce a signature. Used by the sandbox provider simulator and by
 * tests — the same function the verifier checks against, so a test that
 * passes proves the verifier accepts genuine signatures rather than
 * proving two implementations happen to agree.
 */
export function signDelivery(providerKey: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', webhookSecretFor(providerKey))
    .update(signingPayload(timestamp, rawBody))
    .digest('hex');
}

export function verifyDelivery(delivery: SignedDelivery, now = new Date()): WebhookVerification {
  if (delivery.signatureHeader === null || delivery.signatureHeader.length === 0) {
    return { ok: false, reason: 'SIGNATURE_MISSING' };
  }
  if (delivery.timestampHeader === null || delivery.timestampHeader.length === 0) {
    return { ok: false, reason: 'TIMESTAMP_MISSING' };
  }
  if (!/^[0-9a-f]{64}$/i.test(delivery.signatureHeader)) {
    return { ok: false, reason: 'SIGNATURE_MALFORMED' };
  }
  if (!/^[0-9]{1,15}$/.test(delivery.timestampHeader)) {
    return { ok: false, reason: 'TIMESTAMP_MALFORMED' };
  }

  const eventAt = new Date(Number(delivery.timestampHeader) * 1000);
  const skewSeconds = (now.getTime() - eventAt.getTime()) / 1000;
  if (skewSeconds > WEBHOOK_FRESHNESS_SECONDS) return { ok: false, reason: 'TIMESTAMP_STALE' };
  // A timestamp from the future is not a clock problem to tolerate; it is
  // the shape of an attacker extending a captured event's usable life.
  if (skewSeconds < -WEBHOOK_FRESHNESS_SECONDS) return { ok: false, reason: 'TIMESTAMP_FUTURE' };

  const expected = Buffer.from(
    signDelivery(delivery.providerKey, delivery.timestampHeader, delivery.rawBody),
    'hex',
  );
  const received = Buffer.from(delivery.signatureHeader, 'hex');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: 'SIGNATURE_INVALID' };
  }

  return {
    ok: true,
    digest: createHash('sha256').update(delivery.rawBody).digest(),
    eventAt,
  };
}
