/**
 * Sandbox contract — shared by server and client.
 *
 * Types, the closed rejection vocabulary, and the copy that explains each
 * rejection. Deliberately free of `server-only`, `pg` and any database import,
 * because client components legitimately need to *render* an outcome the
 * server decided.
 *
 * Nothing here decides anything. Authorization, status and permitted actions
 * are computed in `service.ts` on the server; this module only names them.
 */

import type { Role, Scenario } from './scenario';
import type { FeeBearer } from './fees';

export type { Role, Scenario, FeeBearer };

export type SandboxError =
  | 'UNAUTHENTICATED'
  | 'NOT_FOUND'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_CONSUMED'
  | 'LINK_EXPIRED'
  | 'LINK_CONSUMED'
  | 'LINK_CLOSED'
  | 'CANNOT_JOIN_OWN_LINK'
  | 'NOT_A_PARTICIPANT'
  | 'NOT_FIAT_SIDE'
  | 'NOT_CRYPTO_SIDE'
  | 'ALREADY_CLAIMED'
  | 'NOT_CLAIMED_YET'
  | 'DEAL_TERMINAL'
  | 'UTR_INVALID'
  | 'UTR_ALREADY_USED'
  | 'SELF_CONFIRM_FORBIDDEN'
  | 'REQUIRES_VERIFICATION'
  | 'DEAL_DISPUTED'
  | 'ALREADY_DISPUTED'
  | 'WINDOW_LAPSED'
  | 'EVIDENCE_TOO_LARGE'
  | 'EVIDENCE_TYPE_REJECTED'
  | 'MESSAGE_EMPTY'
  | 'AMOUNT_INVALID'
  | 'AMOUNT_TOO_SMALL'
  | 'AMOUNT_TOO_LARGE'
  /* ---- DEL-02 boundary vocabulary ---------------------------------- */
  | 'COMMAND_ID_INVALID'
  | 'COMMAND_NOT_YOURS'
  | 'IDEMPOTENCY_CONFLICT'
  | 'FEE_EXCEEDS_AMOUNT'
  | 'SCENARIO_UNAVAILABLE'
  | 'ADAPTER_UNAVAILABLE'
  /* ---- DEL-03 identity and access vocabulary ----------------------- */
  | 'AUTH_EMAIL_INVALID'
  | 'AUTH_CHALLENGE_INVALID'
  | 'RATE_LIMITED'
  | 'TELEGRAM_LAUNCH_REPLAYED'
  | 'ACCOUNT_LINK_CONFLICT'
  | 'MFA_REQUIRED'
  | 'MFA_INVALID'
  | 'MFA_NOT_ENROLLED'
  | 'SESSION_EXPIRED'
  | 'PERMISSION_DENIED'
  | 'REVIEWER_CONFLICT'
  /* ---- DEL-04 value protection -------------------------------------- */
  | 'INSUFFICIENT_BALANCE'
  /* ---- DEL-05 payment rails ----------------------------------------- */
  | 'VALUE_NOT_LOCKED'
  | 'PAYMENT_INTENT_EXISTS'
  | 'PAYMENT_INTENT_TERMINAL'
  | 'PAYMENT_NOT_INSTRUCTED'
  | 'RAIL_UNSUPPORTED'
  | 'NETWORK_INVALID'
  | 'REFERENCE_INVALID'
  | 'REFERENCE_ALREADY_USED'
  | 'AMOUNT_MISMATCH'
  | 'ASSET_MISMATCH'
  | 'BENEFICIARY_MISMATCH'
  | 'WEBHOOK_UNVERIFIED'
  | 'WEBHOOK_REPLAYED'
  | 'OBSERVATION_UNMATCHED'
  | 'CONFIRMATIONS_INSUFFICIENT'
  /* ---- DEL-06 deal room, evidence and disputes ---------------------- */
  | 'CASE_ALREADY_OPEN'
  | 'CASE_NOT_OPEN'
  | 'CASE_TERMINAL'
  | 'CASE_STALE'
  | 'STATEMENT_TOO_SHORT'
  | 'PROPOSAL_EXISTS'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_STALE'
  | 'SELF_APPROVAL_FORBIDDEN'
  | 'DEAL_FROZEN'
  | 'EVIDENCE_NOT_READY'
  | 'EVIDENCE_REJECTED'
  | 'CAPABILITY_INVALID'
  | 'CAPABILITY_EXPIRED'
  | 'CAPABILITY_CONSUMED'
  | 'MESSAGE_TOO_LONG'
  | 'INCIDENT_RAISED';

