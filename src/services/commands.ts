import 'server-only';
import { createHash } from 'node:crypto';
import {
  cancelDealIn,
  closeDealLinkIn,
  confirmReceiptIn,
  createDealIntentIn,
  joinDealLinkIn,
  postMessageIn,
  raiseDisputeIn,
  submitPaymentClaimIn,
  type DealIntent,
  type DealState,
  type DisputeReason,
  type JoinSuccess,
  type LinkClosure,
  type SessionUser,
} from '@/server/sandbox/service';
import { ruleOnDisputeIn, type Ruling } from '@/server/sandbox/ops';
import type { Principal } from '@/server/identity/rbac';
import { isCommandId, runCommand, writeAudit } from '@/server/boundary/command';
import {
  fundSandboxBalance,
  lockDealValue,
  refundDealValue,
  releaseDealValue,
  reverseLock,
  type ValueLock,
} from '@/server/ledger/valueProtection';
import type { LedgerAsset } from '@/server/ledger/accounts';
import {
  issueInstruction,
  openIntent,
  redactInstruction,
  type PaymentInstruction,
  type PaymentIntent,
} from '@/server/rails/intents';
import {
  ingestProviderEvent,
  recordClientEvidence,
  type IngestResult,
  type ProviderEvent,
} from '@/server/rails/observations';
import { redactReference, type Network, type Rail } from '@/lib/railReference';
import type { SignedDelivery } from '@/server/rails/webhook';
import { reject, type Outcome } from '@/server/boundary/outcome';
import { DEFAULT_FEE_BEARER } from '@/server/adapters/policy';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { parseInrToMinor, parseUsdtToMicro } from '@/lib/parse';
import type { Scenario } from '@/lib/scenario';

/**
 * The DEL-02 command layer.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THIS IS THE CODE THE TESTS RUN, AND THE CODE THE BROWSER RUNS.    │
 * │                                                                    │
 * │  It used to live inside the `'use server'` actions, which are      │
 * │  awkward to call from a test: they resolve a session from a        │
 * │  request-scoped cookie store and they navigate by throwing. So the │
 * │  first version of the suite rebuilt each `runCommand(...)` call by │
 * │  hand — and a test that reconstructs the thing it is testing       │
 * │  proves only that the reconstruction works. A parser bug in the    │
 * │  real action would have sailed straight through.                   │
 * │                                                                    │
 * │  Everything that decides anything now lives here: argument         │
 * │  parsing, command identity, payload canonicalisation, the boundary │
 * │  call. The action wrapper is left with exactly three jobs —        │
 * │  resolve the session, redirect, revalidate — none of which can     │
 * │  change an outcome.                                                │
 * └────────────────────────────────────────────────────────────────────┘
 */

/* ------------------------------------------------------------------ *
 * Creating a deal
 * ------------------------------------------------------------------ */

export interface CreateDealInput {
  readonly commandId: string;
  readonly scenario: Scenario;
  readonly inrAmount?: string;
  readonly usdtAmount?: string;
  readonly intent: 'PAY' | 'RECEIVE';
  readonly title?: string | null;
}

/**
 * Issue a quote and mint its link, as one command.
 *
 * `feeBearer` is deliberately absent from the input. It is server policy
 * (UX-01 §3, roadmap B4), so a forged payload has nothing to select: the
 * field the browser used to send no longer exists on this boundary, and
 * the value written to the quote comes from `DEFAULT_FEE_BEARER`.
 */
