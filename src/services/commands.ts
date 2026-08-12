import 'server-only';
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
import { isCommandId, runCommand } from '@/server/boundary/command';
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
