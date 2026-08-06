import 'server-only';
import { randomBytes, randomUUID } from 'node:crypto';
import { getPool, toBigInt, withTransaction, type Tx } from '@/server/db/pool';
import { getEscrowService } from './escrow';

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
  DealState,
  LinkState,
  PreviewStatus,
  Terms,
  SandboxQuote,
  LinkPreview,
  DealView,
  SessionUser,
} from '@/lib/sandboxContract';
export { SandboxFailure, FAILURE_COPY } from '@/lib/sandboxContract';

import {
  FAILURE_COPY,
  SandboxFailure,
  type DealState,
  type DealView,
  type LinkPreview,
  type PreviewStatus,
  type Role,
  type SandboxError,
  type SandboxQuote,
  type SessionUser,
  type Terms,
} from '@/lib/sandboxContract';

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

/** Sandbox UTR: 12 uppercase alphanumerics, matching real UTR length. */
export const UTR_PATTERN = /^[0-9A-Z]{12}$/;

function rowTerms(r: Record<string, unknown>): Terms {
  return {
    direction: r.direction as Terms['direction'],
    usdtMinor: toBigInt(r.usdt_minor).toString(),
    inrMinor: toBigInt(r.inr_minor).toString(),
    rateNum: toBigInt(r.rate_num).toString(),
    rateDen: toBigInt(r.rate_den).toString(),
    pricingSource: r.pricing_source as string,
    observedAt: (r.observed_at as Date).toISOString(),
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

/* ------------------------------------------------------------------ *
 * Users / session
 * ------------------------------------------------------------------ */

/** Sandbox sign-in: no password is accepted, checked or stored. */
export async function signInSandbox(email: string): Promise<SessionUser> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(normalized)) {
    throw new SandboxFailure('UNAUTHENTICATED', 'Enter a valid email address.');
  }
  const isOperator = normalized.startsWith('ops@');
  const isVerified = !normalized.startsWith('new@');
  const displayName = normalized.split('@')[0]!.replace(/[._-]+/g, ' ');

  const { rows } = await getPool().query(
    `INSERT INTO sandbox.app_user (email, display_name, is_operator, is_verified)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING user_id, email, display_name, is_operator, is_verified`,
    [normalized, displayName, isOperator, isVerified],
  );
  const r = rows[0]!;
  return {
    userId: r.user_id,
    email: r.email,
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
    email: r.email,
    displayName: r.display_name,
    isOperator: r.is_operator,
    isVerified: r.is_verified,
  };
}

/* ------------------------------------------------------------------ *
 * 1. Server-issued firm quote
 * ------------------------------------------------------------------ */

/** Sandbox reference price: exact rational, INR paise per USDT micro. */
const SANDBOX_RATE_NUM = 8880n; // 88.80 INR / USDT
const SANDBOX_RATE_DEN = 100n;
const QUOTE_TTL_SECONDS = 150;

export async function issueFirmQuote(
  user: SessionUser,
  direction: Terms['direction'],
  usdtMinor: bigint,
): Promise<SandboxQuote> {
  if (usdtMinor <= 0n) throw new SandboxFailure('NOT_FOUND', 'Enter an amount greater than zero.');

  // INR paise = USDT micro × rate, floored. Rounding happens exactly once,
  // here, at issuance; no later step re-derives an amount from the rate.
  const inrMinor = (usdtMinor * SANDBOX_RATE_NUM) / (SANDBOX_RATE_DEN * 10_000n);
  if (inrMinor <= 0n) {
    throw new SandboxFailure('NOT_FOUND', 'That amount is too small to quote.');
  }

  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO sandbox.quote
         (issued_to, direction, usdt_minor, inr_minor, rate_num, rate_den,
          pricing_source, observed_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now() + ($8 || ' seconds')::interval)
       RETURNING *`,
      [
        user.userId,
        direction,
        usdtMinor.toString(),
        inrMinor.toString(),
        SANDBOX_RATE_NUM.toString(),
        SANDBOX_RATE_DEN.toString(),
        'SANDBOX_REFERENCE',
        String(QUOTE_TTL_SECONDS),
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
      detail: { usdtMinor: usdtMinor.toString(), inrMinor: inrMinor.toString() },
    });
    return {
      quoteId: r.quote_id,
      ...rowTerms(r),
      expiresAt: (r.expires_at as Date).toISOString(),
      expired: false,
    };
  });
}

/* ------------------------------------------------------------------ *
 * 2. Create a deal link from a valid quote
 * ------------------------------------------------------------------ */

const LINK_TTL_SECONDS = 1800;

export async function createDealLink(user: SessionUser, quoteId: string): Promise<LinkPreview> {
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

    // The creator supplies the USDT when selling it, so they are CRYPTO_SIDE.
    const creatorRole: Role = q.direction === 'USDT_TO_INR' ? 'CRYPTO_SIDE' : 'FIAT_SIDE';

    await tx.query(`UPDATE sandbox.quote SET state='CONSUMED' WHERE quote_id=$1`, [quoteId]);

    const publicId = newPublicId();
    const { rows: linkRows } = await tx.query(
      `INSERT INTO sandbox.deal_link
         (public_id, quote_id, created_by, creator_role, expires_at)
       VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval)
       RETURNING *`,
      [publicId, quoteId, user.userId, creatorRole, String(LINK_TTL_SECONDS)],
    );
    const l = linkRows[0]!;

    await audit(tx, {
      actorId: user.userId,
      action: 'LINK_CREATE',
      subjectKind: 'link',
      subjectId: l.link_id,
      toState: 'OPEN',
      outcome: 'OK',
      detail: { publicId, creatorRole },
    });

    return {
      publicId,
      ...rowTerms(q),
      displayStatus: 'OPEN',
      joinable: true,
      expiresAt: (l.expires_at as Date).toISOString(),
      viewerWouldBe: creatorRole === 'CRYPTO_SIDE' ? 'FIAT_SIDE' : 'CRYPTO_SIDE',
      viewerIsCreator: true,
      createdAtIso: (l.created_at as Date).toISOString(),
    };
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
            q.pricing_source, q.observed_at,
            (l.expires_at <= now()) AS is_expired
       FROM sandbox.deal_link l
       JOIN sandbox.quote q ON q.quote_id = l.quote_id
      WHERE l.public_id = $1`,
    [publicId],
  );
  const r = rows[0];
  if (!r) return null;

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
    viewerWouldBe: r.creator_role === 'CRYPTO_SIDE' ? 'FIAT_SIDE' : 'CRYPTO_SIDE',
    // Identity-derived, so it is false for every anonymous reader.
    viewerIsCreator: viewer ? r.created_by === viewer.userId : false,
    createdAtIso: (r.created_at as Date).toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * 5. ATOMIC SINGLE-WINNER JOIN
 * ------------------------------------------------------------------ */