export async function createDealCommand(
  user: SessionUser,
  input: CreateDealInput,
): Promise<Outcome<DealIntent>> {
  if (!isCommandId(input.commandId)) {
    return reject('COMMAND_ID_INVALID', FAILURE_COPY.COMMAND_ID_INVALID.reason);
  }

  const isExchange = input.scenario !== 'INR_TO_INR';
  const usdtMinor = isExchange && input.usdtAmount ? parseUsdtToMicro(input.usdtAmount) : undefined;
  const inrMinor = usdtMinor === undefined ? parseInrToMinor(input.inrAmount ?? '') : undefined;

  if (usdtMinor === null || inrMinor === null) {
    return reject('AMOUNT_INVALID', FAILURE_COPY.AMOUNT_INVALID.reason);
  }

  return runCommand({
    commandId: input.commandId,
    commandType: 'DEAL_INTENT_CREATE',
    actorId: user.userId,
    payload: {
      scenario: input.scenario,
      inrMinor: inrMinor?.toString() ?? null,
      usdtMinor: usdtMinor?.toString() ?? null,
      intent: input.intent,
      // Hashed so a policy change is a different command, not a silent
      // re-pricing of one somebody already submitted.
      feeBearer: DEFAULT_FEE_BEARER,
      title: input.title ?? null,
    },
    body: (ctx) =>
      createDealIntentIn(ctx, user, {
        scenario: input.scenario,
        inrMinor: inrMinor ?? undefined,
        usdtMinor: usdtMinor ?? undefined,
        intent: input.intent,
        feeBearer: DEFAULT_FEE_BEARER,
        title: input.title ?? null,
      }),
    encodeResult: (v) => ({ publicId: v.publicId, quoteId: v.quoteId }),
    decodeResult: (r) => ({ publicId: String(r.publicId), quoteId: String(r.quoteId) }),
  });
}

/**
 * The no-JavaScript form, parsed from real `FormData`.
 *
 * The command id arrives in a hidden field rendered by `/app/new`, so a
 * browser repeating the post — on refresh, on back-navigation — sends the
 * same one and replays instead of creating a second deal. Nothing here
 * mints an id: a missing or malformed one is refused, because a
 * server-generated id would differ on every retry and would guarantee the
 * duplicate it is supposed to prevent.
 */
export async function createLinkFromForm(
  user: SessionUser,
  formData: FormData,
): Promise<Outcome<DealIntent>> {
  return createDealCommand(user, {
    commandId: String(formData.get('commandId') ?? ''),
    scenario: 'USDT_TO_INR',
    usdtAmount: String(formData.get('usdt') ?? ''),
    intent: 'RECEIVE',
  });
}

/* ------------------------------------------------------------------ *
 * Link and deal transitions
 * ------------------------------------------------------------------ */

export async function joinCommand(
  user: SessionUser,
  commandId: string,
  publicId: string,
): Promise<Outcome<JoinSuccess>> {
  return runCommand({
    commandId,
    commandType: 'LINK_JOIN',
    actorId: user.userId,
    payload: { publicId },
    body: (ctx) => joinDealLinkIn(ctx, user, publicId),
    encodeResult: (v) => ({
      dealId: v.dealId,
      publicId: v.publicId,
      dealCode: v.dealCode,
      role: v.role,
    }),
    decodeResult: (r) => ({
      kind: 'JOINED' as const,
      dealId: String(r.dealId),
      publicId: String(r.publicId),
      dealCode: String(r.dealCode),
      role: r.role as 'FIAT_SIDE' | 'CRYPTO_SIDE',
    }),
  });
}

export async function closeLinkCommand(
  user: SessionUser,
  commandId: string,
  publicId: string,
): Promise<Outcome<LinkClosure>> {
  return runCommand({
    commandId,
    commandType: 'LINK_CLOSE',
    actorId: user.userId,
    payload: { publicId },
    body: (ctx) => closeDealLinkIn(ctx, user, publicId),
    encodeResult: (v) => ({ publicId: v.publicId, alreadyClosed: v.alreadyClosed }),
    decodeResult: (r) => ({
      publicId: String(r.publicId),
      alreadyClosed: r.alreadyClosed === true,
    }),
  });
}

