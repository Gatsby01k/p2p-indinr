import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fundForDeals, clearRiskCounters } from './support/escrow';
import { getPool } from '@/server/db/pool';
import { newCommandId } from '@/server/boundary/command';
import { AdapterUnavailableError } from '@/server/adapters/mode';
import { signInSandbox, type SessionUser } from '@/server/sandbox/service';
import { createDealCommand, joinCommand } from '@/services/commands';

/**
 * Fail-closed behaviour in production mode.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE PROPERTY UNDER TEST IS THE ABSENCE OF ARTEFACTS.              │
 * │                                                                    │
 * │  It is not enough that production "refuses". A refusal that        │
 * │  commits a REJECTED command row, or an audit row, or — worst — a   │
 * │  quote priced from a sandbox constant, has still written           │
 * │  something. Each case below counts rows before and after and       │
 * │  requires the delta to be exactly zero.                            │
 * └────────────────────────────────────────────────────────────────────┘
 */

let alice: SessionUser;
let bob: SessionUser;

const unique = () => Math.random().toString(36).slice(2, 10);

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

beforeAll(async () => {
  // Accounts are created while the deployment is still a sandbox: in
  // production the identity path itself refuses, which is DEL-02's other
  // containment guarantee and is covered separately.
  alice = await signInSandbox(`fc-alice-${unique()}@example.com`);
  bob = await signInSandbox(`fc-bob-${unique()}@example.com`);
});

interface Counts {
  commands: number;
  quotes: number;
  links: number;
  audits: number;
  outbox: number;
}

async function counts(): Promise<Counts> {
  const { rows } = await getPool().query(`
    SELECT (SELECT count(*) FROM sandbox.command)      AS commands,
           (SELECT count(*) FROM sandbox.quote)        AS quotes,
           (SELECT count(*) FROM sandbox.deal_link)    AS links,
           (SELECT count(*) FROM sandbox.audit_event)  AS audits,
           (SELECT count(*) FROM sandbox.outbox_event) AS outbox`);
  const r = rows[0]!;
  return {
    commands: Number(r.commands),
    quotes: Number(r.quotes),
    links: Number(r.links),
    audits: Number(r.audits),
    outbox: Number(r.outbox),
  };
}

/* ------------------------------------------------------------------ *
 * Pricing
 * ------------------------------------------------------------------ */

/*
 * Escrow is real now: the crypto side must own what it sells, and every
 * deal counts toward that account's rolling exposure. Neither is what
 * this file tests, so both are handled by shared fixture support rather
 * than by relaxing the checks that make them true.
 */
beforeAll(async () => {
  await fundForDeals([alice, bob]);
});
beforeEach(async () => {
  await clearRiskCounters([alice, bob]);
});

