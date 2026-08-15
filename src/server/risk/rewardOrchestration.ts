import 'server-only';
import { type Tx } from '@/server/db/pool';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { deploymentMode } from '@/server/adapters/mode';
import { enforce } from './engine';
import { consumeLimit } from './limits';
import { openCase } from './cases';

/**
 * Reward granting — the orchestration DEL-07 deliberately deferred.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  DEL-07 BUILT REWARDS AND REFUSED TO GRANT THEM AUTOMATICALLY,     │
 * │  BECAUSE THE ANTI-ABUSE CONTROLS DID NOT EXIST YET.                │
 * │                                                                    │
 * │  They exist now, so this is the connection: a completed deal is    │
 * │  evaluated for abuse signals, put through the risk engine, checked │
 * │  against velocity limits, and only then granted — exactly once.    │
 * │                                                                    │
 * │  Suspicious qualification does not silently fail and does not      │
 * │  silently grant. It opens a REVIEW case, so a person decides and   │
 * │  the customer is not quietly denied something they earned.         │
 * └────────────────────────────────────────────────────────────────────┘
 */

export interface AbuseSignals {
  readonly selfDealing: boolean;
  readonly linkedAccount: boolean;
  readonly repeatedCounterparty: number;
  readonly rewardVelocityExceeded: boolean;
}

/**
 * Gather the abuse signals for a completed deal.
 *
 * Every one is derived from what the platform OBSERVED — who dealt with
 * whom, how often, from where. None is a judgement, and none is a
 * protected attribute.
 */
export async function abuseSignalsFor(
  tx: Tx,
  input: { readonly dealId: string; readonly userId: string },
): Promise<AbuseSignals> {
  const { rows: seats } = await tx.query(
    `SELECT user_id FROM sandbox.participant WHERE deal_id = $1`,
    [input.dealId],
  );
  const counterparty = seats.map((s) => s.user_id as string).find((id) => id !== input.userId);

  /*
   * SELF-DEALING: the counterparty is this account's own referrer, or
   * its referee. One person with two accounts is the single most common
   * reward-farming pattern and the cheapest to detect honestly.
   */
  const { rows: related } = await tx.query(
    `SELECT 1 FROM sandbox.referral_attribution
      WHERE (referrer_id = $1 AND referee_id = $2)
         OR (referrer_id = $2 AND referee_id = $1)`,
    [input.userId, counterparty ?? input.userId],
  );

  /*
   * LINKED ACCOUNT: the two addresses are plus-aliases of one mailbox.
   *
   * `alice+1@x` and `alice+2@x` deliver to the same person, and using
   * them to be two customers is the cheapest reward-farming technique
   * there is. Detecting it needs nothing but the addresses already on
   * file.
   *
   * A shared device, IP or payment instrument would be a stronger
   * signal, and this repository records NONE of those. Rather than
   * imply a device-fingerprinting capability that does not exist, this
   * check is limited to what is genuinely observable — and DEL-08's
   * scope explicitly leaves broader correlation to a future stage with
   * the data to support it.
   */
  const { rows: linked } = await tx.query(
    `SELECT 1
       FROM sandbox.app_user a
       JOIN sandbox.app_user b
         ON split_part(lower(a.email), '@', 2) = split_part(lower(b.email), '@', 2)
        AND split_part(split_part(lower(a.email), '@', 1), '+', 1)
          = split_part(split_part(lower(b.email), '@', 1), '+', 1)
      WHERE a.user_id = $1 AND b.user_id = $2 AND a.user_id <> b.user_id`,
    [input.userId, counterparty ?? input.userId],
  );

  const { rows: repeats } = await tx.query(
    `SELECT count(*)::int AS n
       FROM sandbox.participant p1
       JOIN sandbox.participant p2 ON p2.deal_id = p1.deal_id AND p2.user_id <> p1.user_id
      WHERE p1.user_id = $1 AND p2.user_id = $2`,
    [input.userId, counterparty ?? input.userId],
  );

  const { rows: velocity } = await tx.query(
    `SELECT count(*)::int AS n FROM sandbox.reward_grant
      WHERE user_id = $1 AND created_at > now() - interval '1 day'`,
    [input.userId],
  );

  return {
    selfDealing: related.length > 0,
    linkedAccount: linked.length > 0,
    repeatedCounterparty: Number(repeats[0]?.n ?? 0),
    rewardVelocityExceeded: Number(velocity[0]?.n ?? 0) >= 10,
  };
}

