import 'server-only';
import { getPool, type Tx } from '@/server/db/pool';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { denialFor, type Permission, type Principal } from '@/server/identity/rbac';
import { lockForDeal, refundDealValue, releaseDealValue } from '@/server/ledger/valueProtection';

/**
 * Dispute cases and the maker-checker ruling.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  NOBODY DECIDES A DISPUTE ALONE. NOT A PARTICIPANT, NOT AN         │
 * │  OPERATOR, NOT AN ADMIN.                                           │
 * │                                                                    │
 * │  A participant may only OPEN a case — they cannot choose the       │
 * │  outcome, and opening one FREEZES the ordinary paths so neither    │
 * │  side can settle around the complaint while it is being heard.     │
 * │                                                                    │
 * │  An operator may only PROPOSE. A different, separately authorised  │
 * │  person must APPROVE, and approval is where the money actually     │
 * │  moves. Self-approval is impossible: the service refuses it and a  │
 * │  CHECK constraint refuses it, so even a bug cannot produce a       │
 * │  one-person ruling.                                                │
 * │                                                                    │
 * │  Both permissions AND both second factors are re-checked at        │
 * │  EXECUTION time, not at proposal time — an operator whose access   │
 * │  was revoked between proposing and approving has no authority left │
 * │  to lend the decision.                                             │
 * └────────────────────────────────────────────────────────────────────┘
 */

export type CaseCategory =
  | 'PAYMENT_NOT_RECEIVED'
  | 'WRONG_AMOUNT'
  | 'PROOF_MISMATCH'
  | 'NOT_AS_AGREED'
  | 'OTHER';

export type CaseState = 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED' | 'WITHDRAWN';
export type Disposition = 'RELEASE' | 'REFUND';

export interface DisputeCase {
  readonly caseId: string;
  readonly dealId: string;
  readonly openedBy: string;
  readonly category: CaseCategory;
  readonly statement: string;
  readonly state: CaseState;
  readonly version: number;
  readonly disposition: Disposition | null;
  readonly resolutionNote: string | null;
  readonly openedAt: string;
  readonly resolvedAt: string | null;
}

const CASE_COLUMNS = `case_id, deal_id, opened_by, category, statement, state, version,
  disposition, resolution_note, opened_at, resolved_at`;

function mapCase(r: Record<string, unknown>): DisputeCase {
  return {
    caseId: r.case_id as string,
    dealId: r.deal_id as string,
    openedBy: r.opened_by as string,
    category: r.category as CaseCategory,
    statement: r.statement as string,
    state: r.state as CaseState,
    version: r.version as number,
    disposition: (r.disposition as Disposition | null) ?? null,
    resolutionNote: (r.resolution_note as string | null) ?? null,
    openedAt: (r.opened_at as Date).toISOString(),
    resolvedAt: r.resolved_at === null ? null : (r.resolved_at as Date).toISOString(),
  };
}

/** States in which a case still governs the deal. */
export const ACTIVE_CASE_STATES = ['OPEN', 'UNDER_REVIEW'] as const;

/**
 * The live case for a deal, if there is one.
 *
 * Used by the freeze check on every ordinary mutation, so it reads the
 * table rather than the compatibility view — one hop fewer on the path
 * that runs most often.
 */
export async function activeCaseForDeal(tx: Tx, dealId: string): Promise<DisputeCase | null> {
  const { rows } = await tx.query(
    `SELECT ${CASE_COLUMNS} FROM sandbox.dispute_case
      WHERE deal_id = $1 AND state IN ('OPEN','UNDER_REVIEW')`,
    [dealId],
  );
  return rows[0] ? mapCase(rows[0]) : null;
}

export async function caseById(caseId: string): Promise<DisputeCase | null> {
  const { rows } = await getPool().query(
    `SELECT ${CASE_COLUMNS} FROM sandbox.dispute_case WHERE case_id = $1`,
    [caseId],
  );
  return rows[0] ? mapCase(rows[0]) : null;
}

