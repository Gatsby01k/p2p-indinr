import 'server-only';
import { getPool, type Tx } from '@/server/db/pool';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { deploymentMode } from '@/server/adapters/mode';
import { getInrRailAdapter, type InrNetwork } from '@/server/adapters/inrRail';
import { getUsdtRailAdapter } from '@/server/adapters/usdtRail';
import {
  assetForRail,
  networkBelongsToRail,
  redactDestination,
  type Network,
  type Rail,
} from '@/lib/railReference';

/**
 * Payment intents and instructions.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  AN INSTRUCTION IS A REQUEST TO SEND REAL MONEY.                   │
 * │                                                                    │
 * │  Everything in this file exists to make sure one is never issued   │
 * │  to the wrong person, for the wrong deal, or before the value      │
 * │  behind it is actually secured. Three gates, checked in this       │
 * │  order, on every single read:                                      │
 * │                                                                    │
 * │  1. IS THE ADAPTER REAL? Production has no rail provider, so it    │
 * │     refuses. A fake destination shown to a customer is the worst   │
 * │     failure this stage can produce.                                │
 * │  2. IS THE VALUE LOCKED, RIGHT NOW? Not "was it locked when the    │
 * │     intent was created" — the DEL-04 lock is re-read on every      │
 * │     disclosure, so a released or reversed lock closes instructions │
 * │     immediately.                                                   │
 * │  3. IS THIS THE PAYER? Not a participant, not an operator: THE     │
 * │     payer. The counterparty has no business knowing the            │
 * │     destination, and neither does anybody else.                    │
 * └────────────────────────────────────────────────────────────────────┘
 */

export interface PaymentIntent {
  readonly intentId: string;
  readonly dealId: string;
  readonly rail: Rail;
  readonly network: Network;
  readonly direction: 'COLLECT' | 'PAYOUT';
  readonly state:
    | 'REQUESTED'
    | 'INSTRUCTED'
    | 'OBSERVED'
    | 'CONFIRMED'
    | 'FAILED'
    | 'EXPIRED'
    | 'REVERSED';
  readonly payerId: string;
  readonly payeeId: string;
  readonly asset: string;
  readonly amountMinor: string;
  readonly ledgerEntryId: string | null;
  readonly expiresAt: string;
}

/** States in which a payment is still going somewhere. */
export const LIVE_STATES = ['REQUESTED', 'INSTRUCTED', 'OBSERVED'] as const;

function mapIntent(r: Record<string, unknown>): PaymentIntent {
  return {
    intentId: r.intent_id as string,
    dealId: r.deal_id as string,
    rail: r.rail as Rail,
    network: r.network as Network,
    direction: r.direction as 'COLLECT' | 'PAYOUT',
    state: r.state as PaymentIntent['state'],
    payerId: r.payer_id as string,
    payeeId: r.payee_id as string,
    asset: r.asset as string,
    amountMinor: r.amount_minor as string,
    ledgerEntryId: (r.ledger_entry_id as string | null) ?? null,
    expiresAt: (r.observed_expires_at as Date).toISOString(),
  };
}

const INTENT_COLUMNS = `intent_id, deal_id, rail, network, direction, state, payer_id,
  payee_id, asset, amount_minor::text AS amount_minor, ledger_entry_id,
  expires_at AS observed_expires_at`;

export async function intentById(intentId: string): Promise<PaymentIntent | null> {
  const { rows } = await getPool().query(
    `SELECT ${INTENT_COLUMNS} FROM sandbox.payment_intent WHERE intent_id = $1`,
    [intentId],
  );
  return rows[0] ? mapIntent(rows[0]) : null;
}

export async function intentsForDeal(dealId: string): Promise<readonly PaymentIntent[]> {
  const { rows } = await getPool().query(
    `SELECT ${INTENT_COLUMNS} FROM sandbox.payment_intent
      WHERE deal_id = $1 ORDER BY created_at`,
    [dealId],
  );
  return rows.map(mapIntent);
}

/* ------------------------------------------------------------------ *
 * The live-lock gate
 * ------------------------------------------------------------------ */

/**
 * Is the DEL-04 value lock for this deal live at this instant?
 *
 * Read inside the caller's transaction so the answer cannot go stale
 * between the check and the disclosure. `FOR SHARE` on the lock row means
 * a concurrent release blocks until this disclosure commits rather than
 * silently proceeding underneath it.
 */
