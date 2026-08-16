import { getPool } from '@/server/db/pool';

/**
 * The live fee schedule, discovered rather than assumed.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHY THE COMMERCIAL TESTS WERE ORDER-DEPENDENT — AND WORSE.        │
 * │                                                                    │
 * │  They asserted absolute version numbers (`toBe(1)`, `toBe(2)`,     │
 * │  `toBe(3)`) against a table that only ever grows. On a second run  │
 * │  the seeded schedule is already at version 3, so the first         │
 * │  assertion fails.                                                  │
 * │                                                                    │
 * │  The damage was not the failed assertion. The immutability test    │
 * │  activates a deliberately PUNITIVE schedule and rolls it back on   │
 * │  the following line — so when an assertion between those two       │
 * │  points threw, the rollback never ran and the punitive schedule    │
 * │  stayed live. One failure permanently re-priced every case in      │
 * │  every later run, which is exactly how the database reached        │
 * │  `protected-inr` v5 ACTIVE at 900bps.                              │
 * │                                                                    │
 * │  So: read the live terms instead of assuming them, and restore in  │
 * │  a `finally` so a failing assertion cannot poison the fixture.     │
 * └────────────────────────────────────────────────────────────────────┘
 */
export interface LivePolicy {
  readonly policyId: string;
  readonly policyKey: string;
  readonly version: number;
  readonly bps: bigint;
  readonly fixedMinor: bigint;
  readonly minFeeMinor: bigint;
  readonly maxFeeMinor: bigint;
  readonly discountCapBps: bigint;
}

/** The schedule a quote in this corridor will actually be priced by. */
export async function activePolicy(scenario: string): Promise<LivePolicy> {
  const { rows } = await getPool().query(
    `SELECT policy_id, policy_key, version, bps, fixed_minor,
            min_fee_minor, max_fee_minor, discount_cap_bps
       FROM sandbox.fee_policy
      WHERE scenario = $1 AND state = 'ACTIVE'`,
    [scenario],
  );
  if (rows.length !== 1) {
    // `fee_policy_active_uq` makes this impossible; if it ever fires the
    // invariant itself has broken and the test should say so loudly.
    throw new Error(`expected exactly one ACTIVE policy for ${scenario}, found ${rows.length}`);
  }
  const r = rows[0]!;
  return {
    policyId: String(r.policy_id),
    policyKey: String(r.policy_key),
    version: Number(r.version),
    bps: BigInt(r.bps),
    fixedMinor: BigInt(r.fixed_minor),
    minFeeMinor: BigInt(r.min_fee_minor),
    maxFeeMinor: BigInt(r.max_fee_minor),
    discountCapBps: BigInt(r.discount_cap_bps),
  };
}

/**
 * The base fee the live schedule produces for an amount.
 *
 * Mirrors the server's rule so a test can assert the quote matches the
 * schedule that priced it, whatever version that happens to be, instead
 * of hard-coding a figure that is only true on a virgin database.
 */
export function expectedBaseFee(policy: LivePolicy, amountMinor: bigint): bigint {
  const raw = (amountMinor * policy.bps) / 10_000n + policy.fixedMinor;
  if (raw < policy.minFeeMinor) return policy.minFeeMinor;
  if (raw > policy.maxFeeMinor) return policy.maxFeeMinor;
  return raw;
}

/**
 * Run a body with a temporary schedule, and put the original back even
 * if the body throws.
 *
 * `activate` is the caller's maker-checker activation function — the
 * real command path, never a direct write — so the restoration is
 * itself a genuine two-person activation rather than a shortcut around
 * the control being tested.
 */
export async function withTemporaryPolicy<T>(
  scenario: string,
  activate: (terms: {
    bps: bigint;
    fixedMinor: bigint;
    minFeeMinor: bigint;
    maxFeeMinor: bigint;
    rationale: string;
  }) => Promise<{ version: number }>,
  temporary: {
    bps: bigint;
    fixedMinor: bigint;
    minFeeMinor: bigint;
    maxFeeMinor: bigint;
    rationale: string;
  },
  body: (activated: { version: number }, baseline: LivePolicy) => Promise<T>,
): Promise<T> {
  const baseline = await activePolicy(scenario);
  const activated = await activate(temporary);
  try {
    return await body(activated, baseline);
  } finally {
    // The whole point. A failure inside `body` must not leave the
    // deployment priced by the temporary schedule.
    await activate({
      bps: baseline.bps,
      fixedMinor: baseline.fixedMinor,
      minFeeMinor: baseline.minFeeMinor,
      maxFeeMinor: baseline.maxFeeMinor,
      rationale: 'Restoring the schedule that was live before this test.',
    });
  }
}
