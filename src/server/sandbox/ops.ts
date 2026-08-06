import 'server-only';
import { getPool, toBigInt, withTransaction } from '@/server/db/pool';
import {
  FAILURE_COPY,
  SandboxFailure,
  type DealState,
  type DisputeReason,
  type OperatorRow,
  type Scenario,
} from '@/lib/sandboxContract';
import type { SessionUser } from '@/lib/sandboxContract';

/**
 * The Operator Deal Desk.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  DISCLOSURE IS TIERED, ON PURPOSE.                                 │
 * │                                                                    │
 * │  The QUEUE answers "what needs attention" and carries the parties' │
 * │  display names, because a person triaging disputes has to know who │
 * │  is involved. It carries no email, no UTR, no bank handle and no   │
 * │  wallet address.                                                   │
 * │                                                                    │
 * │  The CASE view adds payment references and evidence, and only for  │
 * │  a deal that is actually blocked. Opening one is audited.          │
 * │                                                                    │
 * │  Neither may be reached by a non-operator: authorization is        │
 * │  checked before the first row is read, so a denied caller's        │
 * │  response never contained the data at all.                         │
 * └────────────────────────────────────────────────────────────────────┘
 */

function assertOperator(user: SessionUser): void {
  if (!user.isOperator) {
    throw new SandboxFailure('NOT_A_PARTICIPANT', 'This area is restricted to operators.');
  }
}

/* ------------------------------------------------------------------ *
 * The queue
 * ------------------------------------------------------------------ */

export type DeskFilter = 'ALL' | 'DISPUTED' | 'AWAITING_PAYMENT' | 'AWAITING_CONFIRM' | 'AT_RISK';

/** Minutes after which an unmoved deal is treated as going stale. */
export const AT_RISK_MINUTES = 30;

export async function deskQueue(
  user: SessionUser,
  filter: DeskFilter = 'ALL',
): Promise<readonly OperatorRow[]> {
  assertOperator(user);

  const { rows } = await getPool().query(
    `SELECT d.deal_id, d.public_id, d.deal_code, d.state, d.direction,
            d.inr_minor, d.usdt_minor,
            EXTRACT(EPOCH FROM (now() - d.created_at))/60 AS waiting_minutes,
            di.dispute_id IS NOT NULL AS disputed,
            di.reason                 AS dispute_reason,
            payer.display_name        AS payer_name,
            payee.display_name        AS payee_name,
            (SELECT count(*) FROM sandbox.deal_evidence e WHERE e.deal_id = d.deal_id) AS evidence_count,
            (SELECT count(*) FROM sandbox.deal_message m
               WHERE m.deal_id = d.deal_id AND m.kind = 'CHAT')                        AS message_count
       FROM sandbox.deal d
       LEFT JOIN sandbox.dispute di ON di.deal_id = d.deal_id AND di.state <> 'RESOLVED'
       JOIN sandbox.participant pf ON pf.deal_id = d.deal_id AND pf.role = 'FIAT_SIDE'
       JOIN sandbox.app_user payer ON payer.user_id = pf.user_id
       JOIN sandbox.participant pc ON pc.deal_id = d.deal_id AND pc.role = 'CRYPTO_SIDE'
       JOIN sandbox.app_user payee ON payee.user_id = pc.user_id
      WHERE d.state IN ('FIAT_PENDING','FIAT_CLAIMED','DISPUTED')
      ORDER BY (di.dispute_id IS NOT NULL) DESC, d.created_at ASC`,
  );

  const all: OperatorRow[] = rows.map((r) => ({
    dealId: r.deal_id,
    publicId: r.public_id,
    dealCode: r.deal_code,
    state: r.state as DealState,
    direction: r.direction as Scenario,
    inrMinor: toBigInt(r.inr_minor).toString(),
    usdtMinor: r.usdt_minor === null ? null : toBigInt(r.usdt_minor).toString(),
    waitingMinutes: Math.floor(Number(r.waiting_minutes)),
    disputed: r.disputed,
    disputeReason: (r.dispute_reason as DisputeReason | null) ?? null,
    payerName: r.payer_name,
    payeeName: r.payee_name,
    evidenceCount: Number(r.evidence_count),
    messageCount: Number(r.message_count),
  }));

  switch (filter) {
    case 'DISPUTED':
      return all.filter((r) => r.disputed);
    case 'AWAITING_PAYMENT':
      return all.filter((r) => r.state === 'FIAT_PENDING');
    case 'AWAITING_CONFIRM':
      return all.filter((r) => r.state === 'FIAT_CLAIMED');
    case 'AT_RISK':
      return all.filter((r) => r.waitingMinutes >= AT_RISK_MINUTES && !r.disputed);
    default:
      return all;
  }
}