export async function claimCommand(
  user: SessionUser,
  commandId: string,
  dealId: string,
  utr: string,
  note: string,
): Promise<Outcome<{ dealId: string }>> {
  return runCommand({
    commandId,
    commandType: 'PAYMENT_CLAIM',
    actorId: user.userId,
    payload: { dealId, utr: utr.trim().toUpperCase(), note: note.trim() },
    body: (ctx) => submitPaymentClaimIn(ctx, user, dealId, utr, note),
    encodeResult: (v) => ({ dealId: v.dealId }),
    decodeResult: (r) => ({ dealId: String(r.dealId) }),
  });
}

export async function confirmCommand(
  user: SessionUser,
  commandId: string,
  dealId: string,
): Promise<Outcome<{ dealId: string }>> {
  return runCommand({
    commandId,
    commandType: 'CONFIRM_RECEIPT',
    actorId: user.userId,
    payload: { dealId },
    body: (ctx) => confirmReceiptIn(ctx, user, dealId),
    encodeResult: (v) => ({ dealId: v.dealId }),
    decodeResult: (r) => ({ dealId: String(r.dealId) }),
  });
}

export async function cancelCommand(
  user: SessionUser,
  commandId: string,
  dealId: string,
): Promise<Outcome<{ dealId: string }>> {
  return runCommand({
    commandId,
    commandType: 'DEAL_CANCEL',
    actorId: user.userId,
    payload: { dealId },
    body: (ctx) => cancelDealIn(ctx, user, dealId),
    encodeResult: (v) => ({ dealId: v.dealId }),
    decodeResult: (r) => ({ dealId: String(r.dealId) }),
  });
}

export async function messageCommand(
  user: SessionUser,
  commandId: string,
  dealId: string,
  body: string,
): Promise<Outcome<{ messageId: string }>> {
  return runCommand({
    commandId,
    commandType: 'MESSAGE_POST',
    actorId: user.userId,
    payload: { dealId, body: body.trim() },
    body: (ctx) => postMessageIn(ctx, user, dealId, body),
    encodeResult: (v) => ({ messageId: v.messageId }),
    decodeResult: (r) => ({ messageId: String(r.messageId) }),
  });
}

export async function disputeCommand(
  user: SessionUser,
  commandId: string,
  dealId: string,
  reason: DisputeReason,
  detail: string,
): Promise<Outcome<{ dealId: string }>> {
  return runCommand({
    commandId,
    commandType: 'DISPUTE_RAISE',
    actorId: user.userId,
    payload: { dealId, reason, detail: detail.trim() },
    body: (ctx) => raiseDisputeIn(ctx, user, dealId, reason, detail),
    encodeResult: (v) => ({ dealId: v.dealId }),
    decodeResult: (r) => ({ dealId: String(r.dealId) }),
  });
}

/**
 * Resolve a dispute.
 *
 * Command-bound like every other deal-state transition, and no more than
 * that: this is the existing sandbox ruling, not DEL-06. It adds no
 * maker-checker, no ledger disposition and no fund movement, and it is
 * unavailable in production until those exist.
 */
export async function rulingCommand(
  principal: Principal,
  commandId: string,
  dealId: string,
  ruling: Ruling,
  reason: string,
): Promise<Outcome<{ dealId: string; ruling: Ruling; state: DealState }>> {
  return runCommand({
    commandId,
    commandType: 'DISPUTE_RULE',
    actorId: principal.userId,
    payload: { dealId, ruling, reason: reason.trim() },
    body: (ctx) => ruleOnDisputeIn(ctx, principal, dealId, ruling, reason),
    encodeResult: (v) => ({ dealId: v.dealId, ruling: v.ruling, state: v.state }),
    decodeResult: (r) => ({
      dealId: String(r.dealId),
      ruling: r.ruling as Ruling,
      state: r.state as DealState,
    }),
  });
}

