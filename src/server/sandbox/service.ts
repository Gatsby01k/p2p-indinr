import 'server-only';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getPool, toBigInt, withTransaction, type Tx } from '@/server/db/pool';
import { getEscrowService } from './escrow';
import {
  getValueProtectionAdapter,
  valueProtectionAvailable,
} from '@/server/adapters/valueProtection';
import { sandboxRolesForEmail, scenarioAvailable } from '@/server/adapters/policy';
import { getPricingAdapter, type RateSnapshot } from '@/server/adapters/pricing';
import {
  boundaryContextFor,
  newCommandId,
  writeAudit,
  type AuditEvent,
  type BoundaryContext,
} from '@/server/boundary/command';
import { accept, reject, type Outcome, type Rejected } from '@/server/boundary/outcome';
import { feesFor, settlementFor } from '@/lib/fees';
import {
  CONFIRM_WINDOW_MINUTES,
  PAYMENT_WINDOW_MINUTES,
  QUOTE_TTL_SECONDS,
  REFERENCE_RATE,
  linkTtlSeconds,
} from '@/lib/rate';
import { SCENARIO, creatorRoleFor, otherRole, type Scenario } from '@/lib/scenario';

/**
 * Sandbox domain service — the authoritative server side of the vertical.
 *
 * Every status, expiry evaluation and permitted action in the UI comes from
 * here. Nothing is decided client-side: a component may only render what a
 * function in this file returned.
 *
 * Time discipline: expiry is always evaluated against the DATABASE clock
 * (`now()`), read inside the same transaction and after the controlling row
 * lock is held. A client countdown is decoration; it never gates anything.
 */

/* ------------------------------------------------------------------ *
 * Result vocabulary
 * ------------------------------------------------------------------ */

export type {
  SandboxError,
  Role,
  Scenario,
  DealState,
  LinkState,
  PreviewStatus,
  Terms,
  SandboxQuote,
  LinkPreview,
  DealView,
  DealMessage,
  DealEvidence,
  DisputeView,
  DisputeReason,
  SessionUser,
} from '@/lib/sandboxContract';
export { SandboxFailure, FAILURE_COPY, isTerminalState } from '@/lib/sandboxContract';

import {
  FAILURE_COPY,
  SandboxFailure,
  isTerminalState,
  type DealEvidence,
  type DealMessage,
  type DealState,
  type DealView,
  type DisputeReason,
  type DisputeView,
  type LinkPreview,
  type PreviewStatus,
  type Role,
  type SandboxError,
  type SandboxQuote,
  type SessionUser,
  type Terms,
} from '@/lib/sandboxContract';
import type { FeeBearer } from '@/lib/fees';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const PUBLIC_ID_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'.replace(/[IO]/g, '');

/** Crockford-ish token: no I/O to avoid transcription errors. Not a secret. */
function newPublicId(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (const b of bytes) out += PUBLIC_ID_ALPHABET[b % PUBLIC_ID_ALPHABET.length];
  return `INRP-${out}`;
}

/** Three letters naming the scenario, so a code is legible out of context. */
const CODE_PREFIX: Readonly<Record<Scenario, string>> = {
  INR_TO_INR: 'INR',
  INR_TO_USDT: 'BUY',
  USDT_TO_INR: 'SEL',
};

/** The short reference a person reads aloud: `INR-8K4M`. */
function newDealCode(scenario: Scenario): string {
  const bytes = randomBytes(4);
  let body = '';
  for (const b of bytes) body += PUBLIC_ID_ALPHABET[b % PUBLIC_ID_ALPHABET.length];
  return `${CODE_PREFIX[scenario]}-${body}`;
}

/** Sandbox UTR: 12 uppercase alphanumerics, matching real UTR length. */
export const UTR_PATTERN = /^[0-9A-Z]{12}$/;

/** Protected deals start at ₹100 and are capped per deal in the sandbox. */
export const MIN_INR_MINOR = 10_000n; // ₹100.00
export const MAX_INR_MINOR = 500_000_000n; // ₹50,00,000.00

function nullableBigIntString(raw: unknown): string | null {
  return raw === null || raw === undefined ? null : toBigInt(raw).toString();
}

function rowTerms(r: Record<string, unknown>): Terms {
  return {
    direction: r.direction as Scenario,
    usdtMinor: nullableBigIntString(r.usdt_minor),
    inrMinor: toBigInt(r.inr_minor).toString(),
    rateNum: toBigInt(r.rate_num).toString(),
    rateDen: toBigInt(r.rate_den).toString(),
    pricingSource: r.pricing_source as string,
    observedAt: (r.observed_at as Date).toISOString(),
    protectionFeeMinor: toBigInt(r.protection_fee_minor ?? '0').toString(),
    networkFeeMinor: toBigInt(r.network_fee_minor ?? '0').toString(),
    feeBearer: (r.fee_bearer as FeeBearer) ?? 'PAYER',
    title: (r.title as string | null) ?? null,
  };
}

export type { AuditEvent };

/** Audit a transition, inside the transaction it describes. Commits with it. */
async function audit(tx: Tx, e: AuditEvent): Promise<void> {
  await writeAudit(tx, e);
}

/**
 * Audit an expected REJECTION — in the SAME transaction, which then commits.
 *
 * TS-00 `AUD-P1-004` recorded that this used to write on a separate pooled
 * connection inside a `catch` that only logged, so a pool exhaustion or a
 * restart silently destroyed the record of why somebody was refused.
 *
 * The reasoning behind that design was half right: a rejection that THROWS
 * does abort its transaction, and PostgreSQL then refuses every further
 * statement on the connection with 25P02. The fix is not a second
 * connection — it is not throwing. Every DEL-02 boundary now returns a
 * `Rejected` value rather than raising, so the transaction stays healthy,
 * this row is written on the same connection as the decision, and it
 * commits with it. No domain write accompanies it, because every guard
 * runs before the first mutation.
 *
 * See `src/server/boundary/outcome.ts` for the full contract.
 */
async function auditRejectionInTx(tx: Tx, e: AuditEvent): Promise<void> {
  await writeAudit(tx, e);
}

/**
 * Audit a rejection taken BEFORE a subject row is known or safe to name.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  AN EARLY REFUSAL IS STILL A REFUSAL, AND STILL NEEDS A RECORD.    │
 * │                                                                    │
 * │  Some guards fire before the boundary has a link or a deal to      │
 * │  audit against: an unverified account is turned away before the    │
 * │  link is read, and a non-participant's query returns no row at all │
 * │  because participation is a JOIN. Previously those paths returned  │
 * │  a code and wrote nothing, so the audit trail an operator reads    │
 * │  had no evidence that anyone had tried.                            │
 * │                                                                    │
 * │  The subject becomes the AUTHENTICATED ACTOR, and the resource     │
 * │  they reached for goes into structured detail. That records the    │
 * │  attempt without asserting the resource exists — and crucially     │
 * │  without changing what the CALLER is told: a non-participant       │
 * │  receives `NOT_A_PARTICIPANT` whether the deal exists or not, so   │
 * │  the audit row is visible to operators and the response remains    │
 * │  useless as an existence oracle.                                   │
 * └────────────────────────────────────────────────────────────────────┘
 */
async function auditEarlyRejection(
  tx: Tx,
  input: {
    readonly actorId: string;
    readonly action: string;
    readonly outcome: SandboxError;
    /** What the caller reached for. Recorded, never confirmed to them. */
    readonly attempted: Record<string, unknown>;
  },
): Promise<void> {
  await writeAudit(tx, {
    actorId: input.actorId,
    action: input.action,
    subjectKind: 'user',
    subjectId: input.actorId,
    outcome: input.outcome,
    detail: { attempted: input.attempted },
  });
}

/** A system line in the deal thread. Never attributable to a person. */
async function systemLine(tx: Tx, dealId: string, body: string): Promise<void> {
  await tx.query(
    `INSERT INTO sandbox.deal_message (deal_id, author_id, kind, body)
     VALUES ($1, NULL, 'SYSTEM', $2)`,
    [dealId, body],
  );
}

/** Queue a notification for one user. Never for the actor who caused it. */
async function notify(
  tx: Tx,
  userId: string,
  dealId: string | null,
  severity: 'INFO' | 'ACTION' | 'WARNING',
  title: string,
  body: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO sandbox.notification (user_id, deal_id, severity, title, body)
     VALUES ($1,$2,$3,$4,$5)`,
    [userId, dealId, severity, title, body],
  );
}

/* ------------------------------------------------------------------ *
 * Users / session
 * ------------------------------------------------------------------ */

/** A referral code that is pronounceable enough to type from a screenshot. */
function newReferralCode(seed: string): string {
  const base = seed.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'inrp2p';
  const salt = randomBytes(3).toString('hex');
  return `${base}${salt}`.slice(0, 16);
}

/** Sandbox sign-in: no password is accepted, checked or stored. */
export async function signInSandbox(email: string): Promise<SessionUser> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(normalized)) {
    throw new SandboxFailure('UNAUTHENTICATED', 'Enter a valid email address.');
  }
  /*
   * Role derivation lives behind the deployment policy, not inline here.
   *
   * TS-00 recorded two P0s against this path: `ops@` granting operator
   * (AUD-P0-001) and the whole path verifying no credential at all
   * (AUD-P0-002). Replacing it is DEL-03's work and is deliberately not
   * attempted here. What DEL-02 owes is that flipping a deployment to
   * production cannot make it reachable — `sandboxRolesForEmail` throws
   * `AdapterUnavailableError` before the first database write.
   */
  const { isOperator, isVerified } = sandboxRolesForEmail(normalized);
  const local = normalized.split('@')[0]!;
  /*
   * Title-cased at the source, not with a `capitalize` class at each of the
   * thirty places a name appears. CSS capitalisation cannot be used inside a
   * sentence — "Send the rupees to ananya sharma" needs the name capitalised
   * and the rest of the sentence left alone — so the stored value has to be
   * right. Storing it right also means a screen reader reads a name as a
   * name, and a copied string looks like one.
   */
  const displayName = local
    .replace(/[._-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

  const { rows } = await getPool().query(
    `INSERT INTO sandbox.app_user (email, display_name, is_operator, is_verified)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING user_id, email, display_name, is_operator, is_verified`,
    [normalized, displayName, isOperator, isVerified],
  );
  const r = rows[0]!;

  // A profile and one addressable payment handle, so the product is usable
  // from the first screen rather than demanding setup before anything works.
  // Neither carries a credential: see the schema comment on payment_method.
  await getPool().query(
    `INSERT INTO sandbox.user_profile (user_id, referral_code, upi_verified, identity_verified)
     VALUES ($1,$2,$3,$3)
     ON CONFLICT (user_id) DO NOTHING`,
    [r.user_id, newReferralCode(local), isVerified],
  );
  await getPool().query(
    `INSERT INTO sandbox.payment_method (user_id, kind, label, handle, is_default, verified)
     SELECT $1, 'UPI', 'Primary UPI', $2, TRUE, $3
      WHERE NOT EXISTS (SELECT 1 FROM sandbox.payment_method WHERE user_id = $1)`,
    [r.user_id, `${local.replace(/[^a-z0-9.]/g, '')}@sandboxupi`, isVerified],
  );

  return {
    userId: r.user_id,
    email: r.email ?? null,
    displayName: r.display_name,
    isOperator: r.is_operator,
    isVerified: r.is_verified,
  };
}

export async function getUser(userId: string): Promise<SessionUser | null> {
  const { rows } = await getPool().query(
    `SELECT user_id, email, display_name, is_operator, is_verified
       FROM sandbox.app_user WHERE user_id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    userId: r.user_id,
    email: r.email ?? null,
    displayName: r.display_name,
    isOperator: r.is_operator,
    isVerified: r.is_verified,
  };
}

