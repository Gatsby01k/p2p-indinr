import { beforeAll, describe, expect, it } from 'vitest';
import { getPool } from '@/server/db/pool';
import { newCommandId, readCommand, runCommand } from '@/server/boundary/command';
import { createDealIntentIn, signInSandbox, type SessionUser } from '@/server/sandbox/service';
/*
 * THE APPLICATION'S OWN COMMAND LAYER — not a reconstruction of it.
 *
 * `createLinkFromForm` is the exact function `createLinkAction(FormData)`
 * calls after resolving the session, and `closeLinkCommand` is what
 * `closeLinkAction` calls. Driving them here means a bug in the form
 * parser, the command id validation or the payload shape fails these
 * tests instead of sailing past a hand-built copy.
 */
import {
  closeLinkCommand,
  createLinkFromForm,
  fundSandboxCommand,
  joinCommand,
} from '@/services/commands';
import { grantRole, permissionsFor, type Principal } from '@/server/identity/rbac';
import { makeOperator } from './support/operator';

/**
 * The two paths the CTO review found outside the boundary:
 *
 *   · the no-JavaScript create-link form, which used to issue a quote and
 *     mint a link in two separate transactions with no command record;
 *   · `closeLinkAction`, which mutated a link with no command, no replay
 *     protection and no domain event.
 *
 * Plus the ownership and namespace properties a command id must have once
 * it is carried in a form field a browser will happily resend.
 */

let owner: SessionUser;
let stranger: SessionUser;
let joiner: SessionUser;

const unique = () => Math.random().toString(36).slice(2, 10);

beforeAll(async () => {
  owner = await signInSandbox(`link-owner-${unique()}@example.com`);
  stranger = await signInSandbox(`link-stranger-${unique()}@example.com`);
  joiner = await signInSandbox(`link-joiner-${unique()}@example.com`);

  /*
   * ⚠ THE CRYPTO SIDE MUST NOW HAVE THE USDT IT IS SELLING.
   *
   * These links are `USDT_TO_INR`, so the CREATOR is the crypto side and
   * joining takes their balance into escrow. Before the escrow was wired
   * into the lifecycle, the lock was a synthetic string and an empty
   * balance joined happily — which is exactly the defect that let a buyer
   * pay rupees and receive nothing.
   *
   * Funded here rather than the assertion relaxed: a join that refuses an
   * unfunded deal is the behaviour under test everywhere else, and these
   * tests are about the LINK boundary, not about being broke.
   */
  const admin = await makeOperator(`link-admin-${unique()}@example.com`);
  await grantRole({
    userId: admin.user.userId,
    role: 'ADMIN',
    grantedBy: null,
    via: 'CLI',
    reason: 'Funding fixture, so a joined link holds real protected value.',
  });
  const ledgerAdmin: Principal = {
    ...admin.principal,
    roles: ['ADMIN'],
    permissions: permissionsFor(['ADMIN']),
  };

  // Generous on purpose: every link here is 40 USDT and the file joins
  // many of them, so a per-test top-up would be noise.
  for (const who of [owner, stranger, joiner]) {
    const funded = await fundSandboxCommand(ledgerAdmin, newCommandId(), {
      userId: who.userId,
      asset: 'USDT',
      amountMinor: 10_000_000_000n,
    });
    if (!funded.ok) throw new Error(`funding fixture: ${funded.code}`);
  }
});

/* ------------------------------------------------------------------ *
 * Helpers mirroring exactly what the actions do
 * ------------------------------------------------------------------ */

/** Build the exact `FormData` the no-JavaScript form posts. */
function noJsForm(commandId: string, usdt: string): FormData {
  const fd = new FormData();
  fd.set('commandId', commandId);
  fd.set('usdt', usdt);
  return fd;
}

/** The real no-JS entry point, parser included. */
function noJsCreate(commandId: string, usdt: string, actor: SessionUser = owner) {
  return createLinkFromForm(actor, noJsForm(commandId, usdt));
}

function closeLink(commandId: string, publicId: string, actor: SessionUser = owner) {
  return closeLinkCommand(actor, commandId, publicId);
}