/* ------------------------------------------------------------------ *
 * DEL-04 — value protection
 *
 * Each of these runs through the SAME command boundary as every deal
 * mutation, so the command record, the ledger entries, the value-lock
 * row, the audit event and the outbox event are one transaction. There
 * is no path that posts to the ledger outside it.
 * ------------------------------------------------------------------ */

/**
 * Credit a sandbox balance.
 *
 * ⚠ Sandbox only, and `ledger.fund` only. See `fundSandboxBalance` for
 * why a function that invents money carries three separate guards.
 */
export async function fundSandboxCommand(
  principal: Principal,
  commandId: string,
  input: { userId: string; asset: LedgerAsset; amountMinor: bigint },
): Promise<Outcome<{ entryId: string }>> {
  return runCommand({
    commandId,
    commandType: 'LEDGER_FUND',
    actorId: principal.userId,
    payload: { userId: input.userId, asset: input.asset, amountMinor: input.amountMinor },
    body: async (ctx) => {
      const funded = await fundSandboxBalance(ctx.tx, principal, {
        ...input,
        commandId,
      });
      if (!funded.ok) {
        await writeAudit(ctx.tx, {
          actorId: principal.userId,
          action: 'LEDGER_FUND',
          subjectKind: 'user',
          subjectId: input.userId,
          outcome: funded.code,
          detail: { asset: input.asset },
        });
        return funded;
      }
      await ctx.audit({
        actorId: principal.userId,
        action: 'LEDGER_FUND',
        subjectKind: 'user',
        subjectId: input.userId,
        outcome: 'OK',
        detail: { entryId: funded.value.entryId, amountMinor: input.amountMinor.toString() },
      });
      await ctx.emit({
        type: 'ledger.funded',
        subjectKind: 'user',
        subjectId: input.userId,
        payload: { entryId: funded.value.entryId },
      });
      return funded;
    },
    encodeResult: (v) => ({ entryId: v.entryId }),
    decodeResult: (r) => ({ entryId: String(r.entryId) }),
  });
}

/** Lock a participant's available balance into a deal's escrow. */
export async function lockValueCommand(
  user: SessionUser,
  commandId: string,
  input: { dealId: string; asset: LedgerAsset; amountMinor: bigint },
): Promise<Outcome<ValueLock>> {
  return runCommand({
    commandId,
    commandType: 'VALUE_LOCK',
    actorId: user.userId,
    payload: { dealId: input.dealId, asset: input.asset, amountMinor: input.amountMinor },
    body: async (ctx) => {
      // Participation is the authorization: only a seat in the deal may
      // commit that deal's value. Re-derived here, not taken on trust.
      const { rows } = await ctx.tx.query(
        `SELECT 1 FROM sandbox.participant WHERE deal_id = $1 AND user_id = $2`,
        [input.dealId, user.userId],
      );
      if (!rows[0]) {
        await writeAudit(ctx.tx, {
          actorId: user.userId,
          action: 'VALUE_LOCK',
          subjectKind: 'deal',
          subjectId: input.dealId,
          outcome: 'NOT_A_PARTICIPANT',
        });
        return reject('NOT_A_PARTICIPANT', FAILURE_COPY.NOT_A_PARTICIPANT.reason);
      }

      const locked = await lockDealValue(ctx.tx, {
        dealId: input.dealId,
        ownerId: user.userId,
        commandId,
        asset: input.asset,
        amountMinor: input.amountMinor,
      });
      if (!locked.ok) {
        await writeAudit(ctx.tx, {
          actorId: user.userId,
          action: 'VALUE_LOCK',
          subjectKind: 'deal',
          subjectId: input.dealId,
          outcome: locked.code,
          detail: locked.detail ?? {},
        });
        return locked;
      }
      await ctx.audit({
        actorId: user.userId,
        action: 'VALUE_LOCK',
        subjectKind: 'deal',
        subjectId: input.dealId,
        toState: 'LOCKED',
        outcome: 'OK',
        detail: { lockId: locked.value.lockId, entryId: locked.value.lockEntryId },
      });
      await ctx.emit({
        type: 'value.locked',
        subjectKind: 'deal',
        subjectId: input.dealId,
        payload: { lockId: locked.value.lockId, amountMinor: locked.value.amountMinor },
      });
      return locked;
    },
    encodeResult: (v) => ({ ...v }) as unknown as Record<string, unknown>,
    decodeResult: (r) => r as unknown as ValueLock,
  });
}

