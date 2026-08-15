import 'server-only';
import { getPool, type Tx } from '@/server/db/pool';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';

/**
 * Limits and counters.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A LIMIT IS ONLY A LIMIT IF CONCURRENCY CANNOT OVERSHOOT IT.       │
 * │                                                                    │
 * │  The naive shape — read the total, compare, then write — lets two  │
 * │  simultaneous requests both read the same total and both pass. At  │
 * │  the boundary, which is the only moment a limit matters, it fails. │
 * │                                                                    │
 * │  So consumption is ONE statement: `INSERT ... ON CONFLICT DO       │
 * │  UPDATE ... RETURNING`, which takes the counter's row lock and     │
 * │  returns the post-increment total. Two callers serialise, the      │
 * │  second sees the first's effect, and the check is made on a number │
 * │  that is already committed to.                                     │
 * │                                                                    │
 * │  An overshoot is then UNDONE inside the same transaction rather    │
 * │  than prevented by a prior read — which is the only ordering that  │
 * │  is actually safe under concurrency.                               │
 * └────────────────────────────────────────────────────────────────────┘
 */

export interface LimitDefinition {
  readonly limitKey: string;
  readonly scopeKind: 'user' | 'corridor' | 'global';
  readonly maxAmount: bigint | null;
  readonly maxCount: number | null;
  readonly windowSeconds: number;
  readonly hard: boolean;
}

export interface LimitVerdict {
  readonly limitKey: string;
  readonly allowed: boolean;
  readonly hard: boolean;
  readonly totalAmount: string;
  readonly totalCount: number;
  readonly maxAmount: string | null;
  readonly maxCount: number | null;
}

