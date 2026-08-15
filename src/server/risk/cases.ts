import 'server-only';
import { getPool, type Tx } from '@/server/db/pool';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { denialFor, type Permission, type Principal } from '@/server/identity/rbac';

/**
 * Operational cases, queues and two-person approvals.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  SEPARATE FROM `dispute_case`, DELIBERATELY.                       │
 * │                                                                    │
 * │  A dispute is between two customers about a deal and both of them  │
 * │  can read it. An operational case is the PLATFORM investigating    │
 * │  something — possibly one of those customers. Putting an           │
 * │  account-takeover investigation in the deal room would show it to  │
 * │  the person being investigated.                                    │
 * │                                                                    │
 * │  So: two tables, two access models, and no participant-facing read │
 * │  path in this file at all.                                         │
 * └────────────────────────────────────────────────────────────────────┘
 */

export type CaseKind =
  | 'IDENTITY_REVIEW'
  | 'TRANSACTION_ALERT'
  | 'PAYMENT_ANOMALY'
  | 'ACCOUNT_TAKEOVER'
  | 'REWARD_ABUSE'
  | 'RAIL_INCIDENT'
  | 'POST_SETTLEMENT_COMPLAINT'
  | 'EVIDENCE_INCIDENT'
  | 'OPERATOR_SECURITY';

export type OpsCaseState = 'OPEN' | 'ASSIGNED' | 'ESCALATED' | 'RESOLVED' | 'CLOSED';

export type Disposition =
  | 'NO_ACTION'
  | 'CONFIRMED_ABUSE'
  | 'FALSE_POSITIVE'
  | 'ESCALATED_EXTERNAL'
  | 'CUSTOMER_CONTACTED'
  | 'CONTROL_APPLIED';

export interface OpsCase {
  readonly opsCaseId: string;
  readonly kind: CaseKind;
  readonly state: OpsCaseState;
  readonly priority: number;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly summary: string;
  readonly reasonCodes: readonly string[];
  readonly version: number;
  readonly assignedTo: string | null;
}

const CASE_COLUMNS = `ops_case_id, kind, state, priority, subject_kind, subject_id,
  summary, reason_codes, version, assigned_to`;

function mapCase(r: Record<string, unknown>): OpsCase {
  return {
    opsCaseId: r.ops_case_id as string,
    kind: r.kind as CaseKind,
    state: r.state as OpsCaseState,
    priority: Number(r.priority),
    subjectKind: r.subject_kind as string,
    subjectId: r.subject_id as string,
    summary: r.summary as string,
    reasonCodes: (r.reason_codes as string[]) ?? [],
    version: Number(r.version),
    assignedTo: (r.assigned_to as string | null) ?? null,
  };
}

function authorize(principal: Principal, permission: Permission): Outcome<null> {
  const denial = denialFor(principal, permission);
  if (denial === null) return accept(null);
  if (denial === 'MFA_REQUIRED') return reject('MFA_REQUIRED', FAILURE_COPY.MFA_REQUIRED.reason);
  if (denial === 'MFA_NOT_ENROLLED') {
    return reject('MFA_NOT_ENROLLED', FAILURE_COPY.MFA_NOT_ENROLLED.reason);
  }
  return reject('PERMISSION_DENIED', FAILURE_COPY.PERMISSION_DENIED.reason);
}

/* ------------------------------------------------------------------ *
 * Opening and correlating
 * ------------------------------------------------------------------ */

/** Default SLA by priority, in minutes. Higher priority, tighter clock. */
function slaMinutes(priority: number): number {
  if (priority >= 90) return 60;
  if (priority >= 70) return 240;
  return 1440;
}