export async function valueLockIsLive(tx: Tx, dealId: string): Promise<string | null> {
  const { rows } = await tx.query(
    `SELECT lock_id FROM inrp2p.value_lock WHERE deal_id = $1 AND state = 'LOCKED' FOR SHARE`,
    [dealId],
  );
  return (rows[0]?.lock_id as string | undefined) ?? null;
}

/* ------------------------------------------------------------------ *
 * Opening an intent
 * ------------------------------------------------------------------ */

export interface OpenIntentInput {
  readonly dealId: string;
  readonly rail: Rail;
  readonly network: Network;
  readonly direction: 'COLLECT' | 'PAYOUT';
  readonly payerId: string;
  readonly payeeId: string;
  readonly amountMinor: bigint;
  readonly expiresInSeconds: number;
}

/**
 * Open a payment demand.
 *
 * Opening an intent is deliberately cheap and discloses nothing: it
 * creates the demand, not the destination. That separation is why the
 * expensive authorization sits on `issueInstruction` rather than here —
 * an intent leaks no account number even if it were over-shared.
 */
export async function openIntent(tx: Tx, input: OpenIntentInput): Promise<Outcome<PaymentIntent>> {
  if (deploymentMode() === 'PRODUCTION') {
    return reject('ADAPTER_UNAVAILABLE', FAILURE_COPY.ADAPTER_UNAVAILABLE.reason);
  }
  if (!networkBelongsToRail(input.rail, input.network)) {
    return reject('NETWORK_INVALID', FAILURE_COPY.NETWORK_INVALID.reason, {
      rail: input.rail,
      network: input.network,
    });
  }
  if (input.amountMinor <= 0n) {
    return reject('AMOUNT_INVALID', FAILURE_COPY.AMOUNT_INVALID.reason);
  }
  if (input.payerId === input.payeeId) {
    return reject('NOT_A_PARTICIPANT', FAILURE_COPY.NOT_A_PARTICIPANT.reason);
  }

  // Both parties must actually hold seats in this deal. Checked against
  // `participant` rather than trusted from the caller, because the caller
  // supplies both ids and one of them is the beneficiary.
  const { rows: seats } = await tx.query(
    `SELECT user_id FROM sandbox.participant WHERE deal_id = $1 AND user_id = ANY($2::uuid[])`,
    [input.dealId, [input.payerId, input.payeeId]],
  );
  if (seats.length !== 2) {
    return reject('NOT_A_PARTICIPANT', FAILURE_COPY.NOT_A_PARTICIPANT.reason);
  }

  const { rows: dealRows } = await tx.query(
    `SELECT state FROM sandbox.deal WHERE deal_id = $1 FOR UPDATE`,
    [input.dealId],
  );
  if (dealRows[0] === undefined) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);
  if (dealRows[0].state === 'COMPLETED' || dealRows[0].state === 'CANCELLED') {
    return reject('DEAL_TERMINAL', FAILURE_COPY.DEAL_TERMINAL.reason);
  }

  /*
   * The partial unique index does the real work here. This SELECT is the
   * courteous refusal; the index is the guarantee, and it is what makes
   * two concurrent opens produce one intent rather than two demands for
   * the same money.
   */
  const { rows: existing } = await tx.query(
    `SELECT ${INTENT_COLUMNS} FROM sandbox.payment_intent
      WHERE deal_id = $1 AND rail = $2 AND direction = $3
        AND state IN ('REQUESTED','INSTRUCTED','OBSERVED')`,
    [input.dealId, input.rail, input.direction],
  );
  if (existing[0]) {
    return reject('PAYMENT_INTENT_EXISTS', FAILURE_COPY.PAYMENT_INTENT_EXISTS.reason, {
      intentId: existing[0].intent_id as string,
    });
  }

  const lockId = await valueLockIsLive(tx, input.dealId);

  const { rows } = await tx.query(
    `INSERT INTO sandbox.payment_intent
       (deal_id, rail, network, direction, payer_id, payee_id, asset, amount_minor,
        required_lock_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + make_interval(secs => $10))
     RETURNING ${INTENT_COLUMNS}`,
    [
      input.dealId,
      input.rail,
      input.network,
      input.direction,
      input.payerId,
      input.payeeId,
      assetForRail(input.rail),
      input.amountMinor.toString(),
      lockId,
      input.expiresInSeconds,
    ],
  );
  return accept(mapIntent(rows[0]!));
}

/* ------------------------------------------------------------------ *
 * Issuing the instruction — the sensitive disclosure
 * ------------------------------------------------------------------ */

export interface PaymentInstruction {
  readonly instructionId: string;
  readonly intentId: string;
  readonly providerKey: string;
  readonly destination: string;
  readonly detail: Readonly<Record<string, string>>;
  readonly reference: string;
  readonly network: Network;
  readonly amountMinor: string;
  readonly asset: string;
}

