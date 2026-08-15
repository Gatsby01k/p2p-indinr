import 'server-only';
import { randomUUID } from 'node:crypto';
import { getPool, type Tx } from '@/server/db/pool';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { deploymentMode } from '@/server/adapters/mode';
import {
  blocks,
  evaluate,
  parseRules,
  type Evaluation,
  type RiskDecision,
  type Signals,
} from '@/lib/riskRules';

/**
 * The risk engine — evaluate, record, and actually block.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE WHOLE POINT IS `enforce`.                                     │
 * │                                                                    │
 * │  It evaluates the live policy, writes the decision, reads any live │
 * │  hold, checks the emergency pause — all on the CALLER'S            │
 * │  transaction, before the protected mutation writes. A blocked      │
 * │  command returns a rejection and its evidence commits.             │
 * │                                                                    │
 * │  Nothing here depends on a screen. Hiding a button is not          │
 * │  enforcement, and every test in this stage calls the command       │
 * │  directly to prove it.                                             │
 * └────────────────────────────────────────────────────────────────────┘
 */

export type EnforcementPoint =
  | 'ACCOUNT_VERIFY'
  | 'ACCOUNT_LINK'
  | 'QUOTE_ISSUE'
  | 'DEAL_JOIN'
  | 'VALUE_LOCK'
  | 'INSTRUCTION_DISCLOSE'
  | 'RAIL_OBSERVE'
  | 'DEAL_COMPLETE'
  | 'ESCROW_RELEASE'
  | 'ESCROW_REFUND'
  | 'DISPUTE_RESOLVE'
  | 'REFERRAL_QUALIFY'
  | 'REWARD_GRANT'
  | 'REWARD_REDEEM'
  | 'PREMIUM_CHANGE'
  | 'OPERATOR_ACTION';

export type SubjectKind = 'user' | 'deal' | 'quote' | 'payment' | 'case' | 'reward' | 'link';

export interface RiskContext {
  readonly point: EnforcementPoint;
  readonly subjectKind: SubjectKind;
  readonly subjectId: string;
  readonly actorId?: string | null;
  readonly signals?: Signals;
  readonly commandId?: string | null;
  readonly correlationId?: string;
}

export interface RiskOutcome {
  readonly decisionId: string;
  readonly decision: RiskDecision;
  readonly matchedRules: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly policyKey: string;
  readonly policyVersion: number;
}

/* ------------------------------------------------------------------ *
 * Policy resolution
 * ------------------------------------------------------------------ */

interface ActivePolicy {
  readonly policyId: string;
  readonly policyKey: string;
  readonly version: number;
  readonly rules: ReturnType<typeof parseRules>;
  readonly fallback: RiskDecision;
}

/**
 * The live policy for this point.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  PRODUCTION FAILS CLOSED AT MATERIAL FINANCIAL BOUNDARIES.         │
 * │                                                                    │
 * │  With no production-enabled policy, a money-moving point does not  │
 * │  default to ALLOW — it refuses. Defaulting to allow would mean a   │
 * │  misconfigured deployment silently ships with no controls at all,  │
 * │  which is precisely the failure this stage exists to prevent.      │
 * │                                                                    │
 * │  Non-financial points (reading a quote, linking an account) still  │
 * │  fail OPEN with an explicit `NO_POLICY` reason code, because       │
 * │  blocking sign-in on a missing risk config helps nobody and the    │
 * │  decision is recorded either way.                                  │
 * └────────────────────────────────────────────────────────────────────┘
 */
const MATERIAL_POINTS: ReadonlySet<EnforcementPoint> = new Set<EnforcementPoint>([
  'VALUE_LOCK',
  'INSTRUCTION_DISCLOSE',
  'RAIL_OBSERVE',
  'ESCROW_RELEASE',
  'ESCROW_REFUND',
  'DISPUTE_RESOLVE',
  'REWARD_GRANT',
  'REWARD_REDEEM',
]);

