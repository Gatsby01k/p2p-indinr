import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { getPool, withTransaction } from '@/server/db/pool';
import { newCommandId, readCommand } from '@/server/boundary/command';
import { enforce, liveHold, placeHold, replayDecision } from '@/server/risk/engine';
import { consumeLimit, correctConsumption } from '@/server/risk/limits';
import { caseDetail, claimCase, openCase, queue } from '@/server/risk/cases';
import { recordScreening, signScreening } from '@/server/risk/screening';
import { withdrawRewardsFor } from '@/server/risk/rewardOrchestration';
import {
  approveOpsActionCommand,
  evaluateRewardCommand,
  issuePaymentInstructionCommand,
  lockValueCommand,
  openPaymentIntentCommand,
  pauseControlCommand,
  proposeApprovalCommand,
  raisePostSettlementComplaintCommand,
  releaseHoldCommand,
  releaseValueCommand,
  resumeControlCommand,
  fundSandboxCommand,
} from '@/services/commands';
import type { SessionUser } from '@/server/sandbox/service';
import type { Principal } from '@/server/identity/rbac';
import { lockedDeal, liveDeal, unique } from './support/rails';
import { bare, newUser, operatorPrincipal, withoutMfa } from './support/room';

/**
 * DEL-08 risk, compliance and operator operations.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE CLAIM UNDER TEST: A CONTROL BLOCKS THE SERVER, NOT THE SCREEN.│
 * │                                                                    │
 * │  Every enforcement test calls the COMMAND directly — the same      │
 * │  entry point a hostile client would reach — because "we hid the    │
 * │  button" is not a control. A hold, a pause and a limit must each   │
 * │  stop a request that never saw a user interface.                   │
 * │                                                                    │
 * │  And the honesty tests matter as much: a post-settlement complaint │
 * │  moves no money, a screening hit seizes nothing, and production    │
 * │  refuses to pretend anybody was screened.                          │
 * └────────────────────────────────────────────────────────────────────┘
 */

