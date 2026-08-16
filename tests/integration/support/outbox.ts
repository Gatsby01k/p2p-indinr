import { getPool } from '@/server/db/pool';
import { runOnce } from '@/server/ops/outboxWorker';
import { outboxHandlers } from '@/server/ops/outboxHandlers';

/**
 * Establish the queue precondition instead of assuming it.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHY THE OUTBOX TESTS WERE ORDER-DEPENDENT.                        │
 * │                                                                    │
 * │  `runOnce` claims a BOUNDED batch in `occurred_at` order. Every    │
 * │  other suite in this run emits events as a side effect of doing    │
 * │  real work, so by the time the worker tests execute there is a     │
 * │  backlog of older events that fills every batch — and the event    │
 * │  the test just seeded is never reached. The assertions then        │
 * │  described queue depth rather than the behaviour under test.       │
 * │                                                                    │
 * │  It passed on a virgin database and failed on a used one, which    │
 * │  is the worst possible failure mode: green in development, red at  │
 * │  the second CI run, and blind to anything that only appears with   │
 * │  real data. The same blind spot hid a release-blocking migration   │
 * │  defect for four stages.                                           │
 * │                                                                    │
 * │  Draining first makes each test a statement about the event it     │
 * │  seeded, whatever ran before it.                                   │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function drainOutbox(): Promise<number> {
  const registry = outboxHandlers();
  let drained = 0;
  /*
   * Bounded rather than `while (true)`. A handler bug that re-queues its
   * own event would otherwise hang the suite with no output; a bound
   * turns that into an ordinary assertion failure further down.
   */
  for (let pass = 0; pass < 500; pass += 1) {
    const result = await runOnce(registry, { limit: 200 });
    if (result.claimed === 0) return drained;
    drained += result.claimed;
  }
  throw new Error('outbox did not drain in 500 passes — a handler is re-queuing');
}

/**
 * Park every event that already exists so a test sees an empty queue.
 *
 * Draining DELIVERS events, which is the right preparation for tests
 * about delivery. Some tests instead need to count what the worker
 * claims, and for those even a delivered backlog is noise — this moves
 * the existing rows out of the worker's view without pretending they
 * were handled, by dating them into the future rather than marking them
 * delivered. Nothing is deleted: the audit trail is unchanged.
 */
export async function quiesceOutbox(): Promise<void> {
  await getPool().query(
    `UPDATE sandbox.outbox_event
        SET next_attempt_at = now() + interval '1 day'
      WHERE state = 'PENDING' AND lease_owner IS NULL`,
  );
}

/** How many events the worker would consider claimable right now. */
export async function claimableCount(): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM sandbox.outbox_event
      WHERE state = 'PENDING' AND next_attempt_at <= now()`,
  );
  return rows[0]!.n as number;
}