export interface GrantOutcome {
  readonly granted: boolean;
  readonly grantId: string | null;
  readonly opsCaseId: string | null;
  readonly reasonCodes: readonly string[];
}

/**
 * Evaluate a completed deal for a reward, and grant it if it is clean.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  EXACTLY ONCE, DECIDED BY THE DATABASE.                            │
 * │                                                                    │
 * │  `reward_grant_source_uq` covers (campaign, user, source deal), so │
 * │  a redelivered completion — or two concurrent ones — insert once.  │
 * │  The code does not count; the index does.                          │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function evaluateRewardFor(
  tx: Tx,
  input: {
    readonly dealId: string;
    readonly userId: string;
    readonly campaignId: string;
    readonly commandId: string;
  },
): Promise<Outcome<GrantOutcome>> {
  const { rows: campaign } = await tx.query(
    `SELECT campaign_id, grant_ttl_days, sandbox_only, eligible_from, eligible_to
       FROM sandbox.reward_campaign WHERE campaign_id = $1`,
    [input.campaignId],
  );
  if (campaign[0] === undefined) {
    return reject('CAMPAIGN_UNAVAILABLE', FAILURE_COPY.CAMPAIGN_UNAVAILABLE.reason);
  }
  /*
   * A sandbox-only campaign cannot run in production. A demonstration
   * reward reaching a real customer is a real liability.
   */
  if (campaign[0].sandbox_only === true && deploymentMode() === 'PRODUCTION') {
    return reject('CAMPAIGN_UNAVAILABLE', FAILURE_COPY.CAMPAIGN_UNAVAILABLE.reason);
  }

  const { rows: window } = await tx.query(
    `SELECT now() BETWEEN eligible_from AND eligible_to AS open
       FROM sandbox.reward_campaign WHERE campaign_id = $1`,
    [input.campaignId],
  );
  if (window[0]?.open !== true) {
    return reject('REWARD_NOT_ELIGIBLE', FAILURE_COPY.REWARD_NOT_ELIGIBLE.reason);
  }

  const signals = await abuseSignalsFor(tx, input);

  /* ---- THE RISK GATE ---- */
  const decision = await enforce(tx, {
    point: 'REWARD_GRANT',
    subjectKind: 'user',
    subjectId: input.userId,
    actorId: input.userId,
    commandId: input.commandId,
    signals: {
      selfDealing: signals.selfDealing,
      linkedAccount: signals.linkedAccount,
      repeatedCounterparty: signals.repeatedCounterparty,
      rewardVelocityExceeded: signals.rewardVelocityExceeded,
    },
  });

  if (!decision.ok) {
    // HOLD or REJECT. Nothing is granted, and the refusal is recorded
    // by the engine with its reason codes.
    return decision;
  }

  if (decision.value.decision === 'REVIEW') {
    /*
     * SUSPICIOUS, NOT REFUSED.
     *
     * A person decides. Silently denying somebody a reward they may
     * genuinely have earned — with no case and no explanation — is the
     * failure mode this branch exists to avoid.
     */
    const opened = await openCase(tx, {
      kind: 'REWARD_ABUSE',
      subjectKind: 'user',
      subjectId: input.userId,
      correlationKey: `reward-review:${input.userId}:${input.dealId}`,
      summary: `Reward qualification for deal ${input.dealId} needs review.`,
      reasonCodes: decision.value.reasonCodes,
      priority: 60,
    });
    return accept({
      granted: false,
      grantId: null,
      opsCaseId: opened.ok ? opened.value.opsCase.opsCaseId : null,
      reasonCodes: decision.value.reasonCodes,
    });
  }

  /* ---- Velocity, consumed atomically ---- */
  const velocity = await consumeLimit(tx, {
    limitKey: 'reward.velocity',
    scopeId: input.userId,
    consumptionKey: `reward:${input.campaignId}:${input.dealId}:${input.userId}`,
    count: 1,
  });
  if (!velocity.ok) return velocity;

  /* ---- The grant, exactly once ---- */
  const { rows } = await tx.query(
    `INSERT INTO sandbox.reward_grant (campaign_id, user_id, source_deal_id, expires_at)
     SELECT $1, $2, $3, now() + make_interval(days => c.grant_ttl_days)
       FROM sandbox.reward_campaign c WHERE c.campaign_id = $1
     ON CONFLICT DO NOTHING
     RETURNING grant_id`,
    [input.campaignId, input.userId, input.dealId],
  );

  if (rows[0] === undefined) {
    // Already granted for this deal. A redelivered completion is a
    // no-op, not a second reward.
    const { rows: prior } = await tx.query(
      `SELECT grant_id FROM sandbox.reward_grant
        WHERE campaign_id = $1 AND user_id = $2 AND source_deal_id = $3`,
      [input.campaignId, input.userId, input.dealId],
    );
    return accept({
      granted: false,
      grantId: (prior[0]?.grant_id as string | undefined) ?? null,
      opsCaseId: null,
      reasonCodes: ['ALREADY_GRANTED'],
    });
  }

  return accept({
    granted: true,
    grantId: rows[0].grant_id as string,
    opsCaseId: null,
    reasonCodes: decision.value.reasonCodes,
  });
}

