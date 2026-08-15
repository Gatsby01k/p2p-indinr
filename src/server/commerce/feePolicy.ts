import 'server-only';
import { getPool, toBigInt, type Tx } from '@/server/db/pool';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { deploymentMode } from '@/server/adapters/mode';
import { denialFor, type Permission, type Principal } from '@/server/identity/rbac';
import type { FeePolicyTerms } from '@/lib/feeMath';
import type { Scenario } from '@/lib/scenario';

/**
 * Fee policy: resolution, and activation under maker-checker.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  CHANGING A FEE SCHEDULE IS AT LEAST AS SERIOUS AS RULING ON A     │
 * │  DISPUTE, SO IT GETS THE SAME PROTECTION.                          │
 * │                                                                    │
 * │  One authorised person proposes an activation, a DIFFERENT one     │
 * │  approves it, and self-approval is refused by a CHECK constraint   │
 * │  as well as by this code. There is no email-prefix shortcut, no    │
 * │  cached boolean, and no path by which an ordinary web user reaches │
 * │  it at all.                                                        │
 * │                                                                    │
 * │  A policy is never edited. A new rate is a NEW VERSION, and the    │
 * │  old one stays readable forever because every quote issued under   │
 * │  it points at it.                                                  │
 * └────────────────────────────────────────────────────────────────────┘
 */

export interface FeePolicyRecord extends FeePolicyTerms {
  readonly policyId: string;
  readonly scenario: Scenario;
  readonly state: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  readonly productionEnabled: boolean;
  readonly effectiveFrom: string;
  readonly expiresAt: string | null;
}

const POLICY_COLUMNS = `policy_id, policy_key, version, scenario, fee_asset, fee_bearer,
  bps, fixed_minor, min_fee_minor, max_fee_minor, discount_cap_bps, state,
  production_enabled, effective_from, expires_at`;

function mapPolicy(r: Record<string, unknown>): FeePolicyRecord {
  return {
    policyId: r.policy_id as string,
    policyKey: r.policy_key as string,
    version: Number(r.version),
    scenario: r.scenario as Scenario,
    feeAsset: r.fee_asset as 'INR' | 'USDT',
    feeBearer: r.fee_bearer as 'PAYER' | 'PAYEE',
    bps: toBigInt(r.bps),
    fixedMinor: toBigInt(r.fixed_minor),
    minFeeMinor: toBigInt(r.min_fee_minor),
    maxFeeMinor: toBigInt(r.max_fee_minor),
    discountCapBps: toBigInt(r.discount_cap_bps),
    state: r.state as 'DRAFT' | 'ACTIVE' | 'RETIRED',
    productionEnabled: r.production_enabled as boolean,
    effectiveFrom: (r.effective_from as Date).toISOString(),
    expiresAt: r.expires_at === null ? null : (r.expires_at as Date).toISOString(),
  };
}

/**
 * The policy that prices this scenario right now.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  PRODUCTION FAILS CLOSED.                                          │
 * │                                                                    │
 * │  A production deployment with no activated, production-enabled     │
 * │  schedule does not fall back to a default, a constant, or the      │
 * │  sandbox policy. It refuses to quote. A guessed fee is worse than  │
 * │  no quote: the customer would be charged something nobody          │
 * │  approved.                                                         │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * The window is checked against the DATABASE clock, so a skewed
 * application server cannot bring a schedule forward.
 */
export async function activePolicyFor(
  tx: Tx,
  scenario: Scenario,
): Promise<Outcome<FeePolicyRecord>> {
  const production = deploymentMode() === 'PRODUCTION';

  const { rows } = await tx.query(
    `SELECT ${POLICY_COLUMNS} FROM sandbox.fee_policy
      WHERE scenario = $1 AND state = 'ACTIVE'
        AND effective_from <= now()
        AND (expires_at IS NULL OR expires_at > now())
        AND ($2::boolean = FALSE OR production_enabled = TRUE)
      ORDER BY effective_from DESC
      LIMIT 1`,
    [scenario, production],
  );

  if (rows[0] === undefined) {
    return reject('FEE_POLICY_UNAVAILABLE', FAILURE_COPY.FEE_POLICY_UNAVAILABLE.reason, {
      scenario,
      deployment: production ? 'PRODUCTION' : 'SANDBOX',
    });
  }
  return accept(mapPolicy(rows[0]));
}

export async function policyById(policyId: string): Promise<FeePolicyRecord | null> {
  const { rows } = await getPool().query(
    `SELECT ${POLICY_COLUMNS} FROM sandbox.fee_policy WHERE policy_id = $1`,
    [policyId],
  );
  return rows[0] ? mapPolicy(rows[0]) : null;
}

