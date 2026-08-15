import 'server-only';
import { getPool, type Tx } from '@/server/db/pool';
import { accept, type Outcome } from '@/server/boundary/outcome';

/**
 * Reputation — computed from immutable events, never stored as a score.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THERE IS NO `app_user.reputation` COLUMN, AND THERE MUST NOT BE.  │
 * │                                                                    │
 * │  A stored score is a number somebody can set. It drifts from the   │
 * │  events that justified it, it cannot answer "why is mine this?",   │
 * │  and the first support escalation ends with an operator editing    │
 * │  it. So the score is DERIVED, every time, from an append-only      │
 * │  event log with a versioned model — and any score can be           │
 * │  reproduced by replaying the events that produced it.              │
 * │                                                                    │
 * │  Corrections are ADDITIVE. A reversed deal adds a negative event   │
 * │  pointing at the positive one; it does not delete it. What was     │
 * │  believed, and when it stopped being true, both survive.           │
 * │                                                                    │
 * │  NO PROTECTED ATTRIBUTE PARTICIPATES. Every signal below is        │
 * │  conduct on this platform, and the list is closed by a CHECK       │
 * │  constraint so a future feature cannot quietly add one.            │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * REPUTATION GRANTS NOTHING. It is not consulted by any authorization
 * path, it cannot bypass verification or a value lock, it cannot confirm
 * a payment and it cannot influence a dispute. It is a number shown to
 * people, and a test asserts it stays that way.
 */

export type ReputationSignal =
  | 'DEAL_COMPLETED'
  | 'VOLUME_SETTLED'
  | 'PAID_ON_TIME'
  | 'PAID_LATE'
  | 'DEAL_CANCELLED'
  | 'DISPUTE_RAISED'
  | 'DISPUTE_LOST'
  | 'REVERSAL_INCIDENT'
  | 'EVIDENCE_PROVIDED'
  | 'ACCOUNT_VERIFIED'
  | 'CORRECTION';

/**
 * The scoring model, version 1.
 *
 * Weights live in code and are versioned with the module, so a score can
 * be reproduced by replaying events through a known model. Adverse
 * signals outweigh positive ones deliberately: a platform where ten good
 * deals erase one lost dispute is a platform where losing disputes is
 * cheap.
 */
export const REPUTATION_MODEL_VERSION = 1;

export const SIGNAL_POINTS: Readonly<Record<ReputationSignal, number>> = {
  DEAL_COMPLETED: 10,
  VOLUME_SETTLED: 2,
  PAID_ON_TIME: 5,
  PAID_LATE: -5,
  DEAL_CANCELLED: -2,
  DISPUTE_RAISED: 0, // Raising a dispute is a right, not a demerit.
  DISPUTE_LOST: -25,
  REVERSAL_INCIDENT: -15,
  EVIDENCE_PROVIDED: 3,
  ACCOUNT_VERIFIED: 15,
  CORRECTION: 0, // Carries its own explicit points.
};

/**
 * Record one signal, exactly once.
 *
 * `dedupKey` is derived by the CALLER from the underlying fact — the
 * deal id, the case id, the incident id — never from a timestamp or a
 * random value. `ON CONFLICT DO NOTHING` then makes a redelivered event
 * a no-op, which is the property that stops a retried settlement
 * inflating somebody's rating.
 */
export async function recordSignal(
  tx: Tx,
  input: {
    readonly userId: string;
    readonly signal: ReputationSignal;
    readonly dedupKey: string;
    readonly dealId?: string | null;
    readonly points?: number;
    readonly corrects?: string | null;
    readonly detail?: Record<string, unknown>;
  },
): Promise<Outcome<{ eventId: string | null }>> {
  const points = input.points ?? SIGNAL_POINTS[input.signal];

  const { rows } = await tx.query(
    `INSERT INTO sandbox.reputation_event
       (user_id, signal, points, deal_id, dedup_key, corrects, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING event_id`,
    [
      input.userId,
      input.signal,
      points,
      input.dealId ?? null,
      input.dedupKey,
      input.corrects ?? null,
      JSON.stringify({ ...(input.detail ?? {}), model: REPUTATION_MODEL_VERSION }),
    ],
  );
  // `null` means the signal was already recorded. Not an error — it is
  // the deduplication doing its job.
  return accept({ eventId: (rows[0]?.event_id as string | undefined) ?? null });
}