/* ------------------------------------------------------------------ *
 * The freeze
 * ------------------------------------------------------------------ */

/**
 * Refuse an ordinary mutation while a dispute is live.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THIS IS THE FUNCTION THAT MAKES "OPENING A DISPUTE FREEZES THE    │
 * │  DEAL" TRUE RATHER THAN ASPIRATIONAL.                              │
 * │                                                                    │
 * │  It is called at the TOP of every completion, release, refund and  │
 * │  cancellation path, inside the caller's transaction and after the  │
 * │  deal row is locked. Anything less and the sequence "read deal →   │
 * │  dispute opens → complete deal" settles a deal somebody is         │
 * │  actively disputing.                                               │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function assertNotFrozen(tx: Tx, dealId: string): Promise<Outcome<null>> {
  const live = await activeCaseForDeal(tx, dealId);
  if (live === null) return accept(null);
  return reject('DEAL_FROZEN', FAILURE_COPY.DEAL_FROZEN.reason, { caseId: live.caseId });
}

/* ------------------------------------------------------------------ *
 * Opening
 * ------------------------------------------------------------------ */

/**
 * Capture what was true when the complaint was made.
 *
 * A ruling days later has to be judged against the facts at the time. A
 * live re-read at ruling time would show the facts the ruling itself is
 * about to change — and, worse, would let a late provider event silently
 * rewrite the basis of a decision somebody already made.
 */
async function snapshotFor(tx: Tx, dealId: string): Promise<Record<string, unknown>> {
  const { rows: deal } = await tx.query(
    `SELECT state, direction, inr_minor::text AS inr_minor,
            usdt_minor::text AS usdt_minor, version
       FROM sandbox.deal WHERE deal_id = $1`,
    [dealId],
  );
  const { rows: lock } = await tx.query(
    `SELECT lock_id, state, asset::text AS asset, amount_minor::text AS amount_minor
       FROM inrp2p.value_lock WHERE deal_id = $1`,
    [dealId],
  );
  const { rows: intents } = await tx.query(
    `SELECT intent_id, rail::text AS rail, state::text AS state,
            amount_minor::text AS amount_minor, ledger_entry_id
       FROM sandbox.payment_intent WHERE deal_id = $1 ORDER BY created_at`,
    [dealId],
  );
  return {
    capturedAt: new Date().toISOString(),
    deal: deal[0] ?? null,
    valueLock: lock[0] ?? null,
    paymentIntents: intents,
  };
}

