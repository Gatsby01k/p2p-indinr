import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getPool, withTransaction } from '@/server/db/pool';
import { newCommandId, readCommand } from '@/server/boundary/command';
import {
  ingestRailEventCommand,
  issuePaymentInstructionCommand,
  openPaymentIntentCommand,
  railEventCommandId,
  releaseValueCommand,
  submitPaymentEvidenceCommand,
} from '@/services/commands';
import { readInstruction } from '@/server/rails/intents';
import { expirePaymentIntents } from '@/server/rails/observations';
import type { SessionUser } from '@/server/sandbox/service';
import {
  escrowBalance,
  expireNow,
  inrEvent,
  intentState,
  liveDeal,
  lockedDeal,
  newUser,
  observationsFor,
  sign,
  txHash,
  unique,
  usdtEvent,
  utr,
} from './support/rails';

/**
 * DEL-05 payment rails.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE CLAIM UNDER TEST: NOTHING IN THIS SYSTEM SAYS MONEY MOVED     │
 * │  UNLESS SOMETHING INDEPENDENT OBSERVED IT MOVING.                  │
 * │                                                                    │
 * │  So the tests are mostly about REFUSAL. A payment confirming when  │
 * │  it should is one test. A payment refusing to confirm on a forged  │
 * │  webhook, a replayed webhook, a stale timestamp, a wrong amount, a │
 * │  wrong network, a reused reference, another deal's reference, too  │
 * │  few confirmations, or a human's word — that is the rest of the    │
 * │  file, and that is where the product's honesty actually lives.     │
 * └────────────────────────────────────────────────────────────────────┘
 */