async function settleValueCommand(
  user: SessionUser,
  commandId: string,
  input: { dealId: string; beneficiaryId: string },
  settlement: 'RELEASED' | 'REFUNDED',
): Promise<Outcome<ValueLock>> {
  return runCommand({
    commandId,
    commandType: settlement === 'RELEASED' ? 'VALUE_RELEASE' : 'VALUE_REFUND',
    actorId: user.userId,
    payload: { dealId: input.dealId, beneficiaryId: input.beneficiaryId },
    body: async (ctx) => {
      const { rows } = await ctx.tx.query(
        `SELECT 1 FROM sandbox.participant WHERE deal_id = $1 AND user_id = $2`,
        [input.dealId, user.userId],
      );
      if (!rows[0]) {
        await writeAudit(ctx.tx, {
          actorId: user.userId,
          action: settlement === 'RELEASED' ? 'VALUE_RELEASE' : 'VALUE_REFUND',
          subjectKind: 'deal',
          subjectId: input.dealId,
          outcome: 'NOT_A_PARTICIPANT',
        });
        return reject('NOT_A_PARTICIPANT', FAILURE_COPY.NOT_A_PARTICIPANT.reason);
      }

      const settled =
        settlement === 'RELEASED'
          ? await releaseDealValue(ctx.tx, { ...input, commandId })
          : await refundDealValue(ctx.tx, { ...input, commandId });

      const action = settlement === 'RELEASED' ? 'VALUE_RELEASE' : 'VALUE_REFUND';
      if (!settled.ok) {
        await writeAudit(ctx.tx, {
          actorId: user.userId,
          action,
          subjectKind: 'deal',
          subjectId: input.dealId,
          outcome: settled.code,
        });
        return settled;
      }
      await ctx.audit({
        actorId: user.userId,
        action,
        subjectKind: 'deal',
        subjectId: input.dealId,
        fromState: 'LOCKED',
        toState: settlement,
        outcome: 'OK',
        detail: { lockId: settled.value.lockId, entryId: settled.value.settleEntryId },
      });
      await ctx.emit({
        type: settlement === 'RELEASED' ? 'value.released' : 'value.refunded',
        subjectKind: 'deal',
        subjectId: input.dealId,
        payload: { lockId: settled.value.lockId },
      });
      return settled;
    },
    encodeResult: (v) => ({ ...v }) as unknown as Record<string, unknown>,
    decodeResult: (r) => r as unknown as ValueLock,
  });
}

export function releaseValueCommand(
  user: SessionUser,
  commandId: string,
  input: { dealId: string; beneficiaryId: string },
): Promise<Outcome<ValueLock>> {
  return settleValueCommand(user, commandId, input, 'RELEASED');
}

export function refundValueCommand(
  user: SessionUser,
  commandId: string,
  input: { dealId: string; beneficiaryId: string },
): Promise<Outcome<ValueLock>> {
  return settleValueCommand(user, commandId, input, 'REFUNDED');
}