/**
 * Correct an earlier signal, additively.
 *
 * The correction points AT the original and carries the inverse points.
 * Nothing is deleted, so the history reads: "this counted, then it
 * stopped counting, and here is why."
 */
export async function correctSignal(
  tx: Tx,
  input: {
    readonly userId: string;
    readonly correctsEventId: string;
    readonly dedupKey: string;
    readonly reason: string;
  },
): Promise<Outcome<{ eventId: string | null }>> {
  const { rows } = await tx.query(
    `SELECT points, deal_id FROM sandbox.reputation_event WHERE event_id = $1`,
    [input.correctsEventId],
  );
  if (rows[0] === undefined) return accept({ eventId: null });

  return recordSignal(tx, {
    userId: input.userId,
    signal: 'CORRECTION',
    dedupKey: input.dedupKey,
    dealId: (rows[0].deal_id as string | null) ?? null,
    points: -Number(rows[0].points),
    corrects: input.correctsEventId,
    detail: { reason: input.reason },
  });
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export type ReputationBand = 'NEW' | 'ESTABLISHED' | 'TRUSTED' | 'AT_RISK';

export interface ReputationStanding {
  readonly userId: string;
  readonly modelVersion: number;
  readonly points: number;
  readonly completedDeals: number;
  readonly band: ReputationBand;
}

/**
 * Bands, not raw scores, for anything a counterparty sees.
 *
 * A precise number invites reverse-engineering of the weights and turns
 * reputation into a game to be optimised. A band answers the question a
 * counterparty actually has — "is this person safe to deal with?" —
 * without publishing the internal signal.
 */
function bandFor(points: number, completedDeals: number): ReputationBand {
  if (points < 0) return 'AT_RISK';
  if (completedDeals >= 20 && points >= 200) return 'TRUSTED';
  if (completedDeals >= 3) return 'ESTABLISHED';
  return 'NEW';
}

export async function standingFor(userId: string): Promise<ReputationStanding> {
  const { rows } = await getPool().query(
    `SELECT coalesce(points, 0) AS points, coalesce(completed_deals, 0) AS completed_deals
       FROM sandbox.reputation_standing WHERE user_id = $1`,
    [userId],
  );
  const points = Number(rows[0]?.points ?? 0);
  const completedDeals = Number(rows[0]?.completed_deals ?? 0);
  return {
    userId,
    modelVersion: REPUTATION_MODEL_VERSION,
    points,
    completedDeals,
    band: bandFor(points, completedDeals),
  };
}

/**
 * Recompute a score from its source events.
 *
 * The function that makes "reproducible from source events" a testable
 * claim rather than an aspiration: it replays the log through the model
 * and must agree with the view, every time.
 */
export async function reproduceScore(userId: string): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT points FROM sandbox.reputation_event WHERE user_id = $1 ORDER BY occurred_at`,
    [userId],
  );
  return rows.reduce((total, r) => total + Number(r.points), 0);
}

/**
 * What a counterparty may see.
 *
 * Band and completed-deal count only. The raw points, the individual
 * adverse signals and anything resembling a risk flag stay internal —
 * publishing "this person lost two disputes" is a disclosure about them
 * that this stage has no mandate to make.
 */
export interface PublicReputation {
  readonly band: ReputationBand;
  readonly completedDeals: number;
  readonly memberSince: string | null;
}

export async function publicReputation(userId: string): Promise<PublicReputation> {
  const standing = await standingFor(userId);
  const { rows } = await getPool().query(
    `SELECT created_at FROM sandbox.app_user WHERE user_id = $1`,
    [userId],
  );
  return {
    band: standing.band,
    completedDeals: standing.completedDeals,
    memberSince: rows[0] ? (rows[0].created_at as Date).toISOString().slice(0, 10) : null,
  };
}