export class SandboxFailure extends Error {
  readonly code: SandboxError;
  constructor(code: SandboxError, message: string) {
    super(message);
    this.name = 'SandboxFailure';
    this.code = code;
  }
}

/**
 * Every rejection carries the reason AND the permitted next step, because a
 * blocked screen that does not say what to do next is a dead end.
 */
export const FAILURE_COPY: Readonly<
  Record<SandboxError, { readonly reason: string; readonly nextStep: string }>
> = {
  UNAUTHENTICATED: {
    reason: 'You are not signed in.',
    nextStep: 'Sign in, then open this link again. Your place is not lost.',
  },
  NOT_FOUND: {
    reason: 'This reference does not exist.',
    nextStep: 'Check the link you were sent, or ask the sender to reissue it.',
  },
  QUOTE_EXPIRED: {
    reason: 'The quoted rate expired before it was used.',
    nextStep: 'Request a fresh quote. The new rate may differ from the one you saw.',
  },
  QUOTE_CONSUMED: {
    reason: 'That quote has already been turned into a deal link.',
    nextStep: 'Request a fresh quote to create another link.',
  },
  LINK_EXPIRED: {
    reason: 'This deal link expired and can no longer be joined.',
    nextStep: 'Ask the sender to issue a new link. Nothing was charged to you.',
  },
  LINK_CONSUMED: {
    reason: 'Someone else joined this deal first.',
    nextStep: 'Ask the sender for a fresh link. Nothing was charged to you.',
  },
  LINK_CLOSED: {
    reason: 'The sender withdrew this deal link before anyone joined.',
    nextStep: 'Ask them to issue a new one if you still want to trade.',
  },
  CANNOT_JOIN_OWN_LINK: {
    reason: 'You created this link, so you already hold one side of it.',
    nextStep: 'Send the link to the person you want to trade with.',
  },
  NOT_A_PARTICIPANT: {
    reason: 'This deal is private to the two people trading.',
    nextStep: 'If you were sent a link to join, open that link instead.',
  },
  NOT_FIAT_SIDE: {
    reason: 'Only the side sending the INR can mark a payment.',
    nextStep: 'You are receiving the INR. Wait for their payment, then confirm it.',
  },
  NOT_CRYPTO_SIDE: {
    reason: 'Only the side receiving the INR can confirm it arrived.',
    nextStep: 'You sent the INR. The other side confirms once it lands.',
  },
  ALREADY_CLAIMED: {
    reason: 'A payment has already been marked for this deal.',
    nextStep: 'Wait for the other side to check their bank and confirm.',
  },
  NOT_CLAIMED_YET: {
    reason: 'No payment has been marked for this deal yet.',
    nextStep: 'Wait until the other side marks the INR sent.',
  },
  DEAL_TERMINAL: {
    reason: 'This deal is finished and can no longer change.',
    nextStep: 'Nothing further is required. Start a new deal if you want to trade again.',
  },
  UTR_INVALID: {
    reason: 'That reference is not a valid UTR.',
    nextStep: 'Enter the 12-character reference from your bank confirmation.',
  },
  UTR_ALREADY_USED: {
    reason: 'That UTR has already been used on another deal.',
    nextStep: 'Enter the reference for this specific transfer.',
  },
  SELF_CONFIRM_FORBIDDEN: {
    reason: 'You cannot confirm your own payment.',
    nextStep: 'The other side confirms once the money reaches their account.',
  },
  REQUIRES_VERIFICATION: {
    reason: 'Your sandbox account is not verified.',
    nextStep: 'Use a verified sandbox account to join.',
  },
  DEAL_DISPUTED: {
    reason: 'Release is paused while this deal is under review.',
    nextStep: 'Add anything that supports your case. An operator decides the outcome.',
  },
  ALREADY_DISPUTED: {
    reason: 'A problem has already been reported on this deal.',
    nextStep: 'Open the existing case and add your evidence there.',
  },
  WINDOW_LAPSED: {
    reason: 'The payment window for this deal has passed.',
    nextStep: 'Nothing was released. Report a problem to have an operator look at it.',
  },
  EVIDENCE_TOO_LARGE: {
    reason: 'That file is larger than 5 MB.',
    nextStep: 'Attach a smaller file — a photo of the receipt is usually well under 1 MB.',
  },
  EVIDENCE_TYPE_REJECTED: {
    reason: 'That file type is not accepted as evidence.',
    nextStep: 'Attach a PDF, PNG, JPG or WebP.',
  },
  MESSAGE_EMPTY: {
    reason: 'That message is empty.',
    nextStep: 'Write something before sending, or attach a file instead.',
  },
  AMOUNT_INVALID: {
    reason: 'That amount is not a valid figure.',
    nextStep: 'Enter digits only, with up to two decimal places for rupees.',
  },
  AMOUNT_TOO_SMALL: {
    reason: 'That amount is below the minimum for a protected deal.',
    nextStep: 'Protected deals start at ₹100. Enter a larger amount.',
  },
  AMOUNT_TOO_LARGE: {
    reason: 'That amount is above your current per-deal limit.',
    nextStep: 'Complete more deals or verify your identity to raise the limit.',
  },
  COMMAND_ID_INVALID: {
    reason: 'That request was not addressed correctly.',
    nextStep: 'Reload the page and try once more. Nothing was created.',
  },
  COMMAND_NOT_YOURS: {
    reason: 'That request reference belongs to a different account.',
    nextStep: 'Reload the page and submit again. Nothing was created or changed.',
  },
  IDEMPOTENCY_CONFLICT: {
    reason: 'This request reuses the reference of a different, earlier request.',
    nextStep: 'Reload the page and submit again. The earlier request is unaffected.',
  },
  FEE_EXCEEDS_AMOUNT: {
    reason: 'With the receiver paying the fees, nothing would be left to receive.',
    nextStep: 'Raise the amount, or set the sender to pay the fees.',
  },
  SCENARIO_UNAVAILABLE: {
    reason: 'This kind of deal is not available on this deployment.',
    nextStep: 'Choose an exchange instead. Nothing was created.',
  },
  ADAPTER_UNAVAILABLE: {
    reason: 'This deployment cannot service that request.',
    nextStep: 'Nothing was created or charged. Contact support if this persists.',
  },
  AUTH_EMAIL_INVALID: {
    reason: 'That does not look like an email address.',
    nextStep: 'Check it and try again — nothing was sent.',
  },
  AUTH_CHALLENGE_INVALID: {
    /*
     * ONE SENTENCE FOR EVERY FAILURE MODE.
     *
     * Wrong code, expired code, already-used code and unknown address all
     * say this. Distinguishing them would tell a stranger which addresses
     * have pending sign-ins and which codes were once valid. The audit
     * trail records which it actually was.
     */
    reason: 'That sign-in code is not valid.',
    nextStep: 'Request a fresh code. Each one works once and expires quickly.',
  },
  RATE_LIMITED: {
    reason: 'Too many attempts from this account.',
    nextStep: 'Wait a few minutes and try again. Nothing was changed.',
  },
  TELEGRAM_LAUNCH_REPLAYED: {
    reason: 'This Telegram launch has already been used.',
    nextStep: 'Open the app from Telegram again to start a fresh session.',
  },
  ACCOUNT_LINK_CONFLICT: {
    reason: 'That account is already linked to a different identity.',
    nextStep: 'Sign in with the identity you already linked, or contact support.',
  },
  MFA_REQUIRED: {
    reason: 'This action needs your second factor.',
    nextStep: 'Enter the code from your authenticator app, then try again.',
  },
  MFA_INVALID: {
    reason: 'That code is not valid.',
    nextStep: 'Wait for the next code in your app and enter it. Each code works once.',
  },
  MFA_NOT_ENROLLED: {
    reason: 'This account has no second factor enrolled.',
    nextStep: 'Set up an authenticator app in Security before using operator tools.',
  },
  SESSION_EXPIRED: {
    reason: 'Your session has ended.',
    nextStep: 'Sign in again. Nothing you did earlier was lost.',
  },
  PERMISSION_DENIED: {
    reason: 'Your account does not have access to that.',
    nextStep: 'If you need it, ask an administrator — it cannot be granted from here.',
  },
  REVIEWER_CONFLICT: {
    reason: 'A verification cannot be decided by the person it is about.',
    nextStep: 'Another reviewer must take this case.',
  },
  INSUFFICIENT_BALANCE: {
    reason: 'There is not enough available balance to protect this deal.',
    nextStep: 'Free up locked value or reduce the amount. Nothing was locked or charged.',
  },

  /* ---- DEL-05 payment rails ------------------------------------------ *
   *
   * Two audiences read these sentences, and they need different things.
   *
   * A PAYER needs to know whether to send money and what to do instead.
   * So every message that could be read as "your transfer is fine" is
   * written so it cannot be: an unmatched observation says the payment is
   * not settled, not that it is "being processed".
   *
   * An ATTACKER reads them too. The webhook failures deliberately say the
   * same thing for a wrong signature, a stale timestamp and a replay:
   * the specific reason is audited, not returned.
   */

  VALUE_NOT_LOCKED: {
    reason: 'Payment instructions are unavailable until the deal value is locked.',
    nextStep: 'Lock the value for this deal first. Do not send any money yet.',
  },
  PAYMENT_INTENT_EXISTS: {
    reason: 'A payment is already running for this deal on that rail.',
    nextStep: 'Use the existing payment. Sending twice will not settle twice.',
  },
  PAYMENT_INTENT_TERMINAL: {
    reason: 'That payment has already finished and cannot change.',
    nextStep: 'Open the deal to see the recorded outcome.',
  },
  PAYMENT_NOT_INSTRUCTED: {
    reason: 'No payment instruction has been issued for this deal yet.',
    nextStep: 'Request the payment instruction before reporting a transfer.',
  },
  RAIL_UNSUPPORTED: {
    reason: 'That payment rail is not available.',
    nextStep: 'Use a supported rail for this deal.',
  },
  NETWORK_INVALID: {
    reason: 'That network does not belong to this payment rail.',
    nextStep: 'Check the network. Sending on the wrong network loses the funds permanently.',
  },
  REFERENCE_INVALID: {
    reason: 'That payment reference is not in a recognised format.',
    nextStep: 'Copy the reference exactly as your bank or wallet shows it.',
  },
  REFERENCE_ALREADY_USED: {
    reason: 'That payment reference has already been recorded.',
    nextStep: 'A reference identifies one transfer and cannot be reused. Check the deal.',
  },
  AMOUNT_MISMATCH: {
    reason: 'The amount reported does not match the amount this payment requires.',
    nextStep: 'Nothing was settled. Contact support with the deal and the reference.',
  },
  ASSET_MISMATCH: {
    reason: 'The asset reported does not match the asset this payment requires.',
    nextStep: 'Nothing was settled. Contact support with the deal and the reference.',
  },
  BENEFICIARY_MISMATCH: {
    reason: 'The payment did not arrive at the destination this deal issued.',
    nextStep: 'Nothing was settled. Contact support before sending anything further.',
  },
  WEBHOOK_UNVERIFIED: {
    reason: 'That provider event could not be verified.',
    nextStep: 'The event was recorded and refused. No payment state changed.',
  },
  WEBHOOK_REPLAYED: {
    reason: 'That provider event has already been processed.',
    nextStep: 'The first delivery was applied. Redelivery changes nothing.',
  },
  OBSERVATION_UNMATCHED: {
    reason: 'That report does not correspond to any payment awaiting settlement.',
    nextStep: 'The report was recorded for review. The payment is NOT settled.',
  },
  CONFIRMATIONS_INSUFFICIENT: {
    reason: 'The transfer has been seen but does not yet have enough confirmations.',
    nextStep: 'Wait for the network to confirm. The payment is not settled yet.',
  },

  /* ---- DEL-06 deal room, evidence and disputes ----------------------- *
   *
   * A dispute is the moment somebody believes they have been wronged and
   * real money is involved, so these sentences avoid two failure modes.
   * They never imply an outcome the system has not decided — no
   * "we'll get your money back" — and they never leave a person unsure
   * whether their complaint was recorded.
   */

  CASE_ALREADY_OPEN: {
    reason: 'A dispute is already open for this deal.',
    nextStep: 'Add to the existing dispute instead of opening a second one.',
  },
  CASE_NOT_OPEN: {
    reason: 'There is no open dispute for this deal.',
    nextStep: 'Open a dispute first if something is wrong.',
  },
  CASE_TERMINAL: {
    reason: 'That dispute has already been resolved.',
    nextStep: 'Open the deal to see the recorded outcome and the reasoning.',
  },
  CASE_STALE: {
    reason: 'The case changed while this was being decided.',
    nextStep: 'Reload the case and review it again before deciding.',
  },
  STATEMENT_TOO_SHORT: {
    reason: 'Explain what went wrong in at least a sentence.',
    nextStep: 'The other side and the reviewer both read this. Give them the facts.',
  },
  PROPOSAL_EXISTS: {
    reason: 'A resolution is already proposed and waiting for approval.',
    nextStep: 'Approve or reject the outstanding proposal before making another.',
  },
  PROPOSAL_NOT_FOUND: {
    reason: 'That resolution proposal does not exist or is no longer outstanding.',
    nextStep: 'Reload the case.',
  },
  PROPOSAL_STALE: {
    reason: 'That proposal was made against an earlier version of the case.',
    nextStep: 'Reject it and propose again against the current facts.',
  },
  SELF_APPROVAL_FORBIDDEN: {
    reason: 'You cannot approve a resolution you proposed yourself.',
    nextStep: 'A second authorised reviewer must approve it.',
  },
  DEAL_FROZEN: {
    reason: 'This deal is under dispute and cannot be changed until it is resolved.',
    nextStep: 'Add your evidence to the dispute. A reviewer decides what happens next.',
  },
  EVIDENCE_NOT_READY: {
    reason: 'That file has not finished being checked yet.',
    nextStep: 'Try again shortly. Files are scanned before anybody can open them.',
  },
  EVIDENCE_REJECTED: {
    reason: 'That file was refused and cannot be opened.',
    nextStep: 'Upload a valid PDF or image.',
  },
  CAPABILITY_INVALID: {
    reason: 'That download link is not valid.',
    nextStep: 'Open the deal and request the file again.',
  },
  CAPABILITY_EXPIRED: {
    reason: 'That download link has expired.',
    nextStep: 'Request the file again. Links are short-lived on purpose.',
  },
  CAPABILITY_CONSUMED: {
    reason: 'That download link has already been used.',
    nextStep: 'Request the file again.',
  },
  MESSAGE_TOO_LONG: {
    reason: 'That message is longer than 2000 characters.',
    nextStep: 'Shorten it, or attach the detail as evidence.',
  },
  INCIDENT_RAISED: {
    reason: 'This deal needs manual review before anything further can happen.',
    nextStep: 'Support has been notified with the full record. Nothing was changed.',
  },
};

