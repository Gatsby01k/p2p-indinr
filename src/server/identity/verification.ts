import 'server-only';
import { getPool, withTransaction, type Tx } from '@/server/db/pool';
import { writeAudit } from '@/server/boundary/command';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { can, type Principal } from './rbac';

/**
 * Verification as a CASE, not a boolean.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHAT WAS WRONG WITH THE BOOLEAN.                                  │
 * │                                                                    │
 * │  `markVerified()` set `identity_verified = TRUE` on request, wrote │
 * │  no audit row, and minted loyalty points every time it was called  │
 * │  (TS-00 `AUD-P1-008`, `AUD-P1-001`). The badge it produced was     │
 * │  displayed next to people's names in a deal room as evidence of    │
 * │  something, and it was evidence of a button press.                 │
 * │                                                                    │
 * │  A case carries: what was submitted, which provider looked at it   │
 * │  and what they said, who decided, when it lapses, and an immutable │
 * │  history. Two rules are enforced by the DATABASE rather than by    │
 * │  this file — a subject cannot decide their own case, and a decided │
 * │  case cannot be deleted.                                           │
 * └────────────────────────────────────────────────────────────────────┘
 */

export type VerificationKind = 'IDENTITY' | 'UPI' | 'WALLET';
export type VerificationState = 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
export type ProviderDecision = 'PASS' | 'FAIL' | 'REFER';

export interface VerificationCase {
  readonly caseId: string;
  readonly userId: string;
  readonly kind: VerificationKind;
  readonly state: VerificationState;
  readonly submittedAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly providerDecision: ProviderDecision | null;
  readonly expiresAt: string | null;
}

/** A verification is a statement about a moment, so it lapses. */
export const VERIFICATION_VALID_DAYS = 365;

/**
 * Submit a case for review.
 *
 * The subject supplies evidence and a provider decision may accompany it,
 * but neither approves anything: a case arrives `SUBMITTED` and only a
 * reviewer who is not the subject can move it.
 */
export async function submitVerification(input: {
  readonly userId: string;
  readonly kind: VerificationKind;
  readonly evidenceRef?: string | null;
  readonly provider?: string | null;
  readonly providerDecision?: ProviderDecision | null;
}): Promise<Outcome<VerificationCase>> {
  return withTransaction(async (tx) => {
    const { rows: open } = await tx.query(
      `SELECT case_id FROM sandbox.verification_case
        WHERE user_id = $1 AND kind = $2 AND state IN ('SUBMITTED','UNDER_REVIEW')`,
      [input.userId, input.kind],
    );
    // A second submission joins the first rather than creating a queue of
    // duplicates a reviewer has to reconcile.
    if (open[0]) return accept(await readCase(tx, open[0].case_id));

    /*
     * `ON CONFLICT DO NOTHING` against the partial unique index, because
     * the read above is not a lock: two simultaneous submissions can both
     * see no open case. The database decides, and the loser re-reads the
     * winner's case rather than failing — a person who double-tapped
     * Submit has one case either way, which is what they meant.
     */
    const { rows } = await tx.query(
      `INSERT INTO sandbox.verification_case
         (user_id, kind, evidence_ref, provider, provider_decision)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT DO NOTHING
       RETURNING case_id`,
      [
        input.userId,
        input.kind,
        input.evidenceRef ?? null,
        input.provider ?? null,
        input.providerDecision ?? null,
      ],
    );
    if (!rows[0]) {
      const { rows: winner } = await tx.query(
        `SELECT case_id FROM sandbox.verification_case
          WHERE user_id = $1 AND kind = $2 AND state IN ('SUBMITTED','UNDER_REVIEW')`,
        [input.userId, input.kind],
      );
      return accept(await readCase(tx, winner[0]!.case_id));
    }

    await writeAudit(tx, {
      actorId: input.userId,
      action: 'VERIFICATION_SUBMIT',
      subjectKind: 'user',
      subjectId: input.userId,
      toState: 'SUBMITTED',
      outcome: 'OK',
      detail: { kind: input.kind, caseId: rows[0]!.case_id },
    });
    return accept(await readCase(tx, rows[0]!.case_id));
  });
}

/**
 * Decide a case.
 *
 * Three guards, in order, and the middle one is the whole point: a person
 * cannot decide a case about themselves. It is checked here for a clean
 * refusal AND enforced by `verification_case_reviewer_not_subject`, so a
 * bug in this file cannot produce a self-approval.
 */