/**
 * Open a case, or join the one already covering this.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  CORRELATION IS NOT TIDINESS — IT IS HOW SIGNALS GET SEEN.         │
 * │                                                                    │
 * │  Fifty rows for one incident is a queue nobody works, and a real   │
 * │  alert buried in it is an alert that was effectively never raised. │
 * │  `correlation_key` is derived by the CALLER from the underlying    │
 * │  thing, and the partial unique index decides the race.             │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function openCase(
  tx: Tx,
  input: {
    readonly kind: CaseKind;
    readonly subjectKind: string;
    readonly subjectId: string;
    readonly correlationKey: string;
    readonly summary: string;
    readonly reasonCodes?: readonly string[];
    readonly priority?: number;
  },
): Promise<Outcome<{ opsCase: OpsCase; created: boolean }>> {
  const priority = Math.min(Math.max(input.priority ?? 50, 1), 100);

  const { rows } = await tx.query(
    `INSERT INTO sandbox.ops_case
       (kind, subject_kind, subject_id, correlation_key, summary, reason_codes,
        priority, sla_due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(mins => $8))
     ON CONFLICT DO NOTHING
     RETURNING ${CASE_COLUMNS}`,
    [
      input.kind,
      input.subjectKind,
      input.subjectId,
      input.correlationKey,
      input.summary.slice(0, 2000),
      input.reasonCodes ?? [],
      priority,
      slaMinutes(priority),
    ],
  );

  if (rows[0]) {
    await recordAction(tx, {
      opsCaseId: rows[0].ops_case_id as string,
      actorId: null,
      action: 'OPENED',
      detail: { reasonCodes: input.reasonCodes ?? [] },
    });
    return accept({ opsCase: mapCase(rows[0]), created: true });
  }

  const { rows: existing } = await tx.query(
    `SELECT ${CASE_COLUMNS} FROM sandbox.ops_case
      WHERE correlation_key = $1 AND state IN ('OPEN','ASSIGNED','ESCALATED')`,
    [input.correlationKey],
  );
  if (existing[0] === undefined) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);

  // A repeat signal is recorded ON the existing case, so the timeline
  // shows it recurred rather than losing the observation entirely.
  await recordAction(tx, {
    opsCaseId: existing[0].ops_case_id as string,
    actorId: null,
    action: 'CORRELATED',
    detail: { reasonCodes: input.reasonCodes ?? [] },
  });
  return accept({ opsCase: mapCase(existing[0]), created: false });
}

export async function recordAction(
  tx: Tx,
  input: {
    readonly opsCaseId: string;
    readonly actorId: string | null;
    readonly action: string;
    readonly detail?: Record<string, unknown>;
    readonly internal?: boolean;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO sandbox.ops_case_action (ops_case_id, actor_id, action, detail, internal)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      input.opsCaseId,
      input.actorId,
      input.action,
      JSON.stringify(input.detail ?? {}),
      input.internal ?? true,
    ],
  );
}

/* ------------------------------------------------------------------ *
 * Working a case
 * ------------------------------------------------------------------ */

/** How long an operator holds a case before the lease lapses. */
export const LEASE_MINUTES = 30;

/**
 * Claim a case.
 *
 * The lease is BOUNDED, and that is the point: an operator who takes a
 * case and goes home must not hold it forever. The conditional UPDATE
 * — unassigned, or assigned to me, or the lease has lapsed — is what
 * makes two operators clicking at once produce one winner, decided by
 * the database rather than by whoever's request arrived first.
 */
export async function claimCase(
  tx: Tx,
  principal: Principal,
  input: { readonly opsCaseId: string; readonly expectedVersion?: number },
): Promise<Outcome<OpsCase>> {
  const allowed = authorize(principal, 'risk.case.work');
  if (!allowed.ok) return allowed;

  const { rows } = await tx.query(
    `UPDATE sandbox.ops_case
        SET assigned_to = $2,
            state = CASE WHEN state = 'OPEN' THEN 'ASSIGNED'::sandbox.ops_case_state
                         ELSE state END,
            lease_expires_at = now() + make_interval(mins => $3),
            version = version + 1
      WHERE ops_case_id = $1
        AND state IN ('OPEN','ASSIGNED','ESCALATED')
        AND (assigned_to IS NULL OR assigned_to = $2 OR lease_expires_at < now())
        AND ($4::int IS NULL OR version = $4)
      RETURNING ${CASE_COLUMNS}`,
    [input.opsCaseId, principal.userId, LEASE_MINUTES, input.expectedVersion ?? null],
  );

  if (rows[0] === undefined) {
    return reject('CASE_LEASE_LOST', FAILURE_COPY.CASE_LEASE_LOST.reason);
  }
  await recordAction(tx, {
    opsCaseId: input.opsCaseId,
    actorId: principal.userId,
    action: 'CLAIMED',
  });
  return accept(mapCase(rows[0]));
}

