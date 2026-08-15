/**
 * Risk rule evaluation — deterministic, declarative, explainable.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  NO MODEL. NO SCORE. NO OPACITY.                                   │
 * │                                                                    │
 * │  A policy is a LIST OF RULES, each with a code, a signal, a        │
 * │  comparison and a decision. Evaluating one produces the decision   │
 * │  AND the codes that produced it, so every hold can be explained to │
 * │  the person it was applied to — which is the difference between a  │
 * │  control and an accusation.                                        │
 * │                                                                    │
 * │  A score would satisfy the same interface and answer none of the   │
 * │  questions that matter when somebody's money is stopped: which     │
 * │  rule, what threshold, what would change it.                       │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * In `lib` and pure, so the same evaluation can be replayed offline
 * against a stored policy version and stored signals — which is what
 * makes "identical inputs produce the same result" checkable rather
 * than asserted.
 */

export type RiskDecision = 'ALLOW' | 'STEP_UP' | 'REVIEW' | 'HOLD' | 'REJECT';

export type RuleOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';

export interface RiskRule {
  readonly code: string;
  readonly signal: string;
  readonly op: RuleOperator;
  readonly value: unknown;
  readonly decision: RiskDecision;
  readonly reason: string;
}

/**
 * The normalized signals a decision sees.
 *
 * `bigint` for anything money-shaped, `number` only for counts, and
 * `boolean` for facts. A float never reaches a comparison here.
 */
export type SignalValue = boolean | number | bigint | string;
export type Signals = Readonly<Record<string, SignalValue | undefined>>;

/**
 * How severe is this decision?
 *
 * The ordering is the safety model: when several rules match, the
 * STRICTEST wins. A policy that matched both "allow" and "reject" and
 * returned the first would depend on rule ordering, and somebody
 * reordering a list for readability would change what the system does
 * with real money.
 */
const SEVERITY: Readonly<Record<RiskDecision, number>> = {
  ALLOW: 0,
  STEP_UP: 1,
  REVIEW: 2,
  HOLD: 3,
  REJECT: 4,
};

export function strictest(a: RiskDecision, b: RiskDecision): RiskDecision {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/** Decisions that BLOCK the protected mutation. */
export function blocks(decision: RiskDecision): boolean {
  return decision === 'HOLD' || decision === 'REJECT';
}

/**
 * Compare one signal against one rule.
 *
 * A MISSING signal never matches. That is deliberate and it is the safe
 * direction for a rule engine whose rules are mostly "reject when X":
 * an absent signal must not be silently treated as zero or false, which
 * would make a rule fire on data nobody actually observed.
 */
function matches(actual: SignalValue | undefined, rule: RiskRule): boolean {
  if (actual === undefined) return false;

  if (rule.op === 'in') {
    return Array.isArray(rule.value) && rule.value.some((v) => sameValue(actual, v));
  }
  if (rule.op === 'eq') return sameValue(actual, rule.value);
  if (rule.op === 'ne') return !sameValue(actual, rule.value);

  // Ordered comparisons need ordered operands. A boolean or a string
  // compared with `gt` is a policy authoring mistake, and treating it as
  // false is safer than inventing an ordering for it.
  const left = asComparable(actual);
  const right = asComparable(rule.value);
  if (left === null || right === null) return false;

  switch (rule.op) {
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
  }
}

function sameValue(a: SignalValue, b: unknown): boolean {
  if (typeof a === 'bigint') {
    const other = asComparable(b);
    return other !== null && a === other;
  }
  if (typeof b === 'bigint') {
    const mine = asComparable(a);
    return mine !== null && mine === b;
  }
  return a === b;
}

/**
 * Coerce to `bigint` for comparison, or refuse.
 *
 * A decimal string is REFUSED rather than truncated: a threshold that
 * silently became a different threshold is worse than a rule that did
 * not fire, because nobody would ever notice.
 */
function asComparable(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : null;
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) return BigInt(value);
  return null;
}

export interface Evaluation {
  readonly decision: RiskDecision;
  readonly matchedRules: readonly string[];
  readonly reasonCodes: readonly string[];
}

/**
 * Evaluate a policy against a set of signals.
 *
 * Every matching rule is collected, not just the first, so the record
 * says everything that fired. The returned decision is the strictest of
 * them, and the codes are sorted — a deterministic order, so two
 * evaluations of the same inputs are byte-identical and comparable.
 */
export function evaluate(
  rules: readonly RiskRule[],
  signals: Signals,
  fallback: RiskDecision = 'ALLOW',
): Evaluation {
  const matched: string[] = [];
  const reasons: string[] = [];
  let decision: RiskDecision = fallback;

  for (const rule of rules) {
    if (!matches(signals[rule.signal], rule)) continue;
    matched.push(rule.code);
    reasons.push(rule.reason);
    decision = strictest(decision, rule.decision);
  }

  return {
    decision,
    matchedRules: [...matched].sort(),
    reasonCodes: [...new Set(reasons)].sort(),
  };
}

/**
 * Parse rules stored as JSON, discarding anything malformed.
 *
 * A malformed rule is DROPPED rather than accepted with defaults: a rule
 * whose decision could not be read is a rule nobody authored, and
 * guessing at it means enforcing something no reviewer approved.
 */
export function parseRules(raw: unknown): readonly RiskRule[] {
  if (!Array.isArray(raw)) return [];
  const decisions = new Set<RiskDecision>(['ALLOW', 'STEP_UP', 'REVIEW', 'HOLD', 'REJECT']);
  const ops = new Set<RuleOperator>(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']);

  return raw.flatMap((entry): RiskRule[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const r = entry as Record<string, unknown>;
    if (typeof r.code !== 'string' || typeof r.signal !== 'string') return [];
    if (typeof r.reason !== 'string') return [];
    if (!decisions.has(r.decision as RiskDecision)) return [];
    if (!ops.has(r.op as RuleOperator)) return [];
    return [
      {
        code: r.code,
        signal: r.signal,
        op: r.op as RuleOperator,
        value: r.value,
        decision: r.decision as RiskDecision,
        reason: r.reason,
      },
    ];
  });
}