/** Undo a lock by reversal. `ledger.reverse` only. */
export async function reverseLockCommand(
  principal: Principal,
  commandId: string,
  input: { dealId: string; reason: string },
): Promise<Outcome<{ reversalEntryId: string }>> {
  return runCommand({
    commandId,
    commandType: 'VALUE_REVERSE',
    actorId: principal.userId,
    payload: { dealId: input.dealId, reason: input.reason.trim() },
    body: async (ctx) => {
      const reversed = await reverseLock(ctx.tx, principal, input);
      if (!reversed.ok) {
        await writeAudit(ctx.tx, {
          actorId: principal.userId,
          action: 'VALUE_REVERSE',
          subjectKind: 'deal',
          subjectId: input.dealId,
          outcome: reversed.code,
        });
        return reversed;
      }
      await ctx.audit({
        actorId: principal.userId,
        action: 'VALUE_REVERSE',
        subjectKind: 'deal',
        subjectId: input.dealId,
        toState: 'REVERSED',
        outcome: 'OK',
        detail: { reversalEntryId: reversed.value.reversalEntryId, reason: input.reason.trim() },
      });
      await ctx.emit({
        type: 'value.reversed',
        subjectKind: 'deal',
        subjectId: input.dealId,
        payload: { reversalEntryId: reversed.value.reversalEntryId },
      });
      return reversed;
    },
    encodeResult: (v) => ({ reversalEntryId: v.reversalEntryId }),
    decodeResult: (r) => ({ reversalEntryId: String(r.reversalEntryId) }),
  });
}

/* ------------------------------------------------------------------ *
 * DEL-05 — payment rails
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE COMMANDS THAT TOUCH REAL MONEY, AND WHAT EACH ONE CLAIMS.     │
 * │                                                                    │
 * │  `openPaymentIntent`       — "someone should pay X." Claims nothing.│
 * │  `issuePaymentInstruction` — "pay it HERE." Requires a live lock.  │
 * │  `submitPaymentEvidence`   — "I say I paid." Claims nothing, ever. │
 * │  `ingestRailEvent`         — "the provider says money moved." The  │
 * │                              ONLY path that may confirm and post.  │
 * │                                                                    │
 * │  Every one of them commits its audit row and its outbox event in   │
 * │  the same transaction as its effect, through the DEL-02 boundary.  │
 * └────────────────────────────────────────────────────────────────────┘
 * ------------------------------------------------------------------ */

export async function openPaymentIntentCommand(
  user: SessionUser,
  commandId: string,
  input: {
    dealId: string;
    rail: Rail;
    network: Network;
    direction: 'COLLECT' | 'PAYOUT';
    payeeId: string;
    amountMinor: bigint;
    expiresInSeconds?: number;
  },
): Promise<Outcome<PaymentIntent>> {
  return runCommand({
    commandId,
    commandType: 'PAYMENT_INTENT_OPEN',
    actorId: user.userId,
    payload: {
      dealId: input.dealId,
      rail: input.rail,
      network: input.network,
      direction: input.direction,
      payeeId: input.payeeId,
      amountMinor: input.amountMinor,
    },
    body: async (ctx) => {
      const opened = await openIntent(ctx.tx, {
        dealId: input.dealId,
        rail: input.rail,
        network: input.network,
        direction: input.direction,
        // The ACTOR is the payer. A caller cannot open a demand against
        // somebody else — that would be inventing an obligation.
        payerId: user.userId,
        payeeId: input.payeeId,
        amountMinor: input.amountMinor,
        expiresInSeconds: input.expiresInSeconds ?? 3600,
      });
      if (!opened.ok) {
        await writeAudit(ctx.tx, {
          actorId: user.userId,
          action: 'PAYMENT_INTENT_OPEN',
          subjectKind: 'deal',
          subjectId: input.dealId,
          outcome: opened.code,
          detail: opened.detail ?? {},
        });
        return opened;
      }
      await ctx.audit({
        actorId: user.userId,
        action: 'PAYMENT_INTENT_OPEN',
        subjectKind: 'payment',
        subjectId: opened.value.intentId,
        toState: 'REQUESTED',
        outcome: 'OK',
        detail: {
          dealId: input.dealId,
          rail: input.rail,
          network: input.network,
          amountMinor: opened.value.amountMinor,
        },
      });
      await ctx.emit({
        type: 'payment.intent_opened',
        subjectKind: 'payment',
        subjectId: opened.value.intentId,
        payload: { dealId: input.dealId, rail: input.rail, amountMinor: opened.value.amountMinor },
      });
      return opened;
    },
    encodeResult: (v) => ({ ...v }) as unknown as Record<string, unknown>,
    decodeResult: (r) => r as unknown as PaymentIntent,
  });
}