export async function addNote(
  tx: Tx,
  principal: Principal,
  input: { readonly opsCaseId: string; readonly body: string },
): Promise<Outcome<{ ok: true }>> {
  const allowed = authorize(principal, 'risk.case.read');
  if (!allowed.ok) return allowed;

  const body = input.body.trim();
  if (body.length === 0) return reject('MESSAGE_EMPTY', FAILURE_COPY.MESSAGE_EMPTY.reason);

  // `internal: true` — a note is never returned to a participant, and
  // that is a property of the row rather than of every read that must
  // remember to exclude it.
  await recordAction(tx, {
    opsCaseId: input.opsCaseId,
    actorId: principal.userId,
    action: 'NOTE',
    detail: { body: body.slice(0, 4000) },
    internal: true,
  });
  return accept({ ok: true });
}

/**
 * Resolve a case.
 *
 * A case whose disposition AFFECTS VALUE — confirmed abuse, a control
 * applied — requires an approved two-person `ops_approval`. Closing an
 * investigation that takes something away from a customer is not a
 * one-person decision, for the same reason a dispute ruling is not.
 */
export async function resolveCase(
  tx: Tx,
  principal: Principal,
  input: {
    readonly opsCaseId: string;
    readonly disposition: Disposition;
    readonly note: string;
    readonly expectedVersion: number;
    readonly approvalId?: string | null;
  },
): Promise<Outcome<OpsCase>> {
  const allowed = authorize(principal, 'risk.case.work');
  if (!allowed.ok) return allowed;

  const note = input.note.trim();
  if (note.length < 10) {
    return reject('STATEMENT_TOO_SHORT', FAILURE_COPY.STATEMENT_TOO_SHORT.reason);
  }

  const valueAffecting =
    input.disposition === 'CONFIRMED_ABUSE' || input.disposition === 'CONTROL_APPLIED';

  if (valueAffecting) {
    if (!input.approvalId) {
      return reject('APPROVAL_REQUIRED', FAILURE_COPY.APPROVAL_REQUIRED.reason, {
        disposition: input.disposition,
      });
    }
    const { rows } = await tx.query(
      `SELECT state, target_ref FROM sandbox.ops_approval
        WHERE approval_id = $1 AND action_kind = 'CASE_CLOSE_VALUE'`,
      [input.approvalId],
    );
    if (
      rows[0] === undefined ||
      rows[0].state !== 'APPROVED' ||
      rows[0].target_ref !== input.opsCaseId
    ) {
      return reject('APPROVAL_REQUIRED', FAILURE_COPY.APPROVAL_REQUIRED.reason);
    }
  }

  const { rows } = await tx.query(
    `UPDATE sandbox.ops_case
        SET state='RESOLVED', disposition=$2, disposition_note=$3,
            resolved_at=now(), version=version+1
      WHERE ops_case_id=$1 AND version=$4
        AND state IN ('OPEN','ASSIGNED','ESCALATED')
      RETURNING ${CASE_COLUMNS}`,
    [input.opsCaseId, input.disposition, note.slice(0, 4000), input.expectedVersion],
  );
  if (rows[0] === undefined) {
    return reject('CASE_STALE', FAILURE_COPY.CASE_STALE.reason);
  }

  await recordAction(tx, {
    opsCaseId: input.opsCaseId,
    actorId: principal.userId,
    action: 'RESOLVED',
    detail: { disposition: input.disposition },
  });
  return accept(mapCase(rows[0]));
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export interface QueueRow extends OpsCase {
  readonly overdue: boolean;
  readonly leaseExpired: boolean;
}

export async function queue(
  principal: Principal,
  options: {
    readonly kind?: CaseKind;
    readonly limit?: number;
    readonly after?: string | null;
  } = {},
): Promise<Outcome<readonly QueueRow[]>> {
  // Checked BEFORE the first row is read, so a denied caller's response
  // never contained the data at all.
  const allowed = authorize(principal, 'risk.queue.read');
  if (!allowed.ok) return allowed;

  const { rows } = await getPool().query(
    `SELECT ${CASE_COLUMNS}, overdue, lease_expired
       FROM sandbox.ops_queue
      WHERE ($1::sandbox.case_kind IS NULL OR kind = $1)
        AND ($2::uuid IS NULL OR ops_case_id > $2)
      ORDER BY priority DESC, opened_at, ops_case_id
      LIMIT $3`,
    [options.kind ?? null, options.after ?? null, Math.min(options.limit ?? 50, 200)],
  );
  return accept(
    rows.map((r) => ({
      ...mapCase(r),
      overdue: r.overdue as boolean,
      leaseExpired: r.lease_expired as boolean,
    })),
  );
}

export interface CaseTimelineEntry {
  readonly actionId: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly detail: Record<string, unknown>;
  readonly createdAt: string;
}

/**
 * A case with its full timeline, including internal notes.
 *
 * `risk.case.read` gated. There is no participant-facing variant of this
 * function anywhere, which is what keeps an investigator's working
 * hypothesis away from the person being investigated.
 */
export async function caseDetail(
  principal: Principal,
  opsCaseId: string,
): Promise<Outcome<{ opsCase: OpsCase; timeline: readonly CaseTimelineEntry[] }>> {
  const allowed = authorize(principal, 'risk.case.read');
  if (!allowed.ok) return allowed;

  const { rows } = await getPool().query(
    `SELECT ${CASE_COLUMNS} FROM sandbox.ops_case WHERE ops_case_id = $1`,
    [opsCaseId],
  );
  if (rows[0] === undefined) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);

  const { rows: actions } = await getPool().query(
    `SELECT action_id, actor_id, action, detail, created_at
       FROM sandbox.ops_case_action WHERE ops_case_id = $1 ORDER BY created_at`,
    [opsCaseId],
  );

  return accept({
    opsCase: mapCase(rows[0]),
    timeline: actions.map((a) => ({
      actionId: a.action_id as string,
      actorId: (a.actor_id as string | null) ?? null,
      action: a.action as string,
      detail: a.detail as Record<string, unknown>,
      createdAt: (a.created_at as Date).toISOString(),
    })),
  });
}