export async function limitDefinition(tx: Tx, limitKey: string): Promise<LimitDefinition | null> {
  const { rows } = await tx.query(
    `SELECT limit_key, scope_kind, max_amount::text AS max_amount, max_count,
            window_seconds, hard
       FROM sandbox.risk_limit WHERE limit_key = $1 AND active`,
    [limitKey],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return {
    limitKey: r.limit_key as string,
    scopeKind: r.scope_kind as 'user' | 'corridor' | 'global',
    maxAmount: r.max_amount === null ? null : BigInt(r.max_amount as string),
    maxCount: r.max_count === null ? null : Number(r.max_count),
    windowSeconds: Number(r.window_seconds),
    hard: r.hard as boolean,
  };
}

/**
 * Consume a limit, exactly once per `consumptionKey`.
 *
 * The key is derived by the CALLER from the underlying command, so a
 * retried request records one consumption. The window start comes from
 * the DATABASE clock via `to_timestamp(floor(...))`, so a skewed
 * application server cannot open itself a fresh window.
 */
export async function consumeLimit(
  tx: Tx,
  input: {
    readonly limitKey: string;
    readonly scopeId: string;
    readonly consumptionKey: string;
    readonly amount?: bigint;
    readonly count?: number;
  },
): Promise<Outcome<LimitVerdict>> {
  const definition = await limitDefinition(tx, input.limitKey);
  if (definition === null) {
    // An undefined limit constrains nothing. Recorded as allowed rather
    // than silently skipped, so a missing definition is visible.
    return accept({
      limitKey: input.limitKey,
      allowed: true,
      hard: false,
      totalAmount: '0',
      totalCount: 0,
      maxAmount: null,
      maxCount: null,
    });
  }

  const amount = input.amount ?? 0n;
  const count = input.count ?? 1;

  /*
   * IDEMPOTENCY FIRST. If this consumption was already recorded, the
   * counter already includes it — re-adding would double-count a retry,
   * which is how an honest customer hits a limit they never reached.
   */
  const claim = await tx.query(
    `INSERT INTO sandbox.risk_consumption
       (consumption_key, limit_key, scope_id, amount, count_delta)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (consumption_key) DO NOTHING
     RETURNING consumption_id`,
    [input.consumptionKey, input.limitKey, input.scopeId, amount.toString(), count],
  );

  const windowSql = `to_timestamp(floor(extract(epoch from now()) / $1) * $1)`;

  if (claim.rowCount === 0) {
    // Already counted. Report the current standing without adding.
    const { rows } = await tx.query(
      `SELECT coalesce(total_amount, 0)::text AS total_amount, coalesce(total_count, 0) AS total_count
         FROM sandbox.risk_counter
        WHERE limit_key = $2 AND scope_id = $3 AND window_start = ${windowSql}`,
      [definition.windowSeconds, input.limitKey, input.scopeId],
    );
    const totalAmount = BigInt((rows[0]?.total_amount as string) ?? '0');
    const totalCount = Number(rows[0]?.total_count ?? 0);
    return accept(verdict(definition, totalAmount, totalCount));
  }

  /*
   * ONE STATEMENT: increment and read the post-increment total under
   * the row lock. This is the whole concurrency guarantee.
   */
  const { rows } = await tx.query(
    `INSERT INTO sandbox.risk_counter (limit_key, scope_id, window_start, total_amount, total_count)
     VALUES ($2, $3, ${windowSql}, $4, $5)
     ON CONFLICT (limit_key, scope_id, window_start) DO UPDATE
       SET total_amount = sandbox.risk_counter.total_amount + EXCLUDED.total_amount,
           total_count  = sandbox.risk_counter.total_count  + EXCLUDED.total_count,
           updated_at   = now()
     RETURNING total_amount::text AS total_amount, total_count`,
    [definition.windowSeconds, input.limitKey, input.scopeId, amount.toString(), count],
  );

  const totalAmount = BigInt(rows[0]!.total_amount as string);
  const totalCount = Number(rows[0]!.total_count);
  const result = verdict(definition, totalAmount, totalCount);

  if (!result.allowed && definition.hard) {
    /*
     * A HARD limit was exceeded, so the consumption is UNDONE — the
     * request is not proceeding, and leaving the increment in place
     * would consume budget the customer never actually used.
     *
     * Undone additively (a correcting row), never by deleting the
     * original: the record that the attempt happened is worth keeping.
     */
    await tx.query(
      `INSERT INTO sandbox.risk_consumption
         (consumption_key, limit_key, scope_id, amount, count_delta, corrects)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        `${input.consumptionKey}:undo`,
        input.limitKey,
        input.scopeId,
        (-amount).toString(),
        -count,
        claim.rows[0]!.consumption_id,
      ],
    );
    await tx.query(
      `UPDATE sandbox.risk_counter
          SET total_amount = total_amount - $4, total_count = total_count - $5,
              updated_at = now()
        WHERE limit_key = $2 AND scope_id = $3 AND window_start = ${windowSql}`,
      [definition.windowSeconds, input.limitKey, input.scopeId, amount.toString(), count],
    );

    return reject('LIMIT_EXCEEDED', FAILURE_COPY.LIMIT_EXCEEDED.reason, {
      limitKey: input.limitKey,
      maxAmount: result.maxAmount,
      maxCount: result.maxCount,
    });
  }

  return accept(result);
}

function verdict(
  definition: LimitDefinition,
  totalAmount: bigint,
  totalCount: number,
): LimitVerdict {
  const overAmount = definition.maxAmount !== null && totalAmount > definition.maxAmount;
  const overCount = definition.maxCount !== null && totalCount > definition.maxCount;
  return {
    limitKey: definition.limitKey,
    allowed: !overAmount && !overCount,
    hard: definition.hard,
    totalAmount: totalAmount.toString(),
    totalCount,
    maxAmount: definition.maxAmount?.toString() ?? null,
    maxCount: definition.maxCount,
  };
}

/**
 * Correct a consumption after the fact, additively.
 *
 * Used when a counted event turns out not to have happened — a reversed
 * deal, a refunded payment. The original consumption stays; a negative
 * one is added beside it, so the history reads "this counted, then it
 * stopped counting".
 */
export async function correctConsumption(
  tx: Tx,
  input: { readonly consumptionKey: string; readonly reason: string },
): Promise<Outcome<{ corrected: boolean }>> {
  const { rows } = await tx.query(
    `SELECT consumption_id, limit_key, scope_id, amount::text AS amount, count_delta
       FROM sandbox.risk_consumption WHERE consumption_key = $1`,
    [input.consumptionKey],
  );
  const r = rows[0];
  if (r === undefined) return accept({ corrected: false });

  const definition = await limitDefinition(tx, r.limit_key as string);
  if (definition === null) return accept({ corrected: false });

  const inserted = await tx.query(
    `INSERT INTO sandbox.risk_consumption
       (consumption_key, limit_key, scope_id, amount, count_delta, corrects)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (consumption_key) DO NOTHING
     RETURNING consumption_id`,
    [
      `${input.consumptionKey}:correction`,
      r.limit_key,
      r.scope_id,
      (-BigInt(r.amount as string)).toString(),
      -Number(r.count_delta),
      r.consumption_id,
    ],
  );
  if (inserted.rowCount === 0) return accept({ corrected: false });

  await tx.query(
    `UPDATE sandbox.risk_counter
        SET total_amount = greatest(total_amount - $3, 0),
            total_count = greatest(total_count - $4, 0),
            updated_at = now()
      WHERE limit_key = $1 AND scope_id = $2
        AND window_start > now() - make_interval(secs => $5)`,
    [
      r.limit_key,
      r.scope_id,
      BigInt(r.amount as string).toString(),
      Number(r.count_delta),
      definition.windowSeconds,
    ],
  );
  return accept({ corrected: true });
}

/** What a subject has consumed in the current window. */
export async function consumptionFor(
  scopeId: string,
): Promise<readonly { limitKey: string; totalAmount: string; totalCount: number }[]> {
  const { rows } = await getPool().query(
    `SELECT limit_key, total_amount::text AS total_amount, total_count
       FROM sandbox.limit_consumption WHERE scope_id = $1 ORDER BY limit_key`,
    [scopeId],
  );
  return rows.map((r) => ({
    limitKey: r.limit_key as string,
    totalAmount: r.total_amount as string,
    totalCount: Number(r.total_count),
  }));
}
