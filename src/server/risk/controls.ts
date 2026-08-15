import 'server-only';
import { getPool, type Tx } from '@/server/db/pool';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { denialFor, type Principal } from '@/server/identity/rbac';
import { approvedPayload, propose } from './cases';
import type { ControlScope as EngineControlScope } from './engine';

/**
 * Emergency controls, and releasing a hold.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  ASYMMETRIC, ON PURPOSE: ONE PERSON STOPS, TWO PEOPLE START.       │
 * │                                                                    │
 * │  Pausing is the SAFE direction. An incident at 03:00 must not wait │
 * │  for a colleague to wake up, so one authorised operator pauses     │
 * │  immediately.                                                      │
 * │                                                                    │
 * │  RESUMING puts customer money back in motion, so it needs a second │
 * │  authorised person — and `control_switch_two_person_resume` refuses│
 * │  the same principal for both halves even if this code were wrong.  │
 * │                                                                    │
 * │  Neither direction touches a ledger entry, a payment record or a   │
 * │  deal. A pause stops NEW work; it never rewrites finished work.    │
 * └────────────────────────────────────────────────────────────────────┘
 */

export type ControlScope = EngineControlScope;

export interface ControlSwitch {
  readonly switchId: string;
  readonly scope: ControlScope;
  readonly target: string | null;
  readonly paused: boolean;
  readonly reason: string;
}

export async function pause(
  tx: Tx,
  principal: Principal,
  input: {
    readonly scope: ControlScope;
    readonly target?: string | null;
    readonly reason: string;
  },
): Promise<Outcome<ControlSwitch>> {
  if (denialFor(principal, 'control.pause') !== null) {
    return reject('PERMISSION_DENIED', FAILURE_COPY.PERMISSION_DENIED.reason);
  }
  const reason = input.reason.trim();
  if (reason.length < 10) {
    return reject('STATEMENT_TOO_SHORT', FAILURE_COPY.STATEMENT_TOO_SHORT.reason);
  }

  /*
   * `ON CONFLICT DO NOTHING` against the live-pause index: pausing an
   * already-paused scope is a no-op that returns the existing switch
   * rather than an error. Somebody hitting the button twice during an
   * incident must not see a failure.
   */
  const { rows } = await tx.query(
    `INSERT INTO sandbox.control_switch (scope, target, reason, paused_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING
     RETURNING switch_id, scope, target, paused, reason`,
    [input.scope, input.target ?? null, reason, principal.userId],
  );
  if (rows[0]) return accept(mapSwitch(rows[0]));

  const { rows: existing } = await tx.query(
    `SELECT switch_id, scope, target, paused, reason FROM sandbox.control_switch
      WHERE scope = $1 AND target IS NOT DISTINCT FROM $2 AND paused`,
    [input.scope, input.target ?? null],
  );
  return accept(mapSwitch(existing[0]!));
}

/**
 * Resume, with an approval from somebody else.
 *
 * The approval is verified here rather than trusted from the caller:
 * `approvedPayload` re-reads it and requires it to be APPROVED and to
 * name this exact switch. Both authorities are checked at execution, so
 * a revoked grant between proposal and resume denies the resume.
 */