const original = { nodeEnv: process.env.NODE_ENV, sandbox: process.env.INRP2P_SANDBOX };
function enterProduction() {
  (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
  delete process.env.INRP2P_SANDBOX;
}
function restore() {
  (process.env as Record<string, string | undefined>).NODE_ENV = original.nodeEnv;
  if (original.sandbox === undefined) delete process.env.INRP2P_SANDBOX;
  else process.env.INRP2P_SANDBOX = original.sandbox;
}
afterEach(restore);

let alice: SessionUser;
let bob: SessionUser;

beforeAll(async () => {
  alice = await newUser('rail-alice');
  bob = await newUser('rail-bob');
});

/** A locked deal with an open USDT collection intent. */
async function usdtIntent(amountMinor = 50_000n) {
  const dealId = await lockedDeal(alice, bob);
  const opened = await openPaymentIntentCommand(alice, newCommandId(), {
    dealId,
    rail: 'USDT',
    network: 'TRC20',
    direction: 'COLLECT',
    payeeId: bob.userId,
    amountMinor,
  });
  if (!opened.ok) throw new Error(`intent fixture: ${opened.code}`);
  return { dealId, intentId: opened.value.intentId, amountMinor };
}

/** The same, instructed, so an address exists to observe against. */
async function instructedUsdt(amountMinor = 50_000n) {
  const base = await usdtIntent(amountMinor);
  const issued = await issuePaymentInstructionCommand(alice, newCommandId(), {
    intentId: base.intentId,
  });
  if (!issued.ok) throw new Error(`instruction fixture: ${issued.code}`);
  return { ...base, address: issued.value.destination, reference: issued.value.reference };
}

async function instructedInr(amountMinor = 250_000n) {
  const dealId = await lockedDeal(alice, bob);
  const opened = await openPaymentIntentCommand(alice, newCommandId(), {
    dealId,
    rail: 'INR',
    network: 'UPI',
    direction: 'COLLECT',
    payeeId: bob.userId,
    amountMinor,
  });
  if (!opened.ok) throw new Error(`intent fixture: ${opened.code}`);
  const issued = await issuePaymentInstructionCommand(alice, newCommandId(), {
    intentId: opened.value.intentId,
  });
  if (!issued.ok) throw new Error(`instruction fixture: ${issued.code}`);
  return {
    dealId,
    intentId: opened.value.intentId,
    amountMinor,
    reference: issued.value.reference,
    destination: issued.value.destination,
  };
}

/* ================================================================== *
 * Instructions and the value-lock gate
 * ================================================================== */

describe('payment instructions require a live value lock', () => {
  it('are REFUSED before the value is locked', async () => {
    const dealId = await liveDeal(alice, bob);
    const opened = await openPaymentIntentCommand(alice, newCommandId(), {
      dealId,
      rail: 'USDT',
      network: 'TRC20',
      direction: 'COLLECT',
      payeeId: bob.userId,
      amountMinor: 10_000n,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const issued = await issuePaymentInstructionCommand(alice, newCommandId(), {
      intentId: opened.value.intentId,
    });
    expect(issued.ok).toBe(false);
    if (issued.ok) return;
    expect(issued.code).toBe('VALUE_NOT_LOCKED');

    // Nothing was allocated, so nobody can have been shown an address.
    const { rows } = await getPool().query(
      `SELECT 1 FROM sandbox.payment_instruction WHERE intent_id = $1`,
      [opened.value.intentId],
    );
    expect(rows).toHaveLength(0);
    expect((await intentState(opened.value.intentId)).state).toBe('REQUESTED');
  });

  it('are issued once the value is locked', async () => {
    const { intentId } = await usdtIntent();
    const issued = await issuePaymentInstructionCommand(alice, newCommandId(), { intentId });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.value.destination).toMatch(/^TSBX[1-9A-HJ-NP-Za-km-z]{30}$/);
    expect(issued.value.reference).toMatch(/^SBX-[A-Z0-9-]+$/);
    expect((await intentState(intentId)).state).toBe('INSTRUCTED');
  });

  it('STOP being readable the moment the lock is released', async () => {
    const { dealId, intentId } = await instructedUsdt();

    const before = await withTransaction((tx) => readInstruction(tx, alice.userId, intentId));
    expect(before.ok).toBe(true);

    const released = await releaseValueCommand(alice, newCommandId(), {
      dealId,
      beneficiaryId: bob.userId,
    });
    expect(released.ok).toBe(true);

    const after = await withTransaction((tx) => readInstruction(tx, alice.userId, intentId));
    expect(after.ok, 'a released lock closes the instruction').toBe(false);
    if (after.ok) return;
    expect(after.code).toBe('VALUE_NOT_LOCKED');
  });

  it('re-issuing returns the SAME destination, never a second one', async () => {
    const { intentId, address } = await instructedUsdt();
    const again = await issuePaymentInstructionCommand(alice, newCommandId(), { intentId });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.destination).toBe(address);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.usdt_address_allocation WHERE intent_id = $1`,
      [intentId],
    );
    expect(rows[0]!.n).toBe(1);
  });
});

/* ================================================================== *
 * Authorization
 * ================================================================== */

describe('only the payer may see or use a payment', () => {
  it('the COUNTERPARTY cannot read the instruction', async () => {
    const { intentId } = await instructedUsdt();
    const outcome = await withTransaction((tx) => readInstruction(tx, bob.userId, intentId));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_A_PARTICIPANT');
  });

  it('a total stranger cannot read the instruction', async () => {
    const { intentId } = await instructedUsdt();
    const outsider = await newUser('rail-outsider');
    const outcome = await withTransaction((tx) => readInstruction(tx, outsider.userId, intentId));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_A_PARTICIPANT');
  });

  it('a stranger cannot issue an instruction for somebody else’s intent', async () => {
    const { intentId } = await usdtIntent();
    const outsider = await newUser('rail-thief');
    const outcome = await issuePaymentInstructionCommand(outsider, newCommandId(), { intentId });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_A_PARTICIPANT');
  });

  it('a non-participant cannot open an intent against a deal', async () => {
    const dealId = await lockedDeal(alice, bob);
    const outsider = await newUser('rail-nobody');
    const outcome = await openPaymentIntentCommand(outsider, newCommandId(), {
      dealId,
      rail: 'USDT',
      network: 'TRC20',
      direction: 'COLLECT',
      payeeId: bob.userId,
      amountMinor: 1_000n,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_A_PARTICIPANT');
  });

  it('a user cannot submit evidence for an unrelated deal’s payment', async () => {
    const { intentId } = await instructedUsdt();
    const outsider = await newUser('rail-liar');
    const outcome = await submitPaymentEvidenceCommand(outsider, newCommandId(), {
      intentId,
      reference: txHash(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_A_PARTICIPANT');
    expect(await observationsFor(intentId)).toEqual([]);
  });
});

/* ================================================================== *
 * Production fails closed
 * ================================================================== */

describe('production has no rail and says so', () => {
  it('refuses to open an intent', async () => {
    const dealId = await lockedDeal(alice, bob);
    enterProduction();
    const outcome = await openPaymentIntentCommand(alice, newCommandId(), {
      dealId,
      rail: 'USDT',
      network: 'TRC20',
      direction: 'COLLECT',
      payeeId: bob.userId,
      amountMinor: 1_000n,
    });
    restore();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('ADAPTER_UNAVAILABLE');
  });

  it('refuses to issue an instruction', async () => {
    const { intentId } = await usdtIntent();
    enterProduction();
    const outcome = await issuePaymentInstructionCommand(alice, newCommandId(), { intentId });
    restore();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('ADAPTER_UNAVAILABLE');
  });

  it('refuses to hand out a webhook signing key rather than using the sandbox one', async () => {
    const { webhookSecretFor } = await import('@/server/adapters/railSecrets');
    enterProduction();
    expect(() => webhookSecretFor('sandbox-inr')).toThrow(/No production adapter/);
    restore();
    expect(webhookSecretFor('sandbox-inr')).toContain('not-a-secret');
  });

  it('refuses to allocate a custody address or an INR destination', async () => {
    const { getUsdtRailAdapter } = await import('@/server/adapters/usdtRail');
    const { getInrRailAdapter } = await import('@/server/adapters/inrRail');
    enterProduction();
    expect(() => getUsdtRailAdapter()).toThrow(/nobody holds the keys/);
    expect(() => getInrRailAdapter()).toThrow(/no bank will honour/);
    restore();
  });

  it('marks every sandbox destination and reference as fictitious', async () => {
    const { address, reference } = await instructedUsdt();
    expect(address.startsWith('TSBX')).toBe(true);
    expect(reference.startsWith('SBX-')).toBe(true);

    const inr = await instructedInr();
    expect(inr.reference.startsWith('SBX-')).toBe(true);
    expect(inr.destination).toMatch(/@sbxbank$/);
  });
});

/* ================================================================== *
 * Webhook authenticity
 * ================================================================== */

describe('a provider event is believed only when it verifies', () => {
  it('accepts a genuine signature and confirms', async () => {
    const { intentId, address, amountMinor, dealId } = await instructedUsdt();
    // The deal escrow already holds the DEL-04 lock; the deposit adds to
    // it, so the delta is what this test is about.
    const before = await escrowBalance(dealId);
    const event = usdtEvent({ address, amountMinor: amountMinor.toString() });
    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', event), event);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.state).toBe('CONFIRMED');
    expect(BigInt(await escrowBalance(dealId)) - BigInt(before)).toBe(amountMinor);
    expect((await intentState(intentId)).ledgerEntryId).not.toBeNull();
  });

  it('REFUSES a forged signature', async () => {
    const { intentId, address, amountMinor } = await instructedUsdt();
    const event = usdtEvent({ address, amountMinor: amountMinor.toString() });
    const forged = sign('sandbox-usdt', event, { signature: 'a'.repeat(64) });

    const outcome = await ingestRailEventCommand(forged, event);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('WEBHOOK_UNVERIFIED');
    expect((await intentState(intentId)).state).toBe('INSTRUCTED');
    expect(await observationsFor(intentId)).toEqual([]);
  });

  it('REFUSES a body tampered with after signing', async () => {
    const { intentId, address, amountMinor } = await instructedUsdt();
    const event = usdtEvent({ address, amountMinor: amountMinor.toString() });
    const outcome = await ingestRailEventCommand(
      sign('sandbox-usdt', event, { tamperBody: true }),
      event,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('WEBHOOK_UNVERIFIED');
    expect((await intentState(intentId)).state).toBe('INSTRUCTED');
  });

  it('REFUSES a stale timestamp even with a valid signature', async () => {
    const { intentId, address, amountMinor } = await instructedUsdt();
    const event = usdtEvent({ address, amountMinor: amountMinor.toString() });
    const old = new Date(Date.now() - 3600_000);
    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', event, { at: old }), event);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('WEBHOOK_UNVERIFIED');
    expect((await intentState(intentId)).state).toBe('INSTRUCTED');
  });

  it('REFUSES a timestamp from the future', async () => {
    const { address, amountMinor } = await instructedUsdt();
    const event = usdtEvent({ address, amountMinor: amountMinor.toString() });
    const ahead = new Date(Date.now() + 3600_000);
    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', event, { at: ahead }), event);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('WEBHOOK_UNVERIFIED');
  });

  it('REFUSES a missing or malformed signature header', async () => {
    const { address, amountMinor } = await instructedUsdt();
    const event = usdtEvent({ address, amountMinor: amountMinor.toString() });
    const base = sign('sandbox-usdt', event);

    for (const header of [null, '', 'not-hex', 'ab']) {
      const outcome = await ingestRailEventCommand(
        { ...base, signatureHeader: header },
        { ...event, providerEventId: `evt-${unique()}` },
      );
      expect(outcome.ok, String(header)).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('WEBHOOK_UNVERIFIED');
    }
  });

  it('gives ONE answer for every authenticity failure', async () => {
    const { address, amountMinor } = await instructedUsdt();
    const event = usdtEvent({ address, amountMinor: amountMinor.toString() });

    const forged = await ingestRailEventCommand(
      sign('sandbox-usdt', event, { signature: 'b'.repeat(64) }),
      { ...event, providerEventId: `evt-${unique()}` },
    );
    const stale = await ingestRailEventCommand(
      sign('sandbox-usdt', event, { at: new Date(Date.now() - 3600_000) }),
      { ...event, providerEventId: `evt-${unique()}` },
    );

    expect(forged.ok || stale.ok).toBe(false);
    if (forged.ok || stale.ok) return;
    // A forger must not learn WHICH part of the forgery failed.
    expect(forged.code).toBe(stale.code);
    expect(forged.message).toBe(stale.message);
  });

  it('records every refused delivery for investigation', async () => {
    const { address, amountMinor } = await instructedUsdt();
    const providerEventId = `probe-${unique()}`;
    const event = usdtEvent({ address, amountMinor: amountMinor.toString(), providerEventId });
    await ingestRailEventCommand(sign('sandbox-usdt', event, { signature: 'c'.repeat(64) }), event);

    const { rows } = await getPool().query(
      `SELECT accepted, signature_verified, refusal_code FROM sandbox.rail_event
        WHERE provider_event_id = $1`,
      [providerEventId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accepted).toBe(false);
    expect(rows[0]!.signature_verified).toBe(false);
    expect(rows[0]!.refusal_code).toBe('SIGNATURE_INVALID');
  });
});

/* ================================================================== *
 * Replay and concurrency
 * ================================================================== */

describe('a redelivered event changes nothing', () => {
  it('applies once and reports the replay thereafter', async () => {
    const { intentId, dealId, address, amountMinor } = await instructedUsdt();
    const providerEventId = `evt-${unique()}`;
    const event = usdtEvent({ address, amountMinor: amountMinor.toString(), providerEventId });
    const delivery = sign('sandbox-usdt', event);

    const first = await ingestRailEventCommand(delivery, event);
    expect(first.ok).toBe(true);
    const escrowAfterFirst = await escrowBalance(dealId);

    const second = await ingestRailEventCommand(delivery, event);
    expect(second.ok).toBe(true); // The DEL-02 boundary replays the record.
    const third = await ingestRailEventCommand(sign('sandbox-usdt', event), event);
    expect(third.ok).toBe(true);

    expect(await escrowBalance(dealId)).toBe(escrowAfterFirst);
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM inrp2p.journal_entry
        WHERE journal_code = 'JD-DEP-CONFIRM' AND entry_key_json->>'intentId' = $1`,
      [intentId],
    );
    expect(rows[0]!.n, 'exactly one ledger entry per intent').toBe(1);
  });

  it('refuses a replayed event id carrying a DIFFERENT body', async () => {
    const { address, amountMinor } = await instructedUsdt();
    const providerEventId = `evt-${unique()}`;
    const event = usdtEvent({ address, amountMinor: amountMinor.toString(), providerEventId });
    const first = await ingestRailEventCommand(sign('sandbox-usdt', event), event);
    expect(first.ok).toBe(true);

    // Same id, different content: not a redelivery, an edit.
    const edited = { ...event, amountMinor: (amountMinor + 1n).toString() };
    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', edited), edited);
    expect(outcome.ok, 'an edited body is not a redelivery').toBe(false);
    if (outcome.ok) return;
    // Refused by the COMMAND boundary, before the body ever runs: the
    // payload hash covers the delivery's bytes.
    expect(outcome.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('two SIMULTANEOUS deliveries confirm once and post once', async () => {
    const { intentId, dealId, address, amountMinor } = await instructedUsdt();
    const escrowBefore = await escrowBalance(dealId);
    const eventA = usdtEvent({ address, amountMinor: amountMinor.toString() });
    const eventB = { ...eventA, providerEventId: `evt-${unique()}` };

    const [a, b] = await Promise.all([
      ingestRailEventCommand(sign('sandbox-usdt', eventA), eventA),
      ingestRailEventCommand(sign('sandbox-usdt', eventB), eventB),
    ]);

    // Both are recorded as reports; exactly one may APPLY.
    const applied = [a, b].filter((r) => r.ok && r.value.matchOutcome === 'APPLIED_CONFIRMED');
    expect(applied).toHaveLength(1);
    const duplicate = [a, b].find((r) => r.ok && r.value.matchOutcome !== 'APPLIED_CONFIRMED');
    expect(duplicate, 'the loser is recorded, not lost').toBeDefined();

    expect((await intentState(intentId)).state).toBe('CONFIRMED');
    expect(BigInt(await escrowBalance(dealId)) - BigInt(escrowBefore)).toBe(amountMinor);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM inrp2p.journal_entry
        WHERE journal_code='JD-DEP-CONFIRM' AND entry_key_json->>'intentId' = $1`,
      [intentId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('derives the same command id for the same delivery', () => {
    const a = railEventCommandId('p', 'e-1');
    const b = railEventCommandId('p', 'e-1');
    const c = railEventCommandId('p', 'e-2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

/* ================================================================== *
 * Terms must agree
 * ================================================================== */

describe('an event whose terms disagree settles nothing', () => {
  it('refuses a wrong amount and records why', async () => {
    const { intentId, dealId, amountMinor, address } = await instructedUsdt();
    const before = await escrowBalance(dealId);
    const event = usdtEvent({ address, amountMinor: (amountMinor - 1n).toString() });

    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', event), event);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('AMOUNT_MISMATCH');
    expect((await intentState(intentId)).state).toBe('INSTRUCTED');
    expect(await escrowBalance(dealId)).toBe(before);

    const observations = await observationsFor(intentId);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      matchOutcome: 'REFUSED_AMOUNT_MISMATCH',
      accepted: false,
    });
  });

  it('refuses an OVERPAYMENT just as firmly as an underpayment', async () => {
    const { intentId, amountMinor, address } = await instructedUsdt();
    const event = usdtEvent({ address, amountMinor: (amountMinor + 100n).toString() });
    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', event), event);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('AMOUNT_MISMATCH');
    expect((await intentState(intentId)).state).toBe('INSTRUCTED');
  });

  it('refuses a wrong asset', async () => {
    const { intentId, amountMinor, address } = await instructedUsdt();
    const event = { ...usdtEvent({ address, amountMinor: amountMinor.toString() }), asset: 'TRX' };
    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', event), event);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('ASSET_MISMATCH');
    expect((await intentState(intentId)).state).toBe('INSTRUCTED');
  });

  it('refuses a NETWORK that does not belong to the rail', async () => {
    const { intentId, amountMinor, address } = await instructedUsdt();
    const event = usdtEvent({ address, amountMinor: amountMinor.toString(), network: 'UPI' });
    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', event), event);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NETWORK_INVALID');
    expect((await intentState(intentId)).state).toBe('INSTRUCTED');
  });

  it('refuses an INR beneficiary that is not the one we issued', async () => {
    const { intentId, amountMinor, reference } = await instructedInr();
    const event = inrEvent({
      reference,
      amountMinor: amountMinor.toString(),
      beneficiaryAccount: 'someone.else@otherbank',
    });
    const outcome = await ingestRailEventCommand(sign('sandbox-inr', event), event);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('BENEFICIARY_MISMATCH');
    expect((await intentState(intentId)).state).toBe('INSTRUCTED');
  });

  it('refuses an event that names nothing we issued', async () => {
    const event = usdtEvent({ address: `TSBX${'2'.repeat(30)}`, amountMinor: '1000' });
    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', event), event);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('OBSERVATION_UNMATCHED');

    // Recorded anyway — an unmatched payment is a support case, not a
    // thing to forget.
    const { rows } = await getPool().query(
      `SELECT match_outcome, accepted FROM sandbox.payment_observation
        WHERE external_ref = $1`,
      [event.reference],
    );
    expect(rows[0]).toMatchObject({ match_outcome: 'UNMATCHED_NO_INTENT', accepted: false });
  });

  it('refuses a malformed reference', async () => {
    const { address, amountMinor } = await instructedUsdt();
    const event = {
      ...usdtEvent({ address, amountMinor: amountMinor.toString() }),
      reference: 'xyz',
    };
    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', event), event);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('REFERENCE_INVALID');
  });
});

/* ================================================================== *
 * Reference uniqueness
 * ================================================================== */

describe('one reference identifies one movement', () => {
  it('refuses the same transaction hash across two deals', async () => {
    const first = await instructedUsdt();
    const second = await instructedUsdt();
    const hash = txHash();

    const eventA = usdtEvent({
      address: first.address,
      amountMinor: first.amountMinor.toString(),
      hash,
    });
    expect((await ingestRailEventCommand(sign('sandbox-usdt', eventA), eventA)).ok).toBe(true);

    const eventB = usdtEvent({
      address: second.address,
      amountMinor: second.amountMinor.toString(),
      hash,
    });
    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', eventB), eventB);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('REFERENCE_ALREADY_USED');
    expect((await intentState(second.intentId)).state).toBe('INSTRUCTED');
    expect((await intentState(second.intentId)).ledgerEntryId).toBeNull();
  });

  it('refuses the same UTR across two deals', async () => {
    const first = await instructedInr();
    const second = await instructedInr();
    const reused = utr();

    const eventA = inrEvent({
      reference: first.reference,
      amountMinor: first.amountMinor.toString(),
      utr: reused,
      beneficiaryAccount: first.destination,
    });
    expect((await ingestRailEventCommand(sign('sandbox-inr', eventA), eventA)).ok).toBe(true);

    const eventB = inrEvent({
      reference: second.reference,
      amountMinor: second.amountMinor.toString(),
      utr: reused,
      beneficiaryAccount: second.destination,
    });
    const outcome = await ingestRailEventCommand(sign('sandbox-inr', eventB), eventB);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('REFERENCE_ALREADY_USED');
  });

  it('normalizes case and prefix before deciding uniqueness', async () => {
    const first = await instructedUsdt();
    const second = await instructedUsdt();
    const hash = txHash();

    const eventA = usdtEvent({
      address: first.address,
      amountMinor: first.amountMinor.toString(),
      hash,
    });
    expect((await ingestRailEventCommand(sign('sandbox-usdt', eventA), eventA)).ok).toBe(true);

    // Same hash, written the way a different explorer writes it.
    const eventB = usdtEvent({
      address: second.address,
      amountMinor: second.amountMinor.toString(),
      hash: `0x${hash.toUpperCase()}`,
    });
    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', eventB), eventB);
    expect(outcome.ok, 'a re-cased 0x-prefixed hash is the SAME hash').toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('REFERENCE_ALREADY_USED');
  });

  it('allocates each deal its own address and never reuses one', async () => {
    const a = await instructedUsdt();
    const b = await instructedUsdt();
    expect(a.address).not.toBe(b.address);

    await expect(
      withTransaction((tx) =>
        tx.query(
          `INSERT INTO sandbox.usdt_address_allocation
             (address, network, deal_id, owner_id, intent_id)
           VALUES ($1,'TRC20',$2,$3,$4)`,
          [a.address, b.dealId, alice.userId, b.intentId],
        ),
      ),
    ).rejects.toThrow(/usdt_address_uq|duplicate key/i);
  });
});

/* ================================================================== *
 * Confirmation policy, ordering and reorgs
 * ================================================================== */

describe('finality is a policy, not a sighting', () => {
  it('does NOT settle below the confirmation threshold', async () => {
    const { intentId, dealId, address, amountMinor } = await instructedUsdt();
    const before = await escrowBalance(dealId);
    const event = usdtEvent({
      address,
      amountMinor: amountMinor.toString(),
      confirmations: 3,
    });

    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', event), event);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('CONFIRMATIONS_INSUFFICIENT');
    expect(outcome.detail).toMatchObject({ confirmations: 3, required: 19 });

    // It IS acknowledged as seen — the payer should know it arrived.
    expect((await intentState(intentId)).state).toBe('OBSERVED');
    expect(await escrowBalance(dealId)).toBe(before);
  });

  it('settles once the threshold is reached', async () => {
    const { intentId, dealId, address, amountMinor } = await instructedUsdt();
    const before = await escrowBalance(dealId);
    const pending = usdtEvent({ address, amountMinor: amountMinor.toString(), confirmations: 1 });
    await ingestRailEventCommand(sign('sandbox-usdt', pending), pending);

    const confirmed = usdtEvent({
      address,
      amountMinor: amountMinor.toString(),
      hash: pending.reference,
      confirmations: 19,
    });
    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', confirmed), confirmed);
    expect(outcome.ok).toBe(true);
    expect((await intentState(intentId)).state).toBe('CONFIRMED');
    expect(BigInt(await escrowBalance(dealId)) - BigInt(before)).toBe(amountMinor);
  });

  it('treats a PENDING status as not settled whatever the count says', async () => {
    const { intentId, address, amountMinor } = await instructedUsdt();
    const event = usdtEvent({
      address,
      amountMinor: amountMinor.toString(),
      status: 'PENDING',
      confirmations: 500,
    });
    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', event), event);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('CONFIRMATIONS_INSUFFICIENT');
    expect((await intentState(intentId)).state).toBe('OBSERVED');
  });

  it('a REORG reverses the ledger entry instead of erasing it', async () => {
    const { intentId, dealId, address, amountMinor } = await instructedUsdt();
    const confirmed = usdtEvent({ address, amountMinor: amountMinor.toString() });
    const applied = await ingestRailEventCommand(sign('sandbox-usdt', confirmed), confirmed);
    expect(applied.ok).toBe(true);
    const escrowAfterDeposit = await escrowBalance(dealId);

    const reorg = usdtEvent({
      address,
      amountMinor: amountMinor.toString(),
      hash: confirmed.reference,
      status: 'REORGED',
    });
    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', reorg), reorg);
    expect(outcome.ok).toBe(true);

    const after = await intentState(intentId);
    expect(after.state).toBe('REVERSED');
    expect(after.reversalEntryId).not.toBeNull();
    expect(after.ledgerEntryId, 'the original entry is NOT erased').not.toBeNull();

    // The escrow went back down by exactly the deposit.
    expect(BigInt(escrowAfterDeposit) - BigInt(await escrowBalance(dealId))).toBe(amountMinor);

    // BOTH entries remain in the journal.
    const { rows } = await getPool().query(
      `SELECT journal_code FROM inrp2p.journal_entry
        WHERE entry_id IN ($1,$2) ORDER BY journal_code`,
      [after.ledgerEntryId, after.reversalEntryId],
    );
    expect(rows.map((r) => r.journal_code)).toEqual(['JD-DEP-CONFIRM', 'JD-REVERSAL']);
  });

  it('a reorg for a payment that never confirmed changes nothing', async () => {
    const { intentId, address, amountMinor } = await instructedUsdt();
    const reorg = usdtEvent({
      address,
      amountMinor: amountMinor.toString(),
      status: 'REORGED',
    });
    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', reorg), reorg);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.matchOutcome).toBe('APPLIED_REORG_NOOP');
    expect((await intentState(intentId)).state).toBe('INSTRUCTED');
  });

  it('a provider FAILURE report closes the payment without posting', async () => {
    const { intentId, dealId, address, amountMinor } = await instructedUsdt();
    const before = await escrowBalance(dealId);
    const failed = usdtEvent({
      address,
      amountMinor: amountMinor.toString(),
      status: 'FAILED',
    });
    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', failed), failed);
    expect(outcome.ok).toBe(true);

    const after = await intentState(intentId);
    expect(after.state).toBe('FAILED');
    expect(after.ledgerEntryId).toBeNull();
    expect(await escrowBalance(dealId)).toBe(before);
  });

  it('a confirmation arriving AFTER expiry posts nothing', async () => {
    const { intentId, dealId, address, amountMinor } = await instructedUsdt();
    const before = await escrowBalance(dealId);
    await expireNow(intentId);
    await withTransaction((tx) => expirePaymentIntents(tx));
    expect((await intentState(intentId)).state).toBe('EXPIRED');

    const late = usdtEvent({ address, amountMinor: amountMinor.toString() });
    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', late), late);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PAYMENT_INTENT_TERMINAL');

    const after = await intentState(intentId);
    expect(after.state).toBe('EXPIRED');
    expect(after.ledgerEntryId).toBeNull();
    expect(await escrowBalance(dealId)).toBe(before);
  });

  it('a failure report AFTER settlement is refused, not obeyed', async () => {
    const { intentId, address, amountMinor } = await instructedUsdt();
    const confirmed = usdtEvent({ address, amountMinor: amountMinor.toString() });
    expect((await ingestRailEventCommand(sign('sandbox-usdt', confirmed), confirmed)).ok).toBe(
      true,
    );

    const contradiction = usdtEvent({
      address,
      amountMinor: amountMinor.toString(),
      status: 'FAILED',
    });
    const outcome = await ingestRailEventCommand(
      sign('sandbox-usdt', contradiction),
      contradiction,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PAYMENT_INTENT_TERMINAL');
    expect((await intentState(intentId)).state).toBe('CONFIRMED');
  });
});

/* ================================================================== *
 * Client evidence
 * ================================================================== */

describe('what a human types is evidence and never settlement', () => {
  it('is recorded, and settles nothing', async () => {
    const { intentId, dealId } = await instructedUsdt();
    const before = await escrowBalance(dealId);

    const outcome = await submitPaymentEvidenceCommand(alice, newCommandId(), {
      intentId,
      reference: txHash(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.settles).toBe(false);

    expect((await intentState(intentId)).state).toBe('INSTRUCTED');
    expect((await intentState(intentId)).ledgerEntryId).toBeNull();
    expect(await escrowBalance(dealId)).toBe(before);

    const observations = await observationsFor(intentId);
    expect(observations).toEqual([
      {
        source: 'CLIENT_EVIDENCE',
        kind: 'PENDING',
        matchOutcome: 'EVIDENCE_ONLY_NOT_SETTLING',
        accepted: false,
      },
    ]);
  });

  it('cannot be forged into an authoritative observation', async () => {
    const { intentId } = await instructedUsdt();
    // The database itself refuses a client row that claims finality.
    await expect(
      withTransaction((tx) =>
        tx.query(
          `INSERT INTO sandbox.payment_observation
             (intent_id, rail, network, source, kind, submitted_by, external_ref,
              asset, amount_minor, observed_at, match_outcome, accepted)
           VALUES ($1,'USDT','TRC20','CLIENT_EVIDENCE','CONFIRMED',$2,$3,'USDT',1,
                   now(),'forged',TRUE)`,
          [intentId, alice.userId, txHash()],
        ),
      ),
    ).rejects.toThrow(/client_not_confirming|check constraint/i);
  });

  it('cannot claim itself an authoritative source without a verified delivery', async () => {
    const { intentId } = await instructedUsdt();
    await expect(
      withTransaction((tx) =>
        tx.query(
          `INSERT INTO sandbox.payment_observation
             (intent_id, rail, network, source, kind, external_ref, asset,
              amount_minor, observed_at, match_outcome, accepted)
           VALUES ($1,'USDT','TRC20','CHAIN_WATCHER','CONFIRMED',$2,'USDT',1,
                   now(),'forged',TRUE)`,
          [intentId, txHash()],
        ),
      ),
    ).rejects.toThrow(/observation_authority|check constraint/i);
  });

  it('refuses evidence naming a reference another payment already used', async () => {
    const first = await instructedUsdt();
    const second = await instructedUsdt();
    const hash = txHash();
    const event = usdtEvent({
      address: first.address,
      amountMinor: first.amountMinor.toString(),
      hash,
    });
    expect((await ingestRailEventCommand(sign('sandbox-usdt', event), event)).ok).toBe(true);

    const outcome = await submitPaymentEvidenceCommand(alice, newCommandId(), {
      intentId: second.intentId,
      reference: hash,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('REFERENCE_ALREADY_USED');
  });

  it('refuses evidence before an instruction exists', async () => {
    const { intentId } = await usdtIntent();
    const outcome = await submitPaymentEvidenceCommand(alice, newCommandId(), {
      intentId,
      reference: txHash(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PAYMENT_NOT_INSTRUCTED');
  });
});

/* ================================================================== *
 * The state machine
 * ================================================================== */

describe('the database refuses an impossible transition', () => {
  it('will not move a CONFIRMED payment back to INSTRUCTED', async () => {
    const { intentId, address, amountMinor } = await instructedUsdt();
    const event = usdtEvent({ address, amountMinor: amountMinor.toString() });
    expect((await ingestRailEventCommand(sign('sandbox-usdt', event), event)).ok).toBe(true);

    await expect(
      withTransaction((tx) =>
        tx.query(`UPDATE sandbox.payment_intent SET state='INSTRUCTED' WHERE intent_id=$1`, [
          intentId,
        ]),
      ),
    ).rejects.toThrow(/cannot move from CONFIRMED to INSTRUCTED/);
  });

  it('will not re-point a live intent at another deal or amount', async () => {
    const { intentId } = await instructedUsdt();
    const otherDeal = await lockedDeal(alice, bob);

    await expect(
      withTransaction((tx) =>
        tx.query(`UPDATE sandbox.payment_intent SET deal_id=$2 WHERE intent_id=$1`, [
          intentId,
          otherDeal,
        ]),
      ),
    ).rejects.toThrow(/immutable in its terms/);

    await expect(
      withTransaction((tx) =>
        tx.query(`UPDATE sandbox.payment_intent SET amount_minor=1 WHERE intent_id=$1`, [intentId]),
      ),
    ).rejects.toThrow(/immutable in its terms/);
  });

  it('will not let a FAILED payment carry a ledger entry', async () => {
    const { intentId, address, amountMinor } = await instructedUsdt();
    const failed = usdtEvent({ address, amountMinor: amountMinor.toString(), status: 'FAILED' });
    expect((await ingestRailEventCommand(sign('sandbox-usdt', failed), failed)).ok).toBe(true);

    await expect(
      withTransaction((tx) =>
        tx.query(
          `UPDATE sandbox.payment_intent SET ledger_entry_id=gen_random_uuid()
            WHERE intent_id=$1`,
          [intentId],
        ),
      ),
    ).rejects.toThrow(/entry_only_when_confirmed|check constraint/i);
  });

  it('will not let an observation or a delivery be edited after the fact', async () => {
    const { intentId, address, amountMinor } = await instructedUsdt();
    const event = usdtEvent({ address, amountMinor: amountMinor.toString() });
    expect((await ingestRailEventCommand(sign('sandbox-usdt', event), event)).ok).toBe(true);

    await expect(
      withTransaction((tx) =>
        tx.query(`UPDATE sandbox.payment_observation SET amount_minor = 1 WHERE intent_id = $1`, [
          intentId,
        ]),
      ),
    ).rejects.toThrow(/append-only/);

    await expect(
      withTransaction((tx) => tx.query(`DELETE FROM sandbox.rail_event`)),
    ).rejects.toThrow(/append-only/);
  });

  it('will not allow a second live intent for the same deal and rail', async () => {
    const { dealId } = await usdtIntent();
    const outcome = await openPaymentIntentCommand(alice, newCommandId(), {
      dealId,
      rail: 'USDT',
      network: 'TRC20',
      direction: 'COLLECT',
      payeeId: bob.userId,
      amountMinor: 999n,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PAYMENT_INTENT_EXISTS');
  });
});

/* ================================================================== *
 * Atomicity
 * ================================================================== */

describe('payment, ledger, audit and outbox commit together', () => {
  it('a confirmation writes all four', async () => {
    const { intentId, address, amountMinor } = await instructedUsdt();
    const event = usdtEvent({ address, amountMinor: amountMinor.toString() });
    const commandId = railEventCommandId('sandbox-usdt', event.providerEventId);

    expect((await ingestRailEventCommand(sign('sandbox-usdt', event), event)).ok).toBe(true);

    expect((await readCommand(commandId))?.status).toBe('SUCCEEDED');
    expect((await intentState(intentId)).ledgerEntryId).not.toBeNull();

    const { rows: audits } = await getPool().query(
      `SELECT outcome FROM sandbox.audit_event
        WHERE subject_kind='payment' AND subject_id=$1 AND action='RAIL_EVENT_INGEST'`,
      [intentId],
    );
    expect(audits.map((a) => a.outcome)).toEqual(['OK']);

    const { rows: events } = await getPool().query(
      `SELECT event_type FROM sandbox.outbox_event WHERE event_key LIKE $1`,
      [`${commandId}:%`],
    );
    expect(events.map((e) => e.event_type)).toEqual(['payment.confirmed']);
  });

  it('an injected failure after the ledger write leaves NOTHING', async () => {
    const { intentId, dealId, address, amountMinor } = await instructedUsdt();
    const before = await escrowBalance(dealId);
    const event = usdtEvent({ address, amountMinor: amountMinor.toString() });
    const commandId = newCommandId();

    const { runCommand } = await import('@/server/boundary/command');
    const { ingestProviderEvent } = await import('@/server/rails/observations');

    await expect(
      runCommand({
        commandId,
        commandType: 'RAIL_EVENT_INGEST',
        actorId: null,
        payload: { probe: event.providerEventId },
        body: async (ctx) => {
          const ingested = await ingestProviderEvent(ctx.tx, sign('sandbox-usdt', event), event);
          // The observation, the ledger entry, the balance update and the
          // intent transition all exist at this instant.
          throw new Error('injected failure after the ledger write');
          return ingested;
        },
        encodeResult: () => ({}),
        decodeResult: () => null,
      }),
    ).rejects.toThrow('injected failure after the ledger write');

    expect(await escrowBalance(dealId)).toBe(before);
    expect((await intentState(intentId)).state).toBe('INSTRUCTED');
    expect(await readCommand(commandId)).toBeNull();
    expect(await observationsFor(intentId)).toEqual([]);

    const { rows } = await getPool().query(
      `SELECT 1 FROM sandbox.rail_event WHERE provider_event_id = $1`,
      [event.providerEventId],
    );
    expect(rows, 'even the delivery record rolled back').toHaveLength(0);
  });

  it('a refused event still commits its evidence', async () => {
    const { intentId, amountMinor, address } = await instructedUsdt();
    const event = usdtEvent({ address, amountMinor: (amountMinor + 5n).toString() });
    const commandId = railEventCommandId('sandbox-usdt', event.providerEventId);

    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', event), event);
    expect(outcome.ok).toBe(false);

    // The refusal is durable and auditable: the transaction COMMITTED.
    expect((await readCommand(commandId))?.outcomeCode).toBe('AMOUNT_MISMATCH');
    expect(await observationsFor(intentId)).toHaveLength(1);
    const { rows } = await getPool().query(
      `SELECT accepted FROM sandbox.rail_event WHERE provider_event_id = $1`,
      [event.providerEventId],
    );
    expect(rows[0]!.accepted).toBe(true);
  });
});

/* ================================================================== *
 * Redaction
 * ================================================================== */

describe('sensitive detail does not leak into the trail', () => {
  it('the audit row and outbox event carry a redacted destination', async () => {
    const { intentId, address } = await instructedUsdt();

    const { rows: audits } = await getPool().query(
      `SELECT detail FROM sandbox.audit_event
        WHERE subject_id=$1 AND action='PAYMENT_INSTRUCTION_ISSUE' AND outcome='OK'`,
      [intentId],
    );
    const detail = audits[0]!.detail as Record<string, unknown>;
    expect(detail.destination).not.toBe(address);
    expect(String(detail.destination)).toContain('*');

    const { rows: events } = await getPool().query(
      `SELECT payload FROM sandbox.outbox_event
        WHERE subject_id=$1 AND event_type='payment.instruction_issued'`,
      [intentId],
    );
    expect((events[0]!.payload as Record<string, unknown>).destination).not.toBe(address);
  });

  it('a submitted reference is redacted in the audit trail', async () => {
    const { intentId } = await instructedUsdt();
    const reference = txHash();
    expect(
      (await submitPaymentEvidenceCommand(alice, newCommandId(), { intentId, reference })).ok,
    ).toBe(true);

    const { rows } = await getPool().query(
      `SELECT detail FROM sandbox.audit_event
        WHERE subject_id=$1 AND action='PAYMENT_EVIDENCE_SUBMIT' AND outcome='OK'`,
      [intentId],
    );
    const logged = String((rows[0]!.detail as Record<string, unknown>).reference);
    expect(logged).not.toBe(reference.toUpperCase());
    expect(logged).toContain('*');
  });

  it('the reconciliation view exposes no destination at all', async () => {
    await instructedUsdt();
    const { rows } = await getPool().query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='sandbox' AND table_name='payment_reconciliation'`,
    );
    const columns = rows.map((r) => r.column_name as string);
    expect(columns).not.toContain('destination');
    expect(columns).not.toContain('destination_detail');
  });
});
