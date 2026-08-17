import { fundForDeals, clearRiskCounters } from './support/escrow';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, withTransaction } from '@/server/db/pool';
import {
  boundaryContextFor,
  canonicalise,
  newCommandId,
  payloadHash,
  readCommand,
  runCommand,
} from '@/server/boundary/command';
import { accept, reject } from '@/server/boundary/outcome';
import {
  createDealIntentIn,
  joinDealLinkIn,
  signInSandbox,
  type SessionUser,
} from '@/server/sandbox/service';

/**
 * DEL-02 command idempotency, atomicity and the transactional outbox.
 *
 * Everything here runs against the real embedded PostgreSQL, because the
 * properties under test — `ON CONFLICT` waiting on a speculative insert,
 * a rollback discarding four writes at once, a unique index refusing a
 * duplicate event — are database behaviour and cannot be modelled.
 */

let creator: SessionUser;
let joiner: SessionUser;

const unique = () => Math.random().toString(36).slice(2, 10);

beforeAll(async () => {
  creator = await signInSandbox(`cmd-creator-${unique()}@example.com`);
  joiner = await signInSandbox(`cmd-joiner-${unique()}@example.com`);
});

function dealRequest() {
  return {
    scenario: 'INR_TO_INR' as const,
    inrMinor: 250_000n, // ₹2,500.00
    intent: 'PAY' as const,
    feeBearer: 'PAYER' as const,
    title: 'Command boundary test',
  };
}

async function createIntent(commandId: string, actor: SessionUser = creator, inrMinor?: bigint) {
  return runCommand({
    commandId,
    commandType: 'DEAL_INTENT_CREATE',
    actorId: actor.userId,
    payload: { scenario: 'INR_TO_INR', inrMinor: (inrMinor ?? 250_000n).toString() },
    body: (ctx) =>
      createDealIntentIn(ctx, actor, { ...dealRequest(), inrMinor: inrMinor ?? 250_000n }),
    encodeResult: (v) => ({ publicId: v.publicId, quoteId: v.quoteId }),
    decodeResult: (r) => ({ publicId: String(r.publicId), quoteId: String(r.quoteId) }),
  });
}

/* ------------------------------------------------------------------ *
 * Canonical hashing
 * ------------------------------------------------------------------ */

/*
 * Escrow is real now: the crypto side must own what it sells, and every
 * deal counts toward that account's rolling exposure. Neither is what
 * this file tests, so both are handled by shared fixture support rather
 * than by relaxing the checks that make them true.
 */
beforeAll(async () => {
  await fundForDeals([creator, joiner]);
});
beforeEach(async () => {
  await clearRiskCounters([creator, joiner]);
});

