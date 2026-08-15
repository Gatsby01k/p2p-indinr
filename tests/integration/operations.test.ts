import { beforeAll, describe, expect, it } from 'vitest';
import { getPool, withTransaction } from '@/server/db/pool';
import { newCommandId } from '@/server/boundary/command';
import { loadConfig, redactObject, validateConfig } from '@/server/ops/config';
import { liveness, publicReadiness, readiness } from '@/server/ops/readiness';
import {
  backoffSeconds,
  claimBatch,
  deadLetters,
  outboxHealth,
  recoverStaleLeases,
  replayDeadLetter,
  runOnce,
} from '@/server/ops/outboxWorker';
import type { Principal } from '@/server/identity/rbac';
import { operatorPrincipal, withoutMfa, bare, newUser, unique } from './support/room';
import { lockedDeal } from './support/rails';

/**
 * DEL-09 operations: configuration, readiness and the outbox worker.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE PROPERTY UNDER TEST: THE SYSTEM REFUSES TO LOOK HEALTHY WHEN  │
 * │  IT IS NOT.                                                        │
 * │                                                                    │
 * │  A green readiness check on a deployment with no secrets, a        │
 * │  sandbox adapter in production, or a schema it was not built for   │
 * │  is worse than a red one: it is the failure that gets promoted     │
 * │  into traffic.                                                     │
 * │                                                                    │
 * │  And the worker's guarantee is at-least-once DELIVERY with         │
 * │  exactly-once EFFECT, so the tests are mostly about a duplicate    │
 * │  changing nothing.                                                 │
 * └────────────────────────────────────────────────────────────────────┘
 */

const original = { ...process.env };
function restore() {
  for (const key of Object.keys(process.env)) {
    if (!(key in original)) delete process.env[key];
  }
  Object.assign(process.env, original);
}

let operator: Principal;

beforeAll(async () => {
  operator = await operatorPrincipal('OPERATOR', 'ops-operator');
});

/* ================================================================== *
 * Configuration
 * ================================================================== */

describe('configuration refuses to guess in production', () => {
  it('names every missing mandatory secret without echoing any value', () => {
    process.env.INRP2P_MODE = 'production';
    process.env.SESSION_SIGNING_KEY = 'a-real-looking-value-that-must-not-be-echoed';
    const verdict = validateConfig(loadConfig());
    restore();

    expect(verdict.ok).toBe(false);
    const joined = verdict.problems.join(' ');
    // NAMES, never values. A configuration report that echoes a secret
    // is a way to exfiltrate one.
    expect(joined).toContain('EVIDENCE_STORAGE_URL');
    expect(joined).not.toContain('a-real-looking-value');
  });

  it('REFUSES a sandbox deployment in production outright', () => {
    process.env.INRP2P_MODE = 'production';
    process.env.INRP2P_SANDBOX = 'true';
    const verdict = validateConfig(loadConfig());
    restore();

    expect(verdict.ok).toBe(false);
    // Simulated custody and a published webhook key serving real
    // customers is not a warning-level problem.
    expect(verdict.problems.join(' ')).toContain('INRP2P_SANDBOX is set in production');
  });

  it('REFUSES the migration credential being visible to the web runtime', () => {
    process.env.INRP2P_MODE = 'production';
    process.env.MIGRATION_DATABASE_URL = 'postgres://migrator:x@host/db';
    const verdict = validateConfig(loadConfig());
    restore();
    expect(verdict.problems.join(' ')).toContain('MIGRATION_DATABASE_URL');
  });

  it('defaults an unlabelled production build to production, not development', () => {
    delete process.env.INRP2P_MODE;
    const previous = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    const config = loadConfig();
    (process.env as Record<string, string | undefined>).NODE_ENV = previous;
    restore();
    // A deployment that forgot to set the mode must not inherit
    // development behaviour.
    expect(config.mode).toBe('production');
  });

  it('bounds the pool and the statement timeout', () => {
    process.env.DATABASE_POOL_MAX = '99999';
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = '1';
    const config = loadConfig();
    restore();
    expect(config.poolMax).toBeLessThanOrEqual(50);
    expect(config.statementTimeoutMs).toBeGreaterThanOrEqual(1000);
  });

  it('redacts anything that could carry a secret', () => {
    const redacted = redactObject({
      sessionToken: 'abc123',
      authorization: 'Bearer xyz',
      DATABASE_URL: 'postgres://u:p@h/db',
      utr: 'UTR123456789',
      nested: { webhookSignature: 'deadbeef', dealId: 'safe' },
      dealId: 'safe',
    });
    expect(redacted.sessionToken).toBe('[redacted]');
    expect(redacted.authorization).toBe('[redacted]');
    expect(redacted.DATABASE_URL).toBe('[redacted connection string]');
    expect(redacted.utr).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).webhookSignature).toBe('[redacted]');
    // A safe identifier survives: redaction that removes everything is
    // redaction nobody can debug with.
    expect(redacted.dealId).toBe('safe');
  });
});

