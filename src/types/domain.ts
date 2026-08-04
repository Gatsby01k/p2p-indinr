/**
 * Domain types for the INRP2P frontend.
 *
 * These mirror the state vocabulary of TS-01.4 so the UI never invents a state
 * the backend cannot produce. Where TS-01.4 defines a state machine, the union
 * here is exhaustive against it.
 *
 * This file describes what the UI may *display*. It confers no authority to
 * move money. All money movement is a TS-03 backend concern.
 */

import type { AssetCode, Money } from '@/lib/money';

export type { AssetCode, Money };

/* ------------------------------------------------------------------ *
 * Direction
 * TS-01.4 §3 — the engine is direction-neutral; direction only decides
 * which party holds the crypto leg and which holds the fiat leg.
 * ------------------------------------------------------------------ */

export type Direction = 'USDT_TO_INR' | 'INR_TO_USDT';

export const DIRECTION_LABEL: Readonly<Record<Direction, string>> = {
  USDT_TO_INR: 'Sell USDT',
  INR_TO_USDT: 'Buy USDT',
};

export function fromAsset(d: Direction): AssetCode {
  return d === 'USDT_TO_INR' ? 'USDT' : 'INR';
}

export function toAsset(d: Direction): AssetCode {
  return d === 'USDT_TO_INR' ? 'INR' : 'USDT';
}

export function flipDirection(d: Direction): Direction {
  return d === 'USDT_TO_INR' ? 'INR_TO_USDT' : 'USDT_TO_INR';
}

/* ------------------------------------------------------------------ *
 * Quote — TS-01.4 §7.1, §13.1.3
 * A quote is a fully collateralized, expiring option to MOVE. The UI must
 * present the economic term set as immutable once issued (M12).
 * ------------------------------------------------------------------ */

export type QuoteStatus = 'QUOTED' | 'CONSUMED' | 'EXPIRED';

export interface PricingSnapshot {
  readonly sourceId: string;
  /** Display-only reference rate string, e.g. "89.20". Never used for arithmetic. */
  readonly displayRate: string;
  readonly observedAt: string;
}

export interface Quote {
  readonly id: string;
  readonly status: QuoteStatus;
  readonly direction: Direction;
  /** Exact amount the customer sends. */
  readonly youSend: Money;
  /** Exact amount the customer receives. All fees already applied. */
  readonly youReceive: Money;
  readonly pricing: PricingSnapshot;
  readonly expiresAt: string;
  readonly deskId: string;
}

/* ------------------------------------------------------------------ *
 * Deal — TS-01.4 §4.1 deal machine
 * ------------------------------------------------------------------ */

export type DealState =
  | 'ESCROW_LOCKED'
  | 'FIAT_PENDING'
  | 'FIAT_CLAIMED'
  | 'PAYMENT_WINDOW_LAPSED'
  | 'FIAT_REVIEW'
  | 'DISPUTED'
  | 'OPERATOR_HOLD'
  | 'COMPLETED'
  | 'REFUNDED'
  | 'CANCELLED';

export const TERMINAL_DEAL_STATES: ReadonlySet<DealState> = new Set<DealState>([
  'COMPLETED',
  'REFUNDED',
  'CANCELLED',
]);

export function isTerminal(state: DealState): boolean {
  return TERMINAL_DEAL_STATES.has(state);
}

/** The customer-facing role in a given deal. */
export type Role = 'CRYPTO_SIDE' | 'FIAT_SIDE';

export interface Counterparty {
  readonly id: string;
  readonly displayName: string;
  readonly kind: 'DESK' | 'USER';
  /** Factual, not aspirational: count of completed deals on the platform. */
  readonly completedDeals: number;
  /** Median minutes to pay, observed. Null when there is no history yet. */
  readonly medianPayMinutes: number | null;
  readonly verified: boolean;
}

export interface BankInstruction {
  readonly accountName: string;
  readonly accountNumberMasked: string;
  readonly ifsc: string;
  readonly bankName: string;
  readonly method: 'IMPS' | 'NEFT' | 'RTGS';
}

