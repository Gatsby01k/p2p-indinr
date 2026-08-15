import 'server-only';
import { createHash } from 'node:crypto';
import type { Tx } from '@/server/db/pool';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { getUsdtRailAdapter } from '@/server/adapters/usdtRail';
import { dealEscrowKey, depositWalletKey, ensureAccounts } from '@/server/ledger/accounts';
import { raiseIncident, valueStillDisposable } from '@/server/room/incidents';
import { verifyDelivery, type SignedDelivery } from './webhook';
import {
  assetForRail,
  networkBelongsToRail,
  normalizeReference,
  parseMinor,
  type Network,
  type Rail,
} from '@/lib/railReference';

/**
 * Observations: what the outside world reported, and what we believe.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE ORDER OF THESE CHECKS IS THE SECURITY MODEL.                  │
 * │                                                                    │
 * │  1. Is the delivery AUTHENTIC?  (signature, timestamp)             │
 * │  2. Is it NEW?                  (provider event id uniqueness)     │
 * │  3. Is the reference WELL-FORMED?                                  │
 * │  4. Does it MATCH an intent?    (allocated address / our reference) │
 * │  5. Do the TERMS agree?         (asset, network, amount, payee)    │
 * │  6. Is the reference UNCLAIMED? (one movement, one reference)      │
 * │  7. Is it FINAL?                (confirmation policy)              │
 * │  8. ONLY THEN: post to the ledger, exactly once.                   │
 * │                                                                    │
 * │  Every refusal from step 3 down is RECORDED, not swallowed. A      │
 * │  payment that failed to reconcile is the single most important     │
 * │  thing in a support case, and "we saw nothing" is the worst        │
 * │  possible answer. The observation row is written with              │
 * │  `accepted = false` and a `match_outcome`, and the transaction     │
 * │  still commits — the DEL-02 non-raising boundary doing exactly     │
 * │  the job it was built for.                                         │
 * └────────────────────────────────────────────────────────────────────┘
 */

export interface ProviderEvent {
  readonly providerKey: string;
  readonly providerEventId: string;
  readonly rail: Rail;
  readonly network: Network;
  readonly status: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REORGED';
  /**
   * The reference identifying this MOVEMENT: a UTR on the INR rail, a
   * transaction hash on the USDT rail. It identifies the transfer, not
   * the deal, so it is used for uniqueness and never for matching.
   */
  readonly reference: string;
  /**
   * Where the money went, as the provider reports it: the TRC20 address
   * for USDT, the instruction reference quoted on the transfer for INR.
   * THIS is what matches an event to an intent.
   */
  readonly destination: string;
  readonly amountMinor: string;
  readonly asset: string;
  readonly confirmations?: number;
  /** For INR: the beneficiary account the provider credited. */
  readonly beneficiaryAccount?: string;
  readonly observedAt?: string;
}

export interface IngestResult {
  readonly observationId: string;
  readonly intentId: string | null;
  readonly matchOutcome: string;
  readonly state: string | null;
  readonly ledgerEntryId: string | null;
}

type AuthoritativeSource = 'PROVIDER_WEBHOOK' | 'CHAIN_WATCHER';

/* ------------------------------------------------------------------ *
 * 1–2. Delivery authenticity and replay
 * ------------------------------------------------------------------ */