export interface DeskCounts {
  readonly all: number;
  readonly disputed: number;
  readonly awaitingPayment: number;
  readonly awaitingConfirm: number;
  readonly atRisk: number;
}

export function countBy(rows: readonly OperatorRow[]): DeskCounts {
  return {
    all: rows.length,
    disputed: rows.filter((r) => r.disputed).length,
    awaitingPayment: rows.filter((r) => r.state === 'FIAT_PENDING').length,
    awaitingConfirm: rows.filter((r) => r.state === 'FIAT_CLAIMED').length,
    atRisk: rows.filter((r) => r.waitingMinutes >= AT_RISK_MINUTES && !r.disputed).length,
  };
}

/* ------------------------------------------------------------------ *
 * One case
 * ------------------------------------------------------------------ */

export interface CaseParty {
  readonly name: string;
  readonly role: 'FIAT_SIDE' | 'CRYPTO_SIDE';
  readonly verified: boolean;
  readonly completedDeals: number;
}

export interface CaseEvidence {
  readonly evidenceId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly uploadedByName: string;
  readonly uploadedAt: string;
}

export interface CaseTimelineEntry {
  readonly at: string;
  readonly action: string;
  readonly fromState: string | null;
  readonly toState: string | null;
  readonly outcome: string;
  readonly actorName: string | null;
}

export interface OperatorCase {
  readonly dealId: string;
  readonly dealCode: string;
  readonly publicId: string;
  readonly state: DealState;
  readonly direction: Scenario;
  readonly title: string | null;
  readonly inrMinor: string;
  readonly usdtMinor: string | null;
  readonly protectionFeeMinor: string;
  readonly createdAt: string;
  readonly actionDeadline: string | null;
  readonly parties: readonly CaseParty[];
  readonly claim: {
    readonly utr: string;
    readonly submittedAt: string;
    readonly note: string | null;
  } | null;
  readonly dispute: {
    readonly disputeId: string;
    readonly reason: DisputeReason;
    readonly detail: string | null;
    readonly state: 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED';
    readonly raisedByName: string;
    readonly raisedAt: string;
    readonly resolution: 'RELEASED' | 'REFUNDED' | 'CANCELLED' | null;
  } | null;
  readonly evidence: readonly CaseEvidence[];
  readonly messages: readonly {
    readonly kind: 'CHAT' | 'SYSTEM';
    readonly authorName: string | null;
    readonly body: string;
    readonly sentAt: string;
  }[];
  readonly timeline: readonly CaseTimelineEntry[];
}

/**
 * Open one case.
 *
 * An operator may read a deal that is BLOCKED — awaiting action or under
 * dispute. A completed private deal between two people is not operator
 * business and is refused, which is what keeps this from being a window onto
 * every transaction on the platform.
 */
