import { beforeAll, describe, expect, it } from 'vitest';
import { getPool, withTransaction } from '@/server/db/pool';
import { newCommandId } from '@/server/boundary/command';
import { enqueueRailRequest, runRailRequests } from '@/server/rails/railRequests';
import { openPaymentIntentCommand } from '@/services/commands';
import type { SessionUser } from '@/server/sandbox/service';
import { lockedDeal, newUser, unique } from './support/rails';

/**
 * The retry-safe external-call outbox.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE FAILURE THIS PREVENTS IS NOT "THE CALL FAILED".               │
 * │                                                                    │
 * │  It is the call SUCCEEDING while the transaction that made it      │
 * │  rolls back — the provider has moved money and the database has no │
 * │  record of asking. That cannot be repaired by retrying, because    │
 * │  retrying does it twice.                                           │
 * │                                                                    │
 * │  So these tests are about the two properties that make at-least-   │
 * │  once delivery safe: the idempotency key never changes across      │
 * │  retries, and a failing request backs off and eventually stops     │
 * │  rather than hammering a provider forever.                         │
 * └────────────────────────────────────────────────────────────────────┘
 */

let alice: SessionUser;
let bob: SessionUser;

beforeAll(async () => {
  alice = await newUser('rr-alice');
  bob = await newUser('rr-bob');
});

async function anIntent(): Promise<string> {
  const dealId = await lockedDeal(alice, bob);
  const opened = await openPaymentIntentCommand(alice, newCommandId(), {
    dealId,
    rail: 'USDT',
    network: 'TRC20',
    direction: 'COLLECT',
    payeeId: bob.userId,
    amountMinor: 10_000n,
  });
  if (!opened.ok) throw new Error(`intent fixture: ${opened.code}`);
  return opened.value.intentId;
}

async function requestRow(idempotencyKey: string) {
  const { rows } = await getPool().query(
    `SELECT state, attempts, last_error, completed_at FROM sandbox.rail_request
      WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return rows[0]!;
}

describe('external calls are enqueued before they are made', () => {
  it('deduplicates on the idempotency key', async () => {
    const intentId = await anIntent();
    const key = `payout:${intentId}`;

    const first = await withTransaction((tx) =>
      enqueueRailRequest(tx, {
        intentId,
        providerKey: 'sandbox-inr',
        operation: 'payout',
        idempotencyKey: key,
      }),
    );
    const second = await withTransaction((tx) =>
      enqueueRailRequest(tx, {
        intentId,
        providerKey: 'sandbox-inr',
        operation: 'payout',
        idempotencyKey: key,
      }),
    );

    expect(first).not.toBeNull();
    // `null` is the deduplication working, not an error.
    expect(second).toBeNull();

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.rail_request WHERE intent_id = $1`,
      [intentId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('vanishes with its transaction if the caller rolls back', async () => {
    const intentId = await anIntent();
    const key = `rollback:${intentId}`;

    await expect(
      withTransaction(async (tx) => {
        await enqueueRailRequest(tx, {
          intentId,
          providerKey: 'sandbox-inr',
          operation: 'payout',
          idempotencyKey: key,
        });
        throw new Error('caller failed after enqueueing');
      }),
    ).rejects.toThrow('caller failed after enqueueing');

    const { rows } = await getPool().query(
      `SELECT 1 FROM sandbox.rail_request WHERE idempotency_key = $1`,
      [key],
    );
    expect(rows).toHaveLength(0);
  });

  it('hands the SAME key to the provider on every retry', async () => {
    const intentId = await anIntent();
    const key = `retry:${intentId}`;
    await withTransaction((tx) =>
      enqueueRailRequest(tx, {
        intentId,
        providerKey: 'sandbox-inr',
        operation: 'payout',
        idempotencyKey: key,
      }),
    );

    // Force the row due immediately so the retries are observable.
    const seen: string[] = [];
    const failOnce = async (r: { idempotencyKey: string }) => {
      seen.push(r.idempotencyKey);
      throw new Error('provider timed out');
    };

    await runRailRequests(failOnce);
    await getPool().query(
      `UPDATE sandbox.rail_request SET next_attempt_at = now() WHERE idempotency_key = $1`,
      [key],
    );
    await runRailRequests(failOnce);

    const mine = seen.filter((k) => k === key);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    // Every attempt carried the identical key, which is what lets the
    // provider deduplicate a call it already performed.
    expect(new Set(mine).size).toBe(1);
  });

  it('marks a request SUCCEEDED once the handler returns', async () => {
    const intentId = await anIntent();
    const key = `ok:${intentId}`;
    await withTransaction((tx) =>
      enqueueRailRequest(tx, {
        intentId,
        providerKey: 'sandbox-inr',
        operation: 'payout',
        idempotencyKey: key,
      }),
    );

    await runRailRequests(async () => {
      /* the provider accepted it */
    });

    const row = await requestRow(key);
    expect(row.state).toBe('SUCCEEDED');
    expect(row.completed_at).not.toBeNull();
  });

  it('gives up at max_attempts instead of retrying forever', async () => {
    const intentId = await anIntent();
    const key = `doomed:${intentId}`;
    await withTransaction((tx) =>
      enqueueRailRequest(tx, {
        intentId,
        providerKey: 'sandbox-inr',
        operation: 'payout',
        idempotencyKey: key,
      }),
    );

    for (let i = 0; i < 6; i += 1) {
      await getPool().query(
        `UPDATE sandbox.rail_request SET next_attempt_at = now()
          WHERE idempotency_key = $1 AND state = 'PENDING'`,
        [key],
      );
      await runRailRequests(async () => {
        throw new Error('the provider is down');
      });
    }

    const row = await requestRow(key);
    // A payout that failed five times is not a transient problem, and
    // retrying it a sixth time hides that from whoever needs to know.
    expect(row.state).toBe('FAILED');
    expect(row.attempts).toBe(5);
    expect(row.last_error).toContain('the provider is down');
  });

  it('two workers do not process the same request', async () => {
    const keys: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const intentId = await anIntent();
      const key = `concurrent:${unique()}:${intentId}`;
      keys.push(key);
      await withTransaction((tx) =>
        enqueueRailRequest(tx, {
          intentId,
          providerKey: 'sandbox-inr',
          operation: 'payout',
          idempotencyKey: key,
        }),
      );
    }

    const handled: string[] = [];
    const handler = async (r: { idempotencyKey: string }) => {
      handled.push(r.idempotencyKey);
    };

    // `FOR UPDATE SKIP LOCKED` is what makes this safe: each worker takes
    // rows nobody else holds rather than queueing behind the same one.
    await Promise.all([runRailRequests(handler), runRailRequests(handler)]);

    const mine = handled.filter((k) => keys.includes(k));
    expect(new Set(mine).size).toBe(mine.length);
  });
});