/**
 * Issue the instruction.
 *
 * The audit detail and the outbox payload carry the REDACTED
 * instruction. An audit row holding the destination account in full is a
 * second copy of the sensitive data, sitting in a table more people can
 * read than the instruction itself.
 */
export async function issuePaymentInstructionCommand(
  user: SessionUser,
  commandId: string,
  input: { intentId: string },
): Promise<Outcome<PaymentInstruction>> {
  return runCommand({
    commandId,
    commandType: 'PAYMENT_INSTRUCTION_ISSUE',
    actorId: user.userId,
    payload: { intentId: input.intentId },
    body: async (ctx) => {
      const issued = await issueInstruction(ctx.tx, user.userId, input.intentId);
      if (!issued.ok) {
        await writeAudit(ctx.tx, {
          actorId: user.userId,
          action: 'PAYMENT_INSTRUCTION_ISSUE',
          subjectKind: 'payment',
          subjectId: input.intentId,
          outcome: issued.code,
          detail: issued.detail ?? {},
        });
        return issued;
      }
      await ctx.audit({
        actorId: user.userId,
        action: 'PAYMENT_INSTRUCTION_ISSUE',
        subjectKind: 'payment',
        subjectId: input.intentId,
        toState: 'INSTRUCTED',
        outcome: 'OK',
        detail: redactInstruction(issued.value),
      });
      await ctx.emit({
        type: 'payment.instruction_issued',
        subjectKind: 'payment',
        subjectId: input.intentId,
        payload: redactInstruction(issued.value),
      });
      return issued;
    },
    encodeResult: (v) => ({ ...v }) as unknown as Record<string, unknown>,
    decodeResult: (r) => r as unknown as PaymentInstruction,
  });
}

/**
 * Record what the payer says they did.
 *
 * The result deliberately carries `settles: false`. A caller rendering
 * this response cannot accidentally show "payment confirmed", because the
 * only field it has says the opposite.
 */
export async function submitPaymentEvidenceCommand(
  user: SessionUser,
  commandId: string,
  input: { intentId: string; reference: string },
): Promise<Outcome<{ observationId: string; settles: false }>> {
  return runCommand({
    commandId,
    commandType: 'PAYMENT_EVIDENCE_SUBMIT',
    actorId: user.userId,
    payload: { intentId: input.intentId, reference: input.reference.trim().toUpperCase() },
    body: async (ctx) => {
      const recorded = await recordClientEvidence(ctx.tx, {
        actorId: user.userId,
        intentId: input.intentId,
        reference: input.reference,
      });
      if (!recorded.ok) {
        await writeAudit(ctx.tx, {
          actorId: user.userId,
          action: 'PAYMENT_EVIDENCE_SUBMIT',
          subjectKind: 'payment',
          subjectId: input.intentId,
          outcome: recorded.code,
        });
        return recorded;
      }
      await ctx.audit({
        actorId: user.userId,
        action: 'PAYMENT_EVIDENCE_SUBMIT',
        subjectKind: 'payment',
        subjectId: input.intentId,
        outcome: 'OK',
        // Redacted: a UTR is a payment credential in practice.
        detail: {
          observationId: recorded.value.observationId,
          reference: redactReference(input.reference.trim().toUpperCase()),
          settles: false,
        },
      });
      await ctx.emit({
        type: 'payment.evidence_submitted',
        subjectKind: 'payment',
        subjectId: input.intentId,
        payload: { observationId: recorded.value.observationId, settles: false },
      });
      return recorded;
    },
    encodeResult: (v) => ({ observationId: v.observationId, settles: false }),
    decodeResult: (r) => ({ observationId: String(r.observationId), settles: false }),
  });
}

