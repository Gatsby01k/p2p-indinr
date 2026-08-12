import { beforeAll, describe, expect, it } from 'vitest';
import { makeOperator, type OperatorFixture } from './support/operator';
import { getPool } from '@/server/db/pool';
import { canonicalise, newCommandId, readCommand, runCommand } from '@/server/boundary/command';
import { reject } from '@/server/boundary/outcome';
import { afterCommit } from '@/services/present';
import { signInSandbox, type SessionUser } from '@/server/sandbox/service';
import { createDealCommand, joinCommand, rulingCommand } from '@/services/commands';
import { FAILURE_COPY } from '@/lib/sandboxContract';

/**
 * Two properties the CTO review found unproven:
 *
 *   · a replayed REJECTION must return the ORIGINAL result — including a
 *     message that differs from `FAILURE_COPY`, which is exactly the case
 *     the old implementation got wrong by rebuilding it from the code;
 *   · a post-commit presentation failure must never destroy a committed
 *     result, because the client would then retry with a fresh id.
 */

let alice: SessionUser;
let operator: OperatorFixture;

const unique = () => Math.random().toString(36).slice(2, 10);

beforeAll(async () => {
  alice = await signInSandbox(`rr-alice-${unique()}@example.com`);
  operator = await makeOperator(`ops@rr-${unique()}.example.com`);
});

/* ------------------------------------------------------------------ *
 * Exact rejected replay
 * ------------------------------------------------------------------ */

describe('a rejected command replays its exact original result', () => {
  const CUSTOM = 'This refusal has wording no FAILURE_COPY entry contains.';

  function customRejection(commandId: string) {
    return runCommand({
      commandId,
      commandType: 'SYSTEM_PROBE',
      actorId: alice.userId,
      payload: { probe: 'custom-rejection' },
      body: async () => reject('NOT_FOUND', CUSTOM, { attempted: 'xyz', hint: 42 }),
      encodeResult: () => ({}),
      decodeResult: () => null,
    });
  }

  it('stores the message and detail rather than only the code', async () => {
    const commandId = newCommandId();
    const first = await customRejection(commandId);
    expect(first.ok).toBe(false);
    if (first.ok) return;

    const stored = await readCommand(commandId);
    expect(stored?.status).toBe('REJECTED');
    expect(stored?.outcomeCode).toBe('NOT_FOUND');
    expect(stored?.result).toMatchObject({ v: 1, code: 'NOT_FOUND', message: CUSTOM });
  });

  it('replays byte-equivalent structured content, not a reconstruction', async () => {
    const commandId = newCommandId();
    const first = await customRejection(commandId);
    const replay = await customRejection(commandId);

    expect(first.ok || replay.ok).toBe(false);
    if (first.ok || replay.ok) return;

    /*
     * Compared CANONICALLY, not by raw `JSON.stringify`.
     *
     * The round trip goes through JSONB, which stores object keys in its
     * own order — so a literal string comparison fails on key order while
     * the content is identical. `canonicalise` is the project's own
     * order-independent encoding, and comparing with it asserts exactly
     * what "byte-equivalent structured content" means.
     */
    expect(canonicalise(replay)).toBe(canonicalise(first));
    expect(replay.message).toBe(CUSTOM);
    expect(replay.detail).toEqual({ attempted: 'xyz', hint: 42 });

    // And emphatically NOT the generic copy the old code would have used.
    expect(replay.message).not.toBe(FAILURE_COPY.NOT_FOUND.reason);
  });

  it('does not run the command body again on replay', async () => {
    const commandId = newCommandId();
    let executions = 0;
    const run = () =>
      runCommand({
        commandId,
        commandType: 'SYSTEM_PROBE',
        actorId: alice.userId,
        payload: { probe: 'once' },
        body: async () => {
          executions += 1;
          return reject('AMOUNT_INVALID', `refused on execution ${executions}`);
        },
        encodeResult: () => ({}),
        decodeResult: () => null,
      });

    const first = await run();
    const replay = await run();
    expect(executions).toBe(1);
    if (first.ok || replay.ok) return;
    // Had the body re-run, the message would name execution 2.
    expect(replay.message).toBe('refused on execution 1');
  });

  it('replays a real ruling validation refusal verbatim', async () => {
    /*
     * The ruling boundary refuses a short reason with wording of its own —
     * "Write at least a sentence explaining the ruling. It is shown to
     * both sides." — which appears in no `FAILURE_COPY` entry. This is the
     * production case the old code got wrong: it replayed the generic
     * `NOT_FOUND` copy instead.
     */
    const dealId = newCommandId(); // a well-formed but unknown deal id
    const commandId = newCommandId();

    const first = await rulingCommand(
      operator.principal,
      commandId,
      dealId,
      'RELEASED',
      'too short',
    );
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.message).toContain('at least a sentence');
    expect(first.message).not.toBe(FAILURE_COPY.NOT_FOUND.reason);

    // Identical arguments → an identical replay, not a conflict.
    const replay = await rulingCommand(
      operator.principal,
      commandId,
      dealId,
      'RELEASED',
      'too short',
    );
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.code).toBe(first.code);
    expect(replay.message).toBe(first.message);
    expect(canonicalise(replay)).toBe(canonicalise(first));
  });

  it('still answers a legacy row written before messages were stored', async () => {
    /*
     * MIGRATION BEHAVIOUR. Rows written by the previous implementation
     * carry `result = '{}'`. They must remain readable and replay the
     * generic copy — which is precisely what they used to return — rather
     * than failing or inventing wording nobody produced.
     */
    const commandId = newCommandId();
    await getPool().query(
      `INSERT INTO sandbox.command
         (command_id, command_type, actor_id, payload_hash, status, outcome_code, result)
       VALUES ($1,'SYSTEM_PROBE',$2,$3,'REJECTED','AMOUNT_TOO_SMALL','{}'::jsonb)`,
      [commandId, alice.userId, 'a'.repeat(64)],
    );

    const replay = await runCommand({
      commandId,
      commandType: 'SYSTEM_PROBE',
      actorId: alice.userId,
      // The hash must match the legacy row for this to be a replay.
      payload: { legacy: true },
      body: async () => reject('NOT_FOUND', 'should never run'),
      encodeResult: () => ({}),
      decodeResult: () => null,
    });

    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    // Hash mismatch is detected first, which is itself correct behaviour.
    expect(['IDEMPOTENCY_CONFLICT', 'AMOUNT_TOO_SMALL']).toContain(replay.code);
  });

  it('replays the generic copy for a legacy row whose payload matches', async () => {
    const commandId = newCommandId();
    const payload = { legacy: 'matched' };
    const { payloadHash } = await import('@/server/boundary/command');
    await getPool().query(
      `INSERT INTO sandbox.command
         (command_id, command_type, actor_id, payload_hash, status, outcome_code, result)
       VALUES ($1,'SYSTEM_PROBE',$2,$3,'REJECTED','AMOUNT_TOO_SMALL','{}'::jsonb)`,
      [commandId, alice.userId, payloadHash(payload)],
    );

    const replay = await runCommand({
      commandId,
      commandType: 'SYSTEM_PROBE',
      actorId: alice.userId,
      payload,
      body: async () => reject('NOT_FOUND', 'should never run'),
      encodeResult: () => ({}),
      decodeResult: () => null,
    });

    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.code).toBe('AMOUNT_TOO_SMALL');
    expect(replay.message).toBe(FAILURE_COPY.AMOUNT_TOO_SMALL.reason);
  });
});

