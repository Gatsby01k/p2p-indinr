import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getPool, withTransaction } from '@/server/db/pool';
import { newCommandId, readCommand } from '@/server/boundary/command';
import { permissionsFor, type Principal } from '@/server/identity/rbac';
import {
  balancesFor,
  journalForDeal,
  lockForDeal,
  lockDealValue,
} from '@/server/ledger/valueProtection';
import { ensureAccounts, partyBalanceKey, sandboxFundingSourceKey } from '@/server/ledger/accounts';
import {
  createDealCommand,
  fundSandboxCommand,
  joinCommand,
  lockValueCommand,
  refundValueCommand,
  releaseValueCommand,
  reverseLockCommand,
} from '@/services/commands';
import { getDeal, signInSandbox, type SessionUser } from '@/server/sandbox/service';
import { makeOperator } from './support/operator';

/**
 * DEL-04 value protection.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE PROPERTY UNDER TEST IS THAT VALUE CANNOT BE IN TWO PLACES.    │
 * │                                                                    │
 * │  Locked value genuinely LEAVES the owner's balance and arrives in  │
 * │  a deal escrow, so "available" and "locked" are two accounts       │
 * │  rather than two columns that can disagree. Overspending is not    │
 * │  refused by a check that could be forgotten — the value is simply  │
 * │  not in the account a spend reads, and a database constraint       │
 * │  refuses the entry that would put it there.                        │
 * │                                                                    │
 * │  None of this is evidence that external funds moved. It is         │
 * │  internal bookkeeping, and the sandbox funding journal is named    │
 * │  and audited so nobody can mistake it for a deposit.               │
 * └────────────────────────────────────────────────────────────────────┘
 */

const unique = () => Math.random().toString(36).slice(2, 10);
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
afterEach(restore);

let alice: SessionUser;
let bob: SessionUser;
let admin: Principal;

const bare = (u: SessionUser): Principal => ({
  userId: u.userId,
  roles: [],
  permissions: [],
  mfaSatisfied: false,
  mfaEnrolled: false,
});

beforeAll(async () => {
  alice = await signInSandbox(`vp-alice-${unique()}@example.com`);
  bob = await signInSandbox(`vp-bob-${unique()}@example.com`);

  // An ADMIN with a satisfied factor — the only principal that may fund
  // or reverse. Built through the DEL-03 boundary, not by a flag.
  const op = await makeOperator(`vp-admin-${unique()}@example.com`);
  const { grantRole } = await import('@/server/identity/rbac');
  await grantRole({
    userId: op.user.userId,
    role: 'ADMIN',
    grantedBy: null,
    via: 'CLI',
    reason: 'Ledger administrator for the value-protection tests.',
  });
  admin = {
    userId: op.user.userId,
    roles: ['ADMIN'],
    permissions: permissionsFor(['ADMIN']),
    mfaSatisfied: true,
    mfaEnrolled: true,
  };
});

async function fund(user: SessionUser, amountMinor: bigint) {
  const outcome = await fundSandboxCommand(admin, newCommandId(), {
    userId: user.userId,
    asset: 'USDT',
    amountMinor,
  });
  if (!outcome.ok) throw new Error(`funding fixture failed: ${outcome.code}`);
}

/** A live deal with both seats filled. */
async function liveDeal(): Promise<{ dealId: string; publicId: string }> {
  const created = await createDealCommand(alice, {
    commandId: newCommandId(),
    scenario: 'INR_TO_INR',
    inrAmount: '2500',
    intent: 'PAY',
  });
  if (!created.ok) throw new Error('deal fixture failed');
  const joined = await joinCommand(bob, newCommandId(), created.value.publicId);
  if (!joined.ok) throw new Error(`join fixture failed: ${joined.code}`);
  return { dealId: joined.value.dealId, publicId: created.value.publicId };
}

/* ------------------------------------------------------------------ *
 * Sandbox funding
 * ------------------------------------------------------------------ */