/* ------------------------------------------------------------------ *
 * Shapes returned to the UI
 * ------------------------------------------------------------------ */

/**
 * Deal states.
 *
 * `EXPIRED` is stored here — unlike a LINK, whose expiry is derived —
 * because a lapsed payment window is a decision the server records once,
 * not a fact that flickers as the clock ticks past it.
 */
export type DealState =
  | 'FIAT_PENDING'
  | 'FIAT_CLAIMED'
  | 'DISPUTED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REFUNDED';

/** Note there is no `EXPIRED` member: link expiry is derived, never stored. */
export type LinkState = 'OPEN' | 'CONSUMED' | 'CLOSED';

export const TERMINAL_STATES: ReadonlySet<DealState> = new Set<DealState>([
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
]);

export function isTerminalState(state: DealState): boolean {
  return TERMINAL_STATES.has(state);
}

export interface Terms {
  readonly direction: Scenario;
  /** Null for INR → INR, which has no USDT leg. */
  readonly usdtMinor: string | null;
  readonly inrMinor: string;
  readonly rateNum: string;
  readonly rateDen: string;
  readonly pricingSource: string;
  readonly observedAt: string;
  readonly protectionFeeMinor: string;
  readonly networkFeeMinor: string;
  readonly feeBearer: FeeBearer;
  readonly title: string | null;
}

