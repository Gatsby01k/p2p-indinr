import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/server/db/pool';
import { runOnce, noopHandler, replayDeadLetter } from '@/server/ops/outboxWorker';
import {
  DECLARED_EVENT_TYPES,
  outboxHandlers,
  unclassifiedTypes,
} from '@/server/ops/outboxHandlers';
import { newUser, operatorPrincipal, unique } from './support/room';
import { drainOutbox } from './support/outbox';

/**
 * The DEL-10 correction: an unknown event must never vanish.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  DEL-09 MARKED AN UNHANDLED EVENT `DELIVERED`.                     │
 * │                                                                    │
 * │  The reasoning was sound as far as it went — retrying something    │
 * │  nothing listens for builds a backlog that hides real work. The    │
 * │  conclusion was wrong: it meant a `payment.confirmed` whose        │
 * │  handler registration was dropped in a refactor would be recorded  │
 * │  as successfully delivered and disappear, with the record          │
 * │  asserting the opposite of what happened.                          │
 * │                                                                    │
 * │  These tests are the proof that it cannot happen now.              │
 * └────────────────────────────────────────────────────────────────────┘
 */

/**
 * Start from an empty queue, every test, not just the first.
 *
 * `runOnce` claims a bounded batch in `occurred_at` order, so a backlog
 * from the rest of the run would fill every batch and this suite's own
 * event would never be reached. Draining makes each assertion a
 * statement about the event it seeded rather than about queue depth.
 */
beforeEach(drainOutbox);

/*
 * Creates its OWN subject user.
 *
 * This used to seed `FROM sandbox.app_user LIMIT 1`, which inserted
 * nothing at all on a database where no other test had run yet — so the
 * whole file failed on a FRESH database and passed on the second run.
 * The mirror image of the backlog problem, and the same root cause: a
 * test describing the state of the world rather than owning its inputs.
 */
async function seed(eventType: string): Promise<string> {
  const { rows } = await getPool().query(
    `INSERT INTO sandbox.outbox_event (event_key, event_type, subject_kind, subject_id, payload)
     VALUES ($1, $2, 'user', $3, '{"probe":true}'::jsonb)
     RETURNING outbox_id`,
    [`obx-${unique()}`, eventType, (await newUser('obx-subject')).userId],
  );
  return String(rows[0]!.outbox_id);
}

async function stateOf(outboxId: string) {
  const { rows } = await getPool().query(
    `SELECT state, published_at, last_error, attempts, event_type
       FROM sandbox.outbox_event WHERE outbox_id = $1`,
    [outboxId],
  );
  return rows[0]!;
}