export async function openCase(
  tx: Tx,
  input: {
    readonly actorId: string;
    readonly dealId: string;
    readonly category: CaseCategory;
    readonly statement: string;
  },
): Promise<Outcome<DisputeCase>> {
  // Participation is the authorization, re-derived rather than trusted.
  const { rows: seat } = await tx.query(
    `SELECT 1 FROM sandbox.participant WHERE deal_id = $1 AND user_id = $2`,
    [input.dealId, input.actorId],
  );
  if (!seat[0]) return reject('NOT_A_PARTICIPANT', FAILURE_COPY.NOT_A_PARTICIPANT.reason);

  const { rows: deal } = await tx.query(
    `SELECT state FROM sandbox.deal WHERE deal_id = $1 FOR UPDATE`,
    [input.dealId],
  );
  if (deal[0] === undefined) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);
  /*
   * A finished deal cannot be disputed through this path.
   *
   * Not because a completed deal is beyond complaint, but because the
   * only dispositions this stage can honour — release and refund —
   * require a LIVE value lock, and a completed deal no longer has one.
   * Opening a case that could never be resolved would be worse than
   * refusing: it would look like the complaint was accepted.
   */
  if (deal[0].state === 'COMPLETED' || deal[0].state === 'CANCELLED') {
    return reject('DEAL_TERMINAL', FAILURE_COPY.DEAL_TERMINAL.reason);
  }

  const statement = input.statement.trim();
  if (statement.length < 20) {
    return reject('STATEMENT_TOO_SHORT', FAILURE_COPY.STATEMENT_TOO_SHORT.reason);
  }
  if (statement.length > 4000) {
    return reject('MESSAGE_TOO_LONG', FAILURE_COPY.MESSAGE_TOO_LONG.reason);
  }

  const existing = await activeCaseForDeal(tx, input.dealId);
  if (existing !== null) {
    return reject('CASE_ALREADY_OPEN', FAILURE_COPY.CASE_ALREADY_OPEN.reason, {
      caseId: existing.caseId,
    });
  }

  const snapshot = await snapshotFor(tx, input.dealId);

  /*
   * The partial unique index is the real guarantee here. Two
   * participants complaining in the same instant both pass the check
   * above; only one insert survives, and the loser is told a case is
   * already open rather than silently creating a second one.
   */
  const { rows } = await tx.query(
    `INSERT INTO sandbox.dispute_case (deal_id, opened_by, category, statement, snapshot)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING ${CASE_COLUMNS}`,
    [input.dealId, input.actorId, input.category, statement, JSON.stringify(snapshot)],
  );

  // The deal itself records that it is frozen, so every existing reader
  // — including the accepted DEL-02 screens — sees it without change.
  await tx.query(
    `UPDATE sandbox.deal SET state='DISPUTED', action_deadline=NULL, version=version+1
      WHERE deal_id=$1 AND state NOT IN ('COMPLETED','CANCELLED')`,
    [input.dealId],
  );

  return accept(mapCase(rows[0]!));
}

/* ------------------------------------------------------------------ *
 * Operator authority, checked live at every step
 * ------------------------------------------------------------------ */

function authorize(principal: Principal, permission: Permission): Outcome<null> {
  const denial = denialFor(principal, permission);
  if (denial === null) return accept(null);
  if (denial === 'MFA_REQUIRED') {
    return reject('MFA_REQUIRED', FAILURE_COPY.MFA_REQUIRED.reason);
  }
  if (denial === 'MFA_NOT_ENROLLED') {
    return reject('MFA_NOT_ENROLLED', FAILURE_COPY.MFA_NOT_ENROLLED.reason);
  }
  return reject('PERMISSION_DENIED', FAILURE_COPY.PERMISSION_DENIED.reason);
}

/* ------------------------------------------------------------------ *
 * Proposing
 * ------------------------------------------------------------------ */

export interface Proposal {
  readonly proposalId: string;
  readonly caseId: string;
  readonly proposedBy: string;
  readonly disposition: Disposition;
  readonly rationale: string;
  readonly caseVersion: number;
  readonly state: 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED';
}

function mapProposal(r: Record<string, unknown>): Proposal {
  return {
    proposalId: r.proposal_id as string,
    caseId: r.case_id as string,
    proposedBy: r.proposed_by as string,
    disposition: r.disposition as Disposition,
    rationale: r.rationale as string,
    caseVersion: r.case_version as number,
    state: r.state as Proposal['state'],
  };
}