async function recordDelivery(
  tx: Tx,
  delivery: SignedDelivery,
  providerEventId: string,
  now: Date,
): Promise<Outcome<{ railEventId: string; eventAt: Date }>> {
  const verification = verifyDelivery(delivery, now);

  if (!verification.ok) {
    /*
     * A refused delivery is RECORDED. A forgery that leaves no trace is a
     * forgery nobody can investigate, and "somebody is probing us with
     * invalid signatures" is exactly the signal an operator needs.
     */
    await tx.query(
      `INSERT INTO sandbox.rail_event
         (provider_key, provider_event_id, body_digest, signature_verified,
          event_at, accepted, refusal_code)
       VALUES ($1,$2,$3,FALSE,$4,FALSE,$5)
       ON CONFLICT (provider_key, provider_event_id) DO NOTHING`,
      [
        delivery.providerKey,
        providerEventId,
        createHash('sha256').update(delivery.rawBody).digest(),
        now,
        verification.reason,
      ],
    );
    /*
     * ONE ANSWER FOR EVERY AUTHENTICITY FAILURE.
     *
     * A wrong signature, a stale timestamp and a malformed header all
     * return `WEBHOOK_UNVERIFIED`. The specific reason goes to the audit
     * trail where an operator can see it; returning it would tell a
     * forger which part of the forgery to fix next.
     */
    return reject('WEBHOOK_UNVERIFIED', FAILURE_COPY.WEBHOOK_UNVERIFIED.reason, {
      reason: verification.reason,
    });
  }

  const claimed = await tx.query(
    `INSERT INTO sandbox.rail_event
       (provider_key, provider_event_id, body_digest, signature_verified,
        event_at, accepted, refusal_code)
     VALUES ($1,$2,$3,TRUE,$4,TRUE,NULL)
     ON CONFLICT (provider_key, provider_event_id) DO NOTHING
     RETURNING rail_event_id`,
    [delivery.providerKey, providerEventId, verification.digest, verification.eventAt],
  );

  if (claimed.rowCount === 0) {
    /*
     * A REDELIVERY. Every real provider does this and it is not an error;
     * the first delivery was applied and its effect stands.
     *
     * `ON CONFLICT DO NOTHING` also makes two SIMULTANEOUS deliveries
     * safe: the second blocks on the first's speculative insert, then
     * finds the committed row here. Exactly one is processed, decided by
     * the database rather than by a check-then-act.
     *
     * The digest is compared rather than assumed equal — the same event
     * id carrying DIFFERENT bytes is not a redelivery, it is somebody
     * editing an event.
     */
    const { rows } = await tx.query(
      `SELECT rail_event_id, body_digest FROM sandbox.rail_event
        WHERE provider_key = $1 AND provider_event_id = $2`,
      [delivery.providerKey, providerEventId],
    );
    const prior = rows[0]!;
    if (!(prior.body_digest as Buffer).equals(verification.digest)) {
      return reject('WEBHOOK_UNVERIFIED', FAILURE_COPY.WEBHOOK_UNVERIFIED.reason, {
        reason: 'BODY_MISMATCH_ON_REPLAY',
      });
    }
    return reject('WEBHOOK_REPLAYED', FAILURE_COPY.WEBHOOK_REPLAYED.reason, {
      railEventId: prior.rail_event_id as string,
    });
  }

  return accept({
    railEventId: claimed.rows[0]!.rail_event_id as string,
    eventAt: verification.eventAt,
  });
}

/* ------------------------------------------------------------------ *
 * Observation rows
 * ------------------------------------------------------------------ */

interface ObservationDraft {
  readonly intentId: string | null;
  readonly dealId: string | null;
  readonly event: ProviderEvent;
  readonly source: AuthoritativeSource;
  readonly railEventId: string;
  readonly reference: string;
  readonly amountMinor: string;
  readonly matchOutcome: string;
  readonly accepted: boolean;
  readonly now: Date;
}

async function writeObservation(tx: Tx, d: ObservationDraft): Promise<string> {
  const { rows } = await tx.query(
    `INSERT INTO sandbox.payment_observation
       (intent_id, deal_id, rail, network, source, kind, rail_event_id,
        external_ref, asset, amount_minor, confirmations, beneficiary,
        observed_at, match_outcome, accepted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING observation_id`,
    [
      d.intentId,
      d.dealId,
      d.event.rail,
      d.event.network,
      d.source,
      d.event.status,
      d.railEventId,
      d.reference,
      d.event.asset,
      d.amountMinor,
      d.event.confirmations ?? 0,
      d.event.beneficiaryAccount ?? d.event.destination,
      d.now,
      d.matchOutcome,
      d.accepted,
    ],
  );
  return rows[0]!.observation_id as string;
}

