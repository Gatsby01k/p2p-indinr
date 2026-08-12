/**
 * The application-service CONTRACT.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THIS IS THE ONLY MODULE A CLIENT COMPONENT MAY IMPORT FOR TYPES.  │
 * │                                                                    │
 * │  UX-01 §9 requires the interface to sit behind a stable service    │
 * │  boundary so that swapping the sandbox for a real backend is a     │
 * │  change of adapter, not a change of every screen. TS-00 `SD-4`     │
 * │  recorded that this was not true: 66 files under `src/app` and     │
 * │  `src/components` imported `@/server/sandbox/*` directly, so the   │
 * │  "one-line swap" the document promised was a 66-site refactor.     │
 * │                                                                    │
 * │  Everything here is data and copy. Nothing decides anything:       │
 * │  authorization, state, permitted actions and every money figure    │
 * │  are computed on the server and merely NAMED here, exactly as      │
 * │  UX-01 §2.2 requires.                                              │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Deliberately free of `server-only`, `pg` and every database import, so
 * a client component can render an outcome the server decided without
 * dragging the server into the bundle.
 */

export type {
  DealEvidence,
  DealMessage,
  DealState,
  DealView,
  DisputeReason,
  DisputeView,
  FeeBearer,
  LinkPreview,
  LinkState,
  NotificationView,
  OperatorRow,
  PaymentMethodView,
  PreviewStatus,
  ReferralEntry,
  RewardEntry,
  Role,
  SandboxError,
  SandboxQuote,
  Scenario,
  SessionUser,
  Terms,
  TrustProfile,
} from '@/lib/sandboxContract';

export {
  DISPUTE_REASON_COPY,
  FAILURE_COPY,
  SandboxFailure,
  TERMINAL_STATES,
  accountHandle,
  isTerminalState,
} from '@/lib/sandboxContract';

export type { Outcome, Rejected } from '@/server/boundary/outcome';

// Imported rather than re-exported under the same name, so `ActionResult`
// below can name it without an inline `import()` annotation.
import type { SandboxError as SandboxErrorCode } from '@/lib/sandboxContract';

/**
 * What every mutation returns to the browser.
 *
 * A closed union with a named code, never a bare boolean and never a raw
 * error string: the interface has to be able to say *which* refusal
 * happened in order to show the right next step, and it must never be
 * handed an internal message to print.
 */
export interface ActionResult {
  readonly ok: boolean;
  readonly code?: SandboxErrorCode | 'UNKNOWN';
  readonly message?: string;
}

/** The result of creating a deal intent: one quote and one link, atomically. */
export interface CreateDealResult extends ActionResult {
  readonly publicId?: string;
}

export interface JoinResult extends ActionResult {
  readonly dealId?: string;
}

/** Operator ruling vocabulary. Kept here so `RulingPanel` needs no server import. */
export type Ruling = 'RELEASED' | 'REFUNDED' | 'CANCELLED';

export type DeskFilter = 'ALL' | 'DISPUTED' | 'AWAITING_PAYMENT' | 'AWAITING_CONFIRM' | 'AT_RISK';