describe('production quote issuance fails closed without a pricing adapter', () => {
  for (const scenario of ['INR_TO_USDT', 'USDT_TO_INR'] as const) {
    it(`${scenario}: refuses, and writes absolutely nothing`, async () => {
      const before = await counts();
      enterProduction();

      await expect(
        createDealCommand(alice, {
          commandId: newCommandId(),
          scenario,
          usdtAmount: scenario === 'USDT_TO_INR' ? '50' : undefined,
          inrAmount: scenario === 'INR_TO_USDT' ? '250000' : undefined,
          intent: 'PAY',
        }),
      ).rejects.toThrow(AdapterUnavailableError);

      restore();
      const after = await counts();
      expect(after).toEqual(before);
    });

    it(`${scenario}: names the pricing capability and the owning stage`, async () => {
      enterProduction();
      try {
        await createDealCommand(alice, {
          commandId: newCommandId(),
          scenario,
          usdtAmount: '10',
          inrAmount: '250000',
          intent: 'PAY',
        });
        throw new Error('should have refused');
      } catch (err) {
        expect(err).toBeInstanceOf(AdapterUnavailableError);
        expect((err as AdapterUnavailableError).capability).toBe('pricing');
        expect((err as AdapterUnavailableError).owningStage).toContain('DEL-05');
      }
    });
  }

  it('still prices both corridors in the sandbox', async () => {
    for (const scenario of ['INR_TO_USDT', 'USDT_TO_INR'] as const) {
      const outcome = await createDealCommand(alice, {
        commandId: newCommandId(),
        scenario,
        usdtAmount: scenario === 'USDT_TO_INR' ? '50' : undefined,
        inrAmount: scenario === 'INR_TO_USDT' ? '250000' : undefined,
        intent: 'PAY',
      });
      expect(outcome.ok, `${scenario} should price in sandbox`).toBe(true);
    }
  });

  it('records the sandbox provenance on the quote, never a market claim', async () => {
    const outcome = await createDealCommand(alice, {
      commandId: newCommandId(),
      scenario: 'USDT_TO_INR',
      usdtAmount: '50',
      intent: 'PAY',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { rows } = await getPool().query(
      `SELECT pricing_source, rate_num, rate_den FROM sandbox.quote WHERE quote_id = $1`,
      [outcome.value.quoteId],
    );
    expect(rows[0]!.pricing_source).toBe('SANDBOX_REFERENCE');
    // Exact integers, never a float.
    expect(String(rows[0]!.rate_num)).toMatch(/^\d+$/);
    expect(String(rows[0]!.rate_den)).toMatch(/^\d+$/);
  });
});

/* ------------------------------------------------------------------ *
 * A rejection must never follow a domain write
 * ------------------------------------------------------------------ */

describe('a production-disabled scenario cannot consume a link', () => {
  it('refuses the Join and leaves the link OPEN', async () => {
    // Minted while INR_TO_INR is available…
    const created = await createDealCommand(alice, {
      commandId: newCommandId(),
      scenario: 'INR_TO_INR',
      inrAmount: '2500',
      intent: 'PAY',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const publicId = created.value.publicId;

    const { rows: before } = await getPool().query(
      `SELECT link_id, state FROM sandbox.deal_link WHERE public_id = $1`,
      [publicId],
    );
    const linkId = before[0]!.link_id as string;

    // …then the deployment becomes production, where it is disabled.
    enterProduction();
    const commandId = newCommandId();
    const outcome = await joinCommand(bob, commandId, publicId);
    restore();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('SCENARIO_UNAVAILABLE');

    /*
     * THE REGRESSION THIS EXISTS FOR.
     *
     * The scenario check used to run AFTER the compare-and-swap, so this
     * rejection committed a link in state CONSUMED with no deal behind
     * it — permanently unusable, destroyed by its own refusal.
     */
    const { rows: after } = await getPool().query(
      `SELECT state, consumed_at FROM sandbox.deal_link WHERE public_id = $1`,
      [publicId],
    );
    expect(after[0]!.state).toBe('OPEN');
    expect(after[0]!.consumed_at).toBeNull();

    // No deal, no participant.
    const { rows: deals } = await getPool().query(`SELECT 1 FROM sandbox.deal WHERE link_id = $1`, [
      linkId,
    ]);
    expect(deals).toHaveLength(0);
    const { rows: parts } = await getPool().query(
      `SELECT 1 FROM sandbox.participant p JOIN sandbox.deal d ON d.deal_id = p.deal_id
        WHERE d.link_id = $1`,
      [linkId],
    );
    expect(parts).toHaveLength(0);

    // The command is recorded as rejected, and the refusal is audited.
    const { rows: cmd } = await getPool().query(
      `SELECT status, outcome_code FROM sandbox.command WHERE command_id = $1`,
      [commandId],
    );
    expect(cmd[0]!.status).toBe('REJECTED');
    expect(cmd[0]!.outcome_code).toBe('SCENARIO_UNAVAILABLE');

    const { rows: audits } = await getPool().query(
      `SELECT outcome FROM sandbox.audit_event
        WHERE subject_id = $1 AND action = 'LINK_JOIN' AND outcome = 'SCENARIO_UNAVAILABLE'`,
      [linkId],
    );
    expect(audits).toHaveLength(1);

    // And no success event was emitted.
    const { rows: events } = await getPool().query(
      `SELECT 1 FROM sandbox.outbox_event WHERE event_key LIKE $1`,
      [`${commandId}:%`],
    );
    expect(events).toHaveLength(0);
  });

  it('rolls back entirely when value protection is unavailable', async () => {
    const created = await createDealCommand(alice, {
      commandId: newCommandId(),
      scenario: 'USDT_TO_INR',
      usdtAmount: '50',
      intent: 'PAY',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const publicId = created.value.publicId;

    const before = await counts();
    enterProduction();
    /*
     * `USDT_TO_INR` is an approved corridor, so the scenario guard passes
     * and execution reaches the value-protection adapter — which throws in
     * production. A throw rolls the transaction back, so unlike the
     * rejection above there is no command row either.
     */
    const commandId = newCommandId();
    await expect(joinCommand(bob, commandId, publicId)).rejects.toThrow(AdapterUnavailableError);
    restore();

    const after = await counts();
    expect(after).toEqual(before);

    const { rows } = await getPool().query(
      `SELECT state FROM sandbox.deal_link WHERE public_id = $1`,
      [publicId],
    );
    expect(rows[0]!.state).toBe('OPEN');
  });
});

/* ------------------------------------------------------------------ *
 * Fee bearing is server policy — UX-01 §3, roadmap B4
 * ------------------------------------------------------------------ */

describe('a forged request cannot choose who bears the fee', () => {
  it('ignores a feeBearer smuggled into the command input', async () => {
    const outcome = await createDealCommand(alice, {
      commandId: newCommandId(),
      scenario: 'INR_TO_INR',
      inrAmount: '2500',
      intent: 'PAY',
      // Not part of `CreateDealInput`. A forged client payload would carry
      // exactly this, and the boundary has nowhere to put it.
      ...({ feeBearer: 'PAYEE' } as Record<string, unknown>),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { rows } = await getPool().query(
      `SELECT fee_bearer FROM sandbox.quote WHERE quote_id = $1`,
      [outcome.value.quoteId],
    );
    expect(rows[0]!.fee_bearer).toBe('PAYER');
  });

  it('keeps the zero-net rejection as defence in depth', async () => {
    // Even if policy were ever changed to PAYEE, the server still refuses
    // a quote that would leave the receiver nothing.
    const { settlementFor } = await import('@/lib/fees');
    expect(settlementFor('INR_TO_USDT', 10_000n, 'PAYEE').payeeReceivesMinor).toBe(0n);

    const { createDealIntentIn } = await import('@/server/sandbox/service');
    const { runCommand } = await import('@/server/boundary/command');
    const outcome = await runCommand({
      commandId: newCommandId(),
      commandType: 'DEAL_INTENT_CREATE',
      actorId: alice.userId,
      payload: { forced: 'PAYEE' },
      body: (ctx) =>
        createDealIntentIn(ctx, alice, {
          scenario: 'INR_TO_USDT',
          inrMinor: 10_000n,
          intent: 'PAY',
          feeBearer: 'PAYEE',
        }),
      encodeResult: () => ({}),
      decodeResult: () => ({ publicId: '', quoteId: '' }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('FEE_EXCEEDS_AMOUNT');
  });
});