export async function proposeResolution(
  tx: Tx,
  principal: Principal,
  input: {
    readonly caseId: string;
    readonly disposition: Disposition;
    readonly rationale: string;
    readonly caseVersion: number;
  },
): Promise<Outcome<Proposal>> {
  const allowed = authorize(principal, 'case.propose');
  if (!allowed.ok) return allowed;

  const rationale = input.rationale.trim();
  if (rationale.length < 20) {
    return reject('STATEMENT_TOO_SHORT', FAILURE_COPY.STATEMENT_TOO_SHORT.reason);
  }

  const { rows } = await tx.query(
    `SELECT ${CASE_COLUMNS} FROM sandbox.dispute_case WHERE case_id = $1 FOR UPDATE`,
    [input.caseId],
  );
  if (rows[0] === undefined) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);
  const kase = mapCase(rows[0]);

  if (!(ACTIVE_CASE_STATES as readonly string[]).includes(kase.state)) {
    return reject('CASE_TERMINAL', FAILURE_COPY.CASE_TERMINAL.reason);
  }
  // Optimistic concurrency: a proposal is made against a version of the
  // facts, and if those moved the operator has not seen what they think.
  if (kase.version !== input.caseVersion) {
    return reject('CASE_STALE', FAILURE_COPY.CASE_STALE.reason, {
      expected: kase.version,
      received: input.caseVersion,
    });
  }

  /*
   * A DISPOSITION NEEDS A LIVE LOCK TO DISPOSE OF.
   *
   * Checked at proposal time so an operator is not asked to approve
   * something that cannot execute — and checked AGAIN at approval,
   * because the lock can move in between and only the approval moves
   * money.
   */
  const lock = await lockForDeal(kase.dealId);
  if (lock === null || lock.state !== 'LOCKED') {
    return reject('VALUE_NOT_LOCKED', FAILURE_COPY.VALUE_NOT_LOCKED.reason, {
      dealId: kase.dealId,
    });
  }

  const { rows: live } = await tx.query(
    `SELECT proposal_id FROM sandbox.dispute_proposal
      WHERE case_id = $1 AND state = 'PROPOSED'`,
    [input.caseId],
  );
  if (live[0]) {
    return reject('PROPOSAL_EXISTS', FAILURE_COPY.PROPOSAL_EXISTS.reason, {
      proposalId: live[0].proposal_id as string,
    });
  }

  const inserted = await tx.query(
    `INSERT INTO sandbox.dispute_proposal
       (case_id, proposed_by, disposition, rationale, case_version)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING proposal_id, case_id, proposed_by, disposition, rationale,
               case_version, state`,
    [input.caseId, principal.userId, input.disposition, rationale, kase.version],
  );

  // Picking a case up is itself a state change, and it bumps the
  // version — which is what makes a second, concurrent proposal stale.
  await tx.query(
    `UPDATE sandbox.dispute_case
        SET state = CASE WHEN state = 'OPEN' THEN 'UNDER_REVIEW'::sandbox.case_state ELSE state END,
            version = version + 1
      WHERE case_id = $1`,
    [input.caseId],
  );

  return accept(mapProposal(inserted.rows[0]!));
}

/* ------------------------------------------------------------------ *
 * Rejecting a proposal
 * ------------------------------------------------------------------ */

export async function rejectProposal(
  tx: Tx,
  principal: Principal,
  input: { readonly proposalId: string; readonly note: string },
): Promise<Outcome<Proposal>> {
  const allowed = authorize(principal, 'case.approve');
  if (!allowed.ok) return allowed;

  const { rows } = await tx.query(
    `SELECT proposal_id, case_id, proposed_by, disposition, rationale, case_version, state
       FROM sandbox.dispute_proposal WHERE proposal_id = $1 FOR UPDATE`,
    [input.proposalId],
  );
  if (rows[0] === undefined)
    return reject('PROPOSAL_NOT_FOUND', FAILURE_COPY.PROPOSAL_NOT_FOUND.reason);
  const proposal = mapProposal(rows[0]);
  if (proposal.state !== 'PROPOSED') {
    return reject('PROPOSAL_NOT_FOUND', FAILURE_COPY.PROPOSAL_NOT_FOUND.reason);
  }

  /*
   * A checker may REJECT their own proposal.
   *
   * The maker-checker rule protects against one person unilaterally
   * moving money; withdrawing a proposal moves nothing, and forcing an
   * operator to find a colleague to retract their own mistake would make
   * the safe action the inconvenient one.
   */
  await tx.query(
    `UPDATE sandbox.dispute_proposal
        SET state='REJECTED', approved_by=NULL, decided_at=now(), decision_note=$2
      WHERE proposal_id=$1 AND state='PROPOSED'`,
    [input.proposalId, input.note.trim().slice(0, 4000)],
  );
  await tx.query(`UPDATE sandbox.dispute_case SET version = version + 1 WHERE case_id = $1`, [
    proposal.caseId,
  ]);

  return accept({ ...proposal, state: 'REJECTED' });
}

