import 'server-only';
import { randomUUID } from 'node:crypto';
import { getPool, withTransaction } from '@/server/db/pool';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { denialFor, type Principal } from '@/server/identity/rbac';

/**
 * The outbox dispatcher.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  DUPLICATE DELIVERY IS EXPECTED. DUPLICATE EFFECT IS NOT.          │
 * │                                                                    │
 * │  At-least-once is the only delivery guarantee a system like this   │
 * │  can honestly offer: a worker can crash after the handler          │
 * │  succeeded and before the row was marked. So the guarantee that    │
 * │  matters is that a REPEATED delivery changes nothing — and that    │
 * │  property lives in the handlers and in the boundaries they call,   │
 * │  every one of which has been keyed since DEL-02.                   │
 * │                                                                    │
 * │  This dispatcher publishes NOTHING to the outside world, because   │
 * │  no notification provider is configured. It runs the registered    │
 * │  handlers, marks delivery, and dead-letters what will not succeed. │
 * │  A fake email provider would be worse than none: it would make an  │
 * │  undelivered notification look delivered.                          │
 * └────────────────────────────────────────────────────────────────────┘
 */

export interface OutboxEvent {
  readonly outboxId: string;
  readonly eventKey: string;
  readonly eventType: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly correlationId: string;
}

export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

/** How long a worker holds a claimed event before the lease lapses. */
export const LEASE_SECONDS = 60;

/** Per-event ceiling. A handler that hangs must not hold a lease forever. */
export const HANDLER_TIMEOUT_MS = 15_000;

/**
 * Exponential backoff WITH JITTER: 2s, 4s, 8s … capped at 5 minutes.
 *
 * The jitter matters more than the exponent. Without it, a hundred
 * events that failed together retry together, and the thundering herd
 * turns one provider blip into a sustained outage of our own making.
 */
export function backoffSeconds(attempts: number, random = Math.random): number {
  const base = Math.min(2 ** Math.max(1, attempts), 300);
  const jitter = Math.floor(base * 0.25 * random());
  return base + jitter;
}

/* ------------------------------------------------------------------ *
 * Claiming
 * ------------------------------------------------------------------ */

/**
 * Claim a batch of due events.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes multiple workers safe: each
 * takes rows nobody else holds rather than all of them queueing behind
 * the same head-of-line row.
 *
 * The lease is written in the SAME statement as the claim, so a worker
 * that dies immediately afterwards still leaves a row whose lease will
 * lapse and be re-claimed — rather than one marked in-flight forever.
 */
export async function claimBatch(workerId: string, limit = 20): Promise<readonly OutboxEvent[]> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE sandbox.outbox_event o
          SET lease_owner = $1,
              lease_expires_at = now() + make_interval(secs => $2),
              attempts = o.attempts + 1
        WHERE o.outbox_id IN (
                SELECT outbox_id FROM sandbox.outbox_event
                 WHERE state = 'PENDING'
                   AND next_attempt_at <= now()
                   AND (lease_expires_at IS NULL OR lease_expires_at < now())
                 ORDER BY occurred_at
                 LIMIT $3
                 FOR UPDATE SKIP LOCKED)
        RETURNING outbox_id, event_key, event_type, subject_kind, subject_id,
                  payload, attempts, correlation_id`,
      [workerId, LEASE_SECONDS, limit],
    );
    return rows.map((r) => ({
      outboxId: String(r.outbox_id),
      eventKey: r.event_key as string,
      eventType: r.event_type as string,
      subjectKind: r.subject_kind as string,
      subjectId: r.subject_id as string,
      payload: r.payload as Record<string, unknown>,
      attempts: Number(r.attempts),
      correlationId: (r.correlation_id as string | null) ?? r.event_key,
    }));
  });
}

/* ------------------------------------------------------------------ *
 * Running
 * ------------------------------------------------------------------ */

export interface RunResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly deadLettered: number;
}

/**
 * Run one pass.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  ONE PASS, NOT A LOOP.                                             │
 * │                                                                    │
 * │  A `while (true)` inside a request process is how a serverless     │
 * │  function is killed mid-handler holding a lease. The entry point   │
 * │  is one-shot and idempotent; a scheduler calls it. That makes the  │
 * │  scheduler an EXTERNAL readiness dependency, which is stated       │
 * │  plainly rather than hidden behind a background timer that does    │
 * │  not survive a deploy.                                             │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * The handler runs OUTSIDE the claiming transaction. Holding one open
 * across a slow handler turns a slow dependency into a database
 * incident.
 */
export async function runOnce(
  handlers: Readonly<Record<string, OutboxHandler>>,
  options: { readonly workerId?: string; readonly limit?: number } = {},
): Promise<RunResult> {
  const workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const batch = await claimBatch(workerId, options.limit ?? 20);

  let delivered = 0;
  let retried = 0;
  let deadLettered = 0;

  for (const event of batch) {
    const handler = handlers[event.eventType];
    try {
      if (handler !== undefined) {
        await withTimeout(handler(event), HANDLER_TIMEOUT_MS, event.eventType);
      }
      /*
       * An event with NO handler is delivered, not retried forever.
       * Retrying something nothing is listening for produces a backlog
       * that hides the events somebody is actually waiting on.
       */
      await markDelivered(event.outboxId, workerId);
      delivered += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome = await markFailed(event.outboxId, workerId, message, event.attempts);
      if (outcome === 'DEAD_LETTER') deadLettered += 1;
      else retried += 1;
    }
  }

  return { claimed: batch.length, delivered, retried, deadLettered };
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error(`handler ${label} timed out`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Mark delivered — but only if WE still hold the lease.
 *
 * A worker whose lease lapsed while it was slow must not mark an event
 * another worker has since claimed and may already be handling. The
 * `lease_owner = $2` predicate is what makes the handover safe.
 */
async function markDelivered(outboxId: string, workerId: string): Promise<void> {
  await withTransaction((tx) =>
    tx.query(
      `UPDATE sandbox.outbox_event
          SET state='DELIVERED', published_at=now(), lease_owner=NULL,
              lease_expires_at=NULL, last_error=NULL
        WHERE outbox_id=$1 AND lease_owner=$2 AND state='PENDING'`,
      [outboxId, workerId],
    ),
  );
}

async function markFailed(
  outboxId: string,
  workerId: string,
  message: string,
  attempts: number,
): Promise<'RETRY' | 'DEAD_LETTER'> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE sandbox.outbox_event
          SET last_error = $3,
              lease_owner = NULL,
              lease_expires_at = NULL,
              next_attempt_at = now() + make_interval(secs => $4),
              state = CASE WHEN attempts >= max_attempts THEN 'DEAD_LETTER' ELSE 'PENDING' END,
              dead_lettered_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
        WHERE outbox_id = $1 AND lease_owner = $2
        RETURNING state`,
      [outboxId, workerId, message.slice(0, 1000), backoffSeconds(attempts)],
    );
    return (rows[0]?.state as string | undefined) === 'DEAD_LETTER' ? 'DEAD_LETTER' : 'RETRY';
  });
}