export interface SandboxQuote extends Terms {
  readonly quoteId: string;
  readonly expiresAt: string;
  /** Server-evaluated. The client never decides this. */
  readonly expired: boolean;
}

/**
 * The public preview.
 *
 * `displayStatus` is a SINGLE value computed server-side, which is what makes
 * "Open" and "Expired" structurally unable to appear together: there is one
 * field and it has one value.
 */
export type PreviewStatus = 'OPEN' | 'EXPIRED' | 'CONSUMED' | 'CLOSED';

export interface LinkPreview extends Terms {
  readonly publicId: string;
  readonly displayStatus: PreviewStatus;
  /** Server's verdict on whether a Join may even be attempted. */
  readonly joinable: boolean;
  readonly expiresAt: string;
  /** The seat the *viewer* would take if they joined. */
  readonly viewerWouldBe: Role;
  /**
   * True only when an authenticated viewer created this link.
   *
   * Computed per request from the session and deliberately absent for an
   * anonymous reader — it is an identity fact, and the public preview and
   * its Open Graph metadata carry no identity. It exists so the creator is
   * offered "share this" and a joiner is offered "take the other side",
   * rather than both being offered both.
   */
  readonly viewerIsCreator: boolean;
  readonly createdAtIso: string;
  /**
   * Who made this link — but ONLY for a signed-in viewer.
   *
   * The disclosure boundary is identity-gated rather than absent, because
   * the two readers are not the same reader. An anonymous fetch is also how
   * an unfurl is generated: public, forwardable, and cached by
   * intermediaries the sender does not control, so it gets `null` and the
   * Open Graph card carries terms alone. A person who has signed in is
   * about to become the counterparty and is entitled to know who they would
   * be dealing with before they commit.
   */
  readonly creatorName: string | null;
  readonly creatorVerified: boolean;
}