export async function decideVerification(input: {
  readonly reviewer: Principal;
  readonly caseId: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly note: string;
}): Promise<Outcome<VerificationCase>> {
  if (!can(input.reviewer, 'verification.review')) {
    return reject('PERMISSION_DENIED', FAILURE_COPY.PERMISSION_DENIED.reason);
  }
  if (input.note.trim().length < 8) {
    return reject('NOT_FOUND', 'A decision must carry a written reason.');
  }

  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT case_id, user_id, kind, state FROM sandbox.verification_case
        WHERE case_id = $1 FOR UPDATE`,
      [input.caseId],
    );
    const c = rows[0];
    if (!c) return reject('NOT_FOUND', 'That verification case does not exist.');

    const refuse = async (code: 'REVIEWER_CONFLICT' | 'DEAL_TERMINAL', message: string) => {
      await writeAudit(tx, {
        actorId: input.reviewer.userId,
        action: 'VERIFICATION_DECIDE',
        subjectKind: 'user',
        subjectId: c.user_id,
        outcome: code,
        detail: { caseId: input.caseId },
      });
      return reject(code, message);
    };

    // REVIEWER SEPARATION.
    if (c.user_id === input.reviewer.userId) {
      return refuse('REVIEWER_CONFLICT', FAILURE_COPY.REVIEWER_CONFLICT.reason);
    }
    if (!['SUBMITTED', 'UNDER_REVIEW'].includes(c.state)) {
      return refuse('DEAL_TERMINAL', 'That case has already been decided.');
    }

    await tx.query(
      `UPDATE sandbox.verification_case
          SET state = $2, decided_at = now(), decided_by = $3, decision_note = $4,
              expires_at = CASE WHEN $2 = 'APPROVED'
                                THEN now() + ($5 || ' days')::interval ELSE NULL END
        WHERE case_id = $1 AND state IN ('SUBMITTED','UNDER_REVIEW')`,
      [
        input.caseId,
        input.decision,
        input.reviewer.userId,
        input.note.trim(),
        String(VERIFICATION_VALID_DAYS),
      ],
    );

    // The profile flag is a CACHE of the decision, written only here.
    if (input.decision === 'APPROVED') {
      const column = {
        IDENTITY: 'identity_verified',
        UPI: 'upi_verified',
        WALLET: 'wallet_verified',
      }[c.kind as VerificationKind];
      await tx.query(
        `UPDATE sandbox.user_profile SET ${column} = TRUE, updated_at = now() WHERE user_id = $1`,
        [c.user_id],
      );
      if (c.kind === 'IDENTITY') {
        await tx.query(`UPDATE sandbox.app_user SET is_verified = TRUE WHERE user_id = $1`, [
          c.user_id,
        ]);
      }
    }

    await writeAudit(tx, {
      actorId: input.reviewer.userId,
      action: 'VERIFICATION_DECIDE',
      subjectKind: 'user',
      subjectId: c.user_id,
      fromState: c.state,
      toState: input.decision,
      outcome: 'OK',
      detail: { caseId: input.caseId, kind: c.kind, note: input.note.trim() },
    });

    return accept(await readCase(tx, input.caseId));
  });
}

/** Lapse approved verifications whose validity has run out. DEL-09 schedules it. */
export async function expireLapsedVerifications(): Promise<number> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE sandbox.verification_case
          SET state = 'EXPIRED'
        WHERE state = 'APPROVED' AND expires_at IS NOT NULL AND expires_at <= now()
        RETURNING case_id, user_id, kind`,
    );
    for (const r of rows) {
      const column = {
        IDENTITY: 'identity_verified',
        UPI: 'upi_verified',
        WALLET: 'wallet_verified',
      }[r.kind as VerificationKind];
      await tx.query(`UPDATE sandbox.user_profile SET ${column} = FALSE WHERE user_id = $1`, [
        r.user_id,
      ]);
      if (r.kind === 'IDENTITY') {
        await tx.query(`UPDATE sandbox.app_user SET is_verified = FALSE WHERE user_id = $1`, [
          r.user_id,
        ]);
      }
      await writeAudit(tx, {
        actorId: null,
        action: 'VERIFICATION_EXPIRE',
        subjectKind: 'user',
        subjectId: r.user_id,
        fromState: 'APPROVED',
        toState: 'EXPIRED',
        outcome: 'OK',
        detail: { caseId: r.case_id, kind: r.kind },
      });
    }
    return rows.length;
  });
}