/* ------------------------------------------------------------------ *
 * Approving — the only place value moves
 * ------------------------------------------------------------------ */

export interface RulingResult {
  readonly caseId: string;
  readonly proposalId: string;
  readonly disposition: Disposition;
  readonly dealState: string;
  readonly lockState: string;
  readonly settleEntryId: string | null;
}

/**
 * Approve a proposal and execute it.
 *
 * Everything below happens in the caller's ONE transaction: the case
 * resolution, the proposal decision, the deal transition, the DEL-04
 * release or refund with its ledger entry, and — through the boundary
 * context the caller holds — the audit and outbox rows.
 */
export async function approveResolution(
  tx: Tx,
  principal: Principal,
  input: {
    readonly proposalId: string;
    readonly commandId: string;
    readonly note?: string;
  },
): Promise<Outcome<RulingResult>> {
  /*
   * AUTHORITY IS RE-CHECKED HERE, AT EXECUTION.
   *
   * Not when the case was opened, not when the proposal was made. An
   * approver whose role was revoked, or whose session never proved a
   * second factor, has no authority to lend this decision no matter what
   * was true when the screen was rendered.
   */
  const allowed = authorize(principal, 'case.approve');
  if (!allowed.ok) return allowed;

  const { rows: proposalRows } = await tx.query(
    `SELECT proposal_id, case_id, proposed_by, disposition, rationale, case_version, state
       FROM sandbox.dispute_proposal WHERE proposal_id = $1 FOR UPDATE`,
    [input.proposalId],
  );
  if (proposalRows[0] === undefined) {
    return reject('PROPOSAL_NOT_FOUND', FAILURE_COPY.PROPOSAL_NOT_FOUND.reason);
  }
  const proposal = mapProposal(proposalRows[0]);

  if (proposal.state !== 'PROPOSED') {
    /*
     * Already decided. Two checkers clicking approve at the same instant
     * both hold `FOR UPDATE` in turn; the second arrives here and finds
     * the decision made. Exactly one execution, decided by the database.
     */
    return reject('PROPOSAL_NOT_FOUND', FAILURE_COPY.PROPOSAL_NOT_FOUND.reason, {
      state: proposal.state,
    });
  }

  // THE MAKER-CHECKER RULE. The CHECK constraint enforces it too; this
  // is the version that produces a sentence the operator can act on.
  if (proposal.proposedBy === principal.userId) {
    return reject('SELF_APPROVAL_FORBIDDEN', FAILURE_COPY.SELF_APPROVAL_FORBIDDEN.reason);
  }

  const { rows: caseRows } = await tx.query(
    `SELECT ${CASE_COLUMNS} FROM sandbox.dispute_case WHERE case_id = $1 FOR UPDATE`,
    [proposal.caseId],
  );
  const kase = mapCase(caseRows[0]!);

  if (!(ACTIVE_CASE_STATES as readonly string[]).includes(kase.state)) {
    return reject('CASE_TERMINAL', FAILURE_COPY.CASE_TERMINAL.reason);
  }
  /*
   * The proposal must still describe the case it was made against.
   *
   * `proposeResolution` bumps the version, so a freshly made proposal is
   * exactly one behind. Anything else means the case moved since — a
   * second proposal, a rejection, new facts — and the approver would be
   * ratifying reasoning that no longer applies.
   */
  if (kase.version !== proposal.caseVersion + 1) {
    return reject('PROPOSAL_STALE', FAILURE_COPY.PROPOSAL_STALE.reason, {
      caseVersion: kase.version,
      proposedAgainst: proposal.caseVersion,
    });
  }

  /*
   * THE DEL-08 GATE.
   *
   * A ruling disposes of customer value, so a hold on the deal or a
   * paused SETTLEMENT scope stops it — even with a valid proposal and a
   * valid approver. Risk cannot APPROVE anything here; it can only
   * refuse, which is the only direction a control plane should move a
   * money decision.
   */
  {
    const { enforce } = await import('@/server/risk/engine');
    const gate = await enforce(tx, {
      point: 'DISPUTE_RESOLVE',
      subjectKind: 'deal',
      subjectId: kase.dealId,
      actorId: principal.userId,
      commandId: input.commandId,
      signals: { disposition: proposal.disposition },
    });
    if (!gate.ok) return gate;
  }

  /* ---- The disposition needs something real to dispose of ---- */

  const lock = await lockForDeal(kase.dealId);
  if (lock === null || lock.state !== 'LOCKED') {
    return reject('VALUE_NOT_LOCKED', FAILURE_COPY.VALUE_NOT_LOCKED.reason, {
      dealId: kase.dealId,
    });
  }

  const { rows: seats } = await tx.query(
    `SELECT user_id, role FROM sandbox.participant WHERE deal_id = $1`,
    [kase.dealId],
  );
  const counterparty = seats.find((s) => s.user_id !== lock.ownerId);
  if (counterparty === undefined) {
    return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);
  }

  /*
   * RELEASE hands the locked value to the counterparty; REFUND returns
   * it to the person who locked it. Both go through the accepted DEL-04
   * boundary, so the ledger entry, the zero-sum check and the
   * non-negative balance guarantee are the same ones DEL-04 proved —
   * this stage adds no second way to move value.
   */
  const settled =
    proposal.disposition === 'RELEASE'
      ? await releaseDealValue(tx, {
          dealId: kase.dealId,
          beneficiaryId: counterparty.user_id as string,
          commandId: input.commandId,
        })
      : await refundDealValue(tx, {
          dealId: kase.dealId,
          beneficiaryId: lock.ownerId,
          commandId: input.commandId,
        });

  if (!settled.ok) return settled;

  await tx.query(
    `UPDATE sandbox.dispute_proposal
        SET state='APPROVED', approved_by=$2, decided_at=now(), decision_note=$3
      WHERE proposal_id=$1 AND state='PROPOSED'`,
    [input.proposalId, principal.userId, (input.note ?? '').trim().slice(0, 4000) || null],
  );

  await tx.query(
    `UPDATE sandbox.dispute_case
        SET state='RESOLVED', disposition=$2, resolved_by_proposal=$3,
            resolution_note=$4, resolved_at=now(), version=version+1
      WHERE case_id=$1`,
    [proposal.caseId, proposal.disposition, input.proposalId, proposal.rationale],
  );

  // Any other outstanding proposal on this case is now moot, and saying
  // so explicitly keeps the history readable.
  await tx.query(
    `UPDATE sandbox.dispute_proposal
        SET state='SUPERSEDED', decided_at=now(),
            decision_note='Another proposal was approved first.'
      WHERE case_id=$1 AND state='PROPOSED' AND proposal_id <> $2`,
    [proposal.caseId, input.proposalId],
  );

  /*
   * The deal's terminal state follows the disposition.
   *
   * RELEASE completes it — the counterparty received the value. REFUND
   * cancels it — the value went back and nothing was exchanged.
   * `deal_completed_at` requires `completed_at` exactly when COMPLETED,
   * so the two branches are not interchangeable.
   */
  const dealState = proposal.disposition === 'RELEASE' ? 'COMPLETED' : 'CANCELLED';
  await tx.query(
    `UPDATE sandbox.deal
        SET state = $2::sandbox.deal_state,
            completed_at = CASE WHEN $3 THEN now() ELSE completed_at END,
            action_deadline = NULL,
            version = version + 1
      WHERE deal_id = $1`,
    [kase.dealId, dealState, dealState === 'COMPLETED'],
  );

  // A SYSTEM line, so both parties see the outcome in the room itself.
  await tx.query(
    `INSERT INTO sandbox.deal_message (deal_id, author_id, kind, body)
     VALUES ($1, NULL, 'SYSTEM', $2)`,
    [
      kase.dealId,
      `Dispute resolved · ${proposal.disposition.toLowerCase()}. ${proposal.rationale}`.slice(
        0,
        2000,
      ),
    ],
  );

  return accept({
    caseId: proposal.caseId,
    proposalId: input.proposalId,
    disposition: proposal.disposition,
    dealState,
    lockState: settled.value.state,
    settleEntryId: settled.value.settleEntryId,
  });
}