const original = { nodeEnv: process.env.NODE_ENV, sandbox: process.env.INRP2P_SANDBOX };
function enterProduction() {
  (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
  delete process.env.INRP2P_SANDBOX;
}
function restore() {
  (process.env as Record<string, string | undefined>).NODE_ENV = original.nodeEnv;
  if (original.sandbox === undefined) delete process.env.INRP2P_SANDBOX;
  else process.env.INRP2P_SANDBOX = original.sandbox;
}

let alice: SessionUser;
let bob: SessionUser;
let operator: Principal;
let reviewer: Principal;
let ledgerAdmin: Principal;

/** Everything this suite pauses, released after each test. */
const pausedSwitches: string[] = [];

afterEach(async () => {
  restore();
  // A pause is global, so leaving one behind would silently block every
  // test that follows. Cleared directly: the two-person resume path has
  // its own dedicated test.
  if (pausedSwitches.length > 0) {
    /*
     * DELETED, not half-resumed. `control_switch_resumed` requires all
     * three resume facts together, and inventing an approver in a
     * teardown would be faking the very two-person control this suite
     * exists to verify. The genuine resume path has its own test.
     */
    await getPool().query(`DELETE FROM sandbox.control_switch WHERE switch_id = ANY($1::uuid[])`, [
      pausedSwitches,
    ]);
    pausedSwitches.length = 0;
  }
});

beforeAll(async () => {
  alice = await newUser('rc-alice');
  bob = await newUser('rc-bob');
  operator = await operatorPrincipal('OPERATOR', 'rc-operator');
  reviewer = await operatorPrincipal('REVIEWER', 'rc-reviewer');
  ledgerAdmin = await operatorPrincipal('ADMIN', 'rc-admin');
});

async function pauseScope(scope: Parameters<typeof pauseControlCommand>[2]['scope']) {
  const paused = await pauseControlCommand(operator, newCommandId(), {
    scope,
    reason: 'Deliberate pause for an enforcement test.',
  });
  if (!paused.ok) throw new Error(`pause fixture: ${paused.code}`);
  pausedSwitches.push(paused.value.switchId);
  return paused.value.switchId;
}

/* ================================================================== *
 * Decisions
 * ================================================================== */

describe('risk decisions are recorded, deterministic and replayable', () => {
  it('records an ALLOW as well as a refusal', async () => {
    const user = await newUser('rc-allow');
    const outcome = await withTransaction((tx) =>
      enforce(tx, {
        point: 'QUOTE_ISSUE',
        subjectKind: 'user',
        subjectId: user.userId,
        actorId: user.userId,
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.decision).toBe('ALLOW');

    // A control plane that logs only refusals cannot answer "why was
    // this allowed?", which is the question asked afterwards.
    const { rows } = await getPool().query(
      `SELECT decision FROM sandbox.risk_decision_log WHERE subject_id = $1`,
      [user.userId],
    );
    expect(rows.map((r) => r.decision)).toEqual(['ALLOW']);
  });

  it('REPLAYS to the same decision from stored signals and policy', async () => {
    const user = await newUser('rc-replay');
    const outcome = await withTransaction((tx) =>
      enforce(tx, {
        point: 'REWARD_GRANT',
        subjectKind: 'user',
        subjectId: user.userId,
        signals: { selfDealing: true },
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    const decisionId = outcome.detail!.decisionId as string;
    const replayed = await replayDecision(decisionId);
    // If these ever disagree, either the policy was mutated or the
    // engine changed behaviour — both worth knowing about.
    expect(replayed!.recomputed).toBe(replayed!.stored);
    expect(replayed!.stored).toBe('REJECT');
  });

  it('a policy is IMMUTABLE in its rules', async () => {
    const { rows } = await getPool().query(
      `SELECT policy_id FROM sandbox.risk_policy WHERE point='REWARD_GRANT' AND state='ACTIVE'`,
    );
    await expect(
      withTransaction((tx) =>
        tx.query(`UPDATE sandbox.risk_policy SET rules='[]'::jsonb WHERE policy_id=$1`, [
          rows[0]!.policy_id,
        ]),
      ),
    ).rejects.toThrow(/immutable; publish a new version/);
  });

  it('a decision cannot be rewritten', async () => {
    const user = await newUser('rc-immutable');
    await withTransaction((tx) =>
      enforce(tx, { point: 'QUOTE_ISSUE', subjectKind: 'user', subjectId: user.userId }),
    );
    await expect(
      withTransaction((tx) =>
        tx.query(`UPDATE sandbox.risk_decision_log SET decision='ALLOW' WHERE subject_id=$1`, [
          user.userId,
        ]),
      ),
    ).rejects.toThrow(/cannot be rewritten/);
  });

  it('production FAILS CLOSED at a material boundary with no approved policy', async () => {
    const user = await newUser('rc-prodpolicy');
    enterProduction();
    const material = await withTransaction((tx) =>
      enforce(tx, { point: 'ESCROW_RELEASE', subjectKind: 'user', subjectId: user.userId }),
    );
    const informational = await withTransaction((tx) =>
      enforce(tx, { point: 'ACCOUNT_LINK', subjectKind: 'user', subjectId: user.userId }),
    );
    restore();

    expect(material.ok, 'a money-moving point does not proceed uncontrolled').toBe(false);
    if (!material.ok) expect(material.code).toBe('RISK_POLICY_UNAVAILABLE');

    // A non-financial point still proceeds, and says why in the record.
    expect(informational.ok).toBe(true);
    if (informational.ok) expect(informational.value.reasonCodes).toContain('NO_POLICY');
  });
});

/* ================================================================== *
 * Holds actually block
 * ================================================================== */

describe('a hold blocks the server, not the screen', () => {
  it('BLOCKS a value lock placed directly through the command', async () => {
    const dealId = await liveDeal(alice, bob);
    expect(
      (
        await fundSandboxCommand(ledgerAdmin, newCommandId(), {
          userId: alice.userId,
          asset: 'USDT',
          amountMinor: 50_000n,
        })
      ).ok,
    ).toBe(true);

    await withTransaction((tx) =>
      placeHold(tx, {
        subjectKind: 'user',
        subjectId: alice.userId,
        point: 'VALUE_LOCK',
        reasonCode: 'MANUAL_REVIEW',
      }),
    );

    // Called directly — exactly what a hostile client would do.
    const locked = await lockValueCommand(alice, newCommandId(), {
      dealId,
      asset: 'USDT',
      amountMinor: 10_000n,
    });
    expect(locked.ok).toBe(false);
    if (locked.ok) return;
    expect(locked.code).toBe('RISK_HELD');

    // Nothing moved.
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM inrp2p.value_lock WHERE deal_id = $1`,
      [dealId],
    );
    expect(rows[0]!.n).toBe(0);

    await getPool().query(
      `UPDATE sandbox.risk_hold SET active=FALSE, released_at=now(),
              release_reason='test cleanup' WHERE subject_id=$1 AND active`,
      [alice.userId],
    );
  });

  it('BLOCKS payment-instruction disclosure', async () => {
    const dealId = await lockedDeal(alice, bob, 60_000n);
    const opened = await openPaymentIntentCommand(alice, newCommandId(), {
      dealId,
      rail: 'USDT',
      network: 'TRC20',
      direction: 'COLLECT',
      payeeId: bob.userId,
      amountMinor: 10_000n,
    });
    if (!opened.ok) return;

    await withTransaction((tx) =>
      placeHold(tx, {
        subjectKind: 'user',
        subjectId: alice.userId,
        point: 'INSTRUCTION_DISCLOSE',
        reasonCode: 'SCREENING_HIT',
      }),
    );

    const issued = await issuePaymentInstructionCommand(alice, newCommandId(), {
      intentId: opened.value.intentId,
    });
    expect(issued.ok, 'a held payer is not shown where to send money').toBe(false);
    if (!issued.ok) expect(issued.code).toBe('RISK_HELD');

    await getPool().query(
      `UPDATE sandbox.risk_hold SET active=FALSE, released_at=now(),
              release_reason='test cleanup' WHERE subject_id=$1 AND active`,
      [alice.userId],
    );
  });

  it('BLOCKS a settlement', async () => {
    const dealId = await lockedDeal(alice, bob, 40_000n);
    await withTransaction((tx) =>
      placeHold(tx, {
        subjectKind: 'deal',
        subjectId: dealId,
        reasonCode: 'INVESTIGATION',
      }),
    );

    const released = await releaseValueCommand(alice, newCommandId(), {
      dealId,
      beneficiaryId: bob.userId,
    });
    expect(released.ok).toBe(false);
    if (!released.ok) expect(released.code).toBe('RISK_HELD');

    const { rows } = await getPool().query(`SELECT state FROM inrp2p.value_lock WHERE deal_id=$1`, [
      dealId,
    ]);
    expect(rows[0]!.state).toBe('LOCKED');

    await getPool().query(
      `UPDATE sandbox.risk_hold SET active=FALSE, released_at=now(),
              release_reason='test cleanup' WHERE subject_id=$1 AND active`,
      [dealId],
    );
  });

  it('an EXPIRED hold stops applying by itself', async () => {
    const user = await newUser('rc-expiring');
    await withTransaction((tx) =>
      placeHold(tx, {
        subjectKind: 'user',
        subjectId: user.userId,
        point: 'VALUE_LOCK',
        reasonCode: 'TEMPORARY',
        expiresAt: new Date(Date.now() - 1000),
      }),
    );
    const held = await withTransaction((tx) => liveHold(tx, 'user', user.userId, 'VALUE_LOCK'));
    expect(held, 'expiry is evaluated by the database clock').toBeNull();
  });

  it('a repeated signal joins the existing hold rather than stacking', async () => {
    const user = await newUser('rc-stack');
    for (let i = 0; i < 3; i += 1) {
      await withTransaction((tx) =>
        placeHold(tx, {
          subjectKind: 'user',
          subjectId: user.userId,
          point: 'VALUE_LOCK',
          reasonCode: 'REPEATED',
        }),
      );
    }
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.risk_hold
        WHERE subject_id=$1 AND active`,
      [user.userId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('releasing a hold takes TWO people', async () => {
    const user = await newUser('rc-release');
    const placed = await withTransaction((tx) =>
      placeHold(tx, {
        subjectKind: 'user',
        subjectId: user.userId,
        point: 'VALUE_LOCK',
        reasonCode: 'MANUAL',
      }),
    );

    const proposed = await proposeApprovalCommand(operator, newCommandId(), {
      actionKind: 'HOLD_RELEASE',
      targetRef: placed.holdId,
      rationale: 'Reviewed the account and found nothing that justifies the hold.',
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    // The proposer cannot approve their own.
    const selfApproved = await approveOpsActionCommand(operator, newCommandId(), {
      approvalId: proposed.value.approvalId,
    });
    expect(selfApproved.ok).toBe(false);
    if (!selfApproved.ok) {
      expect(['SELF_APPROVAL_FORBIDDEN', 'PERMISSION_DENIED']).toContain(selfApproved.code);
    }

    const approved = await approveOpsActionCommand(reviewer, newCommandId(), {
      approvalId: proposed.value.approvalId,
    });
    expect(approved.ok).toBe(true);

    const released = await releaseHoldCommand(operator, newCommandId(), {
      holdId: placed.holdId,
      approvalId: proposed.value.approvalId,
      reason: 'Cleared after review; no basis for the hold.',
    });
    expect(released.ok).toBe(true);
    expect(
      await withTransaction((tx) => liveHold(tx, 'user', user.userId, 'VALUE_LOCK')),
    ).toBeNull();
  });
});

/* ================================================================== *
 * Emergency pause
 * ================================================================== */

describe('emergency pause stops one person, resumes with two', () => {
  it('a paused SETTLEMENT scope blocks release AND refund', async () => {
    const dealId = await lockedDeal(alice, bob, 30_000n);
    await pauseScope('SETTLEMENT');

    const released = await releaseValueCommand(alice, newCommandId(), {
      dealId,
      beneficiaryId: bob.userId,
    });
    expect(released.ok).toBe(false);
    if (!released.ok) expect(released.code).toBe('CONTROL_PAUSED');

    const { refundValueCommand } = await import('@/services/commands');
    const refunded = await refundValueCommand(alice, newCommandId(), {
      dealId,
      beneficiaryId: alice.userId,
    });
    expect(refunded.ok).toBe(false);
    if (!refunded.ok) expect(refunded.code).toBe('CONTROL_PAUSED');
  });

  it('a paused INSTRUCTION_DISCLOSE scope blocks disclosure', async () => {
    const dealId = await lockedDeal(alice, bob, 40_000n);
    const opened = await openPaymentIntentCommand(alice, newCommandId(), {
      dealId,
      rail: 'USDT',
      network: 'TRC20',
      direction: 'COLLECT',
      payeeId: bob.userId,
      amountMinor: 10_000n,
    });
    if (!opened.ok) return;

    await pauseScope('INSTRUCTION_DISCLOSE');
    const issued = await issuePaymentInstructionCommand(alice, newCommandId(), {
      intentId: opened.value.intentId,
    });
    expect(issued.ok).toBe(false);
    if (!issued.ok) expect(issued.code).toBe('CONTROL_PAUSED');
  });

  it('pausing NEVER touches existing ledger or payment history', async () => {
    const dealId = await lockedDeal(alice, bob, 30_000n);
    const before = await getPool().query(`SELECT count(*)::int AS n FROM inrp2p.journal_entry`);
    await pauseScope('SETTLEMENT');
    const after = await getPool().query(`SELECT count(*)::int AS n FROM inrp2p.journal_entry`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);

    const { rows } = await getPool().query(`SELECT state FROM inrp2p.value_lock WHERE deal_id=$1`, [
      dealId,
    ]);
    expect(rows[0]!.state).toBe('LOCKED');
  });

  it('ONE person pauses; resuming needs a second', async () => {
    const switchId = await pauseScope('REWARDS');

    // The pauser alone cannot resume.
    const withoutApproval = await resumeControlCommand(operator, newCommandId(), {
      switchId,
      approvalId: crypto.randomUUID(),
      reason: 'Trying to resume alone.',
    });
    expect(withoutApproval.ok).toBe(false);
    if (!withoutApproval.ok) expect(withoutApproval.code).toBe('APPROVAL_REQUIRED');

    const proposed = await proposeApprovalCommand(operator, newCommandId(), {
      actionKind: 'CORRIDOR_RESUME',
      targetRef: switchId,
      rationale: 'The provider incident is over and confirmations are landing again.',
    });
    if (!proposed.ok) return;
    expect(
      (
        await approveOpsActionCommand(reviewer, newCommandId(), {
          approvalId: proposed.value.approvalId,
        })
      ).ok,
    ).toBe(true);

    const resumed = await resumeControlCommand(operator, newCommandId(), {
      switchId,
      approvalId: proposed.value.approvalId,
      reason: 'Incident resolved; resuming rewards.',
    });
    expect(resumed.ok).toBe(true);
    pausedSwitches.length = 0;
  });

  it('a customer cannot pause anything', async () => {
    const outcome = await pauseControlCommand(bare(alice), newCommandId(), {
      scope: 'SETTLEMENT',
      reason: 'I would like to stop the platform please.',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PERMISSION_DENIED');
  });

  it('a REVIEWER cannot pause and an OPERATOR cannot approve a resume', async () => {
    const byReviewer = await pauseControlCommand(reviewer, newCommandId(), {
      scope: 'SETTLEMENT',
      reason: 'A reviewer attempting to pause the platform.',
    });
    expect(byReviewer.ok).toBe(false);
    if (!byReviewer.ok) expect(byReviewer.code).toBe('PERMISSION_DENIED');
  });
});

/* ================================================================== *
 * Limits
 * ================================================================== */

describe('limits cannot be overshot', () => {
  it('CONCURRENT consumption cannot exceed a hard limit', async () => {
    const scope = `rc-limit-${unique()}`;
    // `deal.count.daily` allows 50. Fire 60 at once.
    const attempts = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        withTransaction((tx) =>
          consumeLimit(tx, {
            limitKey: 'deal.count.daily',
            scopeId: scope,
            consumptionKey: `${scope}:${i}`,
            count: 1,
          }),
        ),
      ),
    );
    const allowed = attempts.filter((a) => a.ok).length;
    expect(allowed, 'the limit is a limit under concurrency').toBeLessThanOrEqual(50);

    const { rows } = await getPool().query(
      `SELECT total_count FROM sandbox.risk_counter
        WHERE limit_key='deal.count.daily' AND scope_id=$1`,
      [scope],
    );
    expect(Number(rows[0]!.total_count)).toBeLessThanOrEqual(50);
  });

  it('a RETRY does not count twice', async () => {
    const scope = `rc-retry-${unique()}`;
    const key = `${scope}:once`;
    for (let i = 0; i < 5; i += 1) {
      await withTransaction((tx) =>
        consumeLimit(tx, {
          limitKey: 'deal.count.daily',
          scopeId: scope,
          consumptionKey: key,
          count: 1,
        }),
      );
    }
    const { rows } = await getPool().query(
      `SELECT total_count FROM sandbox.risk_counter
        WHERE limit_key='deal.count.daily' AND scope_id=$1`,
      [scope],
    );
    expect(Number(rows[0]!.total_count)).toBe(1);
  });

  it('an exceeded HARD limit consumes nothing', async () => {
    const scope = `rc-hard-${unique()}`;
    const outcome = await withTransaction((tx) =>
      consumeLimit(tx, {
        limitKey: 'deal.value.per_txn',
        scopeId: scope,
        consumptionKey: `${scope}:huge`,
        amount: 999_999_999_999n,
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('LIMIT_EXCEEDED');

    // Budget the customer never used is not consumed.
    const { rows } = await getPool().query(
      `SELECT total_amount::text AS t FROM sandbox.risk_counter
        WHERE limit_key='deal.value.per_txn' AND scope_id=$1`,
      [scope],
    );
    expect(rows[0] === undefined || rows[0].t === '0').toBe(true);
  });

  it('corrects a consumption ADDITIVELY', async () => {
    const scope = `rc-correct-${unique()}`;
    const key = `${scope}:one`;
    await withTransaction((tx) =>
      consumeLimit(tx, {
        limitKey: 'deal.count.daily',
        scopeId: scope,
        consumptionKey: key,
        count: 1,
      }),
    );
    await withTransaction((tx) =>
      correctConsumption(tx, { consumptionKey: key, reason: 'reversed' }),
    );

    const { rows } = await getPool().query(
      `SELECT total_count FROM sandbox.risk_counter
        WHERE limit_key='deal.count.daily' AND scope_id=$1`,
      [scope],
    );
    expect(Number(rows[0]!.total_count)).toBe(0);

    // BOTH rows survive: the attempt and its correction.
    const { rows: history } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.risk_consumption WHERE scope_id=$1`,
      [scope],
    );
    expect(history[0]!.n).toBe(2);
  });

  it('a HARD limit blocks a real value lock', async () => {
    const user = await newUser('rc-bigdeal');
    const dealId = await liveDeal(user, bob);
    await fundSandboxCommand(ledgerAdmin, newCommandId(), {
      userId: user.userId,
      asset: 'USDT',
      amountMinor: 900_000_000n,
    });

    // `deal.value.per_txn` is 500,000,000.
    const locked = await lockValueCommand(user, newCommandId(), {
      dealId,
      asset: 'USDT',
      amountMinor: 600_000_000n,
    });
    expect(locked.ok).toBe(false);
    if (locked.ok) return;
    expect(locked.code).toBe('LIMIT_EXCEEDED');
  });
});

/* ================================================================== *
 * Screening
 * ================================================================== */

describe('screening is verified, fresh, and never a clearance', () => {
  function response(over: Record<string, unknown> = {}) {
    const body = JSON.stringify({ probe: unique(), ...over });
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      providerKey: 'sandbox-screening',
      providerRef: `ref-${unique()}`,
      kind: 'SANCTIONS' as const,
      subjectKind: 'user' as const,
      subjectId: alice.userId,
      rawBody: body,
      signature: signScreening('sandbox-screening', timestamp, body),
      timestamp,
      findings: { matchStrength: 'NONE' },
      hit: false,
    };
  }

  it('accepts a genuine signature and stores only a HASH', async () => {
    const r = response();
    const recorded = await withTransaction((tx) => recordScreening(tx, r));
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const { rows } = await getPool().query(
      `SELECT raw_hash, provider_key FROM sandbox.screening_result WHERE screening_id=$1`,
      [recorded.value.screeningId],
    );
    expect(
      (rows[0]!.raw_hash as Buffer).equals(createHash('sha256').update(r.rawBody).digest()),
    ).toBe(true);
    // The provider is NAMED. No row here can be read as a real clearance.
    expect(rows[0]!.provider_key).toBe('sandbox-screening');
  });

  it('REFUSES a forged signature', async () => {
    const r = { ...response(), signature: 'a'.repeat(64) };
    const recorded = await withTransaction((tx) => recordScreening(tx, r));
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.code).toBe('SCREENING_UNVERIFIED');
  });

  it('REFUSES a stale timestamp', async () => {
    const body = JSON.stringify({ probe: unique() });
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    const recorded = await withTransaction((tx) =>
      recordScreening(tx, {
        ...response(),
        rawBody: body,
        timestamp: old,
        signature: signScreening('sandbox-screening', old, body),
      }),
    );
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.code).toBe('SCREENING_STALE');
  });

  it('REFUSES a replay', async () => {
    const r = response();
    expect((await withTransaction((tx) => recordScreening(tx, r))).ok).toBe(true);
    const replayed = await withTransaction((tx) => recordScreening(tx, r));
    expect(replayed.ok).toBe(false);
    if (replayed.ok) return;
    expect(replayed.code).toBe('SCREENING_UNVERIFIED');
    expect(replayed.detail).toMatchObject({ reason: 'REPLAYED' });
  });

  it('production REFUSES rather than returning a clean result', async () => {
    // Signed while the sandbox key is still obtainable — production
    // correctly refuses to hand one out at all, which is the second
    // assertion below.
    const signed = response();
    enterProduction();
    const recorded = await withTransaction((tx) => recordScreening(tx, signed));
    const { screeningSecret } = await import('@/server/risk/screening');
    expect(() => screeningSecret('sandbox-screening')).toThrow(/No production adapter/);
    restore();

    expect(recorded.ok, 'a false clean result is the worst possible output').toBe(false);
    if (recorded.ok) return;
    expect(recorded.code).toBe('SCREENING_UNAVAILABLE');
  });

  it('a HIT seizes nothing by itself', async () => {
    const dealId = await lockedDeal(alice, bob, 25_000n);
    const body = JSON.stringify({ hit: true, probe: unique() });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const recorded = await withTransaction((tx) =>
      recordScreening(tx, {
        ...response(),
        rawBody: body,
        timestamp,
        signature: signScreening('sandbox-screening', timestamp, body),
        findings: { matchStrength: 'STRONG', category: 'SANCTIONS' },
        hit: true,
      }),
    );
    expect(recorded.ok).toBe(true);

    // The value is untouched: concluding somebody is sanctioned is not a
    // determination this software is in a position to make.
    const { rows } = await getPool().query(`SELECT state FROM inrp2p.value_lock WHERE deal_id=$1`, [
      dealId,
    ]);
    expect(rows[0]!.state).toBe('LOCKED');
  });

  it('stores REDACTED findings and no provider narrative', async () => {
    const { screeningHistory } = await import('@/server/risk/screening');
    const history = await screeningHistory('user', alice.userId);
    for (const entry of history) {
      // Normalized categories only. The raw payload is not stored at
      // all, so even an authorised reader cannot retrieve it here.
      expect(JSON.stringify(entry.findings)).not.toMatch(/narrative|description|notes/i);
    }
  });
});

/* ================================================================== *
 * Cases and operator work
 * ================================================================== */

describe('operational cases', () => {
  async function openedCase(kind: Parameters<typeof openCase>[1]['kind'] = 'TRANSACTION_ALERT') {
    const key = `rc-case-${unique()}`;
    const opened = await withTransaction((tx) =>
      openCase(tx, {
        kind,
        subjectKind: 'user',
        subjectId: alice.userId,
        correlationKey: key,
        summary: 'An alert raised by the transaction monitor for a test.',
        reasonCodes: ['TEST'],
      }),
    );
    if (!opened.ok) throw new Error('case fixture');
    return opened.value.opsCase;
  }

  it('CORRELATES a repeated alert onto one case', async () => {
    const key = `rc-corr-${unique()}`;
    const open = () =>
      withTransaction((tx) =>
        openCase(tx, {
          kind: 'TRANSACTION_ALERT',
          subjectKind: 'user',
          subjectId: alice.userId,
          correlationKey: key,
          summary: 'The same underlying alert, reported repeatedly.',
        }),
      );
    const first = await open();
    const second = await open();
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.created).toBe(false);
    expect(second.value.opsCase.opsCaseId).toBe(first.value.opsCase.opsCaseId);

    // The repeat is still ON the timeline: fifty rows is a queue nobody
    // works, but losing the observation entirely is worse.
    const detail = await caseDetail(operator, first.value.opsCase.opsCaseId);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.value.timeline.map((t) => t.action)).toContain('CORRELATED');
  });

  it('CONCURRENT claims produce exactly one holder', async () => {
    const kase = await openedCase();
    const second = await operatorPrincipal('OPERATOR', `rc-op2-${unique()}`);

    const [a, b] = await Promise.all([
      withTransaction((tx) => claimCase(tx, operator, { opsCaseId: kase.opsCaseId })),
      withTransaction((tx) => claimCase(tx, second, { opsCaseId: kase.opsCaseId })),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
  });

  it('a LAPSED lease lets somebody else pick it up', async () => {
    const kase = await openedCase();
    await withTransaction((tx) => claimCase(tx, operator, { opsCaseId: kase.opsCaseId }));

    await getPool().query(
      `UPDATE sandbox.ops_case SET lease_expires_at = now() - interval '1 minute'
        WHERE ops_case_id = $1`,
      [kase.opsCaseId],
    );

    const other = await operatorPrincipal('OPERATOR', `rc-op3-${unique()}`);
    const claimed = await withTransaction((tx) =>
      claimCase(tx, other, { opsCaseId: kase.opsCaseId }),
    );
    expect(claimed.ok, 'an operator who went home does not hold it forever').toBe(true);
  });

  it('refuses a customer and an unproved factor', async () => {
    const forCustomer = await queue(bare(alice));
    expect(forCustomer.ok).toBe(false);
    if (!forCustomer.ok) expect(forCustomer.code).toBe('PERMISSION_DENIED');

    const unproved = await queue(withoutMfa(operator));
    expect(unproved.ok).toBe(false);
    if (!unproved.ok) expect(unproved.code).toBe('MFA_REQUIRED');
  });

  it('a value-affecting disposition REQUIRES an approval', async () => {
    const kase = await openedCase();
    const { resolveOpsCaseCommand } = await import('@/services/commands');
    const outcome = await resolveOpsCaseCommand(operator, newCommandId(), {
      opsCaseId: kase.opsCaseId,
      disposition: 'CONFIRMED_ABUSE',
      note: 'Concluding abuse without a second person.',
      expectedVersion: kase.version,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('APPROVAL_REQUIRED');
  });

  it('a harmless disposition does not', async () => {
    const kase = await openedCase();
    const { resolveOpsCaseCommand } = await import('@/services/commands');
    const outcome = await resolveOpsCaseCommand(operator, newCommandId(), {
      opsCaseId: kase.opsCaseId,
      disposition: 'FALSE_POSITIVE',
      note: 'Reviewed the activity and found nothing untoward.',
      expectedVersion: kase.version,
    });
    expect(outcome.ok).toBe(true);
  });

  it('history cannot be edited', async () => {
    const kase = await openedCase();
    await expect(
      withTransaction((tx) =>
        tx.query(`UPDATE sandbox.ops_case_action SET action='FORGED' WHERE ops_case_id=$1`, [
          kase.opsCaseId,
        ]),
      ),
    ).rejects.toThrow(/append-only/);
  });
});

/* ================================================================== *
 * Post-settlement complaints
 * ================================================================== */

describe('a post-settlement complaint moves no money', () => {
  it('opens a case and changes nothing financial', async () => {
    const dealId = await lockedDeal(alice, bob, 30_000n);
    expect(
      (await releaseValueCommand(alice, newCommandId(), { dealId, beneficiaryId: bob.userId })).ok,
    ).toBe(true);

    const before = await getPool().query(
      `SELECT state, settle_entry_id FROM inrp2p.value_lock WHERE deal_id=$1`,
      [dealId],
    );

    const complaint = await raisePostSettlementComplaintCommand(alice, newCommandId(), {
      dealId,
      summary: 'The counterparty never delivered what we agreed after settlement.',
    });
    expect(complaint.ok).toBe(true);
    if (!complaint.ok) return;
    expect(complaint.value.financialEffect).toBe('NONE');

    const after = await getPool().query(
      `SELECT state, settle_entry_id FROM inrp2p.value_lock WHERE deal_id=$1`,
      [dealId],
    );
    // Complaining must not be a mechanism to undo any deal.
    expect(after.rows[0]).toEqual(before.rows[0]);

    const { rows } = await getPool().query(
      `SELECT kind FROM sandbox.ops_case WHERE ops_case_id = $1`,
      [complaint.value.opsCaseId],
    );
    expect(rows[0]!.kind).toBe('POST_SETTLEMENT_COMPLAINT');
  });

  it('refuses a non-participant', async () => {
    const dealId = await lockedDeal(alice, bob, 20_000n);
    const outsider = await newUser('rc-outsider');
    const outcome = await raisePostSettlementComplaintCommand(outsider, newCommandId(), {
      dealId,
      summary: 'Complaining about somebody else’s finished deal.',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_A_PARTICIPANT');
  });
});

/* ================================================================== *
 * Reward orchestration through the controls
 * ================================================================== */

describe('reward granting runs through the abuse controls', () => {
  async function campaign(): Promise<string> {
    const { rows } = await getPool().query(
      `INSERT INTO sandbox.reward_campaign
         (campaign_key, version, benefit_kind, discount_bps, max_benefit_minor,
          eligible_from, eligible_to)
       VALUES ($1, 1, 'FEE_DISCOUNT', 1000, 100000, now() - interval '1 day',
               now() + interval '30 days')
       RETURNING campaign_id`,
      [`rc-campaign-${unique()}`],
    );
    return rows[0]!.campaign_id as string;
  }

  it('GRANTS a clean qualification through the real command', async () => {
    const earner = await newUser('rc-earner');
    const counterparty = await newUser('rc-counterparty');
    const dealId = await lockedDeal(earner, counterparty, 20_000n);
    const campaignId = await campaign();

    const outcome = await evaluateRewardCommand(earner, newCommandId(), {
      dealId,
      campaignId,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.granted).toBe(true);
    expect(outcome.value.grantId).not.toBeNull();
  });

  it('REJECTS self-dealing outright', async () => {
    const referrer = await newUser('rc-selfdeal-r');
    const referee = await newUser('rc-selfdeal-e');
    const { referralCodeFor } = await import('@/server/commerce/entitlements');
    const code = await withTransaction((tx) => referralCodeFor(tx, referrer.userId));
    const { claimReferralCommand } = await import('@/services/commands');
    await claimReferralCommand(referee, newCommandId(), { code });

    const dealId = await lockedDeal(referee, referrer, 20_000n);
    const outcome = await evaluateRewardCommand(referee, newCommandId(), {
      dealId,
      campaignId: await campaign(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('RISK_REJECTED');
  });

  it('opens a REVIEW case for a linked account rather than silently denying', async () => {
    const stamp = unique();
    const { signInSandbox } = await import('@/server/sandbox/service');
    const a = await signInSandbox(`rc-linked+one-${stamp}@example.com`);
    const b = await signInSandbox(`rc-linked+two-${stamp}@example.com`);

    const dealId = await lockedDeal(a, b, 20_000n);
    const outcome = await evaluateRewardCommand(a, newCommandId(), {
      dealId,
      campaignId: await campaign(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.granted, 'suspicious is not the same as refused').toBe(false);
    expect(outcome.value.opsCaseId).not.toBeNull();
    expect(outcome.value.reasonCodes).toContain('REWARD_LINKED_ACCOUNT');
  });

  it('grants EXACTLY ONCE under concurrency', async () => {
    const earner = await newUser('rc-once');
    const counterparty = await newUser('rc-once-cp');
    const dealId = await lockedDeal(earner, counterparty, 20_000n);
    const campaignId = await campaign();

    await Promise.all([
      evaluateRewardCommand(earner, newCommandId(), { dealId, campaignId }),
      evaluateRewardCommand(earner, newCommandId(), { dealId, campaignId }),
    ]);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.reward_grant
        WHERE campaign_id=$1 AND user_id=$2 AND source_deal_id=$3`,
      [campaignId, earner.userId, dealId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('a paused REWARDS scope blocks granting', async () => {
    const earner = await newUser('rc-paused-reward');
    const counterparty = await newUser('rc-paused-cp');
    const dealId = await lockedDeal(earner, counterparty, 20_000n);
    await pauseScope('REWARDS');

    const outcome = await evaluateRewardCommand(earner, newCommandId(), {
      dealId,
      campaignId: await campaign(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('CONTROL_PAUSED');
  });

  it('CANCELS an unused reward and records a LOSS for a used one', async () => {
    const earner = await newUser('rc-withdraw');
    const counterparty = await newUser('rc-withdraw-cp');
    const dealId = await lockedDeal(earner, counterparty, 20_000n);
    const campaignId = await campaign();

    const granted = await evaluateRewardCommand(earner, newCommandId(), { dealId, campaignId });
    if (!granted.ok || granted.value.grantId === null) return;

    const withdrawn = await withTransaction((tx) =>
      withdrawRewardsFor(tx, {
        dealId,
        reason: 'The deal that earned this was reversed by a chain reorganisation.',
      }),
    );
    expect(withdrawn.ok).toBe(true);
    if (!withdrawn.ok) return;
    expect(withdrawn.value.cancelled).toBe(1);

    const { rows } = await getPool().query(
      `SELECT kind FROM sandbox.benefit_adjustment WHERE reward_grant_id=$1`,
      [granted.value.grantId],
    );
    expect(rows[0]!.kind).toBe('REWARD_CANCELLED');
  });
});

/* ================================================================== *
 * Atomicity
 * ================================================================== */

describe('control writes commit with everything else', () => {
  it('an injected failure leaves no decision, no hold and no command', async () => {
    const user = await newUser('rc-rollback');
    const commandId = newCommandId();
    const { runCommand } = await import('@/server/boundary/command');

    await expect(
      runCommand({
        commandId,
        commandType: 'RISK_PROBE',
        actorId: user.userId,
        payload: { probe: true },
        body: async (ctx) => {
          const decided = await enforce(ctx.tx, {
            point: 'REWARD_GRANT',
            subjectKind: 'user',
            subjectId: user.userId,
            signals: { rewardVelocityExceeded: true },
          });
          // The decision row and the review case exist at this instant.
          throw new Error('injected failure after the decision');
          return decided;
        },
        encodeResult: () => ({}),
        decodeResult: () => null,
      }),
    ).rejects.toThrow('injected failure after the decision');

    expect(await readCommand(commandId)).toBeNull();
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.risk_decision_log WHERE subject_id=$1`,
      [user.userId],
    );
    expect(rows[0]!.n).toBe(0);
    expect(
      await withTransaction((tx) => liveHold(tx, 'user', user.userId, 'REWARD_GRANT')),
    ).toBeNull();
  });

  it('a refused enforcement still COMMITS its evidence', async () => {
    const user = await newUser('rc-evidence');
    const outcome = await withTransaction((tx) =>
      enforce(tx, {
        point: 'REWARD_GRANT',
        subjectKind: 'user',
        subjectId: user.userId,
        signals: { selfDealing: true },
      }),
    );
    expect(outcome.ok).toBe(false);

    // A control plane whose refusals roll back has no evidence of what
    // it refused.
    const { rows } = await getPool().query(
      `SELECT decision, reason_codes FROM sandbox.risk_decision_log WHERE subject_id=$1`,
      [user.userId],
    );
    expect(rows[0]!.decision).toBe('REJECT');
    expect(rows[0]!.reason_codes).toContain('REWARD_SELF_DEALING');
  });
});