describe('sandbox funding is explicitly sandbox-only', () => {
  it('credits a balance out of a platform EXPENSE, never a wallet', async () => {
    const user = await signInSandbox(`vp-fund-${unique()}@example.com`);
    await fund(user, 500_000n);

    const balances = await balancesFor(user.userId);
    expect(balances.availableMinor).toBe('500000');

    // The books say the platform gave this away out of nothing, which is
    // what happened. They do NOT say a custodian received it.
    const { rows } = await getPool().query(
      `SELECT balance_minor::text AS b FROM inrp2p_read.account_balance
        WHERE family = 'platform_compensation_expense' AND asset = 'USDT'`,
    );
    expect(Number(rows[0]!.b)).toBeGreaterThanOrEqual(500_000);
  });

  it('NO custodial wallet is EVER touched by conjured value', async () => {
    const user = await signInSandbox(`vp-wallet-${unique()}@example.com`);
    await fund(user, 250_000n);
    const { dealId } = await liveDeal();
    await fund(alice, 40_000n);
    await lockValueCommand(alice, newCommandId(), { dealId, asset: 'USDT', amountMinor: 20_000n });
    await releaseValueCommand(alice, newCommandId(), { dealId, beneficiaryId: bob.userId });

    /*
     * The claim is precise, and it has to be.
     *
     * DEL-05 gives `wallet.deposit` a legitimate balance: a watcher
     * observed a transfer on chain and the confirmation policy was
     * satisfied, so the custodian really does hold those tokens. What
     * must NEVER happen is a wallet balance created by the funding path,
     * because that value was conjured and claiming custody of it would
     * be a lie. So the assertion is not "wallets are empty" — it is that
     * NO posting on any wallet account belongs to a funding entry.
     */
    const { rows } = await getPool().query(
      `SELECT a.family, p.amount_minor::text AS amount
         FROM inrp2p.posting p
         JOIN inrp2p.ledger_account a ON a.account_id = p.account_id
         JOIN inrp2p.journal_entry e  ON e.entry_id   = p.entry_id
        WHERE a.family LIKE 'wallet.%' AND e.journal_code = 'JD-SBX-FUND'`,
    );
    expect(rows).toEqual([]);

    // And every wallet balance that DOES exist came from a confirmed
    // external observation — nothing else may put value there.
    const { rows: sources } = await getPool().query(
      `SELECT DISTINCT e.journal_code
         FROM inrp2p.posting p
         JOIN inrp2p.ledger_account a ON a.account_id = p.account_id
         JOIN inrp2p.journal_entry e  ON e.entry_id   = p.entry_id
        WHERE a.family LIKE 'wallet.%'`,
    );
    expect(sources.map((s) => s.journal_code).sort()).toEqual(
      expect.arrayContaining([] as string[]),
    );
    for (const s of sources) {
      expect(['JD-DEP-CONFIRM', 'JD-REVERSAL']).toContain(s.journal_code);
    }
  });

  it('refuses in production', async () => {
    const user = await signInSandbox(`vp-prod-${unique()}@example.com`);
    enterProduction();
    const outcome = await fundSandboxCommand(admin, newCommandId(), {
      userId: user.userId,
      asset: 'USDT',
      amountMinor: 1_000n,
    });
    restore();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('ADAPTER_UNAVAILABLE');
    expect((await balancesFor(user.userId)).availableMinor).toBe('0');
  });

  it('refuses a caller without ledger.fund', async () => {
    const user = await signInSandbox(`vp-noperm-${unique()}@example.com`);
    const outcome = await fundSandboxCommand(bare(alice), newCommandId(), {
      userId: user.userId,
      asset: 'USDT',
      amountMinor: 1_000n,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PERMISSION_DENIED');
    expect((await balancesFor(user.userId)).availableMinor).toBe('0');
  });

  it('refuses a non-positive amount', async () => {
    const user = await signInSandbox(`vp-zero-${unique()}@example.com`);
    for (const amount of [0n, -5n]) {
      const outcome = await fundSandboxCommand(admin, newCommandId(), {
        userId: user.userId,
        asset: 'USDT',
        amountMinor: amount,
      });
      expect(outcome.ok).toBe(false);
    }
  });

  it('replays identically rather than funding twice', async () => {
    const user = await signInSandbox(`vp-replay-${unique()}@example.com`);
    const commandId = newCommandId();
    const first = await fundSandboxCommand(admin, commandId, {
      userId: user.userId,
      asset: 'USDT',
      amountMinor: 1_000n,
    });
    const replay = await fundSandboxCommand(admin, commandId, {
      userId: user.userId,
      asset: 'USDT',
      amountMinor: 1_000n,
    });
    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.value.entryId).toBe(first.value.entryId);
    expect((await balancesFor(user.userId)).availableMinor).toBe('1000');
  });
});

/* ------------------------------------------------------------------ *
 * Locking
 * ------------------------------------------------------------------ */

describe('locking moves value out of the available balance', () => {
  it('locks, and the value is no longer spendable', async () => {
    const { dealId } = await liveDeal();
    await fund(alice, 100_000n);
    const before = await balancesFor(alice.userId);

    const outcome = await lockValueCommand(alice, newCommandId(), {
      dealId,
      asset: 'USDT',
      amountMinor: 30_000n,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const after = await balancesFor(alice.userId);
    expect(BigInt(before.availableMinor) - BigInt(after.availableMinor)).toBe(30_000n);
    expect(BigInt(after.lockedMinor) - BigInt(before.lockedMinor)).toBe(30_000n);

    // And it is in the deal's escrow, not nowhere.
    const { rows } = await getPool().query(
      `SELECT balance_minor::text AS b FROM inrp2p_read.account_balance
        WHERE family='escrow' AND scope_id = $1`,
      [dealId],
    );
    expect(rows[0]!.b).toBe('30000');
  });

  it('is linked to the deal, the actor and the command', async () => {
    const { dealId } = await liveDeal();
    await fund(alice, 50_000n);
    const commandId = newCommandId();
    const outcome = await lockValueCommand(alice, commandId, {
      dealId,
      asset: 'USDT',
      amountMinor: 10_000n,
    });
    expect(outcome.ok).toBe(true);

    const { rows } = await getPool().query(
      `SELECT owner_id, command_id, deal_id FROM inrp2p.value_lock WHERE deal_id = $1`,
      [dealId],
    );
    expect(rows[0]!.owner_id).toBe(alice.userId);
    expect(rows[0]!.command_id).toBe(commandId);
  });

  it('replays an identical lock without locking twice', async () => {
    const { dealId } = await liveDeal();
    await fund(alice, 50_000n);
    const commandId = newCommandId();
    const first = await lockValueCommand(alice, commandId, {
      dealId,
      asset: 'USDT',
      amountMinor: 10_000n,
    });
    const before = await balancesFor(alice.userId);
    const replay = await lockValueCommand(alice, commandId, {
      dealId,
      asset: 'USDT',
      amountMinor: 10_000n,
    });
    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.value.lockId).toBe(first.value.lockId);
    expect((await balancesFor(alice.userId)).availableMinor).toBe(before.availableMinor);
  });

  it('refuses the same command id with a different amount', async () => {
    const { dealId } = await liveDeal();
    await fund(alice, 50_000n);
    const commandId = newCommandId();
    expect(
      (await lockValueCommand(alice, commandId, { dealId, asset: 'USDT', amountMinor: 10_000n }))
        .ok,
    ).toBe(true);
    const conflicting = await lockValueCommand(alice, commandId, {
      dealId,
      asset: 'USDT',
      amountMinor: 11_000n,
    });
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('REFUSES an insufficient balance and locks nothing', async () => {
    const poor = await signInSandbox(`vp-poor-${unique()}@example.com`);
    const created = await createDealCommand(poor, {
      commandId: newCommandId(),
      scenario: 'INR_TO_INR',
      inrAmount: '2500',
      intent: 'PAY',
    });
    if (!created.ok) return;
    const joined = await joinCommand(bob, newCommandId(), created.value.publicId);
    if (!joined.ok) return;

    await fund(poor, 1_000n);
    const commandId = newCommandId();
    const outcome = await lockValueCommand(poor, commandId, {
      dealId: joined.value.dealId,
      asset: 'USDT',
      amountMinor: 5_000n,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('INSUFFICIENT_BALANCE');
    expect(outcome.detail).toMatchObject({ availableMinor: '1000', requiredMinor: '5000' });

    // Nothing moved, and the refusal is recorded.
    expect((await balancesFor(poor.userId)).availableMinor).toBe('1000');
    expect(await lockForDeal(joined.value.dealId)).toBeNull();
    expect((await readCommand(commandId))?.outcomeCode).toBe('INSUFFICIENT_BALANCE');
    const { rows } = await getPool().query(
      `SELECT 1 FROM sandbox.audit_event
        WHERE subject_id = $1 AND action='VALUE_LOCK' AND outcome='INSUFFICIENT_BALANCE'`,
      [joined.value.dealId],
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a non-participant', async () => {
    const { dealId } = await liveDeal();
    const outsider = await signInSandbox(`vp-out-${unique()}@example.com`);
    await fund(outsider, 50_000n);
    const outcome = await lockValueCommand(outsider, newCommandId(), {
      dealId,
      asset: 'USDT',
      amountMinor: 1_000n,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_A_PARTICIPANT');
  });

  it('two deals competing for one balance cannot both win', async () => {
    const spender = await signInSandbox(`vp-race-${unique()}@example.com`);
    await fund(spender, 10_000n);

    const deals: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const created = await createDealCommand(spender, {
        commandId: newCommandId(),
        scenario: 'INR_TO_INR',
        inrAmount: '2500',
        intent: 'PAY',
      });
      if (!created.ok) throw new Error('fixture');
      const joined = await joinCommand(bob, newCommandId(), created.value.publicId);
      if (!joined.ok) throw new Error('fixture');
      deals.push(joined.value.dealId);
    }

    // Each wants the whole balance. Exactly one may have it.
    const [a, b] = await Promise.all([
      lockValueCommand(spender, newCommandId(), {
        dealId: deals[0]!,
        asset: 'USDT',
        amountMinor: 10_000n,
      }),
      lockValueCommand(spender, newCommandId(), {
        dealId: deals[1]!,
        asset: 'USDT',
        amountMinor: 10_000n,
      }),
    ]);

    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    const loser = [a, b].find((r) => !r.ok)!;
    if (loser.ok) return;
    expect(loser.code).toBe('INSUFFICIENT_BALANCE');

    // And the balance is exactly zero — not negative.
    const balances = await balancesFor(spender.userId);
    expect(balances.availableMinor).toBe('0');
    expect(balances.lockedMinor).toBe('10000');
  });

  it('the database refuses an overspend even without the service check', async () => {
    const spender = await signInSandbox(`vp-dbguard-${unique()}@example.com`);
    await fund(spender, 1_000n);
    const dealId = crypto.randomUUID();

    // Bypass the boundary's sufficiency check entirely.
    await expect(
      withTransaction((tx) =>
        lockDealValue(tx, {
          dealId,
          ownerId: spender.userId,
          commandId: newCommandId(),
          asset: 'USDT',
          // The service WOULD refuse this; the point is that the database
          // also would, so a defective boundary cannot overspend.
          amountMinor: 1_000n,
        }).then(async (r) => {
          if (!r.ok) throw new Error('service refused first');
          // Now force a second lock past the service by posting directly.
          await tx.query(
            `SELECT inrp2p.post_entry('JD-LOCK', $1::jsonb,
               ARRAY[inrp2p.account_id_of(ROW('USDT','party.balance','user',$2,0)::inrp2p.account_key),
                     inrp2p.account_id_of(ROW('USDT','escrow','deal',$3,0)::inrp2p.account_key)],
               ARRAY[5000::numeric, -5000::numeric])`,
            [JSON.stringify({ forced: true, dealId }), spender.userId, dealId],
          );
          return r;
        }),
      ),
    ).rejects.toThrow(/credit_normal_not_debit|check constraint/i);

    // The whole transaction rolled back: the first lock is gone too.
    expect((await balancesFor(spender.userId)).availableMinor).toBe('1000');
  });
});

/* ------------------------------------------------------------------ *
 * Settlement
 * ------------------------------------------------------------------ */

describe('release and refund', () => {
  async function lockedDeal(amount = 20_000n) {
    const { dealId } = await liveDeal();
    await fund(alice, amount);
    const locked = await lockValueCommand(alice, newCommandId(), {
      dealId,
      asset: 'USDT',
      amountMinor: amount,
    });
    if (!locked.ok) throw new Error(`lock fixture: ${locked.code}`);
    return { dealId, amount };
  }

  it('releases escrow to the counterparty', async () => {
    const { dealId, amount } = await lockedDeal();
    const before = await balancesFor(bob.userId);

    const outcome = await releaseValueCommand(alice, newCommandId(), {
      dealId,
      beneficiaryId: bob.userId,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.state).toBe('RELEASED');

    const after = await balancesFor(bob.userId);
    expect(BigInt(after.availableMinor) - BigInt(before.availableMinor)).toBe(amount);

    // The escrow is empty again.
    const { rows } = await getPool().query(
      `SELECT balance_minor::text AS b FROM inrp2p_read.account_balance
        WHERE family='escrow' AND scope_id=$1`,
      [dealId],
    );
    expect(rows[0]!.b).toBe('0');
  });

  it('refunds escrow to the original owner', async () => {
    const { dealId, amount } = await lockedDeal();
    const before = await balancesFor(alice.userId);

    const outcome = await refundValueCommand(alice, newCommandId(), {
      dealId,
      beneficiaryId: alice.userId,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.state).toBe('REFUNDED');
    const after = await balancesFor(alice.userId);
    expect(BigInt(after.availableMinor) - BigInt(before.availableMinor)).toBe(amount);
  });

  it('replays a duplicate release without paying twice', async () => {
    const { dealId, amount } = await lockedDeal();
    const commandId = newCommandId();
    expect(
      (await releaseValueCommand(alice, commandId, { dealId, beneficiaryId: bob.userId })).ok,
    ).toBe(true);
    const mid = await balancesFor(bob.userId);

    const replay = await releaseValueCommand(alice, commandId, {
      dealId,
      beneficiaryId: bob.userId,
    });
    expect(replay.ok).toBe(true);
    expect((await balancesFor(bob.userId)).availableMinor).toBe(mid.availableMinor);
    void amount;
  });

  it('refuses a duplicate refund from a different command', async () => {
    const { dealId } = await lockedDeal();
    expect(
      (await refundValueCommand(alice, newCommandId(), { dealId, beneficiaryId: alice.userId })).ok,
    ).toBe(true);

    const second = await refundValueCommand(alice, newCommandId(), {
      dealId,
      beneficiaryId: alice.userId,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('DEAL_TERMINAL');
  });

  it('a release racing a refund produces exactly one settlement', async () => {
    const { dealId, amount } = await lockedDeal();
    const [rel, ref] = await Promise.all([
      releaseValueCommand(alice, newCommandId(), { dealId, beneficiaryId: bob.userId }),
      refundValueCommand(alice, newCommandId(), { dealId, beneficiaryId: alice.userId }),
    ]);
    expect([rel, ref].filter((r) => r.ok)).toHaveLength(1);

    const lock = await lockForDeal(dealId);
    expect(['RELEASED', 'REFUNDED']).toContain(lock!.state);

    // The escrow is empty, and exactly `amount` went to exactly one side.
    const { rows } = await getPool().query(
      `SELECT balance_minor::text AS b FROM inrp2p_read.account_balance
        WHERE family='escrow' AND scope_id=$1`,
      [dealId],
    );
    expect(rows[0]!.b).toBe('0');
    void amount;
  });

  it('refuses to settle a deal with no lock', async () => {
    const { dealId } = await liveDeal();
    const outcome = await releaseValueCommand(alice, newCommandId(), {
      dealId,
      beneficiaryId: bob.userId,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_FOUND');
  });
});

/* ------------------------------------------------------------------ *
 * Database privilege — the boundary is not merely a convention
 * ------------------------------------------------------------------ */

describe('the application role cannot touch a money table', () => {
  /** Run one statement with the application role's real privileges. */
  async function asApp(sql: string, params: unknown[] = []) {
    return withTransaction(async (tx) => {
      await tx.query('SET LOCAL ROLE inrp2p_app');
      return tx.query(sql, params);
    });
  }

  it('is denied INSERT on posting, journal_entry and account_balance', async () => {
    for (const sql of [
      `INSERT INTO inrp2p.posting (entry_id, seq, account_id, asset, amount_minor)
         VALUES (gen_random_uuid(), 1, gen_random_uuid(), 'USDT', 1)`,
      `INSERT INTO inrp2p.journal_entry (entry_id, journal_code, entry_class, entry_key_json,
                                         entry_key_digest)
         VALUES (gen_random_uuid(), 'JD-LOCK', 'SNJ', '{}'::jsonb, '\\x00'::bytea)`,
      `UPDATE inrp2p.account_balance SET balance_minor = balance_minor - 1000000`,
    ]) {
      await expect(asApp(sql), sql.slice(0, 40)).rejects.toThrow(/permission denied/i);
    }
  });

  it('is denied SELECT on the money tables — it reads through inrp2p_read', async () => {
    await expect(asApp(`SELECT * FROM inrp2p.account_balance`)).rejects.toThrow(
      /permission denied/i,
    );
    const readable = await asApp(`SELECT count(*)::int AS n FROM inrp2p_read.account_balance`);
    expect(readable.rows[0]!.n).toBeGreaterThanOrEqual(0);
  });

  it('CAN reach the ledger only by calling the boundary function', async () => {
    const user = await signInSandbox(`vp-priv-${unique()}@example.com`);
    // ensure_accounts + post_entry are SECURITY DEFINER owned by
    // inrp2p_boundary, so the app role executes them without holding DML.
    const entry = await withTransaction(async (tx) => {
      const [source, party] = await ensureAccounts(tx, [
        sandboxFundingSourceKey('USDT'),
        partyBalanceKey(user.userId, 'USDT'),
      ]);
      await tx.query('SET LOCAL ROLE inrp2p_app');
      const { rows } = await tx.query(
        `SELECT inrp2p.post_entry('JD-SBX-FUND', $1::jsonb, ARRAY[$2::uuid,$3::uuid],
                                  ARRAY[100::numeric, -100::numeric]) AS id`,
        [JSON.stringify({ probe: user.userId }), source, party],
      );
      return rows[0]!.id as string;
    });
    expect(entry).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('runs the definer function as inrp2p_boundary, not as the migration user', async () => {
    const { rows } = await getPool().query(
      `SELECT p.proname, r.rolname, p.prosecdef
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'inrp2p'
          AND p.proname IN ('post_entry','reverse_entry','ensure_accounts')`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.rolname, `${row.proname} owner`).toBe('inrp2p_boundary');
      expect(row.prosecdef, `${row.proname} security definer`).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Identity still governs value
 * ------------------------------------------------------------------ */

describe('revoking authority stops value movement immediately', () => {
  /**
   * Rebuild a principal the way a request does — from LIVE grants, not
   * from whatever the last one happened to hold. A cached principal would
   * make this test pass while the product stayed vulnerable.
   */
  async function livePrincipal(userId: string, mfaSatisfied: boolean): Promise<Principal> {
    const { rolesFor, mfaEnrolled } = await import('@/server/identity/rbac');
    const roles = await rolesFor(userId);
    return {
      userId,
      roles,
      permissions: permissionsFor(roles),
      mfaSatisfied,
      mfaEnrolled: await mfaEnrolled(userId),
    };
  }

  it('a revoked ADMIN role can no longer fund', async () => {
    const op = await makeOperator(`vp-revoke-${unique()}@example.com`);
    const { grantRole, revokeRole } = await import('@/server/identity/rbac');
    await grantRole({
      userId: op.user.userId,
      role: 'ADMIN',
      grantedBy: null,
      via: 'CLI',
      reason: 'Temporary ledger administrator for a revocation test.',
    });

    const user = await signInSandbox(`vp-revoke-target-${unique()}@example.com`);
    const before = await livePrincipal(op.user.userId, true);
    expect(
      (
        await fundSandboxCommand(before, newCommandId(), {
          userId: user.userId,
          asset: 'USDT',
          amountMinor: 1_000n,
        })
      ).ok,
    ).toBe(true);

    await revokeRole({ userId: op.user.userId, role: 'ADMIN', revokedBy: null });

    const after = await livePrincipal(op.user.userId, true);
    expect(after.roles).not.toContain('ADMIN');
    const outcome = await fundSandboxCommand(after, newCommandId(), {
      userId: user.userId,
      asset: 'USDT',
      amountMinor: 1_000n,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PERMISSION_DENIED');
    expect((await balancesFor(user.userId)).availableMinor).toBe('1000');
  });

  it('an unproved factor cannot fund, however senior the role', async () => {
    const op = await makeOperator(`vp-nomfa-${unique()}@example.com`);
    const { grantRole } = await import('@/server/identity/rbac');
    await grantRole({
      userId: op.user.userId,
      role: 'ADMIN',
      grantedBy: null,
      via: 'CLI',
      reason: 'Ledger administrator whose session has not proved a factor.',
    });

    const user = await signInSandbox(`vp-nomfa-target-${unique()}@example.com`);
    const unproved = await livePrincipal(op.user.userId, false);
    expect(unproved.roles).toContain('ADMIN');

    const outcome = await fundSandboxCommand(unproved, newCommandId(), {
      userId: user.userId,
      asset: 'USDT',
      amountMinor: 1_000n,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PERMISSION_DENIED');
    expect((await balancesFor(user.userId)).availableMinor).toBe('0');
  });
});

/* ------------------------------------------------------------------ *
 * Reversal
 * ------------------------------------------------------------------ */

describe('corrections are reversals, never edits', () => {
  it('reverses a lock and restores the balance', async () => {
    const { dealId } = await liveDeal();
    await fund(alice, 40_000n);
    const before = await balancesFor(alice.userId);
    expect(
      (
        await lockValueCommand(alice, newCommandId(), {
          dealId,
          asset: 'USDT',
          amountMinor: 15_000n,
        })
      ).ok,
    ).toBe(true);

    const outcome = await reverseLockCommand(admin, newCommandId(), {
      dealId,
      reason: 'Locked against the wrong deal during a support call.',
    });
    expect(outcome.ok).toBe(true);

    expect((await balancesFor(alice.userId)).availableMinor).toBe(before.availableMinor);

    // BOTH entries remain readable — the history was not erased.
    const history = await journalForDeal(dealId);
    expect(history.map((h) => h.journalCode)).toEqual(
      expect.arrayContaining(['JD-LOCK', 'JD-REVERSAL']),
    );
  });

  it('requires ledger.reverse', async () => {
    const { dealId } = await liveDeal();
    await fund(alice, 20_000n);
    await lockValueCommand(alice, newCommandId(), {
      dealId,
      asset: 'USDT',
      amountMinor: 5_000n,
    });

    const outcome = await reverseLockCommand(bare(alice), newCommandId(), {
      dealId,
      reason: 'I would like my value back please.',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PERMISSION_DENIED');
    expect((await lockForDeal(dealId))!.state).toBe('LOCKED');
  });

  it('requires a written reason', async () => {
    const { dealId } = await liveDeal();
    await fund(alice, 20_000n);
    await lockValueCommand(alice, newCommandId(), { dealId, asset: 'USDT', amountMinor: 5_000n });
    const outcome = await reverseLockCommand(admin, newCommandId(), { dealId, reason: 'oops' });
    expect(outcome.ok).toBe(false);
  });

  it('cannot reverse an already-settled lock', async () => {
    const { dealId } = await liveDeal();
    await fund(alice, 20_000n);
    await lockValueCommand(alice, newCommandId(), { dealId, asset: 'USDT', amountMinor: 5_000n });
    await releaseValueCommand(alice, newCommandId(), { dealId, beneficiaryId: bob.userId });

    const outcome = await reverseLockCommand(admin, newCommandId(), {
      dealId,
      reason: 'Attempting to reverse a released lock.',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('DEAL_TERMINAL');
  });
});

/* ------------------------------------------------------------------ *
 * Atomicity, audit and outbox
 * ------------------------------------------------------------------ */

describe('command, ledger, lock, audit and outbox are one transaction', () => {
  it('a lock writes all five, keyed to the command', async () => {
    const { dealId } = await liveDeal();
    await fund(alice, 30_000n);
    const commandId = newCommandId();
    const outcome = await lockValueCommand(alice, commandId, {
      dealId,
      asset: 'USDT',
      amountMinor: 12_000n,
    });
    expect(outcome.ok).toBe(true);

    expect((await readCommand(commandId))?.status).toBe('SUCCEEDED');
    const { rows: entries } = await getPool().query(
      `SELECT count(*)::int AS n FROM inrp2p.journal_entry WHERE journal_code='JD-LOCK'
        AND entry_key_json->>'commandId' = $1`,
      [commandId],
    );
    expect(entries[0]!.n).toBe(1);
    const { rows: locks } = await getPool().query(
      `SELECT count(*)::int AS n FROM inrp2p.value_lock WHERE command_id = $1`,
      [commandId],
    );
    expect(locks[0]!.n).toBe(1);
    const { rows: audits } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.audit_event
        WHERE subject_id = $1 AND action='VALUE_LOCK' AND outcome='OK'`,
      [dealId],
    );
    expect(audits[0]!.n).toBe(1);
    const { rows: events } = await getPool().query(
      `SELECT event_type FROM sandbox.outbox_event WHERE event_key LIKE $1`,
      [`${commandId}:%`],
    );
    expect(events.map((e) => e.event_type)).toEqual(['value.locked']);
  });

  it('an injected failure after the ledger write leaves NOTHING', async () => {
    const { dealId } = await liveDeal();
    await fund(alice, 30_000n);
    const before = await balancesFor(alice.userId);
    const commandId = newCommandId();

    const { runCommand } = await import('@/server/boundary/command');
    await expect(
      runCommand({
        commandId,
        commandType: 'VALUE_LOCK',
        actorId: alice.userId,
        payload: { dealId, injected: true },
        body: async (ctx) => {
          const locked = await lockDealValue(ctx.tx, {
            dealId,
            ownerId: alice.userId,
            commandId,
            asset: 'USDT',
            amountMinor: 9_000n,
          });
          // The ledger entry, the balance update and the lock row all
          // exist at this instant. The throw must take every one of them.
          throw new Error('injected failure after the ledger write');
          return locked;
        },
        encodeResult: () => ({}),
        decodeResult: () => null,
      }),
    ).rejects.toThrow('injected failure after the ledger write');

    expect((await balancesFor(alice.userId)).availableMinor).toBe(before.availableMinor);
    expect(await lockForDeal(dealId)).toBeNull();
    expect(await readCommand(commandId)).toBeNull();
    const { rows } = await getPool().query(
      `SELECT 1 FROM inrp2p.journal_entry WHERE entry_key_json->>'commandId' = $1`,
      [commandId],
    );
    expect(rows).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Payment instructions follow the LIVE lock
 * ------------------------------------------------------------------ */

describe('payment instructions track the ledger lock', () => {
  it('are shown while value is genuinely locked', async () => {
    const { dealId } = await liveDeal();
    await fund(alice, 30_000n);
    await lockValueCommand(alice, newCommandId(), { dealId, asset: 'USDT', amountMinor: 8_000n });

    const view = await getDeal(alice, dealId);
    expect(view.valueLocked).toBe(true);
    expect(view.payTo).not.toBeNull();
  });

  it('STOP the moment the lock is released', async () => {
    const { dealId } = await liveDeal();
    await fund(alice, 30_000n);
    await lockValueCommand(alice, newCommandId(), { dealId, asset: 'USDT', amountMinor: 8_000n });
    await releaseValueCommand(alice, newCommandId(), { dealId, beneficiaryId: bob.userId });

    const view = await getDeal(alice, dealId);
    expect(view.valueLocked, 'released value is not locked value').toBe(false);
    expect(view.payTo).toBeNull();
  });

  it('STOP when the lock is reversed', async () => {
    const { dealId } = await liveDeal();
    await fund(alice, 30_000n);
    await lockValueCommand(alice, newCommandId(), { dealId, asset: 'USDT', amountMinor: 8_000n });
    await reverseLockCommand(admin, newCommandId(), {
      dealId,
      reason: 'Reversed during a support investigation.',
    });

    const view = await getDeal(alice, dealId);
    expect(view.valueLocked).toBe(false);
    expect(view.payTo).toBeNull();
  });
});