export async function operatorCase(user: SessionUser, dealId: string): Promise<OperatorCase> {
  assertOperator(user);

  const { rows } = await getPool().query(`SELECT d.* FROM sandbox.deal d WHERE d.deal_id = $1`, [
    dealId,
  ]);
  const d = rows[0];
  if (!d) throw new SandboxFailure('NOT_FOUND', 'That deal does not exist.');

  const state = d.state as DealState;
  if (!['FIAT_PENDING', 'FIAT_CLAIMED', 'DISPUTED'].includes(state)) {
    throw new SandboxFailure(
      'NOT_A_PARTICIPANT',
      'This deal is not blocked, so it is private to its two sides.',
    );
  }

  const [parties, claim, dispute, evidence, messages, timeline] = await Promise.all([
    getPool()
      .query(
        `SELECT p.role, u.display_name, u.is_verified, u.user_id,
                (SELECT count(*) FROM sandbox.deal dd
                   JOIN sandbox.participant pp ON pp.deal_id = dd.deal_id AND pp.user_id = u.user_id
                  WHERE dd.state = 'COMPLETED') AS completed
           FROM sandbox.participant p
           JOIN sandbox.app_user u ON u.user_id = p.user_id
          WHERE p.deal_id = $1
          ORDER BY p.role`,
        [dealId],
      )
      .then(({ rows: r }) =>
        r.map((x) => ({
          name: x.display_name,
          role: x.role as 'FIAT_SIDE' | 'CRYPTO_SIDE',
          verified: x.is_verified,
          completedDeals: Number(x.completed),
        })),
      ),
    getPool()
      .query(`SELECT utr, submitted_at, note FROM sandbox.payment_claim WHERE deal_id = $1`, [
        dealId,
      ])
      .then(({ rows: r }) =>
        r[0]
          ? {
              utr: r[0].utr as string,
              submittedAt: (r[0].submitted_at as Date).toISOString(),
              note: (r[0].note as string | null) ?? null,
            }
          : null,
      ),
    getPool()
      .query(
        `SELECT di.*, u.display_name FROM sandbox.dispute di
           JOIN sandbox.app_user u ON u.user_id = di.raised_by
          WHERE di.deal_id = $1`,
        [dealId],
      )
      .then(({ rows: r }) =>
        r[0]
          ? {
              disputeId: r[0].dispute_id as string,
              reason: r[0].reason as DisputeReason,
              detail: (r[0].detail as string | null) ?? null,
              state: r[0].state as 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED',
              raisedByName: r[0].display_name as string,
              raisedAt: (r[0].raised_at as Date).toISOString(),
              resolution:
                (r[0].resolution as OperatorCase['dispute'] extends null
                  ? never
                  : 'RELEASED' | 'REFUNDED' | 'CANCELLED' | null) ?? null,
            }
          : null,
      ),
    getPool()
      .query(
        `SELECT e.evidence_id, e.filename, e.content_type, e.byte_size, e.sha256,
                e.uploaded_at, u.display_name
           FROM sandbox.deal_evidence e
           JOIN sandbox.app_user u ON u.user_id = e.uploaded_by
          WHERE e.deal_id = $1 ORDER BY e.uploaded_at ASC`,
        [dealId],
      )
      .then(({ rows: r }) =>
        r.map((x) => ({
          evidenceId: x.evidence_id as string,
          filename: x.filename as string,
          contentType: x.content_type as string,
          byteSize: Number(x.byte_size),
          sha256: x.sha256 as string,
          uploadedByName: x.display_name as string,
          uploadedAt: (x.uploaded_at as Date).toISOString(),
        })),
      ),
    getPool()
      .query(
        `SELECT m.kind, m.body, m.sent_at, u.display_name
           FROM sandbox.deal_message m
           LEFT JOIN sandbox.app_user u ON u.user_id = m.author_id
          WHERE m.deal_id = $1 ORDER BY m.sent_at ASC`,
        [dealId],
      )
      .then(({ rows: r }) =>
        r.map((x) => ({
          kind: x.kind as 'CHAT' | 'SYSTEM',
          authorName: (x.display_name as string | null) ?? null,
          body: x.body as string,
          sentAt: (x.sent_at as Date).toISOString(),
        })),
      ),
    getPool()
      .query(
        `SELECT a.occurred_at, a.action, a.from_state, a.to_state, a.outcome, u.display_name
           FROM sandbox.audit_event a
           LEFT JOIN sandbox.app_user u ON u.user_id = a.actor_id
          WHERE a.subject_id = $1 ORDER BY a.audit_id ASC`,
        [dealId],
      )
      .then(({ rows: r }) =>
        r.map((x) => ({
          at: (x.occurred_at as Date).toISOString(),
          action: x.action as string,
          fromState: (x.from_state as string | null) ?? null,
          toState: (x.to_state as string | null) ?? null,
          outcome: x.outcome as string,
          actorName: (x.display_name as string | null) ?? null,
        })),
      ),
  ]);

  // Opening a case is itself a disclosure, so it is recorded as one.
  await getPool().query(
    `INSERT INTO sandbox.audit_event
       (actor_id, action, subject_kind, subject_id, outcome, detail)
     VALUES ($1,'OPERATOR_CASE_OPEN','deal',$2,'OK',$3)`,
    [user.userId, dealId, JSON.stringify({ state })],
  );

  return {
    dealId: d.deal_id,
    dealCode: d.deal_code,
    publicId: d.public_id,
    state,
    direction: d.direction as Scenario,
    title: d.title ?? null,
    inrMinor: toBigInt(d.inr_minor).toString(),
    usdtMinor: d.usdt_minor === null ? null : toBigInt(d.usdt_minor).toString(),
    protectionFeeMinor: toBigInt(d.protection_fee_minor ?? '0').toString(),
    createdAt: (d.created_at as Date).toISOString(),
    actionDeadline: d.action_deadline ? (d.action_deadline as Date).toISOString() : null,
    parties,
    claim,
    dispute,
    evidence,
    messages,
    timeline,
  };
}