/**
 * A stable command id for one provider delivery.
 *
 * UUIDv5-shaped and derived from (provider, event id), so a redelivery
 * computes the SAME id and meets the DEL-02 idempotency record rather
 * than starting a second execution. A random id here would make the
 * command boundary useless in exactly the case where it matters most.
 */
export function railEventCommandId(providerKey: string, providerEventId: string): string {
  const bytes = createHash('sha256')
    .update(`rail-event ${providerKey} ${providerEventId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/**
 * Ingest a signed provider or watcher event.
 *
 * `actorId` is null, deliberately: a provider is not a user of this
 * system and must not inherit anybody's authority. Its authorization is
 * the signature, checked inside `ingestProviderEvent`, and nothing else.
 *
 * The command id is derived from the provider event id, so the DEL-02
 * boundary deduplicates redeliveries a SECOND time — independently of
 * `rail_event`'s uniqueness. Two mechanisms, because a duplicated
 * confirmation posts value twice.
 */
export async function ingestRailEventCommand(
  delivery: SignedDelivery,
  event: ProviderEvent,
  options: { now?: Date; source?: 'PROVIDER_WEBHOOK' | 'CHAIN_WATCHER' } = {},
): Promise<Outcome<IngestResult>> {
  const commandId = railEventCommandId(delivery.providerKey, event.providerEventId);
  return runCommand({
    commandId,
    commandType: 'RAIL_EVENT_INGEST',
    actorId: null,
    /*
     * The payload covers the BODY, not just the event id.
     *
     * Without the digest, an attacker who captured one delivery could
     * resend its id with edited contents and the boundary would see an
     * identical payload hash — an "identical replay" — and hand back the
     * FIRST delivery's success. With it, the same id carrying different
     * bytes is an `IDEMPOTENCY_CONFLICT`, refused before the body runs.
     */
    payload: {
      providerKey: delivery.providerKey,
      providerEventId: event.providerEventId,
      bodyDigest: createHash('sha256').update(delivery.rawBody).digest('hex'),
    },
    body: async (ctx) => {
      const ingested = await ingestProviderEvent(ctx.tx, delivery, event, options);
      if (!ingested.ok) {
        await writeAudit(ctx.tx, {
          actorId: null,
          action: 'RAIL_EVENT_INGEST',
          subjectKind: 'payment',
          // A refused event may have matched nothing at all, in which
          // case the delivery itself is the subject.
          subjectId: (ingested.detail?.observationId as string | undefined) ?? commandId,
          outcome: ingested.code,
          detail: { providerKey: delivery.providerKey, ...(ingested.detail ?? {}) },
        });
        return ingested;
      }
      await ctx.audit({
        actorId: null,
        action: 'RAIL_EVENT_INGEST',
        subjectKind: 'payment',
        subjectId: ingested.value.intentId ?? commandId,
        toState: ingested.value.state,
        outcome: 'OK',
        detail: {
          providerKey: delivery.providerKey,
          matchOutcome: ingested.value.matchOutcome,
          ledgerEntryId: ingested.value.ledgerEntryId,
        },
      });
      await ctx.emit({
        type:
          ingested.value.state === 'CONFIRMED'
            ? 'payment.confirmed'
            : ingested.value.state === 'REVERSED'
              ? 'payment.reversed'
              : 'payment.observed',
        subjectKind: 'payment',
        subjectId: ingested.value.intentId ?? commandId,
        payload: {
          matchOutcome: ingested.value.matchOutcome,
          state: ingested.value.state,
          ledgerEntryId: ingested.value.ledgerEntryId,
        },
      });
      return ingested;
    },
    encodeResult: (v) => ({ ...v }) as unknown as Record<string, unknown>,
    decodeResult: (r) => r as unknown as IngestResult,
  });
}