/* ------------------------------------------------------------------ *
 * 4. Matching
 * ------------------------------------------------------------------ */

const MATCH_COLUMNS = `i.intent_id, i.deal_id, i.rail, i.network, i.state, i.asset,
  i.amount_minor::text AS amount_minor, i.ledger_entry_id, i.payer_id, i.payee_id`;

/**
 * Find the intent this event belongs to.
 *
 * Locked `FOR UPDATE` so two concurrent deliveries for the same intent
 * serialise. Without that, two confirmations arriving together would both
 * read `INSTRUCTED` and both try to post.
 *
 * MATCHING NEVER GUESSES. For USDT the destination address decides,
 * because that address was allocated to exactly one intent and is unique
 * platform-wide — which is what makes cross-deal crediting impossible
 * rather than merely checked for. For INR the instruction reference
 * decides, because we issued it and the payer quoted it back.
 */
async function matchIntent(tx: Tx, event: ProviderEvent): Promise<Record<string, unknown> | null> {
  if (event.rail === 'USDT') {
    const { rows } = await tx.query(
      `SELECT ${MATCH_COLUMNS}, a.address AS destination
         FROM sandbox.usdt_address_allocation a
         JOIN sandbox.payment_intent i ON i.intent_id = a.intent_id
        WHERE a.address = $1
        FOR UPDATE OF i`,
      [event.destination.trim()],
    );
    return rows[0] ?? null;
  }

  const { rows } = await tx.query(
    `SELECT ${MATCH_COLUMNS}, s.destination AS destination
       FROM sandbox.payment_instruction s
       JOIN sandbox.payment_intent i ON i.intent_id = s.intent_id
      WHERE s.reference = $1
      FOR UPDATE OF i`,
    [event.destination.trim()],
  );
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * Ingest
 * ------------------------------------------------------------------ */

export async function ingestProviderEvent(
  tx: Tx,
  delivery: SignedDelivery,
  event: ProviderEvent,
  options: { readonly now?: Date; readonly source?: AuthoritativeSource } = {},
): Promise<Outcome<IngestResult>> {
  const now = options.now ?? new Date();
  const source: AuthoritativeSource = options.source ?? 'PROVIDER_WEBHOOK';

  const recorded = await recordDelivery(tx, delivery, event.providerEventId, now);
  if (!recorded.ok) return recorded;
  const { railEventId } = recorded.value;

  if (!networkBelongsToRail(event.rail, event.network)) {
    return reject('NETWORK_INVALID', FAILURE_COPY.NETWORK_INVALID.reason, {
      rail: event.rail,
      network: event.network,
    });
  }

  const reference = normalizeReference(event.rail, event.reference);
  if (!reference.ok) return reject('REFERENCE_INVALID', reference.reason);

  const amount = parseMinor(event.amountMinor, 'The reported amount');
  if (!amount.ok) return reject('AMOUNT_INVALID', amount.reason);

  const intentRow = await matchIntent(tx, event);

  const draft = (matchOutcome: string, accepted: boolean): ObservationDraft => ({
    intentId: (intentRow?.intent_id as string | undefined) ?? null,
    dealId: (intentRow?.deal_id as string | undefined) ?? null,
    event,
    source,
    railEventId,
    reference: reference.value,
    amountMinor: amount.value,
    matchOutcome,
    accepted,
    now,
  });

  if (intentRow === null) {
    const observationId = await writeObservation(tx, draft('UNMATCHED_NO_INTENT', false));
    return reject('OBSERVATION_UNMATCHED', FAILURE_COPY.OBSERVATION_UNMATCHED.reason, {
      observationId,
    });
  }

  /* ---- 5. The terms must agree, exactly ---- */

  if (event.asset !== (intentRow.asset as string) || event.asset !== assetForRail(event.rail)) {
    const observationId = await writeObservation(tx, draft('REFUSED_ASSET_MISMATCH', false));
    return reject('ASSET_MISMATCH', FAILURE_COPY.ASSET_MISMATCH.reason, {
      observationId,
      expected: intentRow.asset as string,
      received: event.asset,
    });
  }

  if (event.network !== (intentRow.network as string)) {
    const observationId = await writeObservation(tx, draft('REFUSED_NETWORK_MISMATCH', false));
    return reject('NETWORK_INVALID', FAILURE_COPY.NETWORK_INVALID.reason, {
      observationId,
      expected: intentRow.network as string,
      received: event.network,
    });
  }

  /*
   * EXACT amount. Not "at least", not "within tolerance".
   *
   * An underpayment is not a partial settlement: the terms were for a
   * specific amount and anything else is a support case. An OVERPAYMENT
   * is refused for the same reason — crediting the agreed amount and
   * keeping the difference is theft, and crediting the whole overpayment
   * breaks terms both parties agreed to.
   */
  if (amount.value !== (intentRow.amount_minor as string)) {
    const observationId = await writeObservation(tx, draft('REFUSED_AMOUNT_MISMATCH', false));
    return reject('AMOUNT_MISMATCH', FAILURE_COPY.AMOUNT_MISMATCH.reason, {
      observationId,
      expectedMinor: intentRow.amount_minor as string,
      receivedMinor: amount.value,
    });
  }

  // For INR the provider names the beneficiary account it credited; it
  // must be the one we issued. (For USDT the address WAS the match key,
  // so there is nothing further to compare.)
  if (
    event.rail === 'INR' &&
    event.beneficiaryAccount !== undefined &&
    event.beneficiaryAccount.trim().toLowerCase() !==
      String(intentRow.destination ?? '').toLowerCase()
  ) {
    const observationId = await writeObservation(tx, draft('REFUSED_BENEFICIARY_MISMATCH', false));
    return reject('BENEFICIARY_MISMATCH', FAILURE_COPY.BENEFICIARY_MISMATCH.reason, {
      observationId,
    });
  }

  /* ---- 6. One movement, one reference, platform-wide ---- */

  const intentId = intentRow.intent_id as string;
  const { rows: claimedRef } = await tx.query(
    `SELECT intent_id FROM sandbox.payment_observation
      WHERE rail = $1 AND external_ref = $2 AND accepted AND kind = 'CONFIRMED'
        AND source IN ('PROVIDER_WEBHOOK','CHAIN_WATCHER')
        AND intent_id IS DISTINCT FROM $3`,
    [event.rail, reference.value, intentId],
  );
  if (claimedRef[0]) {
    const observationId = await writeObservation(tx, draft('REFUSED_REFERENCE_CROSS_DEAL', false));
    return reject('REFERENCE_ALREADY_USED', FAILURE_COPY.REFERENCE_ALREADY_USED.reason, {
      observationId,
      otherIntentId: claimedRef[0].intent_id as string,
    });
  }

  return applyObservation(tx, { intentRow, event, draft, amountMinor: amount.value });
}

/* ------------------------------------------------------------------ *
 * 7–8. Applying a matched observation
 * ------------------------------------------------------------------ */

async function applyObservation(
  tx: Tx,
  input: {
    intentRow: Record<string, unknown>;
    event: ProviderEvent;
    draft: (matchOutcome: string, accepted: boolean) => ObservationDraft;
    amountMinor: string;
  },
): Promise<Outcome<IngestResult>> {
  const { event, draft } = input;
  const intentId = input.intentRow.intent_id as string;
  const dealId = input.intentRow.deal_id as string;
  const state = input.intentRow.state as string;

  /* ---- The provider says the payment FAILED ---- */
  if (event.status === 'FAILED') {
    if (state === 'CONFIRMED' || state === 'REVERSED') {
      // A failure report after settlement is a contradiction, not a
      // reversal. Recorded and refused; a reorg has its own path.
      const observationId = await writeObservation(tx, draft('REFUSED_FAILED_AFTER_SETTLE', false));
      return reject('PAYMENT_INTENT_TERMINAL', FAILURE_COPY.PAYMENT_INTENT_TERMINAL.reason, {
        observationId,
      });
    }
    const observationId = await writeObservation(tx, draft('APPLIED_FAILED', true));
    await tx.query(
      `UPDATE sandbox.payment_intent
          SET state='FAILED', settled_at=now(), version=version+1,
              failure_reason='The provider reported that the transfer failed.'
        WHERE intent_id=$1 AND state IN ('REQUESTED','INSTRUCTED','OBSERVED')`,
      [intentId],
    );
    return accept({
      observationId,
      intentId,
      matchOutcome: 'APPLIED_FAILED',
      state: 'FAILED',
      ledgerEntryId: null,
    });
  }

  /* ---- A chain reorganisation withdrew a confirmation ---- */
  if (event.status === 'REORGED') {
    if (state !== 'CONFIRMED') {
      // Nothing was believed, so nothing has to be unbelieved.
      const observationId = await writeObservation(tx, draft('APPLIED_REORG_NOOP', false));
      return accept({
        observationId,
        intentId,
        matchOutcome: 'APPLIED_REORG_NOOP',
        state,
        ledgerEntryId: null,
      });
    }
    /*
     * ┌──────────────────────────────────────────────────────────────┐
     * │  IF THE VALUE HAS ALREADY BEEN DISPOSED OF, STOP.            │
     * │                                                              │
     * │  The deposit funded a deal escrow. If that escrow has since  │
     * │  been RELEASED to the counterparty or REFUNDED, the value is │
     * │  in somebody's balance and it is theirs. Reversing the        │
     * │  deposit entry now would drive that balance negative — which │
     * │  DEL-04's constraint refuses outright — or, worse, would     │
     * │  silently take money back from a person who did nothing      │
     * │  wrong.                                                      │
     * │                                                              │
     * │  So this raises an INCIDENT and changes nothing. A human     │
     * │  decides. That is the honest answer, and the alternatives    │
     * │  are inventing value or quietly debiting a user.             │
     * └──────────────────────────────────────────────────────────────┘
     */
    if (!(await valueStillDisposable(tx, dealId))) {
      const observationId = await writeObservation(
        tx,
        draft('REFUSED_REORG_AFTER_DISPOSAL', false),
      );
      const incident = await raiseIncident(tx, {
        dealId,
        kind: 'REORG_AFTER_DISPOSAL',
        detail: {
          intentId,
          observationId,
          reference: input.draft('probe', false).reference,
          ledgerEntryId: input.intentRow.ledger_entry_id ?? null,
          note:
            'A chain reorganisation withdrew a deposit whose value had already ' +
            'been released or refunded. Nothing was reversed automatically.',
        },
      });
      return reject('INCIDENT_RAISED', FAILURE_COPY.INCIDENT_RAISED.reason, {
        observationId,
        incidentId: incident.incidentId,
      });
    }

    /*
     * The ledger entry is NOT deleted and NOT edited — it is REVERSED
     * with a DEL-04 reversal, so both the belief and its withdrawal stay
     * in the history. Anything else would leave a support case where the
     * money "was never there", which is untrue and unauditable.
     */
    const observationId = await writeObservation(tx, draft('APPLIED_REORG', true));
    const entryId = input.intentRow.ledger_entry_id as string | null;
    let reversalId: string | null = null;
    if (entryId !== null) {
      const { rows } = await tx.query(`SELECT inrp2p.reverse_entry($1::uuid, $2) AS reversal_id`, [
        entryId,
        'A chain reorganisation withdrew a confirmed payment observation.',
      ]);
      reversalId = rows[0]!.reversal_id as string;
    }
    await tx.query(
      `UPDATE sandbox.payment_intent
          SET state='REVERSED', reversal_entry_id=$2, settled_at=now(), version=version+1,
              failure_reason='A chain reorganisation withdrew this transfer.'
        WHERE intent_id=$1 AND state='CONFIRMED'`,
      [intentId, reversalId],
    );
    return accept({
      observationId,
      intentId,
      matchOutcome: 'APPLIED_REORG',
      state: 'REVERSED',
      ledgerEntryId: entryId,
    });
  }

  /* ---- Already settled: a late or duplicate confirmation ---- */
  if (state === 'CONFIRMED' || state === 'REVERSED') {
    /*
     * NOT an error and deliberately NOT a second posting. Providers
     * redeliver confirmations for hours. The intent already carries its
     * entry, and `payment_intent_entry_uq` plus the transition trigger
     * would refuse a second one regardless.
     */
    const observationId = await writeObservation(tx, draft('DUPLICATE_AFTER_SETTLEMENT', false));
    return accept({
      observationId,
      intentId,
      matchOutcome: 'DUPLICATE_AFTER_SETTLEMENT',
      state,
      ledgerEntryId: (input.intentRow.ledger_entry_id as string | null) ?? null,
    });
  }

  if (state === 'FAILED' || state === 'EXPIRED') {
    // An OUT-OF-ORDER arrival: the window closed, then the confirmation
    // turned up. It changes nothing and creates no posting.
    const observationId = await writeObservation(tx, draft('LATE_AFTER_TERMINAL', false));
    return reject('PAYMENT_INTENT_TERMINAL', FAILURE_COPY.PAYMENT_INTENT_TERMINAL.reason, {
      observationId,
      state,
    });
  }

  /* ---- 7. Is it final? ---- */

  const required = event.rail === 'USDT' ? getUsdtRailAdapter().requiredConfirmations : 0;
  const confirmations = event.confirmations ?? 0;

  if (event.status === 'PENDING' || confirmations < required) {
    const observationId = await writeObservation(tx, draft('SEEN_AWAITING_CONFIRMATION', false));
    if (state === 'INSTRUCTED') {
      await tx.query(
        `UPDATE sandbox.payment_intent SET state='OBSERVED', version=version+1
          WHERE intent_id=$1 AND state='INSTRUCTED'`,
        [intentId],
      );
    }
    return reject('CONFIRMATIONS_INSUFFICIENT', FAILURE_COPY.CONFIRMATIONS_INSUFFICIENT.reason, {
      observationId,
      confirmations,
      required,
    });
  }

  /* ---- 8. CONFIRMED. The one transition that may post to the ledger. ---- */

  /*
   * THE DEL-08 GATE, immediately before the posting.
   *
   * A paused RAIL_CONFIRM scope stops confirmations platform-wide —
   * which is exactly what an operator reaches for when a provider is
   * sending nonsense. The observation is still RECORDED either way: a
   * pause must not lose the report that a transfer arrived.
   */
  {
    const { enforce } = await import('@/server/risk/engine');
    const gate = await enforce(tx, {
      point: 'RAIL_OBSERVE',
      subjectKind: 'payment',
      subjectId: intentId,
      signals: { rail: event.rail, amountMinor: BigInt(input.amountMinor) },
    });
    if (!gate.ok) {
      await writeObservation(tx, draft('HELD_BY_CONTROL', false));
      return gate;
    }
  }

  const observationId = await writeObservation(tx, draft('APPLIED_CONFIRMED', true));
  const entryId = await postConfirmedValue(tx, {
    intentId,
    dealId,
    rail: event.rail,
    amountMinor: input.amountMinor,
  });

  /*
   * THE EXACTLY-ONCE BOUNDARY.
   *
   * `state IN ('INSTRUCTED','OBSERVED')` in the WHERE clause means a
   * concurrent confirmation that already moved the row finds zero rows.
   * Combined with the `FOR UPDATE` taken during matching, exactly one
   * delivery reaches this update — decided by the database.
   */
  const settled = await tx.query(
    `UPDATE sandbox.payment_intent
        SET state='CONFIRMED', ledger_entry_id=$2, confirmed_observation_id=$3,
            settled_at=now(), version=version+1
      WHERE intent_id=$1 AND state IN ('INSTRUCTED','OBSERVED')
      RETURNING intent_id`,
    [intentId, entryId, observationId],
  );
  if (settled.rowCount === 0) {
    return accept({
      observationId,
      intentId,
      matchOutcome: 'DUPLICATE_CONCURRENT_CONFIRMATION',
      state: 'CONFIRMED',
      ledgerEntryId: null,
    });
  }

  return accept({
    observationId,
    intentId,
    matchOutcome: 'APPLIED_CONFIRMED',
    state: 'CONFIRMED',
    ledgerEntryId: entryId,
  });
}

/* ------------------------------------------------------------------ *
 * The ledger posting
 * ------------------------------------------------------------------ */

/**
 * Post confirmed external value into the DEL-04 ledger.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE ONLY LEDGER WRITE IN DEL-05, CALLED FROM EXACTLY ONE PLACE.   │
 * │                                                                    │
 * │  Three independent guarantees of exactly-once, because a duplicated│
 * │  deposit posting is indistinguishable from theft:                  │
 * │                                                                    │
 * │    · `payment_intent_entry_uq` — one entry, one intent;            │
 * │    · the guarded UPDATE above — one confirming delivery;           │
 * │    · `post_entry`'s digest uniqueness — the entry key carries the  │
 * │      intent id, so a second call returns the FIRST entry rather    │
 * │      than creating another.                                        │
 * │                                                                    │
 * │  THE INR RAIL POSTS NOTHING, AND THAT IS NOT AN OMISSION. A        │
 * │  confirmed INR payment means rupees moved between two BANK         │
 * │  accounts. INRP2P holds no rupees, TS-02 §4 forbids an INR ledger  │
 * │  balance, and inventing one would be a claim to hold customer      │
 * │  money that is simply false.                                       │
 * └────────────────────────────────────────────────────────────────────┘
 */
async function postConfirmedValue(
  tx: Tx,
  input: {
    intentId: string;
    dealId: string;
    rail: Rail;
    amountMinor: string;
  },
): Promise<string | null> {
  if (input.rail === 'INR') return null;

  const [wallet, escrow] = await ensureAccounts(tx, [
    depositWalletKey('USDT'),
    dealEscrowKey(input.dealId, 'USDT'),
  ]);

  /*
   * Debit the deposit wallet (+): the custodian now genuinely holds these
   * tokens, because a watcher saw them arrive and the confirmation policy
   * was satisfied. Credit the deal escrow (−): we owe them to the deal's
   * outcome. The pair sums to zero, which DEL-04's constraint trigger
   * verifies at commit.
   */
  const { rows } = await tx.query(
    `SELECT inrp2p.post_entry('JD-DEP-CONFIRM', $1::jsonb, ARRAY[$2::uuid,$3::uuid],
                              ARRAY[$4::numeric,$5::numeric]) AS entry_id`,
    [
      JSON.stringify({ intentId: input.intentId, dealId: input.dealId, rail: 'USDT' }),
      wallet,
      escrow,
      input.amountMinor,
      `-${input.amountMinor}`,
    ],
  );
  return rows[0]!.entry_id as string;
}

/* ------------------------------------------------------------------ *
 * Client evidence — stored, never believed
 * ------------------------------------------------------------------ */

/**
 * Record what a human says they did.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THIS FUNCTION CANNOT CONFIRM A PAYMENT, AND THAT IS STRUCTURAL.   │
 * │                                                                    │
 * │  It writes a `CLIENT_EVIDENCE` row, which the database constrains  │
 * │  to `kind = 'PENDING'` AND `accepted = FALSE`. It never touches    │
 * │  `payment_intent.state`, never calls `postConfirmedValue`, and     │
 * │  holds no branch that could. Someone adding one later would have   │
 * │  to defeat two CHECK constraints as well as the code.              │
 * │                                                                    │
 * │  The evidence is genuinely useful — a reviewer investigating a     │
 * │  stuck payment needs the reference the payer says they sent. It is │
 * │  just never, on its own, a reason to release anything.             │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function recordClientEvidence(
  tx: Tx,
  input: {
    readonly actorId: string;
    readonly intentId: string;
    readonly reference: string;
  },
): Promise<Outcome<{ observationId: string; settles: false }>> {
  const { rows } = await tx.query(
    `SELECT intent_id, deal_id, rail, network, state, asset,
            amount_minor::text AS amount_minor, payer_id
       FROM sandbox.payment_intent WHERE intent_id = $1 FOR UPDATE`,
    [input.intentId],
  );
  if (rows[0] === undefined) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);
  const intent = rows[0];

  // The payer, and only the payer. Checked before the state, so a
  // stranger probing intent ids learns nothing about them.
  if ((intent.payer_id as string) !== input.actorId) {
    return reject('NOT_A_PARTICIPANT', FAILURE_COPY.NOT_A_PARTICIPANT.reason);
  }
  if (!['INSTRUCTED', 'OBSERVED'].includes(intent.state as string)) {
    return reject('PAYMENT_NOT_INSTRUCTED', FAILURE_COPY.PAYMENT_NOT_INSTRUCTED.reason);
  }

  const rail = intent.rail as Rail;
  const normalized = normalizeReference(rail, input.reference);
  if (!normalized.ok) return reject('REFERENCE_INVALID', normalized.reason);

  /*
   * A reference already claimed by an ACCEPTED authoritative observation
   * on another intent is refused — not because the evidence could settle
   * anything, but because storing it would put a contradicting record in
   * front of a reviewer.
   */
  const { rows: taken } = await tx.query(
    `SELECT intent_id FROM sandbox.payment_observation
      WHERE rail = $1 AND external_ref = $2 AND accepted AND kind = 'CONFIRMED'
        AND source IN ('PROVIDER_WEBHOOK','CHAIN_WATCHER')
        AND intent_id IS DISTINCT FROM $3`,
    [rail, normalized.value, input.intentId],
  );
  if (taken[0]) {
    return reject('REFERENCE_ALREADY_USED', FAILURE_COPY.REFERENCE_ALREADY_USED.reason);
  }

  const inserted = await tx.query(
    `INSERT INTO sandbox.payment_observation
       (intent_id, deal_id, rail, network, source, kind, submitted_by,
        external_ref, asset, amount_minor, confirmations, observed_at,
        match_outcome, accepted)
     VALUES ($1,$2,$3,$4,'CLIENT_EVIDENCE','PENDING',$5,$6,$7,$8,0,now(),
             'EVIDENCE_ONLY_NOT_SETTLING', FALSE)
     RETURNING observation_id`,
    [
      input.intentId,
      intent.deal_id,
      rail,
      intent.network,
      input.actorId,
      normalized.value,
      intent.asset,
      intent.amount_minor,
    ],
  );

  return accept({ observationId: inserted.rows[0]!.observation_id as string, settles: false });
}

/* ------------------------------------------------------------------ *
 * Expiry
 * ------------------------------------------------------------------ */

/**
 * Close out payment demands whose window has passed.
 *
 * Uses the DATABASE clock, not the application's. A server with a skewed
 * clock must not be able to expire a payment early — the payer is looking
 * at a countdown that came from that same database.
 */
export async function expirePaymentIntents(tx: Tx): Promise<readonly string[]> {
  const { rows } = await tx.query(
    `UPDATE sandbox.payment_intent
        SET state='EXPIRED', settled_at=now(), version=version+1,
            failure_reason='The payment window closed before the transfer was confirmed.'
      WHERE state IN ('REQUESTED','INSTRUCTED','OBSERVED') AND expires_at <= now()
      RETURNING intent_id`,
  );
  return rows.map((r) => r.intent_id as string);
}