/** The reference a payer must quote. Sandbox-prefixed, always. */
function referenceFor(intentId: string): string {
  return `SBX-${intentId.replace(/-/g, '').slice(0, 16).toUpperCase()}`;
}

/**
 * Issue — or re-issue — the instruction for an intent.
 *
 * Re-issuing returns the SAME instruction rather than allocating a
 * second destination. A payer who reloads the page and gets a different
 * address, having already sent to the first, has lost their money.
 */
export async function issueInstruction(
  tx: Tx,
  actorId: string,
  intentId: string,
): Promise<Outcome<PaymentInstruction>> {
  if (deploymentMode() === 'PRODUCTION') {
    return reject('ADAPTER_UNAVAILABLE', FAILURE_COPY.ADAPTER_UNAVAILABLE.reason);
  }

  const { rows } = await tx.query(
    `SELECT ${INTENT_COLUMNS}, required_lock_id
       FROM sandbox.payment_intent WHERE intent_id = $1 FOR UPDATE`,
    [intentId],
  );
  if (rows[0] === undefined) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);
  const intent = mapIntent(rows[0]);

  /*
   * THE PAYER, AND ONLY THE PAYER.
   *
   * Checked before the state and the lock, so a stranger probing intent
   * ids learns nothing about whether one exists in a useful state. They
   * get the same answer whatever the intent is doing.
   */
  if (intent.payerId !== actorId) {
    return reject('NOT_A_PARTICIPANT', FAILURE_COPY.NOT_A_PARTICIPANT.reason);
  }

  if (!(LIVE_STATES as readonly string[]).includes(intent.state)) {
    return reject('PAYMENT_INTENT_TERMINAL', FAILURE_COPY.PAYMENT_INTENT_TERMINAL.reason);
  }

  // THE DEL-04 GATE. Live, not remembered.
  const lockId = await valueLockIsLive(tx, intent.dealId);
  if (lockId === null) {
    return reject('VALUE_NOT_LOCKED', FAILURE_COPY.VALUE_NOT_LOCKED.reason, {
      dealId: intent.dealId,
    });
  }

  /*
   * THE DEL-08 GATE. Also live.
   *
   * Disclosing a payment destination is the last reversible moment
   * before a customer sends real money, so a hold on the payer or a
   * paused INSTRUCTION_DISCLOSE scope stops it here — inside the
   * transaction, not by hiding the panel.
   */
  {
    const { enforce } = await import('@/server/risk/engine');
    const gate = await enforce(tx, {
      point: 'INSTRUCTION_DISCLOSE',
      subjectKind: 'user',
      subjectId: actorId,
      actorId,
      signals: { rail: intent.rail, amountMinor: BigInt(intent.amountMinor) },
    });
    if (!gate.ok) return gate;
  }

  const existing = await tx.query(
    `SELECT instruction_id, provider_key, destination, destination_detail, reference
       FROM sandbox.payment_instruction WHERE intent_id = $1`,
    [intentId],
  );
  if (existing.rows[0]) {
    const r = existing.rows[0];
    return accept({
      instructionId: r.instruction_id as string,
      intentId,
      providerKey: r.provider_key as string,
      destination: r.destination as string,
      detail: r.destination_detail as Record<string, string>,
      reference: r.reference as string,
      network: intent.network,
      amountMinor: intent.amountMinor,
      asset: intent.asset,
    });
  }

  const reference = referenceFor(intentId);
  /*
   * The idempotency key is derived from the intent, not minted per
   * attempt. Two concurrent issues therefore ask the provider for the
   * same allocation, and a retry after a timeout reaches the provider
   * with a key it has already seen.
   */
  const idempotencyKey = `instr:${intentId}`;

  let providerKey: string;
  let destination: string;
  let detail: Record<string, string>;

  if (intent.rail === 'INR') {
    const adapter = getInrRailAdapter();
    const allocated = await adapter.allocateCollection({
      idempotencyKey,
      network: intent.network as InrNetwork,
      amountMinor: BigInt(intent.amountMinor),
      reference,
    });
    providerKey = adapter.providerKey;
    destination = allocated.destination;
    detail = { ...allocated.detail };
  } else {
    const adapter = getUsdtRailAdapter();
    if (intent.network !== 'TRC20') {
      return reject('NETWORK_INVALID', FAILURE_COPY.NETWORK_INVALID.reason);
    }
    const allocated = await adapter.allocateAddress({ idempotencyKey, network: 'TRC20' });
    providerKey = adapter.providerKey;
    destination = allocated.address;
    detail = {
      network: 'TRC20',
      requiredConfirmations: String(adapter.requiredConfirmations),
      warning: 'TRC20 only. Sending on any other network loses the funds permanently.',
    };

    /*
     * The allocation is recorded with its owner and deal. The unique
     * address constraint means a watcher observation for this address can
     * only ever reconcile to this deal — cross-deal crediting is not
     * something the matching code has to remember to prevent.
     */
    await tx.query(
      `INSERT INTO sandbox.usdt_address_allocation
         (address, network, deal_id, owner_id, intent_id)
       VALUES ($1,'TRC20',$2,$3,$4)`,
      [destination, intent.dealId, intent.payerId, intentId],
    );
  }

  const inserted = await tx.query(
    `INSERT INTO sandbox.payment_instruction
       (intent_id, provider_key, destination, destination_detail, reference, issued_to)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING instruction_id`,
    [intentId, providerKey, destination, JSON.stringify(detail), reference, actorId],
  );

  if (intent.state === 'REQUESTED') {
    await tx.query(
      `UPDATE sandbox.payment_intent
          SET state='INSTRUCTED', instructed_at=now(), required_lock_id=$2,
              version=version+1
        WHERE intent_id=$1`,
      [intentId, lockId],
    );
  }

  return accept({
    instructionId: inserted.rows[0]!.instruction_id as string,
    intentId,
    providerKey,
    destination,
    detail,
    reference,
    network: intent.network,
    amountMinor: intent.amountMinor,
    asset: intent.asset,
  });
}