/* ------------------------------------------------------------------ *
 * Private operator notes
 * ------------------------------------------------------------------ */

export async function addCaseNote(
  tx: Tx,
  principal: Principal,
  input: { readonly caseId: string; readonly body: string },
): Promise<Outcome<{ noteId: string }>> {
  const allowed = authorize(principal, 'case.read');
  if (!allowed.ok) return allowed;

  const body = input.body.trim();
  if (body.length === 0) return reject('MESSAGE_EMPTY', FAILURE_COPY.MESSAGE_EMPTY.reason);
  if (body.length > 4000) return reject('MESSAGE_TOO_LONG', FAILURE_COPY.MESSAGE_TOO_LONG.reason);

  const { rows } = await tx.query(
    `INSERT INTO sandbox.case_note (case_id, author_id, body) VALUES ($1,$2,$3)
     RETURNING note_id`,
    [input.caseId, principal.userId, body],
  );
  return accept({ noteId: rows[0]!.note_id as string });
}

/**
 * Read the private notes.
 *
 * There is no participant-facing caller for this function anywhere, and
 * the permission check makes that structural rather than a convention.
 */
export async function caseNotes(
  principal: Principal,
  caseId: string,
): Promise<Outcome<readonly { noteId: string; authorId: string; body: string }[]>> {
  const allowed = authorize(principal, 'case.read');
  if (!allowed.ok) return allowed;

  const { rows } = await getPool().query(
    `SELECT note_id, author_id, body FROM sandbox.case_note
      WHERE case_id = $1 ORDER BY created_at`,
    [caseId],
  );
  return accept(
    rows.map((r) => ({
      noteId: r.note_id as string,
      authorId: r.author_id as string,
      body: r.body as string,
    })),
  );
}