async function anOpenLink(actor: SessionUser = owner): Promise<string> {
  const outcome = await noJsCreate(newCommandId(), '40', actor);
  if (!outcome.ok) throw new Error(`fixture failed: ${outcome.code}`);
  return outcome.value.publicId;
}

/* ------------------------------------------------------------------ *
 * The no-JavaScript create-link form
 * ------------------------------------------------------------------ */

describe('no-JavaScript create-link form', () => {
  it('writes quote, link, command, audit and outbox in ONE transaction', async () => {
    const commandId = newCommandId();
    const outcome = await noJsCreate(commandId, '25');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { rows } = await getPool().query(
      `SELECT l.link_id, l.state, q.state AS quote_state, q.direction
         FROM sandbox.deal_link l JOIN sandbox.quote q ON q.quote_id = l.quote_id
        WHERE l.public_id = $1`,
      [outcome.value.publicId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.direction).toBe('USDT_TO_INR');
    expect(rows[0]!.state).toBe('OPEN');
    expect(rows[0]!.quote_state).toBe('CONSUMED');

    expect((await readCommand(commandId))?.status).toBe('SUCCEEDED');

    const { rows: events } = await getPool().query(
      `SELECT event_type FROM sandbox.outbox_event WHERE event_key LIKE $1 ORDER BY outbox_id`,
      [`${commandId}:%`],
    );
    expect(events.map((e) => e.event_type)).toEqual(['quote.issued', 'link.created']);
  });

  it('replays an identical resubmission instead of creating a second deal', async () => {
    const commandId = newCommandId();
    const first = await noJsCreate(commandId, '30');
    const retry = await noJsCreate(commandId, '30');

    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(retry.value.publicId).toBe(first.value.publicId);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.deal_link
        WHERE quote_id = (SELECT quote_id FROM sandbox.deal_link WHERE public_id = $1)`,
      [first.value.publicId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('refuses the same form id carrying a different amount', async () => {
    const commandId = newCommandId();
    const first = await noJsCreate(commandId, '30');
    expect(first.ok).toBe(true);

    const conflicting = await noJsCreate(commandId, '31');
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('leaves nothing behind when it fails between the quote and the link', async () => {
    const commandId = newCommandId();
    const marker = `nojs-crash-${unique()}`;

    await expect(
      runCommand({
        commandId,
        commandType: 'DEAL_INTENT_CREATE',
        actorId: owner.userId,
        payload: { marker },
        body: async (ctx) => {
          const created = await createDealIntentIn(ctx, owner, {
            scenario: 'USDT_TO_INR',
            usdtMinor: 22_000_000n,
            intent: 'RECEIVE',
            feeBearer: 'PAYER',
            title: marker,
          });
          throw new Error('injected failure between quote and link');
          return created;
        },
        encodeResult: () => ({}),
        decodeResult: () => ({ publicId: '', quoteId: '' }),
      }),
    ).rejects.toThrow('injected failure between quote and link');

    const survivors: Array<{ label: string; sql: string; params: string[] }> = [
      { label: 'quote', sql: `SELECT 1 FROM sandbox.quote WHERE title = $1`, params: [marker] },
      {
        label: 'link',
        sql: `SELECT 1 FROM sandbox.deal_link l JOIN sandbox.quote q ON q.quote_id = l.quote_id
               WHERE q.title = $1`,
        params: [marker],
      },
      {
        label: 'outbox',
        sql: `SELECT 1 FROM sandbox.outbox_event WHERE event_key LIKE $1`,
        params: [`${commandId}:%`],
      },
    ];
    for (const { label, sql, params } of survivors) {
      const { rows } = await getPool().query(sql, params);
      expect(rows, `${label} should not survive`).toHaveLength(0);
    }
    expect(await readCommand(commandId)).toBeNull();
    // No audit artefact either — the whole transaction went.
    const { rows: audits } = await getPool().query(
      `SELECT 1 FROM sandbox.audit_event WHERE detail->>'title' = $1`,
      [marker],
    );
    expect(audits).toHaveLength(0);
  });

  it('parses the command id out of real FormData', async () => {
    const commandId = newCommandId();
    const form = noJsForm(commandId, '26');
    // The field the page renders is the field the parser reads.
    expect(form.get('commandId')).toBe(commandId);

    const outcome = await createLinkFromForm(owner, form);
    expect(outcome.ok).toBe(true);
    // …and the command was recorded under exactly that id.
    expect((await readCommand(commandId))?.status).toBe('SUCCEEDED');
  });

  it('refuses a form with no command id, and creates nothing', async () => {
    const form = new FormData();
    form.set('usdt', '26');

    /*
     * A before/after delta, not a time window: sibling tests share this
     * actor and this database, so "commands created in the last two
     * seconds" measured them too. The delta measures only this call.
     */
    const total = async () => {
      const { rows } = await getPool().query(
        `SELECT (SELECT count(*) FROM sandbox.command)  AS commands,
                (SELECT count(*) FROM sandbox.quote)    AS quotes,
                (SELECT count(*) FROM sandbox.deal_link) AS links`,
      );
      return JSON.stringify(rows[0]);
    };

    const before = await total();
    const outcome = await createLinkFromForm(owner, form);
    const after = await total();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('COMMAND_ID_INVALID');
    expect(after).toBe(before);
  });

  it('refuses a malformed command id rather than inventing one', async () => {
    for (const bad of ['', 'not-a-uuid', '123', 'INRP-0000000000']) {
      const outcome = await createLinkFromForm(owner, noJsForm(bad, '26'));
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('COMMAND_ID_INVALID');
    }
  });

  it('refuses a malformed amount without recording a command', async () => {
    const commandId = newCommandId();
    const outcome = await createLinkFromForm(owner, noJsForm(commandId, 'twenty'));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('AMOUNT_INVALID');
    // Parsing happens before the boundary, so no command row exists.
    expect(await readCommand(commandId)).toBeNull();
  });

  it('collapses concurrent duplicate submissions into one deal', async () => {
    const commandId = newCommandId();
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () => noJsCreate(commandId, '27')),
    );
    const ids = new Set(attempts.map((a) => (a.ok ? a.value.publicId : `rejected:${a.code}`)));
    expect(attempts.every((a) => a.ok)).toBe(true);
    expect(ids.size).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Closing a link
 * ------------------------------------------------------------------ */

describe('close link runs through the command boundary', () => {
  it('closes, audits and emits link.closed atomically', async () => {
    const publicId = await anOpenLink();
    const commandId = newCommandId();

    const outcome = await closeLink(commandId, publicId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.alreadyClosed).toBe(false);

    const { rows } = await getPool().query(
      `SELECT link_id, state, closed_at FROM sandbox.deal_link WHERE public_id = $1`,
      [publicId],
    );
    expect(rows[0]!.state).toBe('CLOSED');
    expect(rows[0]!.closed_at).not.toBeNull();

    const { rows: audits } = await getPool().query(
      `SELECT from_state, to_state, outcome FROM sandbox.audit_event
        WHERE subject_id = $1 AND action = 'LINK_CLOSE'`,
      [rows[0]!.link_id],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.from_state).toBe('OPEN');
    expect(audits[0]!.to_state).toBe('CLOSED');
    expect(audits[0]!.outcome).toBe('OK');

    const { rows: events } = await getPool().query(
      `SELECT event_type, subject_kind, subject_id FROM sandbox.outbox_event
        WHERE event_key LIKE $1`,
      [`${commandId}:%`],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('link.closed');
    expect(events[0]!.subject_kind).toBe('link');
    expect(events[0]!.subject_id).toBe(rows[0]!.link_id);

    expect((await readCommand(commandId))?.status).toBe('SUCCEEDED');
  });

  it('replays an identical close with the original result and no second event', async () => {
    const publicId = await anOpenLink();
    const commandId = newCommandId();

    const first = await closeLink(commandId, publicId);
    const replay = await closeLink(commandId, publicId);
    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.value).toEqual(first.value);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.outbox_event WHERE event_key LIKE $1`,
      [`${commandId}:%`],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('refuses the same close id pointed at a different link', async () => {
    const first = await anOpenLink();
    const second = await anOpenLink();
    const commandId = newCommandId();

    expect((await closeLink(commandId, first)).ok).toBe(true);
    const conflicting = await closeLink(commandId, second);
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.code).toBe('IDEMPOTENCY_CONFLICT');

    // The second link is untouched, which is the point of refusing.
    const { rows } = await getPool().query(
      `SELECT state FROM sandbox.deal_link WHERE public_id = $1`,
      [second],
    );
    expect(rows[0]!.state).toBe('OPEN');
  });

  it('refuses a caller who does not own the link, and records the refusal', async () => {
    const publicId = await anOpenLink();
    const outcome = await closeLink(newCommandId(), publicId, stranger);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_A_PARTICIPANT');

    const { rows } = await getPool().query(
      `SELECT l.state, (
         SELECT count(*)::int FROM sandbox.audit_event a
          WHERE a.subject_id = l.link_id AND a.action='LINK_CLOSE'
            AND a.outcome='NOT_A_PARTICIPANT') AS refusals
         FROM sandbox.deal_link l WHERE l.public_id = $1`,
      [publicId],
    );
    expect(rows[0]!.state).toBe('OPEN');
    expect(rows[0]!.refusals).toBe(1);
  });

  it('refuses to close a link somebody already joined', async () => {
    const publicId = await anOpenLink();
    const joined = await joinCommand(joiner, newCommandId(), publicId);
    expect(joined.ok).toBe(true);

    const outcome = await closeLink(newCommandId(), publicId);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('LINK_CONSUMED');
  });

  it('is idempotent when the link was already withdrawn', async () => {
    const publicId = await anOpenLink();
    expect((await closeLink(newCommandId(), publicId)).ok).toBe(true);

    const second = await closeLink(newCommandId(), publicId);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.alreadyClosed).toBe(true);

    // Exactly one closure was ever recorded.
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.audit_event a
         JOIN sandbox.deal_link l ON l.link_id = a.subject_id
        WHERE l.public_id = $1 AND a.action='LINK_CLOSE' AND a.outcome='OK'`,
      [publicId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('serialises concurrent closes: one closure, one event', async () => {
    const publicId = await anOpenLink();
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () => closeLink(newCommandId(), publicId)),
    );
    expect(attempts.every((a) => a.ok)).toBe(true);

    const performed = attempts.filter((a) => a.ok && a.value.alreadyClosed === false);
    expect(performed).toHaveLength(1);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.outbox_event e
         JOIN sandbox.deal_link l ON l.link_id = e.subject_id
        WHERE l.public_id = $1 AND e.event_type = 'link.closed'`,
      [publicId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('races a Join without both winning', async () => {
    const publicId = await anOpenLink();
    const [closed, joined] = await Promise.all([
      closeLink(newCommandId(), publicId),
      joinCommand(joiner, newCommandId(), publicId),
    ]);

    const closeWon = closed.ok && closed.value.alreadyClosed === false;
    const joinWon = joined.ok;
    // Exactly one of the two transitions may take the link.
    expect([closeWon, joinWon].filter(Boolean)).toHaveLength(1);

    const { rows } = await getPool().query(
      `SELECT state FROM sandbox.deal_link WHERE public_id = $1`,
      [publicId],
    );
    expect(rows[0]!.state).toBe(closeWon ? 'CLOSED' : 'CONSUMED');
  });
});

/* ------------------------------------------------------------------ *
 * Command ownership and namespace isolation
 * ------------------------------------------------------------------ */

describe('command ownership and namespace isolation', () => {
  it('does not hand another actor the original result', async () => {
    const commandId = newCommandId();
    const first = await noJsCreate(commandId, '33', owner);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Same id, same payload, different caller.
    const impostor = await noJsCreate(commandId, '33', stranger);
    expect(impostor.ok).toBe(false);
    if (impostor.ok) return;
    expect(impostor.code).toBe('COMMAND_NOT_YOURS');
    // Nothing about the original leaked into the refusal.
    expect(JSON.stringify(impostor)).not.toContain(first.value.publicId);
  });

  it('answers a stranger the same way whether or not the payload matches', async () => {
    const commandId = newCommandId();
    expect((await noJsCreate(commandId, '34', owner)).ok).toBe(true);

    const samePayload = await noJsCreate(commandId, '34', stranger);
    const otherPayload = await noJsCreate(commandId, '35', stranger);
    expect(samePayload.ok || otherPayload.ok).toBe(false);
    if (samePayload.ok || otherPayload.ok) return;
    // One answer, so the difference cannot be used as a payload oracle.
    expect(samePayload.code).toBe('COMMAND_NOT_YOURS');
    expect(otherPayload.code).toBe('COMMAND_NOT_YOURS');
  });

  it('records the ownership refusal rather than only returning it', async () => {
    const commandId = newCommandId();
    await noJsCreate(commandId, '36', owner);
    await noJsCreate(commandId, '36', stranger);

    const { rows } = await getPool().query(
      `SELECT actor_id FROM sandbox.audit_event
        WHERE outcome = 'COMMAND_NOT_YOURS' AND detail->>'commandId' = $1`,
      [commandId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe(stranger.userId);
  });

  it('rejects a command id reused for a different command type', async () => {
    const publicId = await anOpenLink();
    const commandId = newCommandId();

    const created = await noJsCreate(commandId, '37', owner);
    expect(created.ok).toBe(true);

    // Same id, same actor, different command type.
    const reused = await closeLink(commandId, publicId, owner);
    expect(reused.ok).toBe(false);
    if (reused.ok) return;
    expect(reused.code).toBe('IDEMPOTENCY_CONFLICT');

    // The link was not touched by the refused command.
    const { rows } = await getPool().query(
      `SELECT state FROM sandbox.deal_link WHERE public_id = $1`,
      [publicId],
    );
    expect(rows[0]!.state).toBe('OPEN');
  });

  it('keeps an anonymous command anonymous: a signed-in caller cannot adopt it', async () => {
    const commandId = newCommandId();
    const anonymous = await runCommand({
      commandId,
      commandType: 'SYSTEM_PROBE',
      actorId: null,
      payload: { probe: true },
      body: async () => ({ ok: true as const, value: { seen: true } }),
      encodeResult: (v) => ({ seen: v.seen }),
      decodeResult: (r) => ({ seen: r.seen === true }),
    });
    expect(anonymous.ok).toBe(true);

    const adopted = await runCommand({
      commandId,
      commandType: 'SYSTEM_PROBE',
      actorId: owner.userId,
      payload: { probe: true },
      body: async () => ({ ok: true as const, value: { seen: false } }),
      encodeResult: (v) => ({ seen: v.seen }),
      decodeResult: (r) => ({ seen: r.seen === true }),
    });
    expect(adopted.ok).toBe(false);
    if (adopted.ok) return;
    expect(adopted.code).toBe('COMMAND_NOT_YOURS');
  });

  it("keeps a signed-in caller's command out of anonymous reach", async () => {
    const commandId = newCommandId();
    expect((await noJsCreate(commandId, '38', owner)).ok).toBe(true);

    const anonymous = await runCommand({
      commandId,
      commandType: 'DEAL_INTENT_CREATE',
      actorId: null,
      payload: {
        scenario: 'USDT_TO_INR',
        usdtMinor: '38000000',
        intent: 'RECEIVE',
        feeBearer: 'PAYER',
      },
      body: async () => ({ ok: true as const, value: { publicId: 'x', quoteId: 'x' } }),
      encodeResult: (v) => ({ publicId: v.publicId, quoteId: v.quoteId }),
      decodeResult: (r) => ({ publicId: String(r.publicId), quoteId: String(r.quoteId) }),
    });
    expect(anonymous.ok).toBe(false);
    if (anonymous.ok) return;
    expect(anonymous.code).toBe('COMMAND_NOT_YOURS');
  });

  it('lets the rightful owner still replay after a stranger was refused', async () => {
    const commandId = newCommandId();
    const first = await noJsCreate(commandId, '39', owner);
    await noJsCreate(commandId, '39', stranger);
    const replay = await noJsCreate(commandId, '39', owner);

    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.value.publicId).toBe(first.value.publicId);
  });
});