export interface DealMessage {
  readonly messageId: string;
  readonly kind: 'CHAT' | 'SYSTEM';
  /** Null on a system line. */
  readonly authorName: string | null;
  readonly authorIsViewer: boolean;
  readonly body: string;
  readonly sentAt: string;
}

export interface DealEvidence {
  readonly evidenceId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly uploadedByName: string;
  readonly uploadedByViewer: boolean;
  readonly uploadedAt: string;
}

export type DisputeReason =
  | 'PAYMENT_NOT_RECEIVED'
  | 'WRONG_AMOUNT'
  | 'PROOF_MISMATCH'
  | 'NOT_AS_AGREED'
  | 'OTHER';

export const DISPUTE_REASON_COPY: Readonly<
  Record<DisputeReason, { readonly label: string; readonly hint: string }>
> = {
  PAYMENT_NOT_RECEIVED: {
    label: 'Payment not received',
    hint: 'The transfer was marked sent but nothing reached the account.',
  },
  WRONG_AMOUNT: {
    label: 'Wrong amount',
    hint: 'Something arrived, but not the figure this deal fixed.',
  },
  PROOF_MISMATCH: {
    label: 'Proof does not match',
    hint: 'The reference or receipt does not correspond to this transfer.',
  },
  NOT_AS_AGREED: {
    label: 'Not as agreed',
    hint: 'The work or goods differ from what the deal described.',
  },
  OTHER: { label: 'Something else', hint: 'Describe it and attach anything relevant.' },
};