/* ------------------------------------------------------------------ *
 * 1. Server-issued firm quote
 * ------------------------------------------------------------------ */

/**
 * Sandbox reference price and the two server-controlled windows.
 *
 * Imported from `@/lib/rate` rather than restated here, so the figure the
 * client previews and the figure the server prices come from one constant.
 * The client's preview is still only indicative: an expiry can only be
 * attached — and honoured — server-side.
 */
const SANDBOX_RATE_NUM = REFERENCE_RATE.num;
const SANDBOX_RATE_DEN = REFERENCE_RATE.den;

export const SANDBOX_RATE = { num: SANDBOX_RATE_NUM, den: SANDBOX_RATE_DEN } as const;

export interface QuoteOptions {
  /** Who absorbs the protection fee. Defaults to the payer. */
  readonly feeBearer?: FeeBearer;
  /** What the deal is for. Shown to both sides; never in a public unfurl. */
  readonly title?: string | null;
}

interface QuoteInsert {
  readonly direction: Scenario;
  readonly usdtMinor: bigint | null;
  readonly inrMinor: bigint;
}

/**
 * Write one quote row inside a caller-supplied transaction.
 *
 * The `tx` parameter is what makes DEL-02 requirement 3 possible: quote
 * issuance and link creation are two writes that must land together, so
 * neither may own its transaction. `insertQuote` therefore never opens
 * one — `createDealIntent` does, once, around both.
 */
async function insertQuoteIn(
  tx: Tx,
  user: SessionUser,
  q: QuoteInsert,
  options: QuoteOptions,
  rate: RateSnapshot,
): Promise<SandboxQuote> {
  const fees = feesFor(q.direction, q.inrMinor);
  const bearer: FeeBearer = options.feeBearer ?? 'PAYER';
  const title = options.title?.trim() ? options.title.trim().slice(0, 120) : null;

  {
    const { rows } = await tx.query(
      `INSERT INTO sandbox.quote
         (issued_to, direction, usdt_minor, inr_minor, rate_num, rate_den,
          pricing_source, observed_at, expires_at,
          protection_fee_minor, network_fee_minor, fee_bearer, title)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now() + ($8 || ' seconds')::interval,
               $9,$10,$11,$12)
       RETURNING *`,
      [
        user.userId,
        q.direction,
        q.usdtMinor === null ? null : q.usdtMinor.toString(),
        q.inrMinor.toString(),
        rate.num.toString(),
        rate.den.toString(),
        // Provenance comes from the adapter, never from a literal here.
        rate.source,
        String(QUOTE_TTL_SECONDS),
        fees.protectionMinor.toString(),
        fees.networkMinor.toString(),
        bearer,
        title,
      ],
    );
    const r = rows[0]!;
    await audit(tx, {
      actorId: user.userId,
      action: 'QUOTE_ISSUE',
      subjectKind: 'quote',
      subjectId: r.quote_id,
      toState: 'ISSUED',
      outcome: 'OK',
      detail: {
        direction: q.direction,
        usdtMinor: q.usdtMinor?.toString() ?? null,
        inrMinor: q.inrMinor.toString(),
      },
    });
    return {
      quoteId: r.quote_id,
      ...rowTerms(r),
      expiresAt: (r.expires_at as Date).toISOString(),
      expired: false,
    };
  }
}

/**
 * Price a quote request, or say exactly why it cannot be priced.
 *
 * Pure and transaction-free, so every guard — scenario availability,
 * amount range, and the net-receipt floor — is decided before a single
 * row is written. That ordering is what lets the boundary commit a
 * rejection audit with no domain write beside it.
 */
function priceQuote(
  scenario: Scenario,
  input: { readonly inrMinor?: bigint; readonly usdtMinor?: bigint },
  bearer: FeeBearer,
  rate: RateSnapshot,
): Outcome<QuoteInsert> {
  if (!scenarioAvailable(scenario)) {
    return reject('SCENARIO_UNAVAILABLE', FAILURE_COPY.SCENARIO_UNAVAILABLE.reason);
  }

  let inrMinor: bigint;
  let usdtMinor: bigint | null;

  if (scenario === 'INR_TO_INR') {
    inrMinor = input.inrMinor ?? 0n;
    usdtMinor = null;
  } else if (input.usdtMinor !== undefined) {
    if (input.usdtMinor <= 0n) {
      return reject('AMOUNT_INVALID', FAILURE_COPY.AMOUNT_INVALID.reason);
    }
    usdtMinor = input.usdtMinor;
    inrMinor = (input.usdtMinor * rate.num) / (rate.den * 10_000n);
  } else {
    inrMinor = input.inrMinor ?? 0n;
    usdtMinor = (inrMinor * rate.den * 10_000n) / rate.num;
  }

  const range = checkInrRange(inrMinor);
  if (range) return range;
  if (usdtMinor !== null && usdtMinor <= 0n) {
    return reject('AMOUNT_TOO_SMALL', FAILURE_COPY.AMOUNT_TOO_SMALL.reason);
  }

  /*
   * THE NET-RECEIPT FLOOR — TS-00 `AUD-P1-005`.
   *
   * `settlementFor` floors a negative receipt at zero so no screen ever
   * renders a negative figure. That is right for presentation and wrong
   * as an acceptance rule: it let a ₹100 exchange with the payee bearing
   * a ₹205 fee be quoted, priced and shared as a link on which the
   * receiving side was guaranteed nothing while the payer was asked for
   * the full amount.
   *
   * The floor stays. The quote is refused.
   */
  const settlement = settlementFor(scenario, inrMinor, bearer);
  if (settlement.payeeReceivesMinor <= 0n) {
    return reject('FEE_EXCEEDS_AMOUNT', FAILURE_COPY.FEE_EXCEEDS_AMOUNT.reason);
  }

  return accept({ direction: scenario, usdtMinor, inrMinor });
}

/** The amount range, as a rejection rather than a throw. */
function checkInrRange(inrMinor: bigint): Rejected | null {
  if (inrMinor <= 0n) return reject('AMOUNT_INVALID', FAILURE_COPY.AMOUNT_INVALID.reason);
  if (inrMinor < MIN_INR_MINOR) {
    return reject('AMOUNT_TOO_SMALL', FAILURE_COPY.AMOUNT_TOO_SMALL.reason);
  }
  if (inrMinor > MAX_INR_MINOR) {
    return reject('AMOUNT_TOO_LARGE', FAILURE_COPY.AMOUNT_TOO_LARGE.reason);
  }
  return null;
}

/**
 * A firm quote for an exchange, priced from the USDT leg.
 *
 * Rounding happens exactly once, here, at issuance; no later step re-derives
 * an amount from the rate.
 *
 * Retained as a primitive for tests and for the quote-expiry paths that
 * need a quote without a link. The application boundary uses
 * `createDealIntent`, which is atomic across both writes.
 */
export async function issueFirmQuote(
  user: SessionUser,
  direction: 'USDT_TO_INR' | 'INR_TO_USDT',
  usdtMinor: bigint,
  options: QuoteOptions = {},
): Promise<SandboxQuote> {
  const rate = getPricingAdapter().rateFor(direction);
  const priced = priceQuote(direction, { usdtMinor }, options.feeBearer ?? 'PAYER', rate);
  if (!priced.ok) throw new SandboxFailure(priced.code, priced.message);
  return withTransaction((tx) => insertQuoteIn(tx, user, priced.value, options, rate));
}

/**
 * A firm quote for an exchange, priced from the INR leg.
 *
 * The same rate, applied the other way. The USDT figure is truncated, so a
 * customer is never credited with micro-USDT that was not paid for.
 */
export async function issueExchangeQuoteFromInr(
  user: SessionUser,
  direction: 'USDT_TO_INR' | 'INR_TO_USDT',
  inrMinor: bigint,
  options: QuoteOptions = {},
): Promise<SandboxQuote> {
  const rate = getPricingAdapter().rateFor(direction);
  const priced = priceQuote(direction, { inrMinor }, options.feeBearer ?? 'PAYER', rate);
  if (!priced.ok) throw new SandboxFailure(priced.code, priced.message);
  return withTransaction((tx) => insertQuoteIn(tx, user, priced.value, options, rate));
}

/** A firm quote for a protected INR → INR payment. No USDT leg exists. */
export async function issueProtectedQuote(
  user: SessionUser,
  inrMinor: bigint,
  options: QuoteOptions = {},
): Promise<SandboxQuote> {
  const rate = getPricingAdapter().rateFor('INR_TO_INR');
  const priced = priceQuote('INR_TO_INR', { inrMinor }, options.feeBearer ?? 'PAYER', rate);
  if (!priced.ok) throw new SandboxFailure(priced.code, priced.message);
  return withTransaction((tx) => insertQuoteIn(tx, user, priced.value, options, rate));
}

/* ------------------------------------------------------------------ *
 * 1b. Authoritative expiry transitions
 *
 * TS-00 `AUD-P1-003` recorded three defects in one function: the payment
 * window lapsed at roughly four hours rather than the two the UI showed,
 * the transition committed with no audit row at all, and it only ever ran
 * because somebody happened to load a page.
 *
 * All three are corrected here. Expiry is an explicit transition, taken
 * under the controlling row lock, compared against the DATABASE clock with
 * no arithmetic beyond the stored deadline, audited in the same
 * transaction, and reachable only from a boundary or the explicit sweep —
 * never from rendering a page.
 * ------------------------------------------------------------------ */

/**
 * Expire one quote if its moment has passed. Caller must already hold the
 * row lock; the row is re-read from the lock, not from a stale snapshot.
 *
 * Returns true when it transitioned, so the caller can distinguish "was
 * already expired" from "expired just now" for its own audit detail.
 */
async function expireQuoteIfLapsed(
  tx: Tx,
  quote: { quote_id: string; state: string; is_expired: boolean },
  actorId: string | null,
  emit?: BoundaryContext['emit'],
): Promise<boolean> {
  if (quote.state !== 'ISSUED' || !quote.is_expired) return false;

  const cas = await tx.query(
    `UPDATE sandbox.quote SET state='EXPIRED' WHERE quote_id=$1 AND state='ISSUED'`,
    [quote.quote_id],
  );
  if (cas.rowCount !== 1) return false;

  await audit(tx, {
    actorId,
    action: 'QUOTE_EXPIRE',
    subjectKind: 'quote',
    subjectId: quote.quote_id,
    fromState: 'ISSUED',
    toState: 'EXPIRED',
    outcome: 'OK',
  });
  if (emit) {
    await emit({ type: 'quote.expired', subjectKind: 'quote', subjectId: quote.quote_id });
  }
  return true;
}

