import 'server-only';
import { withTransaction, type Tx } from '@/server/db/pool';

/**
 * The rail-request outbox: retry-safe calls to the outside world.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE PROBLEM THIS SOLVES IS NOT "THE CALL MIGHT FAIL".             │
 * │                                                                    │
 * │  It is that a call can SUCCEED while the transaction that made it  │
 * │  rolls back. Then the provider has moved money and the database    │
 * │  has no record of asking — the one inconsistency that cannot be    │
 * │  repaired by retrying, because retrying does it twice.             │
 * │                                                                    │
 * │  So the INTENTION to call is committed first, with a stable        │
 * │  idempotency key, and the call happens afterwards outside any      │
 * │  transaction. If the worker dies mid-call, the row is still        │
 * │  PENDING and the retry goes out with the SAME key, which the       │
 * │  provider deduplicates. At-least-once delivery plus a stable key   │
 * │  is exactly-once effect — and that is why the key is stored rather │
 * │  than generated at call time.                                      │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * This is NOT the DEL-09 domain-event dispatcher. That one publishes
 * `sandbox.outbox_event` to the outside world. This one performs
 * provider operations, and the two have different failure semantics:
 * a dropped domain event is a missed notification, a dropped payout is
 * a missing payment.
 */

export interface RailRequest {
  readonly requestId: string;
  readonly intentId: string;
  readonly providerKey: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
}

/**
 * Enqueue a provider call inside the caller's transaction.
 *
 * The idempotency key is derived by the CALLER from durable facts (the
 * intent id, the operation), never from a random value — a random key
 * regenerated on retry is the same as having no key at all.
 */
export async function enqueueRailRequest(
  tx: Tx,
  input: {
    readonly intentId: string;
    readonly providerKey: string;
    readonly operation: string;
    readonly idempotencyKey: string;
    readonly payload?: Record<string, unknown>;
  },
): Promise<string | null> {
  const { rows } = await tx.query(
    `INSERT INTO sandbox.rail_request
       (intent_id, provider_key, operation, idempotency_key, payload)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING request_id`,
    [
      input.intentId,
      input.providerKey,
      input.operation,
      input.idempotencyKey,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  // `null` means this exact call was already enqueued. Not an error: it
  // is the deduplication working.
  return (rows[0]?.request_id as string | undefined) ?? null;
}

/**
 * Exponential backoff, in seconds: 2, 4, 8, 16, 32.
 *
 * A fixed short retry against a provider having a bad minute turns one
 * outage into a self-inflicted flood, and providers rate-limit exactly
 * the callers who do that.
 */
function backoffSeconds(attempts: number): number {
  return Math.min(2 ** Math.max(1, attempts), 300);
}

/**
 * Lease and perform due requests.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes this safe to run in more than
 * one process: each worker takes rows nobody else holds, rather than all
 * of them queueing on the same head-of-line row.
 *
 * The handler runs OUTSIDE the leasing transaction. Holding a transaction
 * open across a network call to a third party is how a slow provider
 * becomes a database incident.
 */
export async function runRailRequests(
  handler: (request: RailRequest) => Promise<void>,
  options: { readonly limit?: number } = {},
): Promise<{ readonly attempted: number; readonly succeeded: number; readonly failed: number }> {
  const limit = options.limit ?? 20;

  const leased = await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT request_id, intent_id, provider_key, operation, idempotency_key,
              payload, attempts
         FROM sandbox.rail_request
        WHERE state = 'PENDING' AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    if (rows.length > 0) {
      // Push the next attempt out before releasing the row, so a crash
      // between here and the call does not spin.
      await tx.query(
        `UPDATE sandbox.rail_request
            SET attempts = attempts + 1,
                next_attempt_at = now() + make_interval(secs => $2)
          WHERE request_id = ANY($1::uuid[])`,
        [rows.map((r) => r.request_id), backoffSeconds(1)],
      );
    }
    return rows.map(
      (r): RailRequest => ({
        requestId: r.request_id as string,
        intentId: r.intent_id as string,
        providerKey: r.provider_key as string,
        operation: r.operation as string,
        idempotencyKey: r.idempotency_key as string,
        payload: r.payload as Record<string, unknown>,
        attempts: (r.attempts as number) + 1,
      }),
    );
  });

  let succeeded = 0;
  let failed = 0;

  for (const request of leased) {
    try {
      await handler(request);
      await withTransaction((tx) =>
        tx.query(
          `UPDATE sandbox.rail_request
              SET state='SUCCEEDED', completed_at=now(), last_error=NULL
            WHERE request_id=$1 AND state='PENDING'`,
          [request.requestId],
        ),
      );
      succeeded += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      await withTransaction((tx) =>
        tx.query(
          /*
           * Give up only at `max_attempts`. A permanently FAILED request
           * is left for an operator rather than retried forever: a payout
           * that has failed five times is not a transient problem, and
           * retrying it a sixth time hides that from whoever needs to
           * know.
           */
          `UPDATE sandbox.rail_request
              SET last_error = $2,
                  next_attempt_at = now() + make_interval(secs => $3),
                  state = CASE WHEN attempts >= max_attempts THEN 'FAILED'::sandbox.rail_request_state
                               ELSE 'PENDING'::sandbox.rail_request_state END,
                  completed_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
            WHERE request_id = $1 AND state = 'PENDING'`,
          [request.requestId, message.slice(0, 500), backoffSeconds(request.attempts)],
        ),
      );
    }
  }

  return { attempted: leased.length, succeeded, failed };
}