/* ------------------------------------------------------------------ *
 * Two-person approvals
 * ------------------------------------------------------------------ */

export type ApprovalKind =
  | 'RISK_POLICY_ACTIVATE'
  | 'CORRIDOR_RESUME'
  | 'LIMIT_INCREASE'
  | 'HOLD_RELEASE'
  | 'CASE_CLOSE_VALUE'
  | 'REWARD_CAMPAIGN_ACTIVATE';

/**
 * The permission each side of a two-person action needs.
 *
 * Maker and checker are DIFFERENT permissions, and for most actions they
 * sit on different roles — so the separation does not rest solely on
 * "these are two different people", which holds until somebody has two
 * accounts.
 */
const APPROVAL_PERMISSIONS: Readonly<
  Record<ApprovalKind, { propose: Permission; approve: Permission }>
> = {
  RISK_POLICY_ACTIVATE: { propose: 'risk.policy.propose', approve: 'risk.policy.approve' },
  CORRIDOR_RESUME: { propose: 'control.pause', approve: 'control.resume.approve' },
  LIMIT_INCREASE: { propose: 'risk.policy.propose', approve: 'risk.policy.approve' },
  HOLD_RELEASE: { propose: 'risk.case.work', approve: 'risk.policy.approve' },
  CASE_CLOSE_VALUE: { propose: 'risk.case.work', approve: 'risk.policy.approve' },
  REWARD_CAMPAIGN_ACTIVATE: { propose: 'reward.campaign.manage', approve: 'risk.policy.approve' },
};