export interface DisputeView {
  readonly disputeId: string;
  readonly reason: DisputeReason;
  readonly detail: string | null;
  readonly state: 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED';
  readonly resolution: 'RELEASED' | 'REFUNDED' | 'CANCELLED' | null;
  readonly raisedByViewer: boolean;
  readonly raisedByName: string;
  readonly raisedAt: string;
  readonly resolvedAt: string | null;
}

export interface DealView extends Terms {
  readonly dealId: string;
  readonly publicId: string;
  /** The short, speakable reference: `INR-8K4M`. */
  readonly dealCode: string;
  readonly state: DealState;
  readonly viewerRole: Role;
  readonly counterpartyName: string;
  readonly counterpartyVerified: boolean;
  readonly actionDeadline: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly claim: {
    readonly utr: string;
    readonly submittedAt: string;
    readonly note: string | null;
  } | null;
  readonly messages: readonly DealMessage[];
  readonly evidence: readonly DealEvidence[];
  readonly dispute: DisputeView | null;
  /**
   * Whether an authoritative locked-value fact exists for this deal.
   *
   * Server-computed and server-owned. The UI renders it; it never derives
   * it from a state name, and it must never show payment instructions
   * when this is false — `payTo` is already null in that case, so the
   * flag exists to let a screen EXPLAIN the absence rather than render a
   * blank where instructions were expected.
   */
  readonly valueLocked: boolean;
  /**
   * Where the INR should actually go.
   *
   * Present only to the paying side, and only once `valueLocked` is true
   * (UX-01 §3, TS-01.4 I7). Null in production until DEL-04 provides a
   * value-protection adapter that can assert a lock.
   */
  readonly payTo: {
    readonly kind: 'UPI' | 'BANK' | 'WALLET';
    readonly label: string;
    readonly handle: string;
    readonly bankName: string | null;
    readonly ifsc: string | null;
  } | null;
  /** Server-authorized actions. The UI renders these; it never derives them. */
  readonly permitted: {
    readonly canClaim: boolean;
    readonly canConfirm: boolean;
    readonly canDispute: boolean;
    readonly canMessage: boolean;
    readonly canUpload: boolean;
    readonly canCancel: boolean;
  };
}