describe('canonical payload hashing', () => {
  it('is independent of key order', () => {
    expect(canonicalise({ a: 1, b: 2 })).toBe(canonicalise({ b: 2, a: 1 }));
    expect(payloadHash({ x: 'y', n: 1 })).toBe(payloadHash({ n: 1, x: 'y' }));
  });

  it('distinguishes genuinely different payloads', () => {
    expect(payloadHash({ amount: '100' })).not.toBe(payloadHash({ amount: '101' }));
    // A string "1" and a number 1 are not the same request.
    expect(payloadHash({ a: '1' })).not.toBe(payloadHash({ a: 1 }));
  });

  it('encodes bigint as a decimal string, never through a JS number', () => {
    expect(canonicalise({ v: 9007199254740993n })).toBe('{"v":"9007199254740993"}');
  });

  it('drops undefined rather than encoding it', () => {
    expect(canonicalise({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

/* ------------------------------------------------------------------ *
 * Atomic quote + link
 * ------------------------------------------------------------------ */

describe('atomic quote and link creation', () => {
  it('writes quote, link, audit, outbox and command in ONE transaction', async () => {
    const commandId = newCommandId();
    const outcome = await createIntent(commandId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { rows: link } = await getPool().query(
      `SELECT l.link_id, l.quote_id, q.state AS quote_state
         FROM sandbox.deal_link l JOIN sandbox.quote q ON q.quote_id = l.quote_id
        WHERE l.public_id = $1`,
      [outcome.value.publicId],
    );
    expect(link).toHaveLength(1);
    expect(link[0]!.quote_id).toBe(outcome.value.quoteId);
    expect(link[0]!.quote_state).toBe('CONSUMED');

    // The command row committed with them.
    const command = await readCommand(commandId);
    expect(command?.status).toBe('SUCCEEDED');
    expect(command?.result.publicId).toBe(outcome.value.publicId);

    // Both audit rows are present, in the same transaction as the writes.
    const { rows: audits } = await getPool().query(
      `SELECT action FROM sandbox.audit_event
        WHERE subject_id IN ($1, $2) ORDER BY audit_id`,
      [outcome.value.quoteId, link[0]!.link_id],
    );
    expect(audits.map((a) => a.action)).toEqual(['QUOTE_ISSUE', 'LINK_CREATE']);

    // And both outbox events, keyed off this command.
    const { rows: events } = await getPool().query(
      `SELECT event_key, event_type, published_at FROM sandbox.outbox_event
        WHERE event_key LIKE $1 ORDER BY outbox_id`,
      [`${commandId}:%`],
    );
    expect(events.map((e) => e.event_type)).toEqual(['quote.issued', 'link.created']);
    expect(events.map((e) => e.event_key)).toEqual([`${commandId}:1`, `${commandId}:2`]);
    // DEL-02 emits; DEL-09 delivers. Nothing here publishes.
    expect(events.every((e) => e.published_at === null)).toBe(true);
  });

  it('leaves NO orphan quote when the command fails part-way through', async () => {
    const commandId = newCommandId();
    const marker = `crash-${unique()}`;

    await expect(
      runCommand({
        commandId,
        commandType: 'DEAL_INTENT_CREATE',
        actorId: creator.userId,
        payload: { marker },
        body: async (ctx) => {
          const created = await createDealIntentIn(ctx, creator, {
            ...dealRequest(),
            title: marker,
          });
          // Injected failure AFTER both writes have happened. This is the
          // exact window that used to strand a committed quote.
          throw new Error('injected mid-command failure');
          return created;
        },
        encodeResult: () => ({}),
        decodeResult: () => ({ publicId: '', quoteId: '' }),
      }),
    ).rejects.toThrow('injected mid-command failure');

    // Nothing survived: not the quote, not the link, not the command.
    const { rows: quotes } = await getPool().query(`SELECT 1 FROM sandbox.quote WHERE title = $1`, [
      marker,
    ]);
    expect(quotes).toHaveLength(0);
    expect(await readCommand(commandId)).toBeNull();
    const { rows: events } = await getPool().query(
      `SELECT 1 FROM sandbox.outbox_event WHERE event_key LIKE $1`,
      [`${commandId}:%`],
    );
    expect(events).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Idempotency
 * ------------------------------------------------------------------ */

describe('command idempotency', () => {
  it('replays an identical command with the original result and acts once', async () => {
    const commandId = newCommandId();
    const first = await createIntent(commandId);
    const second = await createIntent(commandId);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.publicId).toBe(first.value.publicId);
    expect(second.value.quoteId).toBe(first.value.quoteId);

    // Exactly one link and one quote exist for that command.
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.deal_link WHERE public_id = $1`,
      [first.value.publicId],
    );
    expect(rows[0]!.n).toBe(1);

    // And exactly two outbox events, not four.
    const { rows: events } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.outbox_event WHERE event_key LIKE $1`,
      [`${commandId}:%`],
    );
    expect(events[0]!.n).toBe(2);
  });

  it('refuses the same command id carrying a different payload', async () => {
    const commandId = newCommandId();
    const first = await createIntent(commandId, creator, 250_000n);
    expect(first.ok).toBe(true);

    const conflicting = await createIntent(commandId, creator, 900_000n);
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.code).toBe('IDEMPOTENCY_CONFLICT');

    // The original decision is untouched.
    const command = await readCommand(commandId);
    expect(command?.status).toBe('SUCCEEDED');

    // And the conflict itself is recorded, not merely returned.
    const { rows } = await getPool().query(
      `SELECT 1 FROM sandbox.audit_event
        WHERE outcome = 'IDEMPOTENCY_CONFLICT' AND detail->>'commandId' = $1`,
      [commandId],
    );
    expect(rows).toHaveLength(1);
  });

  it('replays a recorded REJECTION as the same rejection', async () => {
    const commandId = newCommandId();
    // ₹1.00 is below the ₹100 floor.
    const first = await createIntent(commandId, creator, 100n);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.code).toBe('AMOUNT_TOO_SMALL');

    const replay = await createIntent(commandId, creator, 100n);
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.code).toBe('AMOUNT_TOO_SMALL');

    const command = await readCommand(commandId);
    expect(command?.status).toBe('REJECTED');
    expect(command?.outcomeCode).toBe('AMOUNT_TOO_SMALL');
  });

  it('serialises concurrent duplicate submissions into exactly one execution', async () => {
    const commandId = newCommandId();
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => createIntent(commandId, creator, 310_000n)),
    );

    const succeeded = attempts.filter((a) => a.ok);
    expect(succeeded).toHaveLength(8); // every caller gets an answer
    const publicIds = new Set(succeeded.map((a) => (a.ok ? a.value.publicId : '')));
    expect(publicIds.size).toBe(1); // and it is the SAME answer

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.deal_link WHERE public_id = $1`,
      [[...publicIds][0]],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('rejects a command id that is not a UUID', async () => {
    const outcome = await createIntent('not-a-uuid');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('COMMAND_ID_INVALID');
  });
});

/* ------------------------------------------------------------------ *
 * Rejections commit; successes do not leak into rejections
 * ------------------------------------------------------------------ */

describe('the non-raising boundary pattern (TS-02 §10)', () => {
  it('commits rejection evidence in the same transaction as the refusal', async () => {
    const intent = await createIntent(newCommandId());
    expect(intent.ok).toBe(true);
    if (!intent.ok) return;

    // The creator cannot join their own link.
    const commandId = newCommandId();
    const outcome = await runCommand({
      commandId,
      commandType: 'LINK_JOIN',
      actorId: creator.userId,
      payload: { publicId: intent.value.publicId },
      body: (ctx) => joinDealLinkIn(ctx, creator, intent.value.publicId),
      encodeResult: (v) => ({ dealId: v.dealId }),
      decodeResult: (r) => ({
        kind: 'JOINED' as const,
        dealId: String(r.dealId),
        publicId: '',
        dealCode: '',
        role: 'FIAT_SIDE' as const,
      }),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('CANNOT_JOIN_OWN_LINK');

    const { rows: link } = await getPool().query(
      `SELECT link_id, state FROM sandbox.deal_link WHERE public_id = $1`,
      [intent.value.publicId],
    );
    // The refusal is durable…
    const { rows: audits } = await getPool().query(
      `SELECT outcome FROM sandbox.audit_event
        WHERE subject_id = $1 AND action = 'LINK_JOIN'`,
      [link[0]!.link_id],
    );
    expect(audits.map((a) => a.outcome)).toContain('CANNOT_JOIN_OWN_LINK');
    // …and NO domain write accompanied it.
    expect(link[0]!.state).toBe('OPEN');
    const { rows: deals } = await getPool().query(`SELECT 1 FROM sandbox.deal WHERE link_id = $1`, [
      link[0]!.link_id,
    ]);
    expect(deals).toHaveLength(0);
    // A rejection emits no domain event.
    const { rows: events } = await getPool().query(
      `SELECT 1 FROM sandbox.outbox_event WHERE event_key LIKE $1`,
      [`${commandId}:%`],
    );
    expect(events).toHaveLength(0);
  });

  it('rejection evidence survives even though the caller sees only a code', async () => {
    const before = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.audit_event WHERE outcome <> 'OK'`,
    );
    const outcome = await createIntent(newCommandId(), joiner, 50n);
    expect(outcome.ok).toBe(false);
    const after = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.audit_event WHERE outcome <> 'OK'`,
    );
    expect(after.rows[0]!.n).toBeGreaterThan(before.rows[0]!.n);
  });
});

/* ------------------------------------------------------------------ *
 * Outbox identity
 * ------------------------------------------------------------------ */

describe('outbox event identity', () => {
  it('refuses a duplicate event key', async () => {
    const commandId = newCommandId();
    await expect(
      withTransaction(async (tx) => {
        const ctx = boundaryContextFor(tx, commandId);
        await ctx.emit({ type: 'x.test', subjectKind: 'user', subjectId: creator.userId });
        // Same key, forced by reusing the sequence through a second context.
        const twin = boundaryContextFor(tx, commandId);
        await twin.emit({ type: 'x.test', subjectKind: 'user', subjectId: creator.userId });
        return accept(null);
      }),
    ).rejects.toThrow(/outbox_event_key_uq|duplicate key/i);
  });

  it('records a rejection without emitting anything', async () => {
    const commandId = newCommandId();
    const outcome = await runCommand({
      commandId,
      commandType: 'DEAL_INTENT_CREATE',
      actorId: creator.userId,
      payload: { deliberate: 'refusal' },
      body: async () => reject('AMOUNT_INVALID', 'refused on purpose'),
      encodeResult: () => ({}),
      decodeResult: () => null,
    });
    expect(outcome.ok).toBe(false);
    const { rows } = await getPool().query(
      `SELECT 1 FROM sandbox.outbox_event WHERE event_key LIKE $1`,
      [`${commandId}:%`],
    );
    expect(rows).toHaveLength(0);
  });
});