export interface PaymentProof {
  readonly utr: string;
  readonly submittedAt: string;
  readonly note?: string;
}

export interface TimelineEntry {
  readonly id: string;
  readonly at: string;
  readonly label: string;
  readonly detail?: string;
  readonly kind: 'system' | 'actor' | 'operator';
}

export interface Deal {
  readonly id: string;
  readonly publicId: string;
  readonly state: DealState;
  readonly direction: Direction;
  readonly youSend: Money;
  readonly youReceive: Money;
  readonly pricing: PricingSnapshot;
  readonly role: Role;
  readonly counterparty: Counterparty;
  readonly createdAt: string;
  /** Deadline for the currently pending action, when one exists. */
  readonly actionDeadline: string | null;
  readonly bankInstruction: BankInstruction | null;
  readonly proof: PaymentProof | null;
  readonly timeline: readonly TimelineEntry[];
  /** Present only when state is DISPUTED / FIAT_REVIEW. */
  readonly caseRef: string | null;
}

/* ------------------------------------------------------------------ *
 * Deal Link — TS-01.4 §7.2
 * Offer Links are NON-FUNDED and reserve nothing. Funded Deal Links are
 * escrow-backed at creation. The preview must not blur these.
 * ------------------------------------------------------------------ */

export type LinkKind = 'FUNDED_DEAL_LINK' | 'OFFER_LINK';
export type LinkStatus = 'OPEN' | 'CONSUMED' | 'CLOSED' | 'EXPIRED';

export interface DealLinkPreview {
  readonly publicId: string;
  readonly kind: LinkKind;
  readonly status: LinkStatus;
  readonly direction: Direction;
  /** Fixed for a funded link; indicative for an offer link. */
  readonly youSend: Money;
  readonly youReceive: Money;
  readonly pricing: PricingSnapshot;
  readonly method: BankInstruction['method'];
  readonly expiresAt: string;
  readonly counterparty: Counterparty;
  /** True only for FUNDED_DEAL_LINK. Offer links reserve nothing. */
  readonly escrowBacked: boolean;
}

/** Outcome of attempting to join. Mirrors the deterministic loser codes of TS-01.4 §15. */
export type JoinOutcome =
  | { readonly kind: 'JOINED'; readonly dealId: string }
  | { readonly kind: 'RESERVED'; readonly dealId: string; readonly holdSeconds: number }
  | { readonly kind: 'LINK_CONSUMED' }
  | { readonly kind: 'LINK_EXPIRED' }
  | { readonly kind: 'LINK_CLOSED' }
  | { readonly kind: 'NOT_AUTHORIZED' }
  | { readonly kind: 'CAPACITY_EXHAUSTED' }
  | { readonly kind: 'MODE_NOT_ADMITTING' }
  | { readonly kind: 'REQUIRES_VERIFICATION' };

/* ------------------------------------------------------------------ *
 * Identity, notifications, operator
 * ------------------------------------------------------------------ */

export type VerificationTier = 'UNVERIFIED' | 'BASIC' | 'FULL';

export interface Session {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly tier: VerificationTier;
  readonly bankVerified: boolean;
  readonly twoFactorEnabled: boolean;
  readonly isOperator: boolean;
}

export interface Notification {
  readonly id: string;
  readonly at: string;
  readonly title: string;
  readonly body: string;
  readonly dealId: string | null;
  readonly read: boolean;
  readonly severity: 'info' | 'action' | 'warning';
}

export interface OperatorQueueItem {
  readonly dealId: string;
  readonly publicId: string;
  readonly state: DealState;
  readonly reason: string;
  readonly waitingMinutes: number;
  readonly amount: Money;
  readonly slaBreached: boolean;
}

/* ------------------------------------------------------------------ *
 * Service errors — every adapter failure the UI is allowed to render.
 * ------------------------------------------------------------------ */

export type ServiceErrorCode =
  | 'OFFLINE'
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'QUOTE_EXPIRED'
  | 'RATE_UNAVAILABLE'
  | 'CONFLICT'
  | 'UNKNOWN';

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}