/** A case as a reviewer needs to see it: the subject, named. */
export interface VerificationQueueRow extends VerificationCase {
  readonly subjectName: string;
  readonly subjectHandle: string;
  /** True when the viewer is the subject — they may never decide it. */
  readonly isOwnCase: boolean;
}

/**
 * The reviewer's queue of undecided cases.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  ⚠ THE QUEUE THAT WAS MISSING, AND WHAT IT COST.                   │
 * │                                                                    │
 * │  `decideVerification` below has existed and been tested since      │
 * │  DEL-03, and nothing in the product could call it: no action, no   │
 * │  screen, no queue. So every case a person submitted stayed         │
 * │  SUBMITTED for ever, `identity_verified` was never written, and    │
 * │  joining any protected deal was refused with "Your sandbox account │
 * │  is not verified" — for everybody, permanently. The core journey   │
 * │  of the product could not be completed by anyone.                  │
 * │                                                                    │
 * │  It stayed invisible because the shared development database had   │
 * │  accounts the integration suite had verified through this function │
 * │  directly. Running the gate against its own fresh cluster is what  │
 * │  surfaced it.                                                      │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Authorization is decided BEFORE the query, so a caller without
 * `verification.review` never causes other people's cases to be read.
 * Own cases are returned but flagged: hiding them would tell a reviewer
 * nothing, and the decision itself is refused by the database anyway.
 */
export async function listVerificationQueue(
  reviewer: Principal,
): Promise<Outcome<readonly VerificationQueueRow[]>> {
  if (!can(reviewer, 'verification.review')) {
    return reject('PERMISSION_DENIED', FAILURE_COPY.PERMISSION_DENIED.reason);
  }
  const { rows } = await getPool().query(
    `SELECT c.case_id, c.user_id, c.kind, c.state, c.submitted_at, c.decided_at,
            c.decided_by, c.provider_decision, c.expires_at,
            u.display_name, u.email
       FROM sandbox.verification_case c
       JOIN sandbox.app_user u ON u.user_id = c.user_id
      WHERE c.state IN ('SUBMITTED','UNDER_REVIEW')
      ORDER BY c.submitted_at ASC`,
  );
  return accept(
    rows.map((r) => ({
      ...mapCase(r),
      subjectName: (r.display_name as string) ?? 'Unnamed account',
      /*
       * The local part only. A reviewer needs to tell two accounts
       * apart; they do not need a mailbox they could then contact
       * outside the product, and a full address in a queue is a
       * contact list waiting to be screenshotted.
       */
      subjectHandle: String(r.email ?? '').split('@')[0] || '—',
      isOwnCase: r.user_id === reviewer.userId,
    })),
  );
}

export async function listVerificationCases(userId: string): Promise<readonly VerificationCase[]> {
  const { rows } = await getPool().query(
    `SELECT case_id, user_id, kind, state, submitted_at, decided_at, decided_by,
            provider_decision, expires_at
       FROM sandbox.verification_case WHERE user_id = $1 ORDER BY submitted_at DESC`,
    [userId],
  );
  return rows.map(mapCase);
}

async function readCase(tx: Tx, caseId: string): Promise<VerificationCase> {
  const { rows } = await tx.query(
    `SELECT case_id, user_id, kind, state, submitted_at, decided_at, decided_by,
            provider_decision, expires_at
       FROM sandbox.verification_case WHERE case_id = $1`,
    [caseId],
  );
  return mapCase(rows[0]);
}

function mapCase(r: Record<string, unknown>): VerificationCase {
  return {
    caseId: r.case_id as string,
    userId: r.user_id as string,
    kind: r.kind as VerificationKind,
    state: r.state as VerificationState,
    submittedAt: (r.submitted_at as Date).toISOString(),
    decidedAt: r.decided_at ? (r.decided_at as Date).toISOString() : null,
    decidedBy: (r.decided_by as string | null) ?? null,
    providerDecision: (r.provider_decision as ProviderDecision | null) ?? null,
    expiresAt: r.expires_at ? (r.expires_at as Date).toISOString() : null,
  };
}