/**
 * Expire one deal whose payment window has passed.
 *
 * The comparison is `action_deadline <= now()` — exactly the deadline the
 * deal carries and exactly the one the interface displays. The previous
 * `now() - interval '2 hours'` silently doubled a two-hour window into
 * four, so the server enforced a deadline nobody had been shown.
 *
 * A claimed deal never expires. Once money is asserted to have moved, the
 * remedy is a dispute, not a timer, and the state machine says so.
 */
async function expireDealIfLapsed(
  tx: Tx,
  deal: { deal_id: string; state: string; deal_code?: string | null },
  actorId: string | null,
  emit?: BoundaryContext['emit'],
): Promise<boolean> {
  if (deal.state !== 'FIAT_PENDING') return false;

  const cas = await tx.query(
    `UPDATE sandbox.deal
        SET state='EXPIRED', closed_at=now(), action_deadline=NULL, version=version+1
      WHERE deal_id=$1
        AND state='FIAT_PENDING'
        AND action_deadline IS NOT NULL
        AND action_deadline <= now()`,
    [deal.deal_id],
  );
  if (cas.rowCount !== 1) return false;

  await systemLine(tx, deal.deal_id, 'The payment window closed. Nothing was transferred.');
  await audit(tx, {
    actorId,
    action: 'DEAL_EXPIRE',
    subjectKind: 'deal',
    subjectId: deal.deal_id,
    fromState: 'FIAT_PENDING',
    toState: 'EXPIRED',
    outcome: 'OK',
  });
  if (emit) {
    await emit({ type: 'deal.expired', subjectKind: 'deal', subjectId: deal.deal_id });
  }

  const { rows: seats } = await tx.query(
    `SELECT user_id FROM sandbox.participant WHERE deal_id = $1`,
    [deal.deal_id],
  );
  for (const seat of seats) {
    await notify(
      tx,
      seat.user_id,
      deal.deal_id,
      'WARNING',
      'Payment window closed',
      'Nobody marked a payment in time. Nothing was transferred or released.',
    );
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 2. Create a deal link from a valid quote
 * ------------------------------------------------------------------ */

export interface DealIntent {
  readonly publicId: string;
  readonly quoteId: string;
}

/**
 * Issue a quote and mint its link — as ONE transaction.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHY THIS FUNCTION EXISTS.                                         │
 * │                                                                    │
 * │  The create-deal action used to call `issueQuote(...)` and then    │
 * │  `createDealLink(...)`, each opening its own transaction. A crash, │
 * │  a timeout or a lost connection between the two committed the      │
 * │  quote and never minted the link, leaving an orphan row that no    │
 * │  screen could reach and no user could act on (TS-00 AUD-P0-004).   │
 * │                                                                    │
 * │  Here both writes share one transaction and one command record.    │
 * │  A failure at any point rolls back everything: no quote, no link,  │
 * │  no audit row, no outbox event, no command record. The caller      │
 * │  retries with the SAME command id and gets exactly one deal        │
 * │  intent, not two.                                                  │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function createDealIntentIn(
  ctx: BoundaryContext,
  user: SessionUser,
  request: {
    readonly scenario: Scenario;
    readonly inrMinor?: bigint;
    readonly usdtMinor?: bigint;
    readonly intent: 'PAY' | 'RECEIVE';
    readonly feeBearer: FeeBearer;
    readonly title?: string | null;
  },
): Promise<Outcome<DealIntent>> {
  /*
   * CAPABILITY FIRST, BEFORE ANY WRITE OR ANY REJECTION.
   *
   * `getPricingAdapter()` throws in production, and it is called here —
   * ahead of the command's first statement — so the whole transaction
   * rolls back and the deployment produces no command row, no quote, no
   * link, no audit row and no outbox event. A rejection *code* would be
   * the wrong shape: it would commit a REJECTED command recording that
   * somebody asked, which is a decision about the caller. This is not
   * about the caller. The deployment cannot price anything.
   */
  const rate = getPricingAdapter().rateFor(request.scenario);

  const priced = priceQuote(
    request.scenario,
    { inrMinor: request.inrMinor, usdtMinor: request.usdtMinor },
    request.feeBearer,
    rate,
  );
  if (!priced.ok) {
    await auditRejectionInTx(ctx.tx, {
      actorId: user.userId,
      action: 'DEAL_INTENT_CREATE',
      subjectKind: 'user',
      subjectId: user.userId,
      outcome: priced.code,
      detail: { scenario: request.scenario },
    });
    return priced;
  }

  const quote = await insertQuoteIn(
    ctx.tx,
    user,
    priced.value,
    { feeBearer: request.feeBearer, title: request.title ?? null },
    rate,
  );
  await ctx.emit({
    type: 'quote.issued',
    subjectKind: 'quote',
    subjectId: quote.quoteId,
    payload: { direction: quote.direction, inrMinor: quote.inrMinor },
  });

  const creatorRole: Role = creatorRoleFor(request.scenario, request.intent);
  await ctx.tx.query(`UPDATE sandbox.quote SET state='CONSUMED' WHERE quote_id=$1`, [
    quote.quoteId,
  ]);

  const publicId = newPublicId();
  const { rows: linkRows } = await ctx.tx.query(
    `INSERT INTO sandbox.deal_link
       (public_id, quote_id, created_by, creator_role, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval)
     RETURNING link_id`,
    [publicId, quote.quoteId, user.userId, creatorRole, String(linkTtlSeconds(request.scenario))],
  );
  const linkId = linkRows[0]!.link_id as string;

  await ctx.audit({
    actorId: user.userId,
    action: 'LINK_CREATE',
    subjectKind: 'link',
    subjectId: linkId,
    toState: 'OPEN',
    outcome: 'OK',
    detail: { publicId, creatorRole, direction: request.scenario, quoteId: quote.quoteId },
  });
  await ctx.emit({
    type: 'link.created',
    subjectKind: 'link',
    subjectId: linkId,
    payload: { publicId, creatorRole, direction: request.scenario },
  });

  return accept({ publicId, quoteId: quote.quoteId });
}

/**
 * Turn a live quote into a shareable link.
 *
 * `intent` only matters for INR → INR, where the creator may be either the
 * payer or the payee. In an exchange the scenario already fixes the seat, so
 * the argument is ignored rather than allowed to contradict it.
 */
export async function createDealLink(
  user: SessionUser,
  quoteId: string,
  intent: 'PAY' | 'RECEIVE' = 'PAY',
): Promise<LinkPreview> {
  const outcome = await withTransaction(async (tx): Promise<Outcome<LinkPreview>> => {
    // Lock the quote, then read the server clock. Expiry is evaluated after
    // the lock is held, so a quote cannot expire between check and use.
    const { rows } = await tx.query(
      `SELECT *, (expires_at <= now()) AS is_expired
         FROM sandbox.quote WHERE quote_id = $1 FOR UPDATE`,
      [quoteId],
    );
    const q = rows[0];
    if (!q) return reject('NOT_FOUND', 'That quote does not exist.');
    if (q.issued_to !== user.userId) {
      return reject('NOT_A_PARTICIPANT', 'That quote was issued to someone else.');
    }
    if (q.state === 'CONSUMED') return reject('QUOTE_CONSUMED', 'Quote already used.');
    if (q.is_expired || q.state === 'EXPIRED') {
      /*
       * The transition and its refusal now commit TOGETHER.
       *
       * Nothing raises, so the transaction stays healthy: the quote is
       * moved `ISSUED → EXPIRED` authoritatively (rather than being left
       * to be re-derived from `expires_at` on every future read), the
       * expiry is audited, the refusal is audited, and all three commit.
       * No link is created, because the guard ran first.
       */
      await expireQuoteIfLapsed(tx, { ...q, is_expired: true }, user.userId);
      await auditRejectionInTx(tx, {
        actorId: user.userId,
        action: 'LINK_CREATE',
        subjectKind: 'quote',
        subjectId: quoteId,
        fromState: q.state,
        outcome: 'QUOTE_EXPIRED',
      });
      return reject('QUOTE_EXPIRED', FAILURE_COPY.QUOTE_EXPIRED.reason);
    }

    const creatorRole: Role = creatorRoleFor(q.direction as Scenario, intent);

    await tx.query(`UPDATE sandbox.quote SET state='CONSUMED' WHERE quote_id=$1`, [quoteId]);

    const publicId = newPublicId();
    const { rows: linkRows } = await tx.query(
      `INSERT INTO sandbox.deal_link
         (public_id, quote_id, created_by, creator_role, expires_at)
       VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval)
       RETURNING *`,
      // A protected payment has no rate to decay, so its link outlives a
      // message sitting unread; an exchange holds a frozen rate and cannot.
      [publicId, quoteId, user.userId, creatorRole, String(linkTtlSeconds(q.direction))],
    );
    const l = linkRows[0]!;

    await audit(tx, {
      actorId: user.userId,
      action: 'LINK_CREATE',
      subjectKind: 'link',
      subjectId: l.link_id,
      toState: 'OPEN',
      outcome: 'OK',
      detail: { publicId, creatorRole, direction: q.direction },
    });

    return accept({
      publicId,
      ...rowTerms(q),
      displayStatus: 'OPEN' as const,
      joinable: true,
      expiresAt: (l.expires_at as Date).toISOString(),
      viewerWouldBe: otherRole(creatorRole),
      viewerIsCreator: true,
      createdAtIso: (l.created_at as Date).toISOString(),
      // The caller here IS the creator, so this discloses nothing new.
      creatorName: user.displayName,
      creatorVerified: user.isVerified,
    });
  });

  // Raised OUTSIDE the transaction, which has already committed the
  // rejection evidence. The caller still sees an exception; the record of
  // why survives regardless of what the caller does with it.
  if (!outcome.ok) throw new SandboxFailure(outcome.code, outcome.message);
  return outcome.value;
}

export interface LinkClosure {
  readonly publicId: string;
  /** True when the link was already withdrawn before this command ran. */
  readonly alreadyClosed: boolean;
}

/**
 * Withdraw a link that nobody has taken yet. Only its creator may.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHY THIS IS A COMMAND AND NOT A BARE MUTATION.                    │
 * │                                                                    │
 * │  Withdrawing a link is a state transition on an object a           │
 * │  counterparty may be looking at RIGHT NOW, and the interesting     │
 * │  case is the race: someone joins while the creator withdraws.      │
 * │  Exactly one of those may win, the loser must be told which, and   │
 * │  both outcomes must leave a record.                                │
 * │                                                                    │
 * │  `FOR UPDATE` serialises the two, the conditional CAS decides the  │
 * │  winner, and the surrounding command makes the answer replayable   │
 * │  so a retry after a dropped connection cannot report the opposite  │
 * │  outcome to the one that actually happened.                        │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function closeDealLinkIn(
  ctx: BoundaryContext,
  user: SessionUser,
  publicId: string,
): Promise<Outcome<LinkClosure>> {
  const tx = ctx.tx;

  const { rows } = await tx.query(
    `SELECT * FROM sandbox.deal_link WHERE public_id = $1 FOR UPDATE`,
    [publicId],
  );
  const link = rows[0];
  if (!link) {
    await auditEarlyRejection(tx, {
      actorId: user.userId,
      action: 'LINK_CLOSE',
      outcome: 'NOT_FOUND',
      attempted: { publicId },
    });
    return reject('NOT_FOUND', 'That deal link does not exist.');
  }

  const refuse = async (code: SandboxError, message: string): Promise<Rejected> => {
    await auditRejectionInTx(tx, {
      actorId: user.userId,
      action: 'LINK_CLOSE',
      subjectKind: 'link',
      subjectId: link.link_id,
      fromState: link.state,
      outcome: code,
    });
    return reject(code, message);
  };

  // Ownership is re-derived here, in the service, from the session-derived
  // caller — never from anything the request carried.
  if (link.created_by !== user.userId) {
    return refuse('NOT_A_PARTICIPANT', 'Only the creator can withdraw a link.');
  }
  if (link.state === 'CONSUMED') {
    return refuse('LINK_CONSUMED', FAILURE_COPY.LINK_CONSUMED.reason);
  }
  // Already withdrawn: an idempotent success, not an error. No second
  // audit row and no second event — it already happened once.
  if (link.state === 'CLOSED') return accept({ publicId, alreadyClosed: true });

  const cas = await tx.query(
    `UPDATE sandbox.deal_link
        SET state='CLOSED', closed_at=now(), version=version+1
      WHERE link_id=$1 AND state='OPEN'`,
    [link.link_id],
  );
  // The lock above makes this unreachable in practice; it is the same
  // belt-and-braces the Join boundary carries, for the same reason.
  if (cas.rowCount !== 1) return refuse('LINK_CONSUMED', FAILURE_COPY.LINK_CONSUMED.reason);

  await ctx.audit({
    actorId: user.userId,
    action: 'LINK_CLOSE',
    subjectKind: 'link',
    subjectId: link.link_id,
    fromState: 'OPEN',
    toState: 'CLOSED',
    outcome: 'OK',
  });
  await ctx.emit({
    type: 'link.closed',
    subjectKind: 'link',
    subjectId: link.link_id,
    payload: { publicId },
  });

  return accept({ publicId, alreadyClosed: false });
}

/** Throwing wrapper, for the integration suite and legacy callers. */
export async function closeDealLink(user: SessionUser, publicId: string): Promise<void> {
  const outcome = await withTransaction((tx) =>
    closeDealLinkIn(boundaryContextFor(tx, newCommandId()), user, publicId),
  );
  if (!outcome.ok) throw new SandboxFailure(outcome.code, outcome.message);
}

/* ------------------------------------------------------------------ *
 * 3. Public preview — safe metadata only
 * ------------------------------------------------------------------ */

/**
 * Resolves the link's status from the database and the database clock.
 *
 * `displayStatus` is one value. `CONSUMED` and `CLOSED` outrank expiry,
 * because a link that was taken is taken regardless of the clock — that is
 * what stops the "consumed link shown as Open" contradiction.
 *
 * Deliberately returns NO identity: no creator name, no counterparty name,
 * no user id, no bank detail, no wallet, no UTR.
 */
export async function getLinkPreview(
  publicId: string,
  viewer?: SessionUser | null,
): Promise<LinkPreview | null> {
  const { rows } = await getPool().query(
    `SELECT l.*, q.direction, q.usdt_minor, q.inr_minor, q.rate_num, q.rate_den,
            q.pricing_source, q.observed_at, q.protection_fee_minor,
            q.network_fee_minor, q.fee_bearer, q.title,
            creator.display_name AS creator_name,
            creator.is_verified  AS creator_verified,
            (l.expires_at <= now()) AS is_expired
       FROM sandbox.deal_link l
       JOIN sandbox.quote q ON q.quote_id = l.quote_id
       JOIN sandbox.app_user creator ON creator.user_id = l.created_by
      WHERE l.public_id = $1`,
    [publicId],
  );
  const r = rows[0];
  if (!r) return null;

  // Identity is disclosed to a SIGNED-IN reader only. An anonymous fetch is
  // also how the unfurl is built, and an unfurl is public and cached by
  // intermediaries the sender does not control.
  const signedIn = Boolean(viewer);

  const displayStatus: PreviewStatus =
    r.state === 'CONSUMED'
      ? 'CONSUMED'
      : r.state === 'CLOSED'
        ? 'CLOSED'
        : r.is_expired
          ? 'EXPIRED'
          : 'OPEN';

  return {
    publicId: r.public_id,
    ...rowTerms(r),
    displayStatus,
    joinable: displayStatus === 'OPEN',
    expiresAt: (r.expires_at as Date).toISOString(),
    viewerWouldBe: otherRole(r.creator_role as Role),
    // Identity-derived, so it is false for every anonymous reader.
    viewerIsCreator: viewer ? r.created_by === viewer.userId : false,
    createdAtIso: (r.created_at as Date).toISOString(),
    creatorName: signedIn ? r.creator_name : null,
    creatorVerified: signedIn ? r.creator_verified : false,
  };
}

/** The deal a consumed link became — but only for one of its two seats. */
export async function dealIdForLink(user: SessionUser, publicId: string): Promise<string | null> {
  const { rows } = await getPool().query(
    `SELECT d.deal_id
       FROM sandbox.deal d
       JOIN sandbox.deal_link l ON l.link_id = d.link_id
       JOIN sandbox.participant p ON p.deal_id = d.deal_id AND p.user_id = $2
      WHERE l.public_id = $1`,
    [publicId, user.userId],
  );
  return rows[0]?.deal_id ?? null;
}

/* ------------------------------------------------------------------ *
 * 5. ATOMIC SINGLE-WINNER JOIN
 * ------------------------------------------------------------------ */

export interface JoinSuccess {
  readonly kind: 'JOINED';
  readonly dealId: string;
  readonly publicId: string;
  readonly dealCode: string;
  readonly role: Role;
}

/**
 * Join a deal link. Exactly one concurrent caller can succeed.
 *
 * The guarantee rests on three independent database facts, not on any UI
 * state and not on application-level checking:
 *
 *   1. `SELECT ... FOR UPDATE` serialises all concurrent joiners on the link
 *      row. The second transaction blocks until the first commits, and then
 *      re-reads the *committed* state — not a stale snapshot.
 *   2. The conditional CAS
 *        `UPDATE ... SET state='CONSUMED' WHERE link_id=$1 AND state='OPEN'`
 *      affects exactly one row for the winner and zero for everyone else.
 *      Zero affected rows is the loser signal; it is checked, not assumed.
 *   3. `UNIQUE(sandbox.deal.link_id)` is the backstop. Even if 1 and 2 were
 *      circumvented, the database itself refuses a second deal for the link.
 *
 * All of it commits as one transaction, so a loser leaves no partial record:
 * no orphan deal, no orphan participant, no half-consumed link.
 */
export async function joinDealLinkIn(
  ctx: BoundaryContext,
  user: SessionUser,
  publicId: string,
): Promise<Outcome<JoinSuccess>> {
  const tx = ctx.tx;

  if (!user.isVerified) {
    await auditEarlyRejection(tx, {
      actorId: user.userId,
      action: 'LINK_JOIN',
      outcome: 'REQUIRES_VERIFICATION',
      attempted: { publicId },
    });
    return reject('REQUIRES_VERIFICATION', FAILURE_COPY.REQUIRES_VERIFICATION.reason);
  }

  // (1) Serialise every concurrent joiner on this exact row.
  const { rows } = await tx.query(
    `SELECT l.*, (l.expires_at <= now()) AS is_expired
       FROM sandbox.deal_link l
      WHERE l.public_id = $1
      FOR UPDATE`,
    [publicId],
  );
  const link = rows[0];
  if (!link) {
    await auditEarlyRejection(tx, {
      actorId: user.userId,
      action: 'LINK_JOIN',
      outcome: 'NOT_FOUND',
      attempted: { publicId },
    });
    return reject('NOT_FOUND', 'That deal link does not exist.');
  }

  /*
   * A refusal is now a VALUE, so the audit row beside it commits.
   *
   * This is the whole of TS-02 §10 in three lines: record why, return the
   * reason, do not raise. The losing side of a race takes exactly this
   * path, which is why "losing is a designed outcome, not an exception"
   * (UX-01 §2.2) is now true at the database level too — the loser leaves
   * a durable record of having lost.
   */
  const refuse = async (code: SandboxError): Promise<Rejected> => {
    await auditRejectionInTx(tx, {
      actorId: user.userId,
      action: 'LINK_JOIN',
      subjectKind: 'link',
      subjectId: link.link_id,
      fromState: link.state,
      outcome: code,
    });
    return reject(code, FAILURE_COPY[code].reason);
  };

  if (link.created_by === user.userId) return refuse('CANNOT_JOIN_OWN_LINK');
  if (link.state === 'CONSUMED') return refuse('LINK_CONSUMED');
  if (link.state === 'CLOSED') return refuse('LINK_CLOSED');
  if (link.is_expired) return refuse('LINK_EXPIRED');

  /*
   * ────────────────────────────────────────────────────────────────────
   * EVERY GUARD RUNS BEFORE THE FIRST DOMAIN WRITE.
   *
   * This ordering was wrong and the bug it caused is worth naming. The
   * CAS below used to run FIRST, and the scenario check afterwards — so
   * a Join of a production-disabled scenario returned
   * `SCENARIO_UNAVAILABLE` as a non-raising rejection, and because a
   * rejection COMMITS, the link committed as `CONSUMED` with no deal
   * behind it. The link was destroyed by the very refusal that was
   * supposed to protect it, and no counterparty could ever join it again.
   *
   * That is the precise hazard of the non-raising pattern: a returned
   * rejection keeps the transaction alive, so anything written before it
   * survives. The pattern is only safe while every guard precedes every
   * write, which is now true here and asserted by test.
   * ────────────────────────────────────────────────────────────────────
   */
  const { rows: qRows } = await tx.query(
    `SELECT *, (expires_at <= now()) AS is_expired FROM sandbox.quote WHERE quote_id=$1`,
    [link.quote_id],
  );
  const q = qRows[0]!;
  const scenario = q.direction as Scenario;

  // A scenario withdrawn from this deployment cannot be joined into a
  // live deal, even through a link minted while it was available.
  if (!scenarioAvailable(scenario)) return refuse('SCENARIO_UNAVAILABLE');

  /*
   * THE LOCKED-VALUE FACT — UX-01 §3 / I7, roadmap B5.
   *
   * `lock()` is the only thing permitted to assert that value is held, and
   * `value_locked_at` is the only thing the pay screen consults. In the
   * sandbox this records a simulated `SBX-` hold that moves nothing. In
   * production `getValueProtectionAdapter()` throws — and it is resolved
   * HERE, before the CAS, so the throw cannot leave a consumed link
   * behind it. A throw would roll back regardless; ordering it first
   * means the link is never even touched.
   */
  const joinerRole: Role = otherRole(link.creator_role as Role);
  const dealPublicId = newPublicId();
  const lock = await getValueProtectionAdapter().lock({
    dealId: dealPublicId,
    scenario,
    usdtMinor: q.usdt_minor === null ? null : toBigInt(q.usdt_minor),
    inrMinor: toBigInt(q.inr_minor),
  });

  // (2) Conditional state change — the FIRST write in this boundary.
  //     Zero affected rows means we lost the race.
  const cas = await tx.query(
    `UPDATE sandbox.deal_link
        SET state='CONSUMED', consumed_at=now(), version=version+1
      WHERE link_id=$1 AND state='OPEN'`,
    [link.link_id],
  );
  if (cas.rowCount !== 1) return refuse('LINK_CONSUMED');

  // (3) UNIQUE(link_id) is the database's own backstop.
  const { rows: dRows } = await tx.query(
    `INSERT INTO sandbox.deal
       (public_id, deal_code, link_id, quote_id, direction, usdt_minor, inr_minor,
        rate_num, rate_den, pricing_source, observed_at,
        protection_fee_minor, network_fee_minor, fee_bearer, title,
        action_deadline, value_locked_at, value_lock_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
             now() + ($16 || ' minutes')::interval, now(), $17)
     RETURNING deal_id, public_id, deal_code`,
    [
      dealPublicId,
      newDealCode(scenario),
      link.link_id,
      link.quote_id,
      q.direction,
      q.usdt_minor,
      q.inr_minor,
      q.rate_num,
      q.rate_den,
      q.pricing_source,
      q.observed_at,
      q.protection_fee_minor,
      q.network_fee_minor,
      q.fee_bearer,
      q.title,
      String(PAYMENT_WINDOW_MINUTES),
      lock.reference,
    ],
  );
  const deal = dRows[0]!;

  // Both seats are assigned in the same transaction as the deal.
  await tx.query(
    `INSERT INTO sandbox.participant (deal_id, user_id, role)
     VALUES ($1,$2,$3), ($1,$4,$5)`,
    [deal.deal_id, user.userId, joinerRole, link.created_by, link.creator_role],
  );

  // Simulated, non-custodial. Records an assertion; holds nothing.
  if (q.usdt_minor !== null) {
    await getEscrowService().hold(deal.deal_id, toBigInt(q.usdt_minor));
  }

  await systemLine(tx, deal.deal_id, 'Deal joined. Both sides are now in the room.');
  await notify(
    tx,
    link.created_by,
    deal.deal_id,
    'ACTION',
    'Someone joined your deal',
    `${user.displayName} took the other side of ${deal.deal_code}.`,
  );

  await ctx.audit({
    actorId: user.userId,
    action: 'LINK_JOIN',
    subjectKind: 'deal',
    subjectId: deal.deal_id,
    toState: 'FIAT_PENDING',
    outcome: 'OK',
    detail: { linkId: link.link_id, joinerRole, publicId: deal.public_id },
  });
  await ctx.emit({
    type: 'deal.joined',
    subjectKind: 'deal',
    subjectId: deal.deal_id,
    payload: { linkId: link.link_id, joinerRole, valueLockRef: lock.reference },
  });

  return accept({
    kind: 'JOINED',
    dealId: deal.deal_id,
    publicId: deal.public_id,
    dealCode: deal.deal_code,
    role: joinerRole,
  });
}

/** Throwing wrapper, for the integration suite and legacy callers. */
export async function joinDealLink(user: SessionUser, publicId: string): Promise<JoinSuccess> {
  const outcome = await withTransaction((tx) =>
    joinDealLinkIn(boundaryContextFor(tx, newCommandId()), user, publicId),
  );
  if (!outcome.ok) throw new SandboxFailure(outcome.code, outcome.message);
  return outcome.value;
}

/* ------------------------------------------------------------------ *
 * 7. Deal room — authorization enforced server-side
 * ------------------------------------------------------------------ */

interface DealOptions {
  /** Skip the thread and evidence when only the header facts are needed. */
  readonly summaryOnly?: boolean;
}

export async function getDeal(
  user: SessionUser,
  dealId: string,
  options: DealOptions = {},
): Promise<DealView> {
  const { rows } = await getPool().query(
    `SELECT d.*,
            me.role                 AS viewer_role,
            other.user_id           AS counterparty_id,
            other_user.display_name AS counterparty_name,
            other_user.is_verified  AS counterparty_verified,
            c.utr, c.submitted_at, c.note, c.claimed_by
       FROM sandbox.deal d
       JOIN sandbox.participant me
              ON me.deal_id = d.deal_id AND me.user_id = $2
       JOIN sandbox.participant other
              ON other.deal_id = d.deal_id AND other.user_id <> $2
       JOIN sandbox.app_user other_user ON other_user.user_id = other.user_id
       LEFT JOIN sandbox.payment_claim c ON c.deal_id = d.deal_id
      WHERE d.deal_id = $1`,
    [dealId, user.userId],
  );
  const r = rows[0];
  // A non-participant gets NOT_A_PARTICIPANT, never the deal's contents.
  if (!r) throw new SandboxFailure('NOT_A_PARTICIPANT', 'This deal is private to its two sides.');

  const viewerRole = r.viewer_role as Role;
  const state = r.state as DealState;
  const terminal = isTerminalState(state);
  const disputed = state === 'DISPUTED';

  /*
   * ────────────────────────────────────────────────────────────────────
   * BANK INSTRUCTIONS ARE GATED ON AN AUTHORITATIVE LOCKED-VALUE FACT.
   *
   * UX-01 §3 and TS-01.4 I7: instructions are released only at or after
   * the value leg is locked, only to an authenticated participant, and
   * never to a metadata crawler. TS-00 `SD-6` recorded that the pay
   * screen relied on the deal merely existing — there was no lock fact to
   * consult, because nothing recorded one.
   *
   * Three conditions must ALL hold, and they are evaluated here rather
   * than in the screen, so no future screen can forget one:
   *
   *   1. the viewer holds the paying seat (a payee has no use for its own
   *      handle, and a room showing both teaches people to pay the wrong
   *      one);
   *   2. `value_locked_at` is set — the adapter asserted a lock;
   *   3. a value-protection adapter exists at all in this deployment.
   *
   * Condition 3 is what makes production correct today: no production
   * adapter exists until DEL-04, so production releases no instructions
   * regardless of what any row says.
   * ────────────────────────────────────────────────────────────────────
   */
  const valueLocked = r.value_locked_at !== null && valueProtectionAvailable();
  const mayDisclosePaymentInstructions = viewerRole === 'FIAT_SIDE' && valueLocked;

  const [messages, evidence, dispute, payTo] = options.summaryOnly
    ? [[], [], null, null]
    : await Promise.all([
        listMessages(dealId, user.userId),
        listEvidence(dealId, user.userId),
        getDispute(dealId, user.userId),
        mayDisclosePaymentInstructions
          ? defaultMethodFor(r.counterparty_id)
          : Promise.resolve(null),
      ]);

  return {
    dealId: r.deal_id,
    publicId: r.public_id,
    dealCode: r.deal_code,
    ...rowTerms(r),
    state,
    viewerRole,
    counterpartyName: r.counterparty_name,
    counterpartyVerified: r.counterparty_verified,
    actionDeadline: r.action_deadline ? (r.action_deadline as Date).toISOString() : null,
    createdAt: (r.created_at as Date).toISOString(),
    completedAt: r.completed_at ? (r.completed_at as Date).toISOString() : null,
    claim: r.utr
      ? {
          utr: r.utr,
          submittedAt: (r.submitted_at as Date).toISOString(),
          note: r.note ?? null,
        }
      : null,
    messages,
    evidence,
    dispute,
    payTo,
    valueLocked,
    permitted: {
      // Only the INR sender may claim, only before a claim exists, only while live.
      canClaim: !terminal && !disputed && viewerRole === 'FIAT_SIDE' && state === 'FIAT_PENDING',
      // Only the INR receiver may confirm, and only after a claim exists.
      canConfirm:
        !terminal && !disputed && viewerRole === 'CRYPTO_SIDE' && state === 'FIAT_CLAIMED',
      // A problem can be raised any time the deal is still live.
      canDispute: !terminal && !disputed,
      // The thread stays open on a disputed deal — that is when it matters
      // most — and closes only when the deal itself is finished.
      canMessage: !terminal,
      canUpload: !terminal,
      // Only before anyone has paid. After a claim, cancelling would strand
      // a real transfer, so it becomes a dispute instead.
      canCancel: state === 'FIAT_PENDING',
    },
  };
}

export async function listDealsForUser(user: SessionUser): Promise<readonly DealView[]> {
  const { rows } = await getPool().query(
    `SELECT d.deal_id FROM sandbox.deal d
       JOIN sandbox.participant p ON p.deal_id = d.deal_id AND p.user_id = $1
      ORDER BY d.created_at DESC`,
    [user.userId],
  );
  // Summary only: a list of twenty deals does not need twenty chat threads.
  return Promise.all(rows.map((r) => getDeal(user, r.deal_id, { summaryOnly: true })));
}

/* ------------------------------------------------------------------ *
 * 8. FIAT_SIDE payment claim
 * ------------------------------------------------------------------ */

export async function submitPaymentClaimIn(
  ctx: BoundaryContext,
  user: SessionUser,
  dealId: string,
  utrRaw: string,
  note?: string,
): Promise<Outcome<{ dealId: string }>> {
  const tx = ctx.tx;
  const utr = utrRaw.trim().toUpperCase();
  if (!UTR_PATTERN.test(utr)) {
    return reject('UTR_INVALID', FAILURE_COPY.UTR_INVALID.reason);
  }

  const { rows } = await tx.query(
    `SELECT d.*, p.role AS viewer_role,
            other.user_id AS counterparty_id
       FROM sandbox.deal d
       JOIN sandbox.participant p ON p.deal_id = d.deal_id AND p.user_id = $2
       JOIN sandbox.participant other ON other.deal_id = d.deal_id AND other.user_id <> $2
      WHERE d.deal_id = $1
      FOR UPDATE OF d`,
    [dealId, user.userId],
  );
  const d = rows[0];
  if (!d) {
    await auditEarlyRejection(tx, {
      actorId: user.userId,
      action: 'PAYMENT_CLAIM',
      outcome: 'NOT_A_PARTICIPANT',
      attempted: { dealId },
    });
    return reject('NOT_A_PARTICIPANT', 'This deal is private to its two sides.');
  }

  const refuse = async (code: SandboxError): Promise<Rejected> => {
    await auditRejectionInTx(tx, {
      actorId: user.userId,
      action: 'PAYMENT_CLAIM',
      subjectKind: 'deal',
      subjectId: dealId,
      fromState: d.state,
      outcome: code,
    });
    return reject(code, FAILURE_COPY[code].reason);
  };

  /*
   * Expiry is decided HERE, under the lock, against the database clock —
   * not by whether a page happened to be rendered. A payer arriving one
   * second after the deadline is refused by the same fact that a sweep
   * would have used, so the two can never disagree.
   */
  if (await expireDealIfLapsed(tx, d, user.userId, ctx.emit)) {
    return refuse('WINDOW_LAPSED');
  }

  if (isTerminalState(d.state as DealState)) return refuse('DEAL_TERMINAL');
  if (d.state === 'DISPUTED') return refuse('DEAL_DISPUTED');
  if (d.viewer_role !== 'FIAT_SIDE') return refuse('NOT_FIAT_SIDE');
  if (d.state === 'FIAT_CLAIMED') return refuse('ALREADY_CLAIMED');

  /*
   * ────────────────────────────────────────────────────────────────────
   * SERIALISE ON THE CANONICAL UTR BEFORE READING IT.
   *
   * A constraint violation DOES abort the transaction, so a duplicate UTR
   * must be *detected* rather than caught — otherwise PostgreSQL raises
   * 23505, the transaction dies, and the rejection evidence dies with it.
   *
   * But a bare `SELECT` then `INSERT` is not safe against two claims
   * carrying the SAME reference on DIFFERENT deals: each locks its own
   * deal row, so nothing makes them contend, both read "no such UTR", and
   * the second `INSERT` raises exactly the 23505 the check was meant to
   * avoid. `UNIQUE(utr)` still protects correctness — nobody reuses a
   * bank reference — but the loser gets an opaque driver error instead of
   * `UTR_ALREADY_USED`, and loses their audit row.
   *
   * A transaction-scoped advisory lock keyed on the canonical UTR makes
   * the two contend deterministically. The winner inserts; the loser
   * blocks, then reads the committed row and is refused properly.
   *
   * LOCK ORDER — always, everywhere in this file:
   *     1. deal row      (`SELECT ... FOR UPDATE OF d`)
   *     2. UTR advisory  (`pg_advisory_xact_lock`)
   * Deadlock is impossible because a claim holds exactly one deal row, and
   * two claims on the same deal serialise on the deal lock before either
   * reaches the advisory one. `8201` namespaces this lock class so it can
   * never collide with an advisory lock taken for another purpose.
   * ────────────────────────────────────────────────────────────────────
   */
  await tx.query(`SELECT pg_advisory_xact_lock(8201, hashtext($1))`, [utr]);

  const { rows: utrRows } = await tx.query(
    `SELECT deal_id FROM sandbox.payment_claim WHERE utr = $1`,
    [utr],
  );
  if (utrRows[0]) {
    return refuse(utrRows[0].deal_id === dealId ? 'ALREADY_CLAIMED' : 'UTR_ALREADY_USED');
  }
  const { rows: existing } = await tx.query(
    `SELECT 1 FROM sandbox.payment_claim WHERE deal_id = $1`,
    [dealId],
  );
  if (existing[0]) return refuse('ALREADY_CLAIMED');

  await tx.query(
    `INSERT INTO sandbox.payment_claim (deal_id, claimed_by, utr, note)
     VALUES ($1,$2,$3,$4)`,
    [dealId, user.userId, utr, note?.trim() || null],
  );

  const cas = await tx.query(
    `UPDATE sandbox.deal
        SET state='FIAT_CLAIMED', version=version+1,
            action_deadline = now() + ($2 || ' minutes')::interval
      WHERE deal_id=$1 AND state='FIAT_PENDING'`,
    [dealId, String(CONFIRM_WINDOW_MINUTES)],
  );
  if (cas.rowCount !== 1) return refuse('ALREADY_CLAIMED');

  await systemLine(tx, dealId, `Payment marked sent · reference ${utr}`);
  await notify(
    tx,
    d.counterparty_id,
    dealId,
    'ACTION',
    'Payment marked as sent',
    `${user.displayName} says the INR is on its way. Check your account, then confirm.`,
  );

  await ctx.audit({
    actorId: user.userId,
    action: 'PAYMENT_CLAIM',
    subjectKind: 'deal',
    subjectId: dealId,
    fromState: 'FIAT_PENDING',
    toState: 'FIAT_CLAIMED',
    outcome: 'OK',
    detail: { utrLength: utr.length },
  });
  await ctx.emit({
    type: 'deal.payment_claimed',
    subjectKind: 'deal',
    subjectId: dealId,
    payload: { utrLength: utr.length },
  });

  return accept({ dealId });
}

export async function submitPaymentClaim(
  user: SessionUser,
  dealId: string,
  utrRaw: string,
  note?: string,
): Promise<DealView> {
  const outcome = await withTransaction((tx) =>
    submitPaymentClaimIn(boundaryContextFor(tx, newCommandId()), user, dealId, utrRaw, note),
  );
  if (!outcome.ok) throw new SandboxFailure(outcome.code, outcome.message);
  return getDeal(user, dealId);
}

/* ------------------------------------------------------------------ *
 * 9–10. CRYPTO_SIDE confirmation → COMPLETED
 * ------------------------------------------------------------------ */

/** SafePoints for finishing a deal. Non-monetary; see the schema comment. */
const POINTS_PER_DEAL = 250;
const POINTS_PER_REFERRAL = 500;

export async function confirmReceiptIn(
  ctx: BoundaryContext,
  user: SessionUser,
  dealId: string,
): Promise<Outcome<{ dealId: string }>> {
  const tx = ctx.tx;
  {
    const { rows } = await tx.query(
      `SELECT d.*, p.role AS viewer_role, c.claimed_by,
              other.user_id AS counterparty_id
         FROM sandbox.deal d
         JOIN sandbox.participant p ON p.deal_id = d.deal_id AND p.user_id = $2
         JOIN sandbox.participant other ON other.deal_id = d.deal_id AND other.user_id <> $2
         LEFT JOIN sandbox.payment_claim c ON c.deal_id = d.deal_id
        WHERE d.deal_id = $1
        FOR UPDATE OF d`,
      [dealId, user.userId],
    );
    const d = rows[0];
    if (!d) {
      await auditEarlyRejection(tx, {
        actorId: user.userId,
        action: 'CONFIRM_RECEIPT',
        outcome: 'NOT_A_PARTICIPANT',
        attempted: { dealId },
      });
      return reject('NOT_A_PARTICIPANT', 'This deal is private to its two sides.');
    }

    const refuse = async (code: SandboxError): Promise<Rejected> => {
      await auditRejectionInTx(tx, {
        actorId: user.userId,
        action: 'CONFIRM_RECEIPT',
        subjectKind: 'deal',
        subjectId: dealId,
        fromState: d.state,
        outcome: code,
      });
      return reject(code, FAILURE_COPY[code].reason);
    };

    if (isTerminalState(d.state as DealState)) return refuse('DEAL_TERMINAL');
    if (d.state === 'DISPUTED') return refuse('DEAL_DISPUTED');
    if (d.viewer_role !== 'CRYPTO_SIDE') return refuse('NOT_CRYPTO_SIDE');
    if (d.state !== 'FIAT_CLAIMED') return refuse('NOT_CLAIMED_YET');
    // Defence in depth: the role check already excludes this.
    if (d.claimed_by === user.userId) return refuse('SELF_CONFIRM_FORBIDDEN');

    await tx.query(
      `INSERT INTO sandbox.settlement_confirmation (deal_id, confirmed_by) VALUES ($1,$2)`,
      [dealId, user.userId],
    );

    const cas = await tx.query(
      `UPDATE sandbox.deal
          SET state='COMPLETED', completed_at=now(), action_deadline=NULL, version=version+1
        WHERE deal_id=$1 AND state='FIAT_CLAIMED'`,
      [dealId],
    );
    if (cas.rowCount !== 1) return refuse('DEAL_TERMINAL');

    // The locked value is released by the same adapter that locked it.
    await getValueProtectionAdapter().release(dealId);
    await getEscrowService().release(dealId);

    // Both sides earn on a completed deal. `UNIQUE(user, deal, kind)` makes a
    // double award impossible even if this ran twice.
    for (const uid of [user.userId, d.counterparty_id]) {
      await tx.query(
        `INSERT INTO sandbox.reward_event (user_id, deal_id, kind, points, note)
         VALUES ($1,$2,'DEAL_COMPLETED',$3,'Protected deal completed')
         ON CONFLICT DO NOTHING`,
        [uid, dealId, POINTS_PER_DEAL],
      );
    }
    await qualifyReferral(tx, user.userId);
    await qualifyReferral(tx, d.counterparty_id);

    await systemLine(tx, dealId, 'Receipt confirmed. The deal is complete.');
    await notify(
      tx,
      d.counterparty_id,
      dealId,
      'INFO',
      'Deal completed',
      `${user.displayName} confirmed receipt. ${d.deal_code} is settled.`,
    );

    await ctx.audit({
      actorId: user.userId,
      action: 'CONFIRM_RECEIPT',
      subjectKind: 'deal',
      subjectId: dealId,
      fromState: 'FIAT_CLAIMED',
      toState: 'COMPLETED',
      outcome: 'OK',
    });
    await ctx.emit({
      type: 'deal.completed',
      subjectKind: 'deal',
      subjectId: dealId,
      payload: { confirmedBy: user.userId },
    });
    return accept({ dealId });
  }
}

export async function confirmReceipt(user: SessionUser, dealId: string): Promise<DealView> {
  const outcome = await withTransaction((tx) =>
    confirmReceiptIn(boundaryContextFor(tx, newCommandId()), user, dealId),
  );
  if (!outcome.ok) throw new SandboxFailure(outcome.code, outcome.message);
  return getDeal(user, dealId);
}

/**
 * A referral qualifies on the invitee's FIRST completed deal, never on
 * sign-up. `UNIQUE(user, deal, kind)` with a null deal id would not protect
 * this, so the update is conditional on `qualified_at IS NULL`.
 */
async function qualifyReferral(tx: Tx, userId: string): Promise<void> {
  const { rows } = await tx.query(
    `UPDATE sandbox.referral
        SET qualified_at = now()
      WHERE invitee_id = $1 AND qualified_at IS NULL
      RETURNING referral_id, referrer_id`,
    [userId],
  );
  const ref = rows[0];
  if (!ref) return;
  await tx.query(
    `INSERT INTO sandbox.reward_event (user_id, deal_id, kind, points, note)
     VALUES ($1, NULL, 'REFERRAL_COMPLETED', $2, 'Invited member completed their first deal')`,
    [ref.referrer_id, POINTS_PER_REFERRAL],
  );
  await notify(
    tx,
    ref.referrer_id,
    null,
    'INFO',
    'Referral qualified',
    `Someone you invited completed their first protected deal. ${POINTS_PER_REFERRAL} SafePoints added.`,
  );
}

/* ------------------------------------------------------------------ *
 * 11. Cancel, before anyone has paid
 * ------------------------------------------------------------------ */

export async function cancelDealIn(
  ctx: BoundaryContext,
  user: SessionUser,
  dealId: string,
): Promise<Outcome<{ dealId: string }>> {
  const tx = ctx.tx;
  {
    const { rows } = await tx.query(
      `SELECT d.*, p.role AS viewer_role, other.user_id AS counterparty_id
         FROM sandbox.deal d
         JOIN sandbox.participant p ON p.deal_id = d.deal_id AND p.user_id = $2
         JOIN sandbox.participant other ON other.deal_id = d.deal_id AND other.user_id <> $2
        WHERE d.deal_id = $1
        FOR UPDATE OF d`,
      [dealId, user.userId],
    );
    const d = rows[0];
    if (!d) {
      await auditEarlyRejection(tx, {
        actorId: user.userId,
        action: 'DEAL_CANCEL',
        outcome: 'NOT_A_PARTICIPANT',
        attempted: { dealId },
      });
      return reject('NOT_A_PARTICIPANT', 'This deal is private to its two sides.');
    }

    const refuse = async (code: SandboxError): Promise<Rejected> => {
      await auditRejectionInTx(tx, {
        actorId: user.userId,
        action: 'DEAL_CANCEL',
        subjectKind: 'deal',
        subjectId: dealId,
        fromState: d.state,
        outcome: code,
      });
      return reject(code, FAILURE_COPY[code].reason);
    };

    if (await expireDealIfLapsed(tx, d, user.userId, ctx.emit)) return refuse('WINDOW_LAPSED');
    if (isTerminalState(d.state as DealState)) return refuse('DEAL_TERMINAL');
    if (d.state === 'DISPUTED') return refuse('DEAL_DISPUTED');
    // Once a transfer is claimed, cancelling would strand it. That is a
    // dispute, not a cancellation, and the state machine says so.
    if (d.state !== 'FIAT_PENDING') return refuse('ALREADY_CLAIMED');

    const cas = await tx.query(
      `UPDATE sandbox.deal
          SET state='CANCELLED', closed_at=now(), action_deadline=NULL, version=version+1
        WHERE deal_id=$1 AND state='FIAT_PENDING'`,
      [dealId],
    );
    if (cas.rowCount !== 1) return refuse('DEAL_TERMINAL');

    await systemLine(tx, dealId, `Deal cancelled by ${user.displayName}. Nothing was transferred.`);
    await notify(
      tx,
      d.counterparty_id,
      dealId,
      'WARNING',
      'Deal cancelled',
      `${user.displayName} cancelled ${d.deal_code} before any payment was made.`,
    );

    await ctx.audit({
      actorId: user.userId,
      action: 'DEAL_CANCEL',
      subjectKind: 'deal',
      subjectId: dealId,
      fromState: 'FIAT_PENDING',
      toState: 'CANCELLED',
      outcome: 'OK',
    });
    await ctx.emit({ type: 'deal.cancelled', subjectKind: 'deal', subjectId: dealId });
    return accept({ dealId });
  }
}

export async function cancelDeal(user: SessionUser, dealId: string): Promise<DealView> {
  const outcome = await withTransaction((tx) =>
    cancelDealIn(boundaryContextFor(tx, newCommandId()), user, dealId),
  );
  if (!outcome.ok) throw new SandboxFailure(outcome.code, outcome.message);
  return getDeal(user, dealId);
}

/* ------------------------------------------------------------------ *
 * 12. The thread
 * ------------------------------------------------------------------ */

async function listMessages(dealId: string, viewerId: string): Promise<readonly DealMessage[]> {
  const { rows } = await getPool().query(
    `SELECT m.message_id, m.kind, m.body, m.sent_at, m.author_id, u.display_name
       FROM sandbox.deal_message m
       LEFT JOIN sandbox.app_user u ON u.user_id = m.author_id
      WHERE m.deal_id = $1
      ORDER BY m.sent_at ASC, m.message_id ASC`,
    [dealId],
  );
  return rows.map((r) => ({
    messageId: r.message_id,
    kind: r.kind as 'CHAT' | 'SYSTEM',
    authorName: r.display_name ?? null,
    authorIsViewer: r.author_id === viewerId,
    body: r.body,
    sentAt: (r.sent_at as Date).toISOString(),
  }));
}

export async function postMessageIn(
  ctx: BoundaryContext,
  user: SessionUser,
  dealId: string,
  bodyRaw: string,
): Promise<Outcome<{ messageId: string }>> {
  const tx = ctx.tx;
  const body = bodyRaw.trim();
  if (!body) return reject('MESSAGE_EMPTY', FAILURE_COPY.MESSAGE_EMPTY.reason);
  if (body.length > 2000) {
    return reject('MESSAGE_EMPTY', 'That message is longer than 2000 characters.');
  }

  const { rows } = await tx.query(
    `SELECT d.state, d.deal_code, other.user_id AS counterparty_id
       FROM sandbox.deal d
       JOIN sandbox.participant p ON p.deal_id = d.deal_id AND p.user_id = $2
       JOIN sandbox.participant other ON other.deal_id = d.deal_id AND other.user_id <> $2
      WHERE d.deal_id = $1`,
    [dealId, user.userId],
  );
  const d = rows[0];
  if (!d) {
    await auditEarlyRejection(tx, {
      actorId: user.userId,
      action: 'MESSAGE_POST',
      outcome: 'NOT_A_PARTICIPANT',
      attempted: { dealId },
    });
    return reject('NOT_A_PARTICIPANT', 'This deal is private to its two sides.');
  }
  if (isTerminalState(d.state as DealState)) {
    await auditRejectionInTx(tx, {
      actorId: user.userId,
      action: 'MESSAGE_POST',
      subjectKind: 'deal',
      subjectId: dealId,
      fromState: d.state,
      outcome: 'DEAL_TERMINAL',
    });
    return reject('DEAL_TERMINAL', FAILURE_COPY.DEAL_TERMINAL.reason);
  }

  const { rows: mRows } = await tx.query(
    `INSERT INTO sandbox.deal_message (deal_id, author_id, kind, body)
     VALUES ($1,$2,'CHAT',$3)
     RETURNING message_id`,
    [dealId, user.userId, body],
  );
  const messageId = mRows[0]!.message_id as string;

  await notify(
    tx,
    d.counterparty_id,
    dealId,
    'INFO',
    `New message on ${d.deal_code}`,
    `${user.displayName}: ${body.slice(0, 90)}${body.length > 90 ? '…' : ''}`,
  );

  /*
   * CHAT IS NOW AUDITED — TS-00 `AUD-P1-011`.
   *
   * Every other participant mutation wrote an audit row; this one did not,
   * so dispute-relevant conversation sat outside the trail an operator
   * actually reads. The BODY is deliberately not copied into the audit
   * detail: the message itself already lives in `deal_message`, and
   * duplicating private text into an append-only table that operators
   * browse would widen disclosure rather than improve accountability.
   * What is recorded is that this actor said something, when, and how
   * much — which is what an investigation needs to correlate.
   */
  await ctx.audit({
    actorId: user.userId,
    action: 'MESSAGE_POST',
    subjectKind: 'deal',
    subjectId: dealId,
    outcome: 'OK',
    detail: { messageId, length: body.length },
  });
  await ctx.emit({
    type: 'deal.message_posted',
    subjectKind: 'deal',
    subjectId: dealId,
    payload: { messageId },
  });

  return accept({ messageId });
}

export async function postMessage(
  user: SessionUser,
  dealId: string,
  bodyRaw: string,
): Promise<DealView> {
  const outcome = await withTransaction((tx) =>
    postMessageIn(boundaryContextFor(tx, newCommandId()), user, dealId, bodyRaw),
  );
  if (!outcome.ok) throw new SandboxFailure(outcome.code, outcome.message);
  return getDeal(user, dealId);
}

/* ------------------------------------------------------------------ *
 * 13. Evidence
 * ------------------------------------------------------------------ */

const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
const EVIDENCE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

async function listEvidence(dealId: string, viewerId: string): Promise<readonly DealEvidence[]> {
  // `content` is deliberately absent: a list of five receipts must not drag
  // 25 MB of bytes through a page render.
  const { rows } = await getPool().query(
    `SELECT e.evidence_id, e.filename, e.content_type, e.byte_size, e.sha256,
            e.uploaded_at, e.uploaded_by, u.display_name
       FROM sandbox.deal_evidence e
       JOIN sandbox.app_user u ON u.user_id = e.uploaded_by
      WHERE e.deal_id = $1
      ORDER BY e.uploaded_at ASC`,
    [dealId],
  );
  return rows.map((r) => ({
    evidenceId: r.evidence_id,
    filename: r.filename,
    contentType: r.content_type,
    byteSize: Number(r.byte_size),
    sha256: r.sha256,
    uploadedByName: r.display_name,
    uploadedByViewer: r.uploaded_by === viewerId,
    uploadedAt: (r.uploaded_at as Date).toISOString(),
  }));
}

export async function attachEvidence(
  user: SessionUser,
  dealId: string,
  file: { name: string; type: string; bytes: Buffer },
): Promise<DealView> {
  if (file.bytes.byteLength === 0) {
    throw new SandboxFailure('EVIDENCE_TYPE_REJECTED', 'That file is empty.');
  }
  if (file.bytes.byteLength > EVIDENCE_MAX_BYTES) {
    throw new SandboxFailure('EVIDENCE_TOO_LARGE', FAILURE_COPY.EVIDENCE_TOO_LARGE.reason);
  }
  if (!EVIDENCE_TYPES.has(file.type)) {
    throw new SandboxFailure('EVIDENCE_TYPE_REJECTED', FAILURE_COPY.EVIDENCE_TYPE_REJECTED.reason);
  }

  const sha256 = createHash('sha256').update(file.bytes).digest('hex');
  // Strip any path the browser sent and keep the name short enough to render.
  const filename = file.name.replace(/^.*[\\/]/, '').slice(0, 120) || 'evidence';

  await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT d.state, d.deal_code, other.user_id AS counterparty_id
         FROM sandbox.deal d
         JOIN sandbox.participant p ON p.deal_id = d.deal_id AND p.user_id = $2
         JOIN sandbox.participant other ON other.deal_id = d.deal_id AND other.user_id <> $2
        WHERE d.deal_id = $1`,
      [dealId, user.userId],
    );
    const d = rows[0];
    if (!d) throw new SandboxFailure('NOT_A_PARTICIPANT', 'This deal is private to its two sides.');
    if (isTerminalState(d.state as DealState)) {
      throw new SandboxFailure('DEAL_TERMINAL', FAILURE_COPY.DEAL_TERMINAL.reason);
    }

    await tx.query(
      `INSERT INTO sandbox.deal_evidence
         (deal_id, uploaded_by, filename, content_type, byte_size, sha256, content)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [dealId, user.userId, filename, file.type, file.bytes.byteLength, sha256, file.bytes],
    );
    await systemLine(tx, dealId, `Evidence attached · ${filename}`);
    await notify(
      tx,
      d.counterparty_id,
      dealId,
      'INFO',
      `New evidence on ${d.deal_code}`,
      `${user.displayName} attached ${filename}.`,
    );
    await audit(tx, {
      actorId: user.userId,
      action: 'EVIDENCE_ATTACH',
      subjectKind: 'deal',
      subjectId: dealId,
      outcome: 'OK',
      detail: { filename, byteSize: file.bytes.byteLength, sha256 },
    });
  });

  return getDeal(user, dealId);
}