/* ------------------------------------------------------------------ *
 * The operator queue
 * ------------------------------------------------------------------ */

export interface CaseQueueRow {
  readonly caseId: string;
  readonly dealId: string;
  readonly category: CaseCategory;
  readonly state: CaseState;
  readonly version: number;
  readonly waitingMinutes: number;
  readonly hasLiveProposal: boolean;
  readonly evidenceCount: number;
}

export async function caseQueue(principal: Principal): Promise<Outcome<readonly CaseQueueRow[]>> {
  // Checked BEFORE the first row is read, so a denied caller's response
  // never contained the data at all.
  const allowed = authorize(principal, 'case.queue.read');
  if (!allowed.ok) return allowed;

  const { rows } = await getPool().query(
    `SELECT c.case_id, c.deal_id, c.category, c.state, c.version,
            EXTRACT(EPOCH FROM (now() - c.opened_at))/60 AS waiting_minutes,
            EXISTS (SELECT 1 FROM sandbox.dispute_proposal p
                     WHERE p.case_id = c.case_id AND p.state = 'PROPOSED') AS has_live_proposal,
            (SELECT count(*) FROM sandbox.evidence_object e
              WHERE e.deal_id = c.deal_id AND e.state = 'READY')          AS evidence_count
       FROM sandbox.dispute_case c
      WHERE c.state IN ('OPEN','UNDER_REVIEW')
      ORDER BY c.opened_at`,
  );

  return accept(
    rows.map((r) => ({
      caseId: r.case_id as string,
      dealId: r.deal_id as string,
      category: r.category as CaseCategory,
      state: r.state as CaseState,
      version: r.version as number,
      waitingMinutes: Math.floor(Number(r.waiting_minutes)),
      hasLiveProposal: r.has_live_proposal as boolean,
      evidenceCount: Number(r.evidence_count),
    })),
  );
}