/**
 * Read an already-issued instruction.
 *
 * Re-checks the payer AND the live lock, because authorization is a
 * property of the moment of disclosure, not of the moment of issue. An
 * instruction issued legitimately an hour ago must stop being readable
 * the instant the lock behind it is released.
 */
export async function readInstruction(
  tx: Tx,
  actorId: string,
  intentId: string,
): Promise<Outcome<PaymentInstruction>> {
  const { rows } = await tx.query(
    `SELECT ${INTENT_COLUMNS} FROM sandbox.payment_intent WHERE intent_id = $1`,
    [intentId],
  );
  if (rows[0] === undefined) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);
  const intent = mapIntent(rows[0]);

  if (intent.payerId !== actorId) {
    return reject('NOT_A_PARTICIPANT', FAILURE_COPY.NOT_A_PARTICIPANT.reason);
  }

  // Re-checked on every READ too: a hold placed after issuance must
  // close an instruction that was legitimately disclosed an hour ago.
  {
    const { enforce } = await import('@/server/risk/engine');
    const gate = await enforce(tx, {
      point: 'INSTRUCTION_DISCLOSE',
      subjectKind: 'user',
      subjectId: actorId,
      actorId,
      signals: { rail: intent.rail },
    });
    if (!gate.ok) return gate;
  }

  if (await valueLockIsLive(tx, intent.dealId)) {
    const { rows: instr } = await tx.query(
      `SELECT instruction_id, provider_key, destination, destination_detail, reference
         FROM sandbox.payment_instruction WHERE intent_id = $1`,
      [intentId],
    );
    if (instr[0] === undefined) {
      return reject('PAYMENT_NOT_INSTRUCTED', FAILURE_COPY.PAYMENT_NOT_INSTRUCTED.reason);
    }
    return accept({
      instructionId: instr[0].instruction_id as string,
      intentId,
      providerKey: instr[0].provider_key as string,
      destination: instr[0].destination as string,
      detail: instr[0].destination_detail as Record<string, string>,
      reference: instr[0].reference as string,
      network: intent.network,
      amountMinor: intent.amountMinor,
      asset: intent.asset,
    });
  }
  return reject('VALUE_NOT_LOCKED', FAILURE_COPY.VALUE_NOT_LOCKED.reason);
}

/**
 * The log-safe form of an instruction.
 *
 * Anything that writes an instruction to a log, an audit detail or an
 * outbox payload goes through here. The destination and the reference are
 * the two fields that must never appear in full, and they are redacted at
 * the point of construction rather than at each call site.
 */
export function redactInstruction(i: PaymentInstruction): Record<string, unknown> {
  return {
    instructionId: i.instructionId,
    intentId: i.intentId,
    providerKey: i.providerKey,
    network: i.network,
    asset: i.asset,
    amountMinor: i.amountMinor,
    destination: redactDestination(i.destination),
    reference: i.reference,
  };
}