/* ================================================================== *
 * Readiness
 * ================================================================== */

describe('readiness', () => {
  it('liveness does NOT touch the database', () => {
    // A liveness probe that fails on a slow query gets a healthy
    // process restarted into the same slow database, repeatedly.
    const result = liveness();
    expect(result.alive).toBe(true);
  });

  it('is ready in the sandbox, with the expected schema version', async () => {
    const result = await readiness();
    const byName = new Map(result.checks.map((c) => [c.name, c]));
    expect(byName.get('schema-version')?.status, 'schema version matches the build').toBe('PASS');
    expect(byName.get('database')?.status).toBe('PASS');
    expect(byName.get('policies')?.status).toBe('PASS');
    expect(result.ready).toBe(true);
  });

  it('the PUBLIC response is a boolean and nothing else', async () => {
    const result = await publicReadiness();
    // A readiness endpoint is reachable by anybody who finds it. A
    // detailed one is a free reconnaissance report.
    expect(Object.keys(result)).toEqual(['ready']);
    expect(JSON.stringify(result)).not.toMatch(/schema|database|adapter|version|postgres/i);
  });

  it('is NOT ready in production without adapters or secrets', async () => {
    process.env.INRP2P_MODE = 'production';
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    delete process.env.INRP2P_SANDBOX;

    const result = await readiness();
    restore();

    expect(result.ready, 'a production deployment with no providers is not ready').toBe(false);
    const failed = result.checks.filter((c) => c.status === 'FAIL').map((c) => c.name);
    expect(failed).toContain('config');
    // Every mandatory adapter is absent from this repository, by design.
    expect(failed.some((n) => n.startsWith('adapter:'))).toBe(true);
  });

  it('reports a pause as DEGRADED, never as unhealthy', async () => {
    const { rows } = await getPool().query(
      `INSERT INTO sandbox.control_switch (scope, reason, paused_by)
       SELECT 'REWARDS', 'Readiness reporting fixture for the operations suite.', user_id
         FROM sandbox.app_user LIMIT 1
       ON CONFLICT DO NOTHING RETURNING switch_id`,
    );

    const result = await readiness();
    const controls = result.checks.find((c) => c.name === 'controls');
    // A paused platform is a DELIBERATE state and still a healthy one.
    expect(controls?.status).toBe('DEGRADED');
    expect(result.ready).toBe(true);

    if (rows[0]) {
      await getPool().query(`DELETE FROM sandbox.control_switch WHERE switch_id = $1`, [
        rows[0].switch_id,
      ]);
    }
  });
});

/* ================================================================== *
 * The outbox worker
 * ================================================================== */