/**
 * Withdraw a reward after the deal that earned it went wrong.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  AN UNUSED REWARD IS CANCELLED. A USED ONE IS NOT CLAWED BACK.     │
 * │                                                                    │
 * │  Taking value from a customer's balance because the platform's own │
 * │  deal reversed is a silent debit, and this system does not do      │
 * │  that. A consumed benefit becomes a recorded LOSS instead —        │
 * │  visible, attributable, and the platform's to absorb.              │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function withdrawRewardsFor(
  tx: Tx,
  input: { readonly dealId: string; readonly reason: string },
): Promise<Outcome<{ cancelled: number; losses: number }>> {
  const { rows } = await tx.query(
    `SELECT grant_id, user_id, state FROM sandbox.reward_grant
      WHERE source_deal_id = $1 FOR UPDATE`,
    [input.dealId],
  );

  let cancelled = 0;
  let losses = 0;

  for (const grant of rows) {
    if (grant.state === 'GRANTED') {
      await tx.query(
        `UPDATE sandbox.reward_grant SET state='CANCELLED', cancelled_reason=$2
          WHERE grant_id=$1 AND state='GRANTED'`,
        [grant.grant_id, input.reason],
      );
      await tx.query(
        `INSERT INTO sandbox.benefit_adjustment
           (user_id, kind, deal_id, reward_grant_id, reason)
         VALUES ($1,'REWARD_CANCELLED',$2,$3,$4)`,
        [grant.user_id, input.dealId, grant.grant_id, input.reason],
      );
      cancelled += 1;
      continue;
    }

    if (grant.state === 'REDEEMED') {
      // Already spent. Recorded as a loss the platform absorbs — never
      // debited from the customer.
      await tx.query(
        `INSERT INTO sandbox.benefit_adjustment
           (user_id, kind, deal_id, reward_grant_id, reason)
         VALUES ($1,'BENEFIT_ALREADY_CONSUMED_LOSS',$2,$3,$4)`,
        [
          grant.user_id,
          input.dealId,
          grant.grant_id,
          `${input.reason} The benefit was already used and is not being reclaimed.`,
        ],
      );
      losses += 1;
    }
  }

  return accept({ cancelled, losses });
}
