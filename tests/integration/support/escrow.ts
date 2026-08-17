import { getPool } from '@/server/db/pool';
import { grantRole, permissionsFor, type Principal } from '@/server/identity/rbac';
import { newCommandId } from '@/server/boundary/command';
import { fundSandboxCommand } from '@/services/commands';
import type { SessionUser } from '@/server/sandbox/service';
import { makeOperator } from './operator';
import { unique } from './room';

/**
 * Fixture support for a world where escrow is real.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  JOINING A DEAL USED TO BE FREE. IT IS NOT ANY MORE.               │
 * │                                                                    │
 * │  The value-protection adapter returned a synthetic string and held │
 * │  nothing, so a fixture could open unlimited deals with accounts    │
 * │  that owned nothing and the risk counter never moved. Wiring the   │
 * │  ledger in changed two things at once for every suite that joins:  │
 * │                                                                    │
 * │    · the crypto side must actually HOLD the asset, and             │
 * │    · each deal now counts toward that account's rolling exposure.  │
 * │                                                                    │
 * │  Both are correct, and neither is what most of these suites are    │
 * │  testing. So they are handled here, once, instead of each file     │
 * │  growing its own copy — or worse, the checks being relaxed to let  │
 * │  an unfunded deal through, which is the exact defect the escrow    │
 * │  was wired in to remove.                                           │
 * └────────────────────────────────────────────────────────────────────┘
 */

/** Generous: a suite is not a person, and per-test top-ups would be noise. */
const FIXTURE_USDT_MICRO = 500_000_000_000n;

/**
 * Give these accounts USDT to sell.
 *
 * Uses the administrator path rather than the sandbox claim button, which
 * hands out a person-sized 5,000 once per account.
 */
export async function fundForDeals(users: readonly SessionUser[]): Promise<void> {
  const admin = await makeOperator(`fixture-fund-${unique()}@sandbox.test`);
  await grantRole({
    userId: admin.user.userId,
    role: 'ADMIN',
    grantedBy: null,
    via: 'CLI',
    reason: 'Test fixture, so a joined deal holds real protected value.',
  });
  const ledgerAdmin: Principal = {
    ...admin.principal,
    roles: ['ADMIN'],
    permissions: permissionsFor(['ADMIN']),
  };

  for (const who of users) {
    const funded = await fundSandboxCommand(ledgerAdmin, newCommandId(), {
      userId: who.userId,
      asset: 'USDT',
      amountMinor: FIXTURE_USDT_MICRO,
    });
    if (!funded.ok) throw new Error(`funding fixture: ${funded.code}`);
  }
}

/**
 * Forget what these accounts have already committed, between tests.
 *
 * ⚠ NOT A WEAKENED POLICY. The limit is unchanged and still enforced
 * within every test; it is simply not carried from one unrelated test to
 * the next. A rolling counter shared across a whole file is the same
 * shape of bug as a shared mutable credential — the suite passes or fails
 * on execution order rather than on behaviour.
 *
 * The limits themselves are tested where they belong, in
 * `riskControl.test.ts`, which sets up its own counters deliberately.
 */
export async function clearRiskCounters(users: readonly SessionUser[]): Promise<void> {
  await getPool().query(`DELETE FROM sandbox.risk_counter WHERE scope_id = ANY($1::text[])`, [
    users.map((u) => u.userId),
  ]);
}
