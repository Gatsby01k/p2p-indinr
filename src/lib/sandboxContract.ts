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
  | 'REQUIRES_VERIFICATION';

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
};

/* ------------------------------------------------------------------ *
 * Shapes returned to the UI
 * ------------------------------------------------------------------ */

export type Role = 'FIAT_SIDE' | 'CRYPTO_SIDE';
export type DealState = 'FIAT_PENDING' | 'FIAT_CLAIMED' | 'COMPLETED' | 'CANCELLED';
/** Note there is no `EXPIRED` member: expiry is derived, never stored. */
export type LinkState = 'OPEN' | 'CONSUMED' | 'CLOSED';

export interface Terms {
  readonly direction: 'USDT_TO_INR' | 'INR_TO_USDT';
  readonly usdtMinor: string;
  readonly inrMinor: string;
  readonly rateNum: string;
  readonly rateDen: string;
  readonly pricingSource: string;
  readonly observedAt: string;
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
  readonly createdAtIso: string;
}

export interface DealView extends Terms {
  readonly dealId: string;
  readonly publicId: string;
  readonly state: DealState;
  readonly viewerRole: Role;
  readonly counterpartyName: string;
  readonly actionDeadline: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly claim: {
    readonly utr: string;
    readonly submittedAt: string;
    readonly note: string | null;
  } | null;
  /** Server-authorized actions. The UI renders these; it never derives them. */
  readonly permitted: {
    readonly canClaim: boolean;
    readonly canConfirm: boolean;
  };
}

export interface SessionUser {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly isOperator: boolean;
  readonly isVerified: boolean;
}