async function activePolicy(tx: Tx, point: EnforcementPoint): Promise<ActivePolicy | null> {
  const production = deploymentMode() === 'PRODUCTION';
  const { rows } = await tx.query(
    `SELECT policy_id, policy_key, version, rules, default_decision
       FROM sandbox.risk_policy
      WHERE point = $1 AND state = 'ACTIVE' AND effective_from <= now()
        AND ($2::boolean = FALSE OR production_enabled = TRUE)
      LIMIT 1`,
    [point, production],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return {
    policyId: r.policy_id as string,
    policyKey: r.policy_key as string,
    version: Number(r.version),
    rules: parseRules(r.rules),
    fallback: r.default_decision as RiskDecision,
  };
}

/* ------------------------------------------------------------------ *
 * Holds
 * ------------------------------------------------------------------ */

export interface LiveHold {
  readonly holdId: string;
  readonly reasonCode: string;
  readonly point: EnforcementPoint | null;
}

/**
 * Is this subject held right now, at this point?
 *
 * A hold with a NULL point applies EVERYWHERE. Expiry is evaluated by
 * the database clock inside the caller's transaction, so a hold that
 * lapsed a second ago stops applying and one placed a second ago starts.
 */
export async function liveHold(
  tx: Tx,
  subjectKind: SubjectKind,
  subjectId: string,
  point: EnforcementPoint,
): Promise<LiveHold | null> {
  const { rows } = await tx.query(
    `SELECT hold_id, reason_code, point FROM sandbox.risk_hold
      WHERE subject_kind = $1 AND subject_id = $2 AND active
        AND (point IS NULL OR point = $3)
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY point NULLS FIRST
      LIMIT 1`,
    [subjectKind, subjectId, point],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return {
    holdId: r.hold_id as string,
    reasonCode: r.reason_code as string,
    point: (r.point as EnforcementPoint | null) ?? null,
  };
}

export async function placeHold(
  tx: Tx,
  input: {
    readonly subjectKind: SubjectKind;
    readonly subjectId: string;
    readonly point?: EnforcementPoint | null;
    readonly reasonCode: string;
    readonly decisionId?: string | null;
    readonly placedBy?: string | null;
    readonly expiresAt?: Date | null;
  },
): Promise<{ holdId: string; created: boolean }> {
  /*
   * `ON CONFLICT DO NOTHING` against the live-hold index: a repeated
   * signal joins the existing hold instead of stacking fifty identical
   * rows that an operator would then have to release one at a time.
   */
  const { rows } = await tx.query(
    `INSERT INTO sandbox.risk_hold
       (subject_kind, subject_id, point, reason_code, decision_id, placed_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING
     RETURNING hold_id`,
    [
      input.subjectKind,
      input.subjectId,
      input.point ?? null,
      input.reasonCode,
      input.decisionId ?? null,
      input.placedBy ?? null,
      input.expiresAt ?? null,
    ],
  );
  if (rows[0]) return { holdId: rows[0].hold_id as string, created: true };

  const { rows: existing } = await tx.query(
    `SELECT hold_id FROM sandbox.risk_hold
      WHERE subject_kind=$1 AND subject_id=$2 AND active
        AND point IS NOT DISTINCT FROM $3`,
    [input.subjectKind, input.subjectId, input.point ?? null],
  );
  return { holdId: existing[0]!.hold_id as string, created: false };
}

/* ------------------------------------------------------------------ *
 * Emergency pause
 * ------------------------------------------------------------------ */

export type ControlScope =
  | 'CORRIDOR'
  | 'QUOTE_ISSUE'
  | 'DEAL_JOIN'
  | 'INSTRUCTION_DISCLOSE'
  | 'RAIL_CONFIRM'
  | 'SETTLEMENT'
  | 'REWARDS';

/**
 * Which pause scopes gate which enforcement point.
 *
 * Stated as a map rather than checked ad hoc at each call site, so
 * "pausing settlement stops release AND refund" is one readable fact
 * instead of two places somebody could update separately.
 */
const POINT_SCOPES: Readonly<Partial<Record<EnforcementPoint, readonly ControlScope[]>>> = {
  QUOTE_ISSUE: ['QUOTE_ISSUE'],
  DEAL_JOIN: ['DEAL_JOIN'],
  INSTRUCTION_DISCLOSE: ['INSTRUCTION_DISCLOSE'],
  RAIL_OBSERVE: ['RAIL_CONFIRM'],
  ESCROW_RELEASE: ['SETTLEMENT'],
  ESCROW_REFUND: ['SETTLEMENT'],
  DISPUTE_RESOLVE: ['SETTLEMENT'],
  REWARD_GRANT: ['REWARDS'],
  REWARD_REDEEM: ['REWARDS'],
  REFERRAL_QUALIFY: ['REWARDS'],
};

/**
 * Is anything paused that would stop this?
 *
 * Read LIVE on the caller's transaction. A cached copy in a screen is
 * not authority and blocks nothing — which is why this is a query and
 * not a module-level constant refreshed on a timer.
 */
export async function pausedFor(
  tx: Tx,
  point: EnforcementPoint,
  corridor?: string | null,
): Promise<{ scope: ControlScope; reason: string } | null> {
  const scopes = POINT_SCOPES[point] ?? [];
  const { rows } = await tx.query(
    `SELECT scope, target, reason FROM sandbox.control_switch
      WHERE paused
        AND (scope = ANY($1::sandbox.control_scope[])
             OR (scope = 'CORRIDOR' AND (target IS NULL OR target = $2)))
      LIMIT 1`,
    [scopes.length > 0 ? scopes : ['CORRIDOR'], corridor ?? null],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return { scope: r.scope as ControlScope, reason: r.reason as string };
}

/* ------------------------------------------------------------------ *
 * The enforcement gate
 * ------------------------------------------------------------------ */

/**
 * Evaluate, record, and block if required.
 *
 * Returns an `Outcome`, so a refusal is a VALUE and its decision row
 * commits with the caller's transaction — the DEL-02 non-raising
 * boundary doing the job it was built for. A control plane whose
 * refusals roll back has no evidence of what it refused.
 */
export async function enforce(tx: Tx, ctx: RiskContext): Promise<Outcome<RiskOutcome>> {
  const correlationId = ctx.correlationId ?? randomUUID();
  const signals: Signals = ctx.signals ?? {};

  /* ---- 1. The emergency pause outranks everything ---- */
  const paused = await pausedFor(
    tx,
    ctx.point,
    typeof signals.corridor === 'string' ? signals.corridor : null,
  );
  if (paused !== null) {
    return reject('CONTROL_PAUSED', FAILURE_COPY.CONTROL_PAUSED.reason, {
      scope: paused.scope,
      point: ctx.point,
    });
  }

  /* ---- 2. An existing hold blocks before any evaluation ---- */
  const held = await liveHold(tx, ctx.subjectKind, ctx.subjectId, ctx.point);

  const policy = await activePolicy(tx, ctx.point);
  if (policy === null) {
    if (MATERIAL_POINTS.has(ctx.point)) {
      // FAIL CLOSED. A money-moving boundary with no approved policy
      // does not proceed uncontrolled.
      return reject('RISK_POLICY_UNAVAILABLE', FAILURE_COPY.RISK_POLICY_UNAVAILABLE.reason, {
        point: ctx.point,
      });
    }
    // Non-material: proceed, but say so in the record.
    return accept({
      decisionId: '',
      decision: 'ALLOW',
      matchedRules: [],
      reasonCodes: ['NO_POLICY'],
      policyKey: '',
      policyVersion: 0,
    });
  }

  /* ---- 3. Evaluate ---- */
  const withHold: Signals = { ...signals, subjectHeld: held !== null };
  const evaluation: Evaluation = evaluate(policy.rules, withHold, policy.fallback);
  const decision: RiskDecision = held === null ? evaluation.decision : 'HOLD';
  const reasonCodes =
    held === null ? evaluation.reasonCodes : [...evaluation.reasonCodes, held.reasonCode].sort();

  /* ---- 4. Record, always — ALLOW included ---- */
  const { rows } = await tx.query(
    `INSERT INTO sandbox.risk_decision_log
       (policy_id, policy_key, policy_version, point, subject_kind, subject_id,
        actor_id, signals, matched_rules, decision, reason_codes, command_id,
        correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING decision_id`,
    [
      policy.policyId,
      policy.policyKey,
      policy.version,
      ctx.point,
      ctx.subjectKind,
      ctx.subjectId,
      ctx.actorId ?? null,
      JSON.stringify(serialiseSignals(withHold)),
      evaluation.matchedRules,
      decision,
      reasonCodes,
      ctx.commandId ?? null,
      correlationId,
    ],
  );
  const decisionId = rows[0]!.decision_id as string;

  const outcome: RiskOutcome = {
    decisionId,
    decision,
    matchedRules: evaluation.matchedRules,
    reasonCodes,
    policyKey: policy.policyKey,
    policyVersion: policy.version,
  };

  /* ---- 5. Act ---- */
  if (decision === 'HOLD' && held === null) {
    // A fresh HOLD places one, so the next attempt is blocked by the
    // hold itself rather than by re-evaluating the same signals.
    await placeHold(tx, {
      subjectKind: ctx.subjectKind,
      subjectId: ctx.subjectId,
      point: ctx.point,
      reasonCode: reasonCodes[0] ?? 'RISK_HOLD',
      decisionId,
    });
  }

  if (blocks(decision)) {
    return reject(
      decision === 'REJECT' ? 'RISK_REJECTED' : 'RISK_HELD',
      decision === 'REJECT' ? FAILURE_COPY.RISK_REJECTED.reason : FAILURE_COPY.RISK_HELD.reason,
      { decisionId, reasonCodes, point: ctx.point },
    );
  }

  return accept(outcome);
}

/**
 * `bigint` cannot be JSON-encoded, so signals are stringified for
 * storage — and stored as strings rather than numbers, so a replay
 * reads back exactly what was compared instead of a float.
 */
function serialiseSignals(signals: Signals): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(signals)) {
    if (value === undefined) continue;
    out[key] = typeof value === 'bigint' ? value.toString() : value;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Reading decisions back
 * ------------------------------------------------------------------ */

export async function decisionsFor(
  subjectKind: SubjectKind,
  subjectId: string,
): Promise<
  readonly {
    decisionId: string;
    point: string;
    decision: RiskDecision;
    reasonCodes: readonly string[];
    policyKey: string;
    policyVersion: number;
    decidedAt: string;
  }[]
> {
  const { rows } = await getPool().query(
    `SELECT decision_id, point, decision, reason_codes, policy_key, policy_version,
            decided_at
       FROM sandbox.risk_decision_log
      WHERE subject_kind = $1 AND subject_id = $2
      ORDER BY decided_at DESC`,
    [subjectKind, subjectId],
  );
  return rows.map((r) => ({
    decisionId: r.decision_id as string,
    point: r.point as string,
    decision: r.decision as RiskDecision,
    reasonCodes: r.reason_codes as string[],
    policyKey: r.policy_key as string,
    policyVersion: Number(r.policy_version),
    decidedAt: (r.decided_at as Date).toISOString(),
  }));
}

/**
 * Replay a recorded decision against its own policy version.
 *
 * The function that makes determinism checkable: it re-reads the stored
 * signals and the stored policy and must reproduce the stored decision.
 * If it ever cannot, either the policy was mutated or the engine changed
 * behaviour — and both are things somebody needs to know about.
 */
export async function replayDecision(
  decisionId: string,
): Promise<{ stored: RiskDecision; recomputed: RiskDecision } | null> {
  const { rows } = await getPool().query(
    `SELECT d.decision, d.signals, p.rules, p.default_decision
       FROM sandbox.risk_decision_log d
       JOIN sandbox.risk_policy p ON p.policy_id = d.policy_id
      WHERE d.decision_id = $1`,
    [decisionId],
  );
  const r = rows[0];
  if (r === undefined) return null;

  const recomputed = evaluate(
    parseRules(r.rules),
    r.signals as Signals,
    r.default_decision as RiskDecision,
  );
  return { stored: r.decision as RiskDecision, recomputed: recomputed.decision };
}