export async function resume(
  tx: Tx,
  principal: Principal,
  input: {
    readonly switchId: string;
    readonly approvalId: string;
    readonly reason: string;
  },
): Promise<Outcome<ControlSwitch>> {
  if (denialFor(principal, 'control.pause') !== null) {
    return reject('PERMISSION_DENIED', FAILURE_COPY.PERMISSION_DENIED.reason);
  }

  const payload = await approvedPayload(tx, input.approvalId, 'CORRIDOR_RESUME', input.switchId);
  if (payload === null) {
    return reject('APPROVAL_REQUIRED', FAILURE_COPY.APPROVAL_REQUIRED.reason);
  }

  const { rows: approval } = await tx.query(
    `SELECT approved_by, proposed_by FROM sandbox.ops_approval WHERE approval_id = $1`,
    [input.approvalId],
  );
  const approvedBy = approval[0]?.approved_by as string | undefined;
  if (approvedBy === undefined) {
    return reject('APPROVAL_REQUIRED', FAILURE_COPY.APPROVAL_REQUIRED.reason);
  }
  /*
   * TWO DIFFERENT PEOPLE. The resumer and the approver cannot be the
   * same, and the CHECK constraint refuses it independently — so even a
   * bug here cannot produce a one-person resume.
   */
  if (approvedBy === principal.userId) {
    return reject('SELF_APPROVAL_FORBIDDEN', FAILURE_COPY.SELF_APPROVAL_FORBIDDEN.reason);
  }

  const { rows } = await tx.query(
    `UPDATE sandbox.control_switch
        SET paused=FALSE, resumed_by=$2, resume_approved_by=$3, resumed_at=now(),
            resume_reason=$4
      WHERE switch_id=$1 AND paused
      RETURNING switch_id, scope, target, paused, reason`,
    [input.switchId, principal.userId, approvedBy, input.reason.trim().slice(0, 1000)],
  );
  if (rows[0] === undefined) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);
  return accept(mapSwitch(rows[0]));
}

function mapSwitch(r: Record<string, unknown>): ControlSwitch {
  return {
    switchId: r.switch_id as string,
    scope: r.scope as ControlScope,
    target: (r.target as string | null) ?? null,
    paused: r.paused as boolean,
    reason: r.reason as string,
  };
}

/** Everything currently paused. Read live; never cached. */
export async function pausedControls(): Promise<readonly ControlSwitch[]> {
  const { rows } = await getPool().query(
    `SELECT switch_id, scope, target, TRUE AS paused, reason FROM sandbox.control_status`,
  );
  return rows.map(mapSwitch);
}

/* ------------------------------------------------------------------ *
 * Releasing a hold
 * ------------------------------------------------------------------ */

/**
 * Release a risk hold, with a second person's approval.
 *
 * Releasing a hold is the moment somebody's money becomes movable again,
 * so it is a two-person action for the same reason a dispute ruling is.
 * A hold placed automatically can be released only deliberately.
 */
export async function releaseHold(
  tx: Tx,
  principal: Principal,
  input: {
    readonly holdId: string;
    readonly approvalId: string;
    readonly reason: string;
  },
): Promise<Outcome<{ holdId: string }>> {
  if (denialFor(principal, 'risk.case.work') !== null) {
    return reject('PERMISSION_DENIED', FAILURE_COPY.PERMISSION_DENIED.reason);
  }
  const reason = input.reason.trim();
  if (reason.length < 10) {
    return reject('STATEMENT_TOO_SHORT', FAILURE_COPY.STATEMENT_TOO_SHORT.reason);
  }

  const payload = await approvedPayload(tx, input.approvalId, 'HOLD_RELEASE', input.holdId);
  if (payload === null) {
    return reject('APPROVAL_REQUIRED', FAILURE_COPY.APPROVAL_REQUIRED.reason);
  }
  const { rows: approval } = await tx.query(
    `SELECT approved_by FROM sandbox.ops_approval WHERE approval_id = $1`,
    [input.approvalId],
  );
  if ((approval[0]?.approved_by as string | undefined) === principal.userId) {
    return reject('SELF_APPROVAL_FORBIDDEN', FAILURE_COPY.SELF_APPROVAL_FORBIDDEN.reason);
  }

  const { rowCount } = await tx.query(
    `UPDATE sandbox.risk_hold
        SET active=FALSE, released_by=$2, released_at=now(), release_reason=$3
      WHERE hold_id=$1 AND active`,
    [input.holdId, principal.userId, reason],
  );
  if (rowCount === 0) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);
  return accept({ holdId: input.holdId });
}

export { propose };