describe('an unhandled event is quarantined, never delivered', () => {
  it('a FINANCIAL event with no handler cannot disappear', async () => {
    // The exact scenario: a registration dropped in a refactor.
    const outboxId = await seed('payment.confirmed');
    const registryMissingIt = outboxHandlers();
    delete (registryMissingIt as Record<string, unknown>)['payment.confirmed'];

    const result = await runOnce(registryMissingIt as never);
    expect(result.unsupported).toBeGreaterThanOrEqual(1);

    const row = await stateOf(outboxId);
    expect(row.state, 'terminal, so it is not retried forever').toBe('DEAD_LETTER');
    // The critical assertion: it was NOT recorded as delivered.
    expect(row.published_at, 'an undelivered event has no delivery time').toBeNull();
    expect(row.last_error).toContain('UNSUPPORTED');
    expect(row.last_error).toContain('payment.confirmed');
  });

  it('records an operational audit signal, without copying the payload', async () => {
    const type = `unknown.type.${unique()}`;
    await seed(type);
    await runOnce(outboxHandlers());

    const { rows } = await getPool().query(
      `SELECT outcome, detail FROM sandbox.audit_event
        WHERE action = 'OUTBOX_UNSUPPORTED' AND detail->>'eventType' = $1`,
      [type],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('UNSUPPORTED');
    expect((rows[0]!.detail as Record<string, unknown>).reason).toBe('NO_HANDLER_REGISTERED');
    // The audit trail is read by more people than the outbox is, so the
    // event payload is deliberately not copied into it.
    expect(JSON.stringify(rows[0]!.detail)).not.toContain('probe');
  });

  it('appears in the dead-letter queue an operator already reads', async () => {
    const type = `unknown.queue.${unique()}`;
    await seed(type);
    await runOnce(outboxHandlers());

    const operator = await operatorPrincipal('OPERATOR', `obx-op-${unique()}`);
    const { deadLetters } = await import('@/server/ops/outboxWorker');
    const letters = await deadLetters(operator, 200);
    expect(letters.ok).toBe(true);
    if (!letters.ok) return;
    expect(letters.value.some((l) => l.eventType === type)).toBe(true);
  });

  it('is NOT retried on a subsequent pass', async () => {
    const type = `unknown.terminal.${unique()}`;
    const outboxId = await seed(type);

    await runOnce(outboxHandlers());
    const first = await stateOf(outboxId);
    // A quarantined event is terminal: it must not spin.
    const second = await runOnce(outboxHandlers());
    expect(second.claimed, 'a dead letter is not re-claimed').toBe(0);
    expect((await stateOf(outboxId)).attempts).toBe(Number(first.attempts));
  });

  it('CAN be replayed once a handler exists', async () => {
    const type = `unknown.replay.${unique()}`;
    const outboxId = await seed(type);
    await runOnce(outboxHandlers());
    expect((await stateOf(outboxId)).state).toBe('DEAD_LETTER');

    const operator = await operatorPrincipal('OPERATOR', `obx-replay-${unique()}`);
    const replayed = await replayDeadLetter(operator, outboxId);
    expect(replayed.ok).toBe(true);

    // Now with a handler registered, it delivers properly.
    let handled = false;
    await runOnce(
      outboxHandlers({
        [type]: async () => {
          handled = true;
        },
      }),
    );
    expect(handled).toBe(true);
    const row = await stateOf(outboxId);
    expect(row.state).toBe('DELIVERED');
    expect(row.published_at).not.toBeNull();
  });

  it('an EXPLICIT no-op is delivered, and is a different thing entirely', async () => {
    const outboxId = await seed('deal.completed');
    await runOnce(outboxHandlers());

    const row = await stateOf(outboxId);
    /*
     * `deal.completed` registers `noopHandler`: somebody looked at it and
     * decided nothing needs to happen while no notification provider
     * exists. That is a DECISION, and it delivers. Silence is not.
     */
    expect(row.state).toBe('DELIVERED');
    expect(row.published_at).not.toBeNull();
    expect(row.last_error).toBeNull();
  });
});

describe('the manifest cannot drift from the registry', () => {
  it('every declared type is classified', () => {
    // A new event added to a command without a decision here fails
    // CI rather than surprising a worker at 03:00.
    expect(unclassifiedTypes()).toEqual([]);
  });

  it('the registry answers for every declared type', () => {
    const registry = outboxHandlers();
    for (const type of DECLARED_EVENT_TYPES) {
      expect(registry[type], `no handler registered for ${type}`).toBeDefined();
    }
  });

  it('the no-op handler is the registered one, not an accident', () => {
    const registry = outboxHandlers();
    expect(registry['deal.completed']).toBe(noopHandler);
  });

  it('every type the DATABASE has seen is declared', async () => {
    /*
     * The source scanner proves the code side. This proves the DATA
     * side: an event type that reached the table but is not in the
     * manifest means something emitted it by a path the scanner cannot
     * see — a raw insert, a migration, a script.
     */
    const { rows } = await getPool().query(
      `SELECT DISTINCT event_type FROM sandbox.outbox_event
        WHERE event_type NOT LIKE 'test.%' AND event_type NOT LIKE 'unknown.%'`,
    );
    const declared = new Set<string>(DECLARED_EVENT_TYPES);
    const undeclared = rows.map((r) => r.event_type as string).filter((t) => !declared.has(t));
    expect(undeclared, 'event types in the database that no manifest declares').toEqual([]);
  });
});
