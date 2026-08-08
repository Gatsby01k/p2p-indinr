import 'server-only';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getPool, toBigInt, withTransaction, type Tx } from '@/server/db/pool';
import { getEscrowService } from './escrow';
import { feesFor } from '@/lib/fees';
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

interface AuditEvent {
  actorId: string | null;
  action: string;
  subjectKind: 'link' | 'deal' | 'quote' | 'user';
  subjectId: string;
  fromState?: string | null;
  toState?: string | null;
  outcome: string;
  detail?: Record<string, unknown>;
}

const AUDIT_SQL = `
  INSERT INTO sandbox.audit_event
    (actor_id, action, subject_kind, subject_id, from_state, to_state, outcome, detail)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;

function auditParams(e: AuditEvent) {
  return [
    e.actorId,
    e.action,
    e.subjectKind,
    e.subjectId,
    e.fromState ?? null,
    e.toState ?? null,
    e.outcome,
    JSON.stringify(e.detail ?? {}),
  ];
}

/** Audit a SUCCESS, inside the transaction it describes. Commits with it. */
async function audit(tx: Tx, e: AuditEvent): Promise<void> {
  await tx.query(AUDIT_SQL, auditParams(e));
}

/**
 * Audit a REJECTION, on a separate connection outside the failing transaction.
 *
 * This is not a stylistic choice; writing it inside the transaction is wrong
 * twice over:
 *
 *  1. **It would be rolled back.** A rejection aborts its transaction, so an
 *     audit row written inside it vanishes with everything else — and the
 *     record of *why* a caller was refused is exactly the record an operator
 *     needs. Expected rejections must persist.
 *  2. **It cannot even be written.** Once PostgreSQL raises (a constraint
 *     violation, say), the transaction is in an aborted state and every
 *     subsequent statement on that connection fails with 25P02
 *     `current transaction is aborted`. The audit attempt would replace the
 *     real rejection code with an opaque driver error.
 *
 * So the rejection record goes out on its own connection, committing
 * independently. It must never throw: a failure to audit must not mask the
 * rejection the caller needs to see.
 */
async function auditRejection(e: AuditEvent): Promise<void> {
  try {
    await getPool().query(AUDIT_SQL, auditParams(e));
  } catch (err) {
    console.error('[sandbox audit] failed to record rejection', e.outcome, err);
  }
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
  const isOperator = normalized.startsWith('ops@');
  const isVerified = !normalized.startsWith('new@');
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

async function insertQuote(
  user: SessionUser,
  q: QuoteInsert,
  options: QuoteOptions,
): Promise<SandboxQuote> {
  const fees = feesFor(q.direction, q.inrMinor);
  const bearer: FeeBearer = options.feeBearer ?? 'PAYER';
  const title = options.title?.trim() ? options.title.trim().slice(0, 120) : null;

  return withTransaction(async (tx) => {
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
        SANDBOX_RATE_NUM.toString(),
        SANDBOX_RATE_DEN.toString(),
        'SANDBOX_REFERENCE',
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
  });
}

/**
 * A firm quote for an exchange, priced from the USDT leg.
 *
 * Rounding happens exactly once, here, at issuance; no later step re-derives
 * an amount from the rate.
 */
export async function issueFirmQuote(
  user: SessionUser,
  direction: 'USDT_TO_INR' | 'INR_TO_USDT',
  usdtMinor: bigint,
  options: QuoteOptions = {},
): Promise<SandboxQuote> {
  if (usdtMinor <= 0n) throw new SandboxFailure('NOT_FOUND', 'Enter an amount greater than zero.');

  const inrMinor = (usdtMinor * SANDBOX_RATE_NUM) / (SANDBOX_RATE_DEN * 10_000n);
  if (inrMinor <= 0n) {
    throw new SandboxFailure('NOT_FOUND', 'That amount is too small to quote.');
  }
  return insertQuote(user, { direction, usdtMinor, inrMinor }, options);
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
  assertInrRange(inrMinor);
  const usdtMinor = (inrMinor * SANDBOX_RATE_DEN * 10_000n) / SANDBOX_RATE_NUM;
  if (usdtMinor <= 0n) throw new SandboxFailure('AMOUNT_TOO_SMALL', 'That amount is too small.');
  return insertQuote(user, { direction, usdtMinor, inrMinor }, options);
}

/** A firm quote for a protected INR → INR payment. No USDT leg exists. */
export async function issueProtectedQuote(
  user: SessionUser,
  inrMinor: bigint,
  options: QuoteOptions = {},
): Promise<SandboxQuote> {
  assertInrRange(inrMinor);
  return insertQuote(user, { direction: 'INR_TO_INR', usdtMinor: null, inrMinor }, options);
}

function assertInrRange(inrMinor: bigint): void {
  if (inrMinor <= 0n)
    throw new SandboxFailure('AMOUNT_INVALID', FAILURE_COPY.AMOUNT_INVALID.reason);
  if (inrMinor < MIN_INR_MINOR) {
    throw new SandboxFailure('AMOUNT_TOO_SMALL', FAILURE_COPY.AMOUNT_TOO_SMALL.reason);
  }
  if (inrMinor > MAX_INR_MINOR) {
    throw new SandboxFailure('AMOUNT_TOO_LARGE', FAILURE_COPY.AMOUNT_TOO_LARGE.reason);
  }
}

/* ------------------------------------------------------------------ *
 * 2. Create a deal link from a valid quote
 * ------------------------------------------------------------------ */

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
  return withTransaction(async (tx) => {
    // Lock the quote, then read the server clock. Expiry is evaluated after
    // the lock is held, so a quote cannot expire between check and use.
    const { rows } = await tx.query(
      `SELECT *, (expires_at <= now()) AS is_expired
         FROM sandbox.quote WHERE quote_id = $1 FOR UPDATE`,
      [quoteId],
    );
    const q = rows[0];
    if (!q) throw new SandboxFailure('NOT_FOUND', 'That quote does not exist.');
    if (q.issued_to !== user.userId) {
      throw new SandboxFailure('NOT_A_PARTICIPANT', 'That quote was issued to someone else.');
    }
    if (q.state === 'CONSUMED') throw new SandboxFailure('QUOTE_CONSUMED', 'Quote already used.');
    if (q.is_expired || q.state === 'EXPIRED') {
      // The rejection audit goes out of band so it survives this transaction's
      // rollback; marking the quote EXPIRED is a separate, idempotent cleanup
      // that the next read would perform anyway from `expires_at`.
      await auditRejection({
        actorId: user.userId,
        action: 'LINK_CREATE',
        subjectKind: 'quote',
        subjectId: quoteId,
        fromState: q.state,
        outcome: 'QUOTE_EXPIRED',
      });
      throw new SandboxFailure('QUOTE_EXPIRED', FAILURE_COPY.QUOTE_EXPIRED.reason);
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

    return {
      publicId,
      ...rowTerms(q),
      displayStatus: 'OPEN',
      joinable: true,
      expiresAt: (l.expires_at as Date).toISOString(),
      viewerWouldBe: otherRole(creatorRole),
      viewerIsCreator: true,
      createdAtIso: (l.created_at as Date).toISOString(),
      // The caller here IS the creator, so this discloses nothing new.
      creatorName: user.displayName,
      creatorVerified: user.isVerified,
    };
  });
}

/** Withdraw a link that nobody has taken yet. Only its creator may. */
export async function closeDealLink(user: SessionUser, publicId: string): Promise<void> {
  await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT * FROM sandbox.deal_link WHERE public_id = $1 FOR UPDATE`,
      [publicId],
    );
    const link = rows[0];
    if (!link) throw new SandboxFailure('NOT_FOUND', 'That deal link does not exist.');
    if (link.created_by !== user.userId) {
      throw new SandboxFailure('NOT_A_PARTICIPANT', 'Only the creator can withdraw a link.');
    }
    if (link.state === 'CONSUMED') {
      throw new SandboxFailure('LINK_CONSUMED', FAILURE_COPY.LINK_CONSUMED.reason);
    }
    if (link.state === 'CLOSED') return;

    await tx.query(
      `UPDATE sandbox.deal_link
          SET state='CLOSED', closed_at=now(), version=version+1
        WHERE link_id=$1 AND state='OPEN'`,
      [link.link_id],
    );
    await audit(tx, {
      actorId: user.userId,
      action: 'LINK_CLOSE',
      subjectKind: 'link',
      subjectId: link.link_id,
      fromState: 'OPEN',
      toState: 'CLOSED',
      outcome: 'OK',
    });
  });
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
export async function joinDealLink(user: SessionUser, publicId: string): Promise<JoinSuccess> {
  if (!user.isVerified) {
    throw new SandboxFailure('REQUIRES_VERIFICATION', 'This sandbox account is not verified.');
  }

  return withTransaction(async (tx) => {
    // (1) Serialise every concurrent joiner on this exact row.
    const { rows } = await tx.query(
      `SELECT l.*, (l.expires_at <= now()) AS is_expired
         FROM sandbox.deal_link l
        WHERE l.public_id = $1
        FOR UPDATE`,
      [publicId],
    );
    const link = rows[0];
    if (!link) throw new SandboxFailure('NOT_FOUND', 'That deal link does not exist.');

    const reject = async (code: SandboxError): Promise<never> => {
      await auditRejection({
        actorId: user.userId,
        action: 'LINK_JOIN',
        subjectKind: 'link',
        subjectId: link.link_id,
        fromState: link.state,
        outcome: code,
      });
      throw new SandboxFailure(code, FAILURE_COPY[code].reason);
    };

    if (link.created_by === user.userId) await reject('CANNOT_JOIN_OWN_LINK');
    if (link.state === 'CONSUMED') await reject('LINK_CONSUMED');
    if (link.state === 'CLOSED') await reject('LINK_CLOSED');
    if (link.is_expired) await reject('LINK_EXPIRED');

    // (2) Conditional state change. Zero affected rows means we lost.
    const cas = await tx.query(
      `UPDATE sandbox.deal_link
          SET state='CONSUMED', consumed_at=now(), version=version+1
        WHERE link_id=$1 AND state='OPEN'`,
      [link.link_id],
    );
    if (cas.rowCount !== 1) await reject('LINK_CONSUMED');

    const { rows: qRows } = await tx.query(`SELECT * FROM sandbox.quote WHERE quote_id=$1`, [
      link.quote_id,
    ]);
    const q = qRows[0]!;
    const scenario = q.direction as Scenario;

    const joinerRole: Role = otherRole(link.creator_role as Role);
    const dealPublicId = newPublicId();

    // (3) UNIQUE(link_id) is the database's own backstop.
    const { rows: dRows } = await tx.query(
      `INSERT INTO sandbox.deal
         (public_id, deal_code, link_id, quote_id, direction, usdt_minor, inr_minor,
          rate_num, rate_den, pricing_source, observed_at,
          protection_fee_minor, network_fee_minor, fee_bearer, title,
          action_deadline)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
               now() + ($16 || ' minutes')::interval)
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

    await audit(tx, {
      actorId: user.userId,
      action: 'LINK_JOIN',
      subjectKind: 'deal',
      subjectId: deal.deal_id,
      toState: 'FIAT_PENDING',
      outcome: 'OK',
      detail: { linkId: link.link_id, joinerRole, publicId: deal.public_id },
    });

    return {
      kind: 'JOINED',
      dealId: deal.deal_id,
      publicId: deal.public_id,
      dealCode: deal.deal_code,
      role: joinerRole,
    };
  });
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

  const [messages, evidence, dispute, payTo] = options.summaryOnly
    ? [[], [], null, null]
    : await Promise.all([
        listMessages(dealId, user.userId),
        listEvidence(dealId, user.userId),
        getDispute(dealId, user.userId),
        // Only the paying seat is told where to send money. The receiving
        // seat has no use for its own handle here, and a deal room that
        // shows both sides' handles teaches people to pay the wrong one.
        viewerRole === 'FIAT_SIDE' ? defaultMethodFor(r.counterparty_id) : Promise.resolve(null),
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

export async function submitPaymentClaim(
  user: SessionUser,
  dealId: string,
  utrRaw: string,
  note?: string,
): Promise<DealView> {
  const utr = utrRaw.trim().toUpperCase();
  if (!UTR_PATTERN.test(utr)) {
    throw new SandboxFailure('UTR_INVALID', FAILURE_COPY.UTR_INVALID.reason);
  }

  await withTransaction(async (tx) => {
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
    if (!d) throw new SandboxFailure('NOT_A_PARTICIPANT', 'This deal is private to its two sides.');

    const fail = async (code: SandboxError): Promise<never> => {
      await auditRejection({
        actorId: user.userId,
        action: 'PAYMENT_CLAIM',
        subjectKind: 'deal',
        subjectId: dealId,
        fromState: d.state,
        outcome: code,
      });
      throw new SandboxFailure(code, FAILURE_COPY[code].reason);
    };

    if (isTerminalState(d.state as DealState)) await fail('DEAL_TERMINAL');
    if (d.state === 'DISPUTED') await fail('DEAL_DISPUTED');
    if (d.viewer_role !== 'FIAT_SIDE') await fail('NOT_FIAT_SIDE');
    if (d.state === 'FIAT_CLAIMED') await fail('ALREADY_CLAIMED');

    try {
      await tx.query(
        `INSERT INTO sandbox.payment_claim (deal_id, claimed_by, utr, note)
         VALUES ($1,$2,$3,$4)`,
        [dealId, user.userId, utr, note?.trim() || null],
      );
    } catch (err) {
      const code = (err as { constraint?: string }).constraint;
      if (code === 'payment_claim_utr_uq') await fail('UTR_ALREADY_USED');
      if (code === 'payment_claim_deal_uq') await fail('ALREADY_CLAIMED');
      throw err;
    }

    const cas = await tx.query(
      `UPDATE sandbox.deal
          SET state='FIAT_CLAIMED', version=version+1,
              action_deadline = now() + ($2 || ' minutes')::interval
        WHERE deal_id=$1 AND state='FIAT_PENDING'`,
      [dealId, String(CONFIRM_WINDOW_MINUTES)],
    );
    if (cas.rowCount !== 1) await fail('ALREADY_CLAIMED');

    await systemLine(tx, dealId, `Payment marked sent · reference ${utr}`);
    await notify(
      tx,
      d.counterparty_id,
      dealId,
      'ACTION',
      'Payment marked as sent',
      `${user.displayName} says the INR is on its way. Check your account, then confirm.`,
    );

    await audit(tx, {
      actorId: user.userId,
      action: 'PAYMENT_CLAIM',
      subjectKind: 'deal',
      subjectId: dealId,
      fromState: 'FIAT_PENDING',
      toState: 'FIAT_CLAIMED',
      outcome: 'OK',
      detail: { utrLength: utr.length },
    });
  });

  return getDeal(user, dealId);
}

/* ------------------------------------------------------------------ *
 * 9–10. CRYPTO_SIDE confirmation → COMPLETED
 * ------------------------------------------------------------------ */

/** SafePoints for finishing a deal. Non-monetary; see the schema comment. */
const POINTS_PER_DEAL = 250;
const POINTS_PER_REFERRAL = 500;

export async function confirmReceipt(user: SessionUser, dealId: string): Promise<DealView> {
  await withTransaction(async (tx) => {
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
    if (!d) throw new SandboxFailure('NOT_A_PARTICIPANT', 'This deal is private to its two sides.');

    const fail = async (code: SandboxError): Promise<never> => {
      await auditRejection({
        actorId: user.userId,
        action: 'CONFIRM_RECEIPT',
        subjectKind: 'deal',
        subjectId: dealId,
        fromState: d.state,
        outcome: code,
      });
      throw new SandboxFailure(code, FAILURE_COPY[code].reason);
    };

    if (isTerminalState(d.state as DealState)) await fail('DEAL_TERMINAL');
    if (d.state === 'DISPUTED') await fail('DEAL_DISPUTED');
    if (d.viewer_role !== 'CRYPTO_SIDE') await fail('NOT_CRYPTO_SIDE');
    if (d.state !== 'FIAT_CLAIMED') await fail('NOT_CLAIMED_YET');
    // Defence in depth: the role check already excludes this.
    if (d.claimed_by === user.userId) await fail('SELF_CONFIRM_FORBIDDEN');

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
    if (cas.rowCount !== 1) await fail('DEAL_TERMINAL');

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

    await audit(tx, {
      actorId: user.userId,
      action: 'CONFIRM_RECEIPT',
      subjectKind: 'deal',
      subjectId: dealId,
      fromState: 'FIAT_CLAIMED',
      toState: 'COMPLETED',
      outcome: 'OK',
    });
  });

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

export async function cancelDeal(user: SessionUser, dealId: string): Promise<DealView> {
  await withTransaction(async (tx) => {
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
    if (!d) throw new SandboxFailure('NOT_A_PARTICIPANT', 'This deal is private to its two sides.');

    const fail = async (code: SandboxError): Promise<never> => {
      await auditRejection({
        actorId: user.userId,
        action: 'DEAL_CANCEL',
        subjectKind: 'deal',
        subjectId: dealId,
        fromState: d.state,
        outcome: code,
      });
      throw new SandboxFailure(code, FAILURE_COPY[code].reason);
    };

    if (isTerminalState(d.state as DealState)) await fail('DEAL_TERMINAL');
    if (d.state === 'DISPUTED') await fail('DEAL_DISPUTED');
    // Once a transfer is claimed, cancelling would strand it. That is a
    // dispute, not a cancellation, and the state machine says so.
    if (d.state !== 'FIAT_PENDING') await fail('ALREADY_CLAIMED');

    const cas = await tx.query(
      `UPDATE sandbox.deal
          SET state='CANCELLED', closed_at=now(), action_deadline=NULL, version=version+1
        WHERE deal_id=$1 AND state='FIAT_PENDING'`,
      [dealId],
    );
    if (cas.rowCount !== 1) await fail('DEAL_TERMINAL');

    await systemLine(tx, dealId, `Deal cancelled by ${user.displayName}. Nothing was transferred.`);
    await notify(
      tx,
      d.counterparty_id,
      dealId,
      'WARNING',
      'Deal cancelled',
      `${user.displayName} cancelled ${d.deal_code} before any payment was made.`,
    );

    await audit(tx, {
      actorId: user.userId,
      action: 'DEAL_CANCEL',
      subjectKind: 'deal',
      subjectId: dealId,
      fromState: 'FIAT_PENDING',
      toState: 'CANCELLED',
      outcome: 'OK',
    });
  });

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

export async function postMessage(
  user: SessionUser,
  dealId: string,
  bodyRaw: string,
): Promise<DealView> {
  const body = bodyRaw.trim();
  if (!body) throw new SandboxFailure('MESSAGE_EMPTY', FAILURE_COPY.MESSAGE_EMPTY.reason);
  if (body.length > 2000) {
    throw new SandboxFailure('MESSAGE_EMPTY', 'That message is longer than 2000 characters.');
  }

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
      `INSERT INTO sandbox.deal_message (deal_id, author_id, kind, body)
       VALUES ($1,$2,'CHAT',$3)`,
      [dealId, user.userId, body],
    );
    await notify(
      tx,
      d.counterparty_id,
      dealId,
      'INFO',
      `New message on ${d.deal_code}`,
      `${user.displayName}: ${body.slice(0, 90)}${body.length > 90 ? '…' : ''}`,
    );
  });

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
export async function raiseDispute(
  user: SessionUser,
  dealId: string,
  reason: DisputeReason,
  detail?: string,
): Promise<DealView> {
  await withTransaction(async (tx) => {
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
    if (!d) throw new SandboxFailure('NOT_A_PARTICIPANT', 'This deal is private to its two sides.');

    const fail = async (code: SandboxError): Promise<never> => {
      await auditRejection({
        actorId: user.userId,
        action: 'DISPUTE_RAISE',
        subjectKind: 'deal',
        subjectId: dealId,
        fromState: d.state,
        outcome: code,
      });
      throw new SandboxFailure(code, FAILURE_COPY[code].reason);
    };

    if (isTerminalState(d.state as DealState)) await fail('DEAL_TERMINAL');
    if (d.state === 'DISPUTED') await fail('ALREADY_DISPUTED');

    try {
      await tx.query(
        `INSERT INTO sandbox.dispute (deal_id, raised_by, reason, detail)
         VALUES ($1,$2,$3,$4)`,
        [dealId, user.userId, reason, detail?.trim()?.slice(0, 2000) || null],
      );
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'dispute_deal_uq') {
        await fail('ALREADY_DISPUTED');
      }
      throw err;
    }

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

    await audit(tx, {
      actorId: user.userId,
      action: 'DISPUTE_RAISE',
      subjectKind: 'deal',
      subjectId: dealId,
      fromState: d.state,
      toState: 'DISPUTED',
      outcome: 'OK',
      detail: { reason },
    });
  });

  return getDeal(user, dealId);
}

/* ------------------------------------------------------------------ *
 * 15. Lapsed payment windows
 * ------------------------------------------------------------------ */

/**
 * Move deals whose payment window has passed to EXPIRED.
 *
 * Called on read paths rather than by a scheduler, because this sandbox has
 * no worker. It is evaluated against the DATABASE clock and only ever affects
 * deals nobody has paid on — a claimed deal never expires, it disputes.
 *
 * This releases nothing, refunds nothing and completes nothing. It records
 * that a window closed.
 */
export async function sweepLapsedDeals(): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE sandbox.deal
        SET state='EXPIRED', closed_at=now(), action_deadline=NULL, version=version+1
      WHERE state='FIAT_PENDING'
        AND action_deadline IS NOT NULL
        AND action_deadline <= now() - interval '2 hours'`,
  );
  return rowCount ?? 0;
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