/** The publishable schedules. No drafts, no eligibility rules. */
export async function publicSchedules(): Promise<readonly FeePolicyRecord[]> {
  const { rows } = await getPool().query(
    `SELECT ${POLICY_COLUMNS} FROM sandbox.fee_policy WHERE state = 'ACTIVE'
      ORDER BY scenario, policy_key`,
  );
  return rows.map(mapPolicy);
}

/* ------------------------------------------------------------------ *
 * Authoring and activation
 * ------------------------------------------------------------------ */

function authorize(principal: Principal, permission: Permission): Outcome<null> {
  const denial = denialFor(principal, permission);
  if (denial === null) return accept(null);
  if (denial === 'MFA_REQUIRED') return reject('MFA_REQUIRED', FAILURE_COPY.MFA_REQUIRED.reason);
  if (denial === 'MFA_NOT_ENROLLED') {
    return reject('MFA_NOT_ENROLLED', FAILURE_COPY.MFA_NOT_ENROLLED.reason);
  }
  return reject('PERMISSION_DENIED', FAILURE_COPY.PERMISSION_DENIED.reason);
}

export interface DraftPolicyInput {
  readonly policyKey: string;
  readonly scenario: Scenario;
  readonly feeAsset: 'INR' | 'USDT';
  readonly feeBearer: 'PAYER' | 'PAYEE';
  readonly bps: bigint;
  readonly fixedMinor: bigint;
  readonly minFeeMinor: bigint;
  readonly maxFeeMinor: bigint;
  readonly discountCapBps: bigint;
  readonly productionEnabled?: boolean;
}

/**
 * Draft a new version of a schedule.
 *
 * Drafting is not activating: a DRAFT prices nothing and is invisible to
 * `activePolicyFor`. That separation is what lets a proposal be reviewed
 * against the real numbers before anybody is charged them.
 */
export async function draftPolicy(
  tx: Tx,
  principal: Principal,
  input: DraftPolicyInput,
): Promise<Outcome<FeePolicyRecord>> {
  const allowed = authorize(principal, 'fee.policy.draft');
  if (!allowed.ok) return allowed;

  if (input.bps < 0n || input.bps > 10_000n) {
    return reject('FEE_POLICY_INVALID', FAILURE_COPY.FEE_POLICY_INVALID.reason);
  }
  if (input.minFeeMinor < 0n || input.maxFeeMinor < input.minFeeMinor) {
    return reject('FEE_POLICY_INVALID', FAILURE_COPY.FEE_POLICY_INVALID.reason);
  }
  if (input.discountCapBps < 0n || input.discountCapBps > 10_000n) {
    return reject('FEE_POLICY_INVALID', FAILURE_COPY.FEE_POLICY_INVALID.reason);
  }
  /*
   * A non-custodial INR fee can be QUOTED but never collected, so it may
   * not be marked production-collectible. The schema refuses it too; this
   * is the version that gives the author a sentence.
   */
  if (input.feeAsset === 'INR' && input.productionEnabled === true) {
    return reject('FEE_ASSET_UNSUPPORTED', FAILURE_COPY.FEE_ASSET_UNSUPPORTED.reason);
  }

  const { rows } = await tx.query(
    `INSERT INTO sandbox.fee_policy
       (policy_key, version, scenario, fee_asset, fee_bearer, bps, fixed_minor,
        min_fee_minor, max_fee_minor, discount_cap_bps, state, production_enabled,
        effective_from, created_by)
     VALUES ($1,
             coalesce((SELECT max(version) + 1 FROM sandbox.fee_policy WHERE policy_key = $1), 1),
             $2,$3,$4,$5,$6,$7,$8,$9,'DRAFT',$10, now(), $11)
     RETURNING ${POLICY_COLUMNS}`,
    [
      input.policyKey,
      input.scenario,
      input.feeAsset,
      // SERVER-CONTROLLED, from the draft the operator authored — never
      // from a customer request, which has no field for it at all.
      input.feeBearer,
      input.bps.toString(),
      input.fixedMinor.toString(),
      input.minFeeMinor.toString(),
      input.maxFeeMinor.toString(),
      input.discountCapBps.toString(),
      input.productionEnabled ?? false,
      principal.userId,
    ],
  );
  return accept(mapPolicy(rows[0]!));
}

export interface Activation {
  readonly activationId: string;
  readonly policyId: string;
  readonly proposedBy: string;
  readonly state: 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED';
}