export interface SessionUser {
  readonly userId: string;
  /**
   * Null for an account created inside Telegram, which supplies no address.
   *
   * Nullable rather than filled with a synthetic `tg-123@telegram.local`:
   * a fabricated address would eventually be printed on a receipt or used
   * to contact someone, and an account simply having no email is the truth.
   */
  readonly email: string | null;
  readonly displayName: string;
  readonly isOperator: boolean;
  readonly isVerified: boolean;
}

/** How an account is addressed on screen, whichever way it signed in. */
export function accountHandle(account: {
  email: string | null;
  telegramUsername?: string | null;
}): string {
  if (account.telegramUsername) return `@${account.telegramUsername}`;
  return account.email ?? 'Telegram account';
}

/* ------------------------------------------------------------------ *
 * Identity, trust, rewards
 * ------------------------------------------------------------------ */

export interface TrustProfile {
  readonly userId: string;
  readonly displayName: string;
  /** Null for a Telegram account. See `SessionUser.email`. */
  readonly email: string | null;
  /** Present only for an account linked to Telegram. Never an email. */
  readonly telegramUsername: string | null;
  readonly memberSince: string;
  readonly completedDeals: number;
  /** Percentage 0–100, or null when there is no history to divide by. */
  readonly completionRate: number | null;
  readonly openDisputes: number;
  readonly resolvedDisputes: number;
  readonly identityVerified: boolean;
  readonly upiVerified: boolean;
  readonly walletVerified: boolean;
  readonly twoFactorEnabled: boolean;
  readonly notifyEmail: boolean;
  readonly notifyPush: boolean;
  readonly about: string | null;
  readonly city: string | null;
  readonly referralCode: string;
  /** Non-monetary loyalty count. Never a balance, never withdrawable. */
  readonly safePoints: number;
  /** The fee discount those points currently unlock, in INR paise. */
  readonly feeCreditMinor: string;
  readonly level: number;
  readonly volumeInrMinor: string;
}

export interface RewardEntry {
  readonly rewardId: string;
  readonly kind: 'DEAL_COMPLETED' | 'REFERRAL_COMPLETED' | 'VERIFICATION' | 'FEE_CREDIT_APPLIED';
  readonly points: number;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface ReferralEntry {
  readonly referralId: string;
  readonly inviteeName: string;
  readonly joinedAt: string;
  readonly qualifiedAt: string | null;
  readonly points: number;
}

export interface PaymentMethodView {
  readonly methodId: string;
  readonly kind: 'UPI' | 'BANK' | 'WALLET';
  readonly label: string;
  readonly handle: string;
  readonly bankName: string | null;
  readonly ifsc: string | null;
  readonly isDefault: boolean;
  readonly verified: boolean;
  readonly createdAt: string;
}

export interface NotificationView {
  readonly notificationId: string;
  readonly severity: 'INFO' | 'ACTION' | 'WARNING';
  readonly title: string;
  readonly body: string;
  readonly dealId: string | null;
  readonly read: boolean;
  readonly createdAt: string;
}

/* ------------------------------------------------------------------ *
 * Operator
 * ------------------------------------------------------------------ */

export interface OperatorRow {
  readonly dealId: string;
  readonly publicId: string;
  readonly dealCode: string;
  readonly state: DealState;
  readonly direction: Scenario;
  readonly inrMinor: string;
  readonly usdtMinor: string | null;
  readonly waitingMinutes: number;
  readonly disputed: boolean;
  readonly disputeReason: DisputeReason | null;
  readonly payerName: string;
  readonly payeeName: string;
  readonly evidenceCount: number;
  readonly messageCount: number;
}