export interface JoinSuccess {
  readonly kind: 'JOINED';
  readonly dealId: string;
  readonly publicId: string;
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

    const joinerRole: Role = link.creator_role === 'CRYPTO_SIDE' ? 'FIAT_SIDE' : 'CRYPTO_SIDE';
    const dealPublicId = newPublicId();

    // (3) UNIQUE(link_id) is the database's own backstop.
    const { rows: dRows } = await tx.query(
      `INSERT INTO sandbox.deal
         (public_id, link_id, quote_id, direction, usdt_minor, inr_minor,
          rate_num, rate_den, pricing_source, observed_at, action_deadline)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + interval '15 minutes')
       RETURNING deal_id, public_id`,
      [
        dealPublicId,
        link.link_id,
        link.quote_id,
        q.direction,
        q.usdt_minor,
        q.inr_minor,
        q.rate_num,
        q.rate_den,
        q.pricing_source,
        q.observed_at,
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
    await getEscrowService().hold(deal.deal_id, toBigInt(q.usdt_minor));

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
      role: joinerRole,
    };
  });
}

/* ------------------------------------------------------------------ *
 * 7. Deal room — authorization enforced server-side
 * ------------------------------------------------------------------ */

export async function getDeal(user: SessionUser, dealId: string): Promise<DealView> {
  const { rows } = await getPool().query(
    `SELECT d.*,
            me.role                AS viewer_role,
            other_user.display_name AS counterparty_name,
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
  const terminal = state === 'COMPLETED' || state === 'CANCELLED';

  return {
    dealId: r.deal_id,
    publicId: r.public_id,
    ...rowTerms(r),
    state,
    viewerRole,
    counterpartyName: r.counterparty_name,
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
    permitted: {
      // Only the INR sender may claim, only before a claim exists, only while live.
      canClaim: !terminal && viewerRole === 'FIAT_SIDE' && state === 'FIAT_PENDING',
      // Only the INR receiver may confirm, and only after a claim exists.
      canConfirm: !terminal && viewerRole === 'CRYPTO_SIDE' && state === 'FIAT_CLAIMED',
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
  return Promise.all(rows.map((r) => getDeal(user, r.deal_id)));
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
      `SELECT d.*, p.role AS viewer_role
         FROM sandbox.deal d
         JOIN sandbox.participant p ON p.deal_id = d.deal_id AND p.user_id = $2
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

    if (d.state === 'COMPLETED' || d.state === 'CANCELLED') await fail('DEAL_TERMINAL');
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
              action_deadline = now() + interval '30 minutes'
        WHERE deal_id=$1 AND state='FIAT_PENDING'`,
      [dealId],
    );
    if (cas.rowCount !== 1) await fail('ALREADY_CLAIMED');

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

export async function confirmReceipt(user: SessionUser, dealId: string): Promise<DealView> {
  await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT d.*, p.role AS viewer_role, c.claimed_by
         FROM sandbox.deal d
         JOIN sandbox.participant p ON p.deal_id = d.deal_id AND p.user_id = $2
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

    if (d.state === 'COMPLETED' || d.state === 'CANCELLED') await fail('DEAL_TERMINAL');
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

/* ------------------------------------------------------------------ *
 * Operator
 * ------------------------------------------------------------------ */

export interface OperatorQueueRow {
  readonly publicId: string;
  readonly state: DealState;
  readonly usdtMinor: string;
  readonly inrMinor: string;
  readonly waitingMinutes: number;
}

export async function operatorQueue(user: SessionUser): Promise<readonly OperatorQueueRow[]> {
  // Authorization is checked here, server-side, before any row is read.
  if (!user.isOperator) {
    throw new SandboxFailure('NOT_A_PARTICIPANT', 'This area is restricted to operators.');
  }
  const { rows } = await getPool().query(
    `SELECT public_id, state, usdt_minor, inr_minor,
            EXTRACT(EPOCH FROM (now() - created_at))/60 AS waiting_minutes
       FROM sandbox.deal
      WHERE state IN ('FIAT_PENDING','FIAT_CLAIMED')
      ORDER BY created_at ASC`,
  );
  return rows.map((r) => ({
    publicId: r.public_id,
    state: r.state as DealState,
    usdtMinor: toBigInt(r.usdt_minor).toString(),
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

export { randomUUID };