export async function proposeActivation(
  tx: Tx,
  principal: Principal,
  input: { readonly policyId: string; readonly rationale: string },
): Promise<Outcome<Activation>> {
  const allowed = authorize(principal, 'fee.policy.propose');
  if (!allowed.ok) return allowed;

  const rationale = input.rationale.trim();
  if (rationale.length < 20) {
    return reject('STATEMENT_TOO_SHORT', FAILURE_COPY.STATEMENT_TOO_SHORT.reason);
  }

  const { rows: policy } = await tx.query(
    `SELECT ${POLICY_COLUMNS} FROM sandbox.fee_policy WHERE policy_id = $1 FOR UPDATE`,
    [input.policyId],
  );
  if (policy[0] === undefined) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);
  if (policy[0].state !== 'DRAFT') {
    return reject('FEE_POLICY_INVALID', 'Only a draft schedule can be activated.');
  }

  const { rows: live } = await tx.query(
    `SELECT activation_id FROM sandbox.fee_policy_activation
      WHERE policy_id = $1 AND state = 'PROPOSED'`,
    [input.policyId],
  );
  if (live[0]) {
    return reject('PROPOSAL_EXISTS', FAILURE_COPY.PROPOSAL_EXISTS.reason);
  }

  const { rows } = await tx.query(
    `INSERT INTO sandbox.fee_policy_activation (policy_id, proposed_by, rationale)
     VALUES ($1,$2,$3)
     RETURNING activation_id, policy_id, proposed_by, state`,
    [input.policyId, principal.userId, rationale],
  );
  return accept({
    activationId: rows[0]!.activation_id as string,
    policyId: input.policyId,
    proposedBy: principal.userId,
    state: 'PROPOSED',
  });
}

/**
 * Approve an activation, and switch the schedule.
 *
 * The previous ACTIVE version of the same key is RETIRED in the same
 * transaction, so there is never a moment with two live schedules — and
 * the partial unique index would refuse it anyway.
 */
export async function approveActivation(
  tx: Tx,
  principal: Principal,
  input: { readonly activationId: string; readonly note?: string },
): Promise<Outcome<FeePolicyRecord>> {
  // Re-checked at EXECUTION. An approver whose grant was revoked since
  // the screen rendered has no authority to lend this.
  const allowed = authorize(principal, 'fee.policy.approve');
  if (!allowed.ok) return allowed;

  const { rows } = await tx.query(
    `SELECT activation_id, policy_id, proposed_by, state
       FROM sandbox.fee_policy_activation WHERE activation_id = $1 FOR UPDATE`,
    [input.activationId],
  );
  if (rows[0] === undefined) {
    return reject('PROPOSAL_NOT_FOUND', FAILURE_COPY.PROPOSAL_NOT_FOUND.reason);
  }
  if (rows[0].state !== 'PROPOSED') {
    // Two approvers racing: the second finds the decision made.
    return reject('PROPOSAL_NOT_FOUND', FAILURE_COPY.PROPOSAL_NOT_FOUND.reason);
  }
  // THE MAKER-CHECKER RULE. The CHECK constraint enforces it too.
  if ((rows[0].proposed_by as string) === principal.userId) {
    return reject('SELF_APPROVAL_FORBIDDEN', FAILURE_COPY.SELF_APPROVAL_FORBIDDEN.reason);
  }

  const policyId = rows[0].policy_id as string;
  const { rows: policyRows } = await tx.query(
    `SELECT ${POLICY_COLUMNS} FROM sandbox.fee_policy WHERE policy_id = $1 FOR UPDATE`,
    [policyId],
  );
  const policy = mapPolicy(policyRows[0]!);
  if (policy.state !== 'DRAFT') {
    return reject('FEE_POLICY_INVALID', 'That schedule is no longer a draft.');
  }

  /*
   * Retire whatever was pricing this CORRIDOR, not just this key.
   *
   * Retiring only the same `policy_key` would leave a differently-named
   * schedule live for the same scenario, and the price would then depend
   * on which row a query ordered first. Done FIRST so the partial unique
   * index never sees two active rows, even momentarily.
   */
  await tx.query(
    `UPDATE sandbox.fee_policy SET state='RETIRED', retired_at=now()
      WHERE scenario = $1 AND state = 'ACTIVE'`,
    [policy.scenario],
  );
  const { rows: activated } = await tx.query(
    `UPDATE sandbox.fee_policy SET state='ACTIVE', activated_at=now()
      WHERE policy_id = $1
      RETURNING ${POLICY_COLUMNS}`,
    [policyId],
  );
  await tx.query(
    `UPDATE sandbox.fee_policy_activation
        SET state='APPROVED', approved_by=$2, decided_at=now(), decision_note=$3
      WHERE activation_id=$1 AND state='PROPOSED'`,
    [input.activationId, principal.userId, (input.note ?? '').trim().slice(0, 4000) || null],
  );

  return accept(mapPolicy(activated[0]!));
}