/* ------------------------------------------------------------------ *
 * Rulings
 * ------------------------------------------------------------------ */

export type Ruling = 'RELEASED' | 'REFUNDED' | 'CANCELLED';

const RULING_STATE: Readonly<Record<Ruling, DealState>> = {
  RELEASED: 'COMPLETED',
  REFUNDED: 'REFUNDED',
  CANCELLED: 'CANCELLED',
};

/**
 * Rule on a dispute.
 *
 * The ONLY way out of DISPUTED. Three outcomes, all of them a person's
 * decision, all of them recorded with the operator's identity and a
 * mandatory written reason — an unexplained ruling on someone's money is not
 * an acceptable artefact.
 */
export async function ruleOnDispute(
  user: SessionUser,
  dealId: string,
  ruling: Ruling,
  reason: string,
): Promise<void> {
  assertOperator(user);
  const note = reason.trim();
  if (note.length < 10) {
    throw new SandboxFailure(
      'NOT_FOUND',
      'Write at least a sentence explaining the ruling. It is shown to both sides.',
    );
  }

  await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT d.*, di.dispute_id, di.state AS dispute_state
         FROM sandbox.deal d
         LEFT JOIN sandbox.dispute di ON di.deal_id = d.deal_id
        WHERE d.deal_id = $1
        FOR UPDATE OF d`,
      [dealId],
    );
    const d = rows[0];
    if (!d) throw new SandboxFailure('NOT_FOUND', 'That deal does not exist.');
    if (d.state !== 'DISPUTED') {
      throw new SandboxFailure('DEAL_TERMINAL', 'That deal is not under dispute.');
    }
    if (!d.dispute_id) {
      throw new SandboxFailure('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);
    }

    const nextState = RULING_STATE[ruling];
    /*
     * `completing` is its own parameter rather than a comparison against
     * `$2`. PostgreSQL deduces one type per placeholder, and using the same
     * one as both a `sandbox.deal_state` and a text literal makes the
     * statement unplannable ("inconsistent types deduced for parameter").
     *
     * `deal_completed_at` requires `completed_at` to be set for COMPLETED
     * and null otherwise, so the two branches are not interchangeable —
     * they are what keeps a refunded deal from carrying a completion time.
     */
    const completing = nextState === 'COMPLETED';
    await tx.query(
      `UPDATE sandbox.deal
          SET state = $2::sandbox.deal_state,
              completed_at = CASE WHEN $3 THEN now() ELSE completed_at END,
              closed_at    = CASE WHEN $3 THEN closed_at ELSE now() END,
              action_deadline = NULL,
              version = version + 1
        WHERE deal_id = $1`,
      [dealId, nextState, completing],
    );
    await tx.query(
      `UPDATE sandbox.dispute
          SET state='RESOLVED', resolution=$2, resolved_by=$3, resolved_at=now()
        WHERE dispute_id=$1`,
      [d.dispute_id, ruling, user.userId],
    );

    await tx.query(
      `INSERT INTO sandbox.deal_message (deal_id, author_id, kind, body)
       VALUES ($1, NULL, 'SYSTEM', $2)`,
      [dealId, `Operator ruling · ${ruling.toLowerCase()}. ${note}`],
    );

    const { rows: seats } = await tx.query(
      `SELECT user_id FROM sandbox.participant WHERE deal_id = $1`,
      [dealId],
    );
    for (const seat of seats) {
      await tx.query(
        `INSERT INTO sandbox.notification (user_id, deal_id, severity, title, body)
         VALUES ($1,$2,'ACTION',$3,$4)`,
        [
          seat.user_id,
          dealId,
          `Dispute resolved on ${d.deal_code}`,
          `Outcome: ${ruling.toLowerCase()}. ${note}`,
        ],
      );
    }

    await tx.query(
      `INSERT INTO sandbox.audit_event
         (actor_id, action, subject_kind, subject_id, from_state, to_state, outcome, detail)
       VALUES ($1,'DISPUTE_RULE','deal',$2,'DISPUTED',$3,'OK',$4)`,
      [user.userId, dealId, nextState, JSON.stringify({ ruling, reason: note })],
    );
  });
}
