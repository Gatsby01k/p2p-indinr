/**
 * The boundary result vocabulary.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  AN EXPECTED REJECTION IS A VALUE, NOT AN EXCEPTION.               │
 * │                                                                    │
 * │  TS-02 §10 requires the non-raising boundary pattern, and the      │
 * │  reason is mechanical rather than stylistic. A rejection that      │
 * │  throws aborts its PostgreSQL transaction; every subsequent        │
 * │  statement on that connection then fails with 25P02, so the        │
 * │  rejection record cannot be written where it belongs. The previous │
 * │  implementation worked around this by writing rejection evidence   │
 * │  on a SEPARATE pooled connection inside a `catch` that only        │
 * │  logged — which meant a pool exhaustion, a network blip or a       │
 * │  restart silently destroyed the record of why somebody was         │
 * │  refused. That is precisely the record an operator needs.          │
 * │                                                                    │
 * │  Returning `Rejected` instead leaves the transaction healthy, so   │
 * │  the rejection audit is written and COMMITTED in the same          │
 * │  transaction as the decision. No domain write accompanies it,      │
 * │  because every guard runs before any mutation.                     │
 * │                                                                    │
 * │  Exceptions remain exceptions: an unexpected fault still throws,   │
 * │  still rolls back, and still leaves nothing behind.                │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Deliberately free of `server-only`, `pg` and framework imports: the
 * union is part of the application-service contract and is rendered by
 * client components.
 */

import type { SandboxError } from '@/lib/sandboxContract';

export interface Rejected {
  readonly ok: false;
  readonly code: SandboxError;
  /**
   * The exact sentence the first execution produced.
   *
   * Not always the `FAILURE_COPY` default: a ruling refuses with its own
   * validation wording, an oversized message names the limit. Because a
   * replay must return the ORIGINAL result rather than a reconstruction,
   * this string is stored on the command row and replayed verbatim.
   */
  readonly message: string;
  /** Stable structured data a caller may render or log. Replayed as stored. */
  readonly detail?: Record<string, unknown>;
}

export interface Accepted<T> {
  readonly ok: true;
  readonly value: T;
}

export type Outcome<T> = Accepted<T> | Rejected;

export function accept<T>(value: T): Accepted<T> {
  return { ok: true, value };
}

export function reject(
  code: SandboxError,
  message: string,
  detail?: Record<string, unknown>,
): Rejected {
  return detail === undefined ? { ok: false, code, message } : { ok: false, code, message, detail };
}

/** Narrowing helper, so callers do not re-test the discriminant by hand. */
export function isRejected<T>(outcome: Outcome<T>): outcome is Rejected {
  return outcome.ok === false;
}
