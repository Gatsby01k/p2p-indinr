import { describe, expect, it } from 'vitest';
import { blocks, evaluate, parseRules, strictest, type RiskRule } from '@/lib/riskRules';

/**
 * The rule engine, tested on its own.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE PROPERTIES THAT MATTER WHEN SOMEBODY'S MONEY IS STOPPED:      │
 * │                                                                    │
 * │  · the same inputs always produce the same decision;               │
 * │  · rule ORDER cannot change the outcome;                           │
 * │  · a missing signal never fires a rule;                            │
 * │  · a malformed rule is dropped, not guessed at;                    │
 * │  · the decision is explainable by the codes that matched.          │
 * └────────────────────────────────────────────────────────────────────┘
 */

const rule = (over: Partial<RiskRule>): RiskRule => ({
  code: 'R1',
  signal: 'amount',
  op: 'gt',
  value: 100,
  decision: 'REVIEW',
  reason: 'AMOUNT_HIGH',
  ...over,
});

describe('severity ordering', () => {
  it('ranks decisions from permissive to terminal', () => {
    expect(strictest('ALLOW', 'STEP_UP')).toBe('STEP_UP');
    expect(strictest('REVIEW', 'HOLD')).toBe('HOLD');
    expect(strictest('HOLD', 'REJECT')).toBe('REJECT');
    expect(strictest('REJECT', 'ALLOW')).toBe('REJECT');
  });

  it('names exactly the two decisions that block', () => {
    expect(blocks('ALLOW')).toBe(false);
    expect(blocks('STEP_UP')).toBe(false);
    // REVIEW proceeds: a case is opened behind it, but the customer is
    // not stopped on a suspicion nobody has looked at yet.
    expect(blocks('REVIEW')).toBe(false);
    expect(blocks('HOLD')).toBe(true);
    expect(blocks('REJECT')).toBe(true);
  });
});

describe('evaluation', () => {
  it('returns the fallback when nothing matches', () => {
    const result = evaluate([rule({})], { amount: 50 }, 'ALLOW');
    expect(result.decision).toBe('ALLOW');
    expect(result.matchedRules).toEqual([]);
  });

  it('collects EVERY matching rule, not just the first', () => {
    const result = evaluate(
      [
        rule({ code: 'A', op: 'gt', value: 100, decision: 'REVIEW', reason: 'HIGH' }),
        rule({ code: 'B', op: 'gt', value: 500, decision: 'HOLD', reason: 'VERY_HIGH' }),
      ],
      { amount: 1000 },
    );
    // Both fired, and the record says so — an explanation needs all of
    // them, not just the one that happened to win.
    expect(result.matchedRules).toEqual(['A', 'B']);
    expect(result.reasonCodes).toEqual(['HIGH', 'VERY_HIGH']);
    expect(result.decision).toBe('HOLD');
  });

  it('is INDEPENDENT of rule order', () => {
    const a = rule({ code: 'A', decision: 'REVIEW', reason: 'A' });
    const b = rule({ code: 'B', decision: 'REJECT', reason: 'B' });
    const forwards = evaluate([a, b], { amount: 1000 });
    const backwards = evaluate([b, a], { amount: 1000 });
    // Reordering a list for readability must not change what happens
    // to real money.
    expect(forwards).toEqual(backwards);
    expect(forwards.decision).toBe('REJECT');
  });

  it('is deterministic across repeated evaluation', () => {
    const rules = [
      rule({ code: 'A', decision: 'REVIEW', reason: 'A' }),
      rule({ code: 'B', signal: 'flag', op: 'eq', value: true, decision: 'HOLD', reason: 'B' }),
    ];
    const signals = { amount: 900, flag: true };
    const runs = Array.from({ length: 20 }, () => evaluate(rules, signals));
    for (const run of runs) expect(run).toEqual(runs[0]);
  });

  it('a MISSING signal never fires a rule', () => {
    // Absent is not zero and not false. A rule firing on data nobody
    // observed is a hold nobody can explain.
    const result = evaluate([rule({ op: 'lt', value: 100 })], {});
    expect(result.decision).toBe('ALLOW');
    expect(result.matchedRules).toEqual([]);
  });

  it('compares bigints exactly, at the boundary', () => {
    const r = rule({ signal: 'amountMinor', op: 'gte', value: 1_000_000, decision: 'HOLD' });
    expect(evaluate([r], { amountMinor: 999_999n }).decision).toBe('ALLOW');
    expect(evaluate([r], { amountMinor: 1_000_000n }).decision).toBe('HOLD');
    // Far beyond a 64-bit integer, still exact.
    expect(evaluate([r], { amountMinor: 10n ** 30n }).decision).toBe('HOLD');
  });

  it('refuses to order a non-numeric operand rather than inventing one', () => {
    const r = rule({ signal: 'name', op: 'gt', value: 'abc' });
    expect(evaluate([r], { name: 'zzz' }).decision).toBe('ALLOW');
  });

  it('supports set membership', () => {
    const r = rule({ signal: 'rail', op: 'in', value: ['INR', 'USDT'], decision: 'REVIEW' });
    expect(evaluate([r], { rail: 'USDT' }).decision).toBe('REVIEW');
    expect(evaluate([r], { rail: 'BTC' }).decision).toBe('ALLOW');
  });

  it('deduplicates reason codes and sorts them', () => {
    const result = evaluate(
      [
        rule({ code: 'B', reason: 'SAME' }),
        rule({ code: 'A', reason: 'SAME' }),
        rule({ code: 'C', reason: 'OTHER' }),
      ],
      { amount: 1000 },
    );
    expect(result.matchedRules).toEqual(['A', 'B', 'C']);
    expect(result.reasonCodes).toEqual(['OTHER', 'SAME']);
  });
});

describe('parsing stored rules', () => {
  it('accepts a well-formed rule', () => {
    const parsed = parseRules([
      { code: 'X', signal: 's', op: 'eq', value: 1, decision: 'HOLD', reason: 'R' },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.decision).toBe('HOLD');
  });

  it('DROPS a malformed rule rather than guessing at it', () => {
    const parsed = parseRules([
      { code: 'ok', signal: 's', op: 'eq', value: 1, decision: 'HOLD', reason: 'R' },
      { code: 'no-decision', signal: 's', op: 'eq', value: 1, reason: 'R' },
      { code: 'bad-decision', signal: 's', op: 'eq', value: 1, decision: 'MAYBE', reason: 'R' },
      { code: 'bad-op', signal: 's', op: 'approximately', value: 1, decision: 'HOLD', reason: 'R' },
      { signal: 's', op: 'eq', value: 1, decision: 'HOLD', reason: 'R' },
      null,
      'not an object',
    ]);
    // A rule whose decision could not be read is a rule nobody
    // authored; enforcing a guess would enforce something unapproved.
    expect(parsed.map((r) => r.code)).toEqual(['ok']);
  });

  it('returns nothing for a non-array', () => {
    expect(parseRules(null)).toEqual([]);
    expect(parseRules({ rules: [] })).toEqual([]);
    expect(parseRules('[]')).toEqual([]);
  });
});