export interface Approval {
  readonly approvalId: string;
  readonly actionKind: ApprovalKind;
  readonly targetRef: string;
  readonly state: 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED';
  readonly proposedBy: string;
}

export async function propose(
  tx: Tx,
  principal: Principal,
  input: {
    readonly actionKind: ApprovalKind;
    readonly targetRef: string;
    readonly rationale: string;
    readonly payload?: Record<string, unknown>;
  },
): Promise<Outcome<Approval>> {
  const allowed = authorize(principal, APPROVAL_PERMISSIONS[input.actionKind].propose);
  if (!allowed.ok) return allowed;

  const rationale = input.rationale.trim();
  if (rationale.length < 20) {
    return reject('STATEMENT_TOO_SHORT', FAILURE_COPY.STATEMENT_TOO_SHORT.reason);
  }

  const { rows } = await tx.query(
    `INSERT INTO sandbox.ops_approval
       (action_kind, target_ref, payload, rationale, proposed_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT DO NOTHING
     RETURNING approval_id, action_kind, target_ref, state, proposed_by`,
    [
      input.actionKind,
      input.targetRef,
      JSON.stringify(input.payload ?? {}),
      rationale,
      principal.userId,
    ],
  );
  if (rows[0] === undefined) {
    return reject('PROPOSAL_EXISTS', FAILURE_COPY.PROPOSAL_EXISTS.reason);
  }
  return accept({
    approvalId: rows[0].approval_id as string,
    actionKind: input.actionKind,
    targetRef: input.targetRef,
    state: 'PROPOSED',
    proposedBy: principal.userId,
  });
}

/**
 * Approve a proposal.
 *
 * Authority is re-checked HERE, at execution — an approver whose grant
 * was revoked since the screen rendered has none to lend. Self-approval
 * is refused by this code and, independently, by a CHECK constraint.
 */
export async function approve(
  tx: Tx,
  principal: Principal,
  input: { readonly approvalId: string; readonly note?: string },
): Promise<Outcome<Approval>> {
  const { rows } = await tx.query(
    `SELECT approval_id, action_kind, target_ref, state, proposed_by, payload
       FROM sandbox.ops_approval WHERE approval_id = $1 FOR UPDATE`,
    [input.approvalId],
  );
  const r = rows[0];
  if (r === undefined || r.state !== 'PROPOSED') {
    return reject('PROPOSAL_NOT_FOUND', FAILURE_COPY.PROPOSAL_NOT_FOUND.reason);
  }

  const actionKind = r.action_kind as ApprovalKind;
  const allowed = authorize(principal, APPROVAL_PERMISSIONS[actionKind].approve);
  if (!allowed.ok) return allowed;

  if ((r.proposed_by as string) === principal.userId) {
    return reject('SELF_APPROVAL_FORBIDDEN', FAILURE_COPY.SELF_APPROVAL_FORBIDDEN.reason);
  }

  await tx.query(
    `UPDATE sandbox.ops_approval
        SET state='APPROVED', approved_by=$2, decided_at=now(), decision_note=$3
      WHERE approval_id=$1 AND state='PROPOSED'`,
    [input.approvalId, principal.userId, (input.note ?? '').trim().slice(0, 4000) || null],
  );

  return accept({
    approvalId: input.approvalId,
    actionKind,
    targetRef: r.target_ref as string,
    state: 'APPROVED',
    proposedBy: r.proposed_by as string,
  });
}

/** The payload of an APPROVED proposal, for the executor that acts on it. */
export async function approvedPayload(
  tx: Tx,
  approvalId: string,
  actionKind: ApprovalKind,
  targetRef: string,
): Promise<Record<string, unknown> | null> {
  const { rows } = await tx.query(
    `SELECT payload FROM sandbox.ops_approval
      WHERE approval_id = $1 AND action_kind = $2 AND target_ref = $3 AND state = 'APPROVED'`,
    [approvalId, actionKind, targetRef],
  );
  return (rows[0]?.payload as Record<string, unknown> | undefined) ?? null;
}