/* ------------------------------------------------------------------ *
 * Post-commit presentation failure
 * ------------------------------------------------------------------ */

describe('presentation failure never destroys a committed command', () => {
  it('afterCommit swallows a throwing revalidation', () => {
    expect(() =>
      afterCommit(() => {
        throw new Error('revalidatePath exploded');
      }),
    ).not.toThrow();
  });

  it('a committed create survives a failing revalidation and replays on retry', async () => {
    const commandId = newCommandId();

    // The exact wrapper shape: command first, presentation strictly after.
    const outcome = await createDealCommand(alice, {
      commandId,
      scenario: 'INR_TO_INR',
      inrAmount: '2500',
      intent: 'PAY',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    afterCommit(() => {
      throw new Error('revalidatePath exploded after the commit');
    });

    // The command is committed regardless of what presentation did.
    expect((await readCommand(commandId))?.status).toBe('SUCCEEDED');

    // A retry carrying the SAME id replays rather than creating a second.
    const retry = await createDealCommand(alice, {
      commandId,
      scenario: 'INR_TO_INR',
      inrAmount: '2500',
      intent: 'PAY',
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.publicId).toBe(outcome.value.publicId);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.deal_link WHERE public_id = $1`,
      [outcome.value.publicId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('a committed join survives the same failure without double-joining', async () => {
    const bob = await signInSandbox(`rr-bob-${unique()}@example.com`);
    const created = await createDealCommand(alice, {
      commandId: newCommandId(),
      scenario: 'INR_TO_INR',
      inrAmount: '2500',
      intent: 'PAY',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const commandId = newCommandId();
    const joined = await joinCommand(bob, commandId, created.value.publicId);
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;

    afterCommit(() => {
      throw new Error('revalidatePath exploded after the commit');
    });

    const retry = await joinCommand(bob, commandId, created.value.publicId);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.dealId).toBe(joined.value.dealId);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.deal d
         JOIN sandbox.deal_link l ON l.link_id = d.link_id
        WHERE l.public_id = $1`,
      [created.value.publicId],
    );
    expect(rows[0]!.n).toBe(1);
  });
});