/**
 * Recover events whose worker died holding the lease.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THIS IS WHAT MAKES A CRASH SURVIVABLE.                            │
 * │                                                                    │
 * │  A worker that is killed between claiming and finishing leaves a   │
 * │  row leased to a process that no longer exists. Without this, that │
 * │  event is stuck forever; with it, the lease lapses and another     │
 * │  worker picks it up — and because the handlers are idempotent, a   │
 * │  re-run after a crash that had ALREADY succeeded is harmless.      │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function recoverStaleLeases(): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE sandbox.outbox_event
        SET lease_owner=NULL, lease_expires_at=NULL
      WHERE state='PENDING' AND lease_expires_at IS NOT NULL AND lease_expires_at < now()`,
  );
  return rowCount ?? 0;
}

/* ------------------------------------------------------------------ *
 * Dead letters
 * ------------------------------------------------------------------ */

export interface DeadLetter {
  readonly outboxId: string;
  readonly eventType: string;
  readonly subjectId: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly deadLetteredAt: string;
}

export async function deadLetters(
  principal: Principal,
  limit = 50,
): Promise<Outcome<readonly DeadLetter[]>> {
  if (denialFor(principal, 'risk.queue.read') !== null) {
    return reject('PERMISSION_DENIED', FAILURE_COPY.PERMISSION_DENIED.reason);
  }
  const { rows } = await getPool().query(
    `SELECT outbox_id, event_type, subject_id, attempts, last_error, dead_lettered_at
       FROM sandbox.outbox_event WHERE state='DEAD_LETTER'
      ORDER BY dead_lettered_at DESC LIMIT $1`,
    [limit],
  );
  return accept(
    rows.map((r) => ({
      outboxId: String(r.outbox_id),
      eventType: r.event_type as string,
      subjectId: r.subject_id as string,
      attempts: Number(r.attempts),
      lastError: (r.last_error as string | null) ?? null,
      deadLetteredAt: (r.dead_lettered_at as Date).toISOString(),
    })),
  );
}

/**
 * Replay a dead letter.
 *
 * MFA- and RBAC-protected, because a dead letter is an event that
 * repeatedly failed and somebody is deciding to try it again against a
 * live system. `attempts` is reset so the backoff starts over — a
 * deliberate replay is not attempt nine of the original failure.
 */
export async function replayDeadLetter(
  principal: Principal,
  outboxId: string,
): Promise<Outcome<{ outboxId: string }>> {
  const denial = denialFor(principal, 'risk.case.work');
  if (denial === 'MFA_REQUIRED') return reject('MFA_REQUIRED', FAILURE_COPY.MFA_REQUIRED.reason);
  if (denial === 'MFA_NOT_ENROLLED') {
    return reject('MFA_NOT_ENROLLED', FAILURE_COPY.MFA_NOT_ENROLLED.reason);
  }
  if (denial !== null) return reject('PERMISSION_DENIED', FAILURE_COPY.PERMISSION_DENIED.reason);

  const { rowCount } = await getPool().query(
    `UPDATE sandbox.outbox_event
        SET state='PENDING', dead_lettered_at=NULL, attempts=0,
            next_attempt_at=now(), lease_owner=NULL, lease_expires_at=NULL
      WHERE outbox_id=$1 AND state='DEAD_LETTER'`,
    [outboxId],
  );
  if (rowCount === 0) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);
  return accept({ outboxId });
}

/** Backlog metrics, for readiness and alerting. */
export async function outboxHealth(): Promise<{
  pending: number;
  lagging: number;
  deadLetter: number;
  oldestPendingSeconds: number | null;
}> {
  const { rows } = await getPool().query(
    `SELECT count(*) FILTER (WHERE state='PENDING') AS pending,
            count(*) FILTER (WHERE state='PENDING'
                             AND next_attempt_at < now() - interval '5 minutes') AS lagging,
            count(*) FILTER (WHERE state='DEAD_LETTER') AS dead,
            EXTRACT(EPOCH FROM (now() - min(occurred_at)
                    FILTER (WHERE state='PENDING'))) AS oldest
       FROM sandbox.outbox_event`,
  );
  const r = rows[0]!;
  return {
    pending: Number(r.pending),
    lagging: Number(r.lagging),
    deadLetter: Number(r.dead),
    oldestPendingSeconds: r.oldest === null ? null : Math.round(Number(r.oldest)),
  };
}