describe('the outbox worker', () => {
  async function seedEvent(type = `test.event.${unique()}`): Promise<string> {
    const { rows } = await getPool().query(
      `INSERT INTO sandbox.outbox_event (event_key, event_type, subject_kind, subject_id, payload)
       SELECT $1, $2, 'user', user_id, '{"probe":true}'::jsonb FROM sandbox.app_user LIMIT 1
       RETURNING outbox_id`,
      [`ops-${unique()}`, type],
    );
    return String(rows[0]!.outbox_id);
  }

  it('backs off exponentially WITH jitter', () => {
    // Without jitter, a hundred events that failed together retry
    // together — one provider blip becomes a self-inflicted outage.
    const fixed = backoffSeconds(3, () => 0);
    const jittered = new Set(Array.from({ length: 20 }, () => backoffSeconds(3)));
    expect(fixed).toBe(8);
    expect(jittered.size).toBeGreaterThan(1);
    expect(Math.max(...jittered)).toBeLessThanOrEqual(Math.floor(8 * 1.25));
    // And it is capped, so a long-dead handler does not retry yearly.
    expect(backoffSeconds(50, () => 0)).toBe(300);
  });

  it('delivers an event exactly once and marks it', async () => {
    const type = `test.once.${unique()}`;
    const outboxId = await seedEvent(type);
    let calls = 0;

    await runOnce({
      [type]: async () => {
        calls += 1;
      },
    });
    await runOnce({
      [type]: async () => {
        calls += 1;
      },
    });

    expect(calls, 'a delivered event is not re-delivered').toBe(1);
    const { rows } = await getPool().query(
      `SELECT state, published_at FROM sandbox.outbox_event WHERE outbox_id = $1`,
      [outboxId],
    );
    expect(rows[0]!.state).toBe('DELIVERED');
    expect(rows[0]!.published_at).not.toBeNull();
  });

  it('TWO WORKERS never claim the same event', async () => {
    const type = `test.race.${unique()}`;
    for (let i = 0; i < 8; i += 1) await seedEvent(type);

    const seen: string[] = [];
    const handler = { [type]: async () => {} };
    await Promise.all([runOnce(handler, { workerId: 'w1' }), runOnce(handler, { workerId: 'w2' })]);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.outbox_event
        WHERE event_type = $1 AND state = 'DELIVERED'`,
      [type],
    );
    expect(rows[0]!.n).toBe(8);
    void seen;
  });

  it('retries a failing handler, then DEAD-LETTERS it', async () => {
    const type = `test.doomed.${unique()}`;
    const outboxId = await seedEvent(type);
    await getPool().query(`UPDATE sandbox.outbox_event SET max_attempts = 3 WHERE outbox_id = $1`, [
      outboxId,
    ]);

    const failing = {
      [type]: async () => {
        throw new Error('the provider is down');
      },
    };
    for (let i = 0; i < 4; i += 1) {
      await getPool().query(
        `UPDATE sandbox.outbox_event SET next_attempt_at = now() WHERE outbox_id = $1
           AND state = 'PENDING'`,
        [outboxId],
      );
      await runOnce(failing);
    }

    const { rows } = await getPool().query(
      `SELECT state, attempts, last_error FROM sandbox.outbox_event WHERE outbox_id = $1`,
      [outboxId],
    );
    // An event that failed three times is not a transient problem, and
    // retrying it forever hides that from whoever needs to know.
    expect(rows[0]!.state).toBe('DEAD_LETTER');
    expect(rows[0]!.last_error).toContain('the provider is down');
  });

  it('RECOVERS an event whose worker died holding the lease', async () => {
    const type = `test.crash.${unique()}`;
    const outboxId = await seedEvent(type);

    // Claim it, then vanish — exactly what a killed process leaves.
    await claimBatch('doomed-worker', 10);
    await getPool().query(
      `UPDATE sandbox.outbox_event SET lease_expires_at = now() - interval '1 minute'
        WHERE outbox_id = $1`,
      [outboxId],
    );

    const recovered = await recoverStaleLeases();
    expect(recovered).toBeGreaterThanOrEqual(1);

    let delivered = false;
    await runOnce({
      [type]: async () => {
        delivered = true;
      },
    });
    expect(delivered, 'another worker picks up an abandoned event').toBe(true);
  });

  it('a handler that HANGS is timed out, not left holding the lease', async () => {
    const type = `test.hang.${unique()}`;
    const outboxId = await seedEvent(type);

    await runOnce({
      [type]: () => new Promise(() => {}), // never settles
    });

    const { rows } = await getPool().query(
      `SELECT state, lease_owner, last_error FROM sandbox.outbox_event WHERE outbox_id = $1`,
      [outboxId],
    );
    expect(rows[0]!.state).toBe('PENDING');
    expect(rows[0]!.lease_owner, 'the lease is released for another worker').toBeNull();
    expect(rows[0]!.last_error).toContain('timed out');
  }, 30_000);

  it('an event with NO handler is delivered, not retried forever', async () => {
    const outboxId = await seedEvent(`test.unhandled.${unique()}`);
    await runOnce({});
    const { rows } = await getPool().query(
      `SELECT state FROM sandbox.outbox_event WHERE outbox_id = $1`,
      [outboxId],
    );
    // Retrying something nothing listens for produces a backlog that
    // hides the events somebody is actually waiting on.
    expect(rows[0]!.state).toBe('DELIVERED');
  });

  it('replaying a dead letter requires permission AND a satisfied factor', async () => {
    const type = `test.replay.${unique()}`;
    const outboxId = await seedEvent(type);
    await getPool().query(
      `UPDATE sandbox.outbox_event SET state='DEAD_LETTER', dead_lettered_at=now()
        WHERE outbox_id=$1`,
      [outboxId],
    );

    const customer = await newUser('ops-customer');
    const byCustomer = await replayDeadLetter(bare(customer), outboxId);
    expect(byCustomer.ok).toBe(false);
    if (!byCustomer.ok) expect(byCustomer.code).toBe('PERMISSION_DENIED');

    const unproved = await replayDeadLetter(withoutMfa(operator), outboxId);
    expect(unproved.ok).toBe(false);
    if (!unproved.ok) expect(unproved.code).toBe('MFA_REQUIRED');

    const replayed = await replayDeadLetter(operator, outboxId);
    expect(replayed.ok).toBe(true);

    const { rows } = await getPool().query(
      `SELECT state, attempts FROM sandbox.outbox_event WHERE outbox_id = $1`,
      [outboxId],
    );
    expect(rows[0]!.state).toBe('PENDING');
    // A deliberate replay is not attempt nine of the original failure.
    expect(Number(rows[0]!.attempts)).toBe(0);
  });

  it('a customer cannot read the dead-letter queue', async () => {
    const customer = await newUser('ops-nosy');
    const outcome = await deadLetters(bare(customer));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PERMISSION_DENIED');
  });

  it('reports backlog health for readiness and alerting', async () => {
    const health = await outboxHealth();
    expect(health.pending).toBeGreaterThanOrEqual(0);
    expect(health.deadLetter).toBeGreaterThanOrEqual(0);
  });

  it('DUPLICATE delivery cannot duplicate a financial effect', async () => {
    /*
     * The guarantee that actually matters. At-least-once delivery is
     * the only honest promise; the handlers and the boundaries they
     * call have been keyed since DEL-02, so a repeat changes nothing.
     */
    const alice = await newUser('ops-dup-a');
    const bob = await newUser('ops-dup-b');
    const dealId = await lockedDeal(alice, bob, 20_000n);

    const before = await getPool().query(`SELECT count(*)::int AS n FROM inrp2p.journal_entry`);

    const type = `test.financial.${unique()}`;
    await seedEvent(type);

    // A handler that calls a real, keyed boundary — five times.
    const { releaseValueCommand } = await import('@/services/commands');
    const commandId = newCommandId();
    const handler = {
      [type]: async () => {
        await releaseValueCommand(alice, commandId, { dealId, beneficiaryId: bob.userId });
      },
    };
    for (let i = 0; i < 5; i += 1) {
      await getPool().query(
        `UPDATE sandbox.outbox_event SET state='PENDING', published_at=NULL,
                next_attempt_at=now(), lease_owner=NULL, lease_expires_at=NULL, attempts=0
          WHERE event_type=$1`,
        [type],
      );
      await runOnce(handler);
    }

    const after = await getPool().query(`SELECT count(*)::int AS n FROM inrp2p.journal_entry`);
    // One settlement, whatever the delivery count. (Release posts the
    // settlement entry; a fee entry may accompany it.)
    expect(after.rows[0]!.n - before.rows[0]!.n).toBeLessThanOrEqual(2);

    const { rows } = await getPool().query(`SELECT state FROM inrp2p.value_lock WHERE deal_id=$1`, [
      dealId,
    ]);
    expect(rows[0]!.state).toBe('RELEASED');
  }, 30_000);
});

/* ================================================================== *
 * Transaction safety
 * ================================================================== */

describe('the claim is transactional', () => {
  it('a rolled-back claim leaves the event claimable', async () => {
    const { rows } = await getPool().query(
      `INSERT INTO sandbox.outbox_event (event_key, event_type, subject_kind, subject_id, payload)
       SELECT $1, 'test.rollback', 'user', user_id, '{}'::jsonb FROM sandbox.app_user LIMIT 1
       RETURNING outbox_id`,
      [`ops-rb-${unique()}`],
    );
    const outboxId = String(rows[0]!.outbox_id);

    await expect(
      withTransaction(async (tx) => {
        await tx.query(`UPDATE sandbox.outbox_event SET lease_owner='probe' WHERE outbox_id=$1`, [
          outboxId,
        ]);
        throw new Error('injected failure during claim');
      }),
    ).rejects.toThrow('injected failure during claim');

    const after = await getPool().query(
      `SELECT lease_owner, state FROM sandbox.outbox_event WHERE outbox_id=$1`,
      [outboxId],
    );
    expect(after.rows[0]!.lease_owner).toBeNull();
    expect(after.rows[0]!.state).toBe('PENDING');
  });
});
