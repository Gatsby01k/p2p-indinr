import 'server-only';
import { getPool } from '@/server/db/pool';

/**
 * Abuse limits on every credential endpoint.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  IN THE DATABASE, NOT IN MEMORY.                                   │
 * │                                                                    │
 * │  This deployment is serverless: many instances, each with its own  │
 * │  heap, none of which sees the others' counters. An in-memory       │
 * │  limiter would therefore permit `limit × instances` attempts and   │
 * │  would loosen silently as traffic grew — the failure mode where a  │
 * │  control looks present and is not.                                 │
 * │                                                                    │
 * │  A fixed window is used rather than a sliding one because the      │
 * │  guarantee that matters here is a hard ceiling per interval, and a │
 * │  fixed window gives that in a single atomic upsert. The known cost │
 * │  is a burst at a window edge — bounded at twice the limit, which   │
 * │  for "eight sign-in codes an hour" is not a meaningful weakness.   │
 * └────────────────────────────────────────────────────────────────────┘
 */

export interface RateRule {
  readonly scope: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * The limits, stated once.
 *
 * Deliberately generous enough that an honest person retrying a flaky
 * connection never meets them, and tight enough that enumeration and
 * credential-stuffing are not viable.
 */
export const RATE_RULES = {
  /** Requesting a sign-in code, per address. */
  SIGN_IN_REQUEST: { scope: 'SIGN_IN_REQUEST', limit: 5, windowSeconds: 15 * 60 },
  /** Presenting a code, per address. Tighter: this one is guessable. */
  SIGN_IN_VERIFY: { scope: 'SIGN_IN_VERIFY', limit: 10, windowSeconds: 15 * 60 },
  /** Telegram launches, per Telegram id. */
  TELEGRAM_AUTH: { scope: 'TELEGRAM_AUTH', limit: 30, windowSeconds: 15 * 60 },
  /** Second-factor attempts, per user. */
  MFA_VERIFY: { scope: 'MFA_VERIFY', limit: 10, windowSeconds: 15 * 60 },
  /** Recovery-code use, per user. Very tight: it bypasses the factor. */
  MFA_RECOVERY: { scope: 'MFA_RECOVERY', limit: 5, windowSeconds: 60 * 60 },
  /** Session operations that a script could abuse, per user. */
  SESSION_MUTATE: { scope: 'SESSION_MUTATE', limit: 30, windowSeconds: 15 * 60 },
} as const satisfies Record<string, RateRule>;

export interface RateVerdict {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

/**
 * Count one attempt and say whether it is permitted.
 *
 * The upsert is atomic, so two concurrent requests cannot both read a
 * count below the limit and both proceed — the `count` returned is
 * post-increment and is the authority.
 *
 * The attempt is counted whether or not it succeeds, which is the point:
 * a limiter that only counted failures would let an attacker who
 * occasionally guesses right keep going indefinitely.
 */
export async function consumeRate(rule: RateRule, subject: string): Promise<RateVerdict> {
  const { rows } = await getPool().query(
    `INSERT INTO sandbox.rate_bucket (scope, subject, window_start, count)
     VALUES ($1, $2, to_timestamp(floor(extract(epoch FROM now()) / $3) * $3), 1)
     ON CONFLICT (scope, subject, window_start)
       DO UPDATE SET count = sandbox.rate_bucket.count + 1
     RETURNING count, window_start`,
    [rule.scope, subject.slice(0, 200), rule.windowSeconds],
  );
  const count = Number(rows[0]!.count);
  const windowStart = rows[0]!.window_start as Date;
  const resetAt = windowStart.getTime() + rule.windowSeconds * 1000;

  return {
    allowed: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSeconds: Math.max(0, Math.ceil((resetAt - Date.now()) / 1000)),
  };
}

/** Read the current usage without consuming. For tests and diagnostics. */
export async function peekRate(rule: RateRule, subject: string): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT count FROM sandbox.rate_bucket
      WHERE scope = $1 AND subject = $2
        AND window_start = to_timestamp(floor(extract(epoch FROM now()) / $3) * $3)`,
    [rule.scope, subject.slice(0, 200), rule.windowSeconds],
  );
  return rows[0] ? Number(rows[0].count) : 0;
}

/** Discard expired windows. DEL-09 schedules this alongside the sweep. */
export async function pruneRateBuckets(olderThanSeconds = 24 * 60 * 60): Promise<number> {
  const { rowCount } = await getPool().query(
    `DELETE FROM sandbox.rate_bucket WHERE window_start < now() - ($1 || ' seconds')::interval`,
    [String(olderThanSeconds)],
  );
  return rowCount ?? 0;
}