/**
 * The bytes of one evidence file.
 *
 * Authorization is a JOIN, not a filter the caller supplies: a participant of
 * THIS deal, or an operator reviewing a raised dispute. There is no path that
 * returns bytes to anybody else, and no signed URL that outlives the check.
 */
export async function readEvidence(
  user: SessionUser,
  evidenceId: string,
): Promise<{ filename: string; contentType: string; bytes: Buffer } | null> {
  const { rows } = await getPool().query(
    `SELECT e.filename, e.content_type, e.content
       FROM sandbox.deal_evidence e
      WHERE e.evidence_id = $1
        AND (
          EXISTS (SELECT 1 FROM sandbox.participant p
                   WHERE p.deal_id = e.deal_id AND p.user_id = $2)
          OR ($3 AND EXISTS (SELECT 1 FROM sandbox.dispute di
                              WHERE di.deal_id = e.deal_id AND di.state <> 'RESOLVED'))
        )`,
    [evidenceId, user.userId, user.isOperator],
  );
  const r = rows[0];
  if (!r) return null;
  return { filename: r.filename, contentType: r.content_type, bytes: r.content as Buffer };
}

/* ------------------------------------------------------------------ *
 * 14. Disputes
 * ------------------------------------------------------------------ */

async function getDispute(dealId: string, viewerId: string): Promise<DisputeView | null> {
  const { rows } = await getPool().query(
    `SELECT di.*, u.display_name
       FROM sandbox.dispute di
       JOIN sandbox.app_user u ON u.user_id = di.raised_by
      WHERE di.deal_id = $1`,
    [dealId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    disputeId: r.dispute_id,
    reason: r.reason as DisputeReason,
    detail: r.detail ?? null,
    state: r.state,
    resolution: r.resolution ?? null,
    raisedByViewer: r.raised_by === viewerId,
    raisedByName: r.display_name,
    raisedAt: (r.raised_at as Date).toISOString(),
    resolvedAt: r.resolved_at ? (r.resolved_at as Date).toISOString() : null,
  };
}

/**
 * Raise a problem.
 *
 * This PAUSES release. It reverses nothing, refunds nothing and completes
 * nothing — the deal sits in DISPUTED until an operator rules, which is the
 * only transition out. No timer resolves it.
 */
export async function raiseDisputeIn(
  ctx: BoundaryContext,
  user: SessionUser,
  dealId: string,
  reason: DisputeReason,
  detail?: string,
): Promise<Outcome<{ dealId: string }>> {
  const tx = ctx.tx;
  {
    const { rows } = await tx.query(
      `SELECT d.*, p.role AS viewer_role, other.user_id AS counterparty_id
         FROM sandbox.deal d
         JOIN sandbox.participant p ON p.deal_id = d.deal_id AND p.user_id = $2
         JOIN sandbox.participant other ON other.deal_id = d.deal_id AND other.user_id <> $2
        WHERE d.deal_id = $1
        FOR UPDATE OF d`,
      [dealId, user.userId],
    );
    const d = rows[0];
    if (!d) {
      await auditEarlyRejection(tx, {
        actorId: user.userId,
        action: 'DISPUTE_RAISE',
        outcome: 'NOT_A_PARTICIPANT',
        attempted: { dealId },
      });
      return reject('NOT_A_PARTICIPANT', 'This deal is private to its two sides.');
    }

    const refuse = async (code: SandboxError): Promise<Rejected> => {
      await auditRejectionInTx(tx, {
        actorId: user.userId,
        action: 'DISPUTE_RAISE',
        subjectKind: 'deal',
        subjectId: dealId,
        fromState: d.state,
        outcome: code,
      });
      return reject(code, FAILURE_COPY[code].reason);
    };

    if (isTerminalState(d.state as DealState)) return refuse('DEAL_TERMINAL');
    if (d.state === 'DISPUTED') return refuse('ALREADY_DISPUTED');

    // Detected, not caught: a raised constraint would abort the
    // transaction and take the rejection evidence with it.
    const { rows: priorDispute } = await tx.query(
      `SELECT 1 FROM sandbox.dispute WHERE deal_id = $1`,
      [dealId],
    );
    if (priorDispute[0]) return refuse('ALREADY_DISPUTED');

    await tx.query(
      `INSERT INTO sandbox.dispute (deal_id, raised_by, reason, detail)
       VALUES ($1,$2,$3,$4)`,
      [dealId, user.userId, reason, detail?.trim()?.slice(0, 2000) || null],
    );

    await tx.query(
      `UPDATE sandbox.deal
          SET state='DISPUTED', action_deadline=NULL, version=version+1
        WHERE deal_id=$1`,
      [dealId],
    );

    await systemLine(tx, dealId, `Problem reported by ${user.displayName}. Release is paused.`);
    await notify(
      tx,
      d.counterparty_id,
      dealId,
      'WARNING',
      `Problem reported on ${d.deal_code}`,
      'Release is paused while an operator reviews the case. Add anything that supports your side.',
    );

    await ctx.audit({
      actorId: user.userId,
      action: 'DISPUTE_RAISE',
      subjectKind: 'deal',
      subjectId: dealId,
      fromState: d.state,
      toState: 'DISPUTED',
      outcome: 'OK',
      detail: { reason },
    });
    await ctx.emit({
      type: 'deal.disputed',
      subjectKind: 'deal',
      subjectId: dealId,
      payload: { reason },
    });
    return accept({ dealId });
  }
}

export async function raiseDispute(
  user: SessionUser,
  dealId: string,
  reason: DisputeReason,
  detail?: string,
): Promise<DealView> {
  const outcome = await withTransaction((tx) =>
    raiseDisputeIn(boundaryContextFor(tx, newCommandId()), user, dealId, reason, detail),
  );
  if (!outcome.ok) throw new SandboxFailure(outcome.code, outcome.message);
  return getDeal(user, dealId);
}

/* ------------------------------------------------------------------ *
 * 15. Lapsed payment windows
 * ------------------------------------------------------------------ */

export interface SweepResult {
  readonly dealsExpired: number;
  readonly quotesExpired: number;
}

/**
 * Close every lifecycle window that has passed.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THIS IS AN EXPLICIT ENTRY POINT, NOT A SIDE EFFECT OF RENDERING.  │
 * │                                                                    │
 * │  It used to be called from `src/app/app/layout.tsx`, so a          │
 * │  financial lifecycle transition happened because somebody loaded a │
 * │  page — meaning an idle system never expired anything, a busy one  │
 * │  expired things at unpredictable moments, and a page render could  │
 * │  mutate deals belonging to strangers. That call is gone.           │
 * │                                                                    │
 * │  Scheduling this is DEL-09's work (workers, leases, monitoring).   │
 * │  DEL-02 owes the correct, idempotent, audited operation for a      │
 * │  scheduler to call — and the guarantee that nothing else calls it. │
 * │  Until then, boundaries expire their own row under lock on the way │
 * │  past, so a user can never act on a deal whose window has closed.  │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Each row is locked individually with `FOR UPDATE SKIP LOCKED`, so two
 * concurrent sweeps divide the work instead of blocking on each other, and
 * neither can expire a deal another transaction is mid-way through
 * claiming.
 *
 * This releases nothing, refunds nothing and completes nothing. It records
 * that a window closed.
 */
export async function runLifecycleSweep(limit = 200): Promise<SweepResult> {
  return withTransaction(async (tx) => {
    const ctx = boundaryContextFor(tx, newCommandId());

    const { rows: deals } = await tx.query(
      `SELECT deal_id, state FROM sandbox.deal
        WHERE state = 'FIAT_PENDING'
          AND action_deadline IS NOT NULL
          AND action_deadline <= now()
        ORDER BY action_deadline ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    let dealsExpired = 0;
    for (const d of deals) {
      if (await expireDealIfLapsed(tx, d, null, ctx.emit)) dealsExpired += 1;
    }

    const { rows: quotes } = await tx.query(
      `SELECT quote_id, state, TRUE AS is_expired FROM sandbox.quote
        WHERE state = 'ISSUED' AND expires_at <= now()
        ORDER BY expires_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    let quotesExpired = 0;
    for (const q of quotes) {
      if (await expireQuoteIfLapsed(tx, q, null, ctx.emit)) quotesExpired += 1;
    }

    return { dealsExpired, quotesExpired };
  });
}

/* ------------------------------------------------------------------ *
 * Payment addressing
 * ------------------------------------------------------------------ */

async function defaultMethodFor(userId: string): Promise<DealView['payTo']> {
  const { rows } = await getPool().query(
    `SELECT kind, label, handle, bank_name, ifsc
       FROM sandbox.payment_method
      WHERE user_id = $1
      ORDER BY is_default DESC, created_at ASC
      LIMIT 1`,
    [userId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    kind: r.kind,
    label: r.label,
    handle: r.handle,
    bankName: r.bank_name ?? null,
    ifsc: r.ifsc ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Operator
 * ------------------------------------------------------------------ */

export interface OperatorQueueRow {
  readonly publicId: string;
  readonly state: DealState;
  readonly usdtMinor: string | null;
  readonly inrMinor: string;
  readonly waitingMinutes: number;
}

/**
 * The triage queue.
 *
 * Deliberately carries no identity and no payment reference: throughput
 * triage does not need either, so the server does not send them. An operator
 * who opens a specific case gets the parties from `operatorCase`, which is a
 * separate, separately-audited disclosure.
 */
export async function operatorQueue(user: SessionUser): Promise<readonly OperatorQueueRow[]> {
  // Authorization is checked here, server-side, before any row is read.
  if (!user.isOperator) {
    throw new SandboxFailure('NOT_A_PARTICIPANT', 'This area is restricted to operators.');
  }
  const { rows } = await getPool().query(
    `SELECT public_id, state, usdt_minor, inr_minor,
            EXTRACT(EPOCH FROM (now() - created_at))/60 AS waiting_minutes
       FROM sandbox.deal
      WHERE state IN ('FIAT_PENDING','FIAT_CLAIMED','DISPUTED')
      ORDER BY created_at ASC`,
  );
  return rows.map((r) => ({
    publicId: r.public_id,
    state: r.state as DealState,
    usdtMinor: nullableBigIntString(r.usdt_minor),
    inrMinor: toBigInt(r.inr_minor).toString(),
    waitingMinutes: Math.floor(Number(r.waiting_minutes)),
  }));
}

export async function auditTrail(subjectId: string) {
  const { rows } = await getPool().query(
    `SELECT occurred_at, action, from_state, to_state, outcome
       FROM sandbox.audit_event
      WHERE subject_id = $1 ORDER BY audit_id ASC`,
    [subjectId],
  );
  return rows;
}

export { randomUUID, SCENARIO };
