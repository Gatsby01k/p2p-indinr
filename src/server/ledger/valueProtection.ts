import 'server-only';
import { getPool, toBigInt, type Tx } from '@/server/db/pool';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { deploymentMode } from '@/server/adapters/mode';
import { can, type Principal } from '@/server/identity/rbac';
import {
  dealEscrowKey,
  ensureAccounts,
  sandboxFundingSourceKey,
  partyBalanceKey,
  type LedgerAsset,
} from './accounts';

/**
 * Value protection: locking, releasing, refunding and reversing.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHAT THIS DOES AND, EMPHATICALLY, WHAT IT DOES NOT.               │
 * │                                                                    │
 * │  It moves value between INTERNAL accounts and keeps a durable      │
 * │  record of every movement. Locked value genuinely leaves the       │
 * │  owner's balance, so it cannot be spent twice — that is a real     │
 * │  guarantee and it is enforced by the database.                     │
 * │                                                                    │
 * │  It does NOT move money in the world. No deposit credits a         │
 * │  balance here, no withdrawal debits one, no bank or chain is       │
 * │  contacted. A balance in this schema is a claim about internal     │
 * │  bookkeeping and must never be shown to anybody as evidence that   │
 * │  funds were received or sent. That is DEL-05's work.               │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Every function here takes a transaction handle from the caller. That is
 * what makes requirement 11 hold: the command record, the ledger entries,
 * the value-lock row, the audit event and the outbox event are written on
 * ONE connection inside ONE transaction, and commit or vanish together.
 */

export interface ValueLock {
  readonly lockId: string;
  readonly dealId: string;
  readonly ownerId: string;
  readonly asset: LedgerAsset;
  readonly amountMinor: string;
  readonly state: 'LOCKED' | 'RELEASED' | 'REFUNDED' | 'REVERSED';
  readonly lockEntryId: string;
  readonly settleEntryId: string | null;
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export interface Balances {
  /** Spendable, in minor units. Never negative. */
  readonly availableMinor: string;
  /** Sum of live locks belonging to this person. */
  readonly lockedMinor: string;
}

/**
 * What somebody has, and what is spoken for.
 *
 * Read through `inrp2p_read`, never off the money tables directly — the
 * application role holds SELECT on the views and nothing on `inrp2p`.
 */
export async function balancesFor(userId: string, asset: LedgerAsset = 'USDT'): Promise<Balances> {
  const key = partyBalanceKey(userId, asset);
  const { rows } = await getPool().query(
    `SELECT coalesce((SELECT balance_minor FROM inrp2p_read.account_balance
                       WHERE family='party.balance' AND scope_kind='user'
                         AND scope_id=$1 AND asset=$2::inrp2p.ledger_asset), 0)::text
              AS available,
            coalesce((SELECT sum(amount_minor) FROM inrp2p_read.value_lock
                       WHERE owner_id=$1::uuid AND asset=$2::inrp2p.ledger_asset
                         AND state='LOCKED'), 0)::text
              AS locked`,
    [key.scopeId, asset],
  );
  return { availableMinor: rows[0]!.available, lockedMinor: rows[0]!.locked };
}

export async function lockForDeal(dealId: string): Promise<ValueLock | null> {
  const { rows } = await getPool().query(
    `SELECT lock_id, deal_id, owner_id, asset::text, amount_minor::text, state,
            lock_entry_id, settle_entry_id
       FROM inrp2p_read.value_lock WHERE deal_id = $1`,
    [dealId],
  );
  return rows[0] ? mapLock(rows[0]) : null;
}

/** Journal history for one deal's escrow. Read-only, no write authority. */
export async function journalForDeal(dealId: string): Promise<
  readonly {
    entryId: string;
    journalCode: string;
    appliedAt: string;
    amountMinor: string;
    family: string;
  }[]
> {
  const { rows } = await getPool().query(
    `SELECT entry_id, journal_code, applied_at, amount_minor::text AS amount, family
       FROM inrp2p_read.journal
      WHERE scope_kind = 'deal' AND scope_id = $1
      ORDER BY applied_at, seq`,
    [dealId],
  );
  return rows.map((r) => ({
    entryId: r.entry_id,
    journalCode: r.journal_code,
    appliedAt: (r.applied_at as Date).toISOString(),
    amountMinor: r.amount,
    family: r.family,
  }));
}

/* ------------------------------------------------------------------ *
 * Sandbox funding — explicitly, structurally sandbox-only
 * ------------------------------------------------------------------ */

/**
 * Credit a party balance with value nobody deposited.
 *
 * ⚠ THIS EXISTS SO THE SANDBOX JOURNEY CAN RUN, AND FOR NO OTHER REASON.
 *
 * Three independent guards, because a function that invents money is the
 * single most dangerous thing in this file:
 *
 *   1. it refuses outside a SANDBOX deployment;
 *   2. it requires the `ledger.fund` permission, which no ordinary
 *      account holds and which is granted only out of band;
 *   3. it books the value as a platform EXPENSE rather than drawing it
 *      from a custodial wallet, so the books say "the platform conjured
 *      this" instead of "the custodian holds this". No `wallet.*`
 *      account is touched, and none ever carries a sandbox balance.
 */
export async function fundSandboxBalance(
  tx: Tx,
  principal: Principal,
  input: {
    readonly userId: string;
    readonly asset: LedgerAsset;
    readonly amountMinor: bigint;
    readonly commandId: string;
  },
): Promise<Outcome<{ entryId: string }>> {
  if (deploymentMode() === 'PRODUCTION') {
    return reject('ADAPTER_UNAVAILABLE', FAILURE_COPY.ADAPTER_UNAVAILABLE.reason);
  }
  if (!can(principal, 'ledger.fund')) {
    return reject('PERMISSION_DENIED', FAILURE_COPY.PERMISSION_DENIED.reason);
  }
  if (input.amountMinor <= 0n) {
    return reject('AMOUNT_INVALID', FAILURE_COPY.AMOUNT_INVALID.reason);
  }

  const [source, party] = await ensureAccounts(tx, [
    sandboxFundingSourceKey(input.asset),
    partyBalanceKey(input.userId, input.asset),
  ]);

  // Debit the expense (+), credit the party balance (−): sums to zero.
  const { rows } = await tx.query(
    `SELECT inrp2p.post_entry('JD-SBX-FUND', $1::jsonb, ARRAY[$2::uuid,$3::uuid],
                              ARRAY[$4::numeric,$5::numeric]) AS entry_id`,
    [
      JSON.stringify({ commandId: input.commandId, userId: input.userId, asset: input.asset }),
      source,
      party,
      input.amountMinor.toString(),
      (-input.amountMinor).toString(),
    ],
  );
  return accept({ entryId: rows[0]!.entry_id as string });
}

/* ------------------------------------------------------------------ *
 * Lock
 * ------------------------------------------------------------------ */

/**
 * Move value out of a person's balance and into a deal's escrow.
 *
 * The sufficiency check happens AFTER `post_entry` has taken the balance
 * row lock in canonical order, so two deals competing for the same
 * balance serialise and the second sees the first's effect rather than a
 * stale snapshot. The database constraint
 * `account_balance_credit_normal_not_debit` is the backstop: even if this
 * check were wrong, an overspend could not commit.
 */
export async function lockDealValue(
  tx: Tx,
  input: {
    readonly dealId: string;
    readonly ownerId: string;
    readonly commandId: string;
    readonly asset: LedgerAsset;
    readonly amountMinor: bigint;
  },
): Promise<Outcome<ValueLock>> {
  if (input.amountMinor <= 0n) {
    return reject('AMOUNT_INVALID', FAILURE_COPY.AMOUNT_INVALID.reason);
  }

  // A live lock for this deal is a replay, not a second lock. Returning
  // it makes the operation idempotent from the caller's point of view.
  const existing = await tx.query(
    `SELECT lock_id, deal_id, owner_id, asset::text, amount_minor::text, state,
            lock_entry_id, settle_entry_id
       FROM inrp2p.value_lock WHERE deal_id = $1 FOR UPDATE`,
    [input.dealId],
  );
  if (existing.rows[0]) {
    const prior = mapLock(existing.rows[0]);
    // A different command asking to lock the same deal is a conflict, not
    // a replay: two callers believe they own the same escrow.
    if (existing.rows[0].owner_id !== input.ownerId) {
      return reject('IDEMPOTENCY_CONFLICT', FAILURE_COPY.IDEMPOTENCY_CONFLICT.reason);
    }
    return accept(prior);
  }

  const [party, escrow] = await ensureAccounts(tx, [
    partyBalanceKey(input.ownerId, input.asset),
    dealEscrowKey(input.dealId, input.asset),
  ]);

  // Sufficiency, read under the lock `post_entry` is about to take.
  const { rows: bal } = await tx.query(
    `SELECT inrp2p.normal_balance(class, balance_minor)::text AS available
       FROM inrp2p.account_balance WHERE account_id = $1 FOR UPDATE`,
    [party],
  );
  const available = toBigInt(bal[0]?.available ?? '0');
  if (available < input.amountMinor) {
    return reject('INSUFFICIENT_BALANCE', FAILURE_COPY.INSUFFICIENT_BALANCE.reason, {
      availableMinor: available.toString(),
      requiredMinor: input.amountMinor.toString(),
    });
  }

  // Debit the party balance (+, reducing what we owe them), credit the
  // escrow (−, taking on what we owe the deal's outcome).
  const { rows } = await tx.query(
    `SELECT inrp2p.post_entry('JD-LOCK', $1::jsonb, ARRAY[$2::uuid,$3::uuid],
                              ARRAY[$4::numeric,$5::numeric]) AS entry_id`,
    [
      JSON.stringify({ dealId: input.dealId, commandId: input.commandId }),
      party,
      escrow,
      input.amountMinor.toString(),
      (-input.amountMinor).toString(),
    ],
  );
  const entryId = rows[0]!.entry_id as string;

  const { rows: lockRows } = await tx.query(
    `INSERT INTO inrp2p.value_lock
       (deal_id, owner_id, command_id, asset, amount_minor, lock_entry_id)
     VALUES ($1,$2,$3,$4::inrp2p.ledger_asset,$5,$6)
     RETURNING lock_id, deal_id, owner_id, asset::text, amount_minor::text, state,
               lock_entry_id, settle_entry_id`,
    [
      input.dealId,
      input.ownerId,
      input.commandId,
      input.asset,
      input.amountMinor.toString(),
      entryId,
    ],
  );
  return accept(mapLock(lockRows[0]));
}

/* ------------------------------------------------------------------ *
 * Settle: release or refund
 * ------------------------------------------------------------------ */

type Settlement = 'RELEASED' | 'REFUNDED';

/**
 * End a lock, moving escrow to whoever the outcome says should have it.
 *
 * RELEASE and REFUND are the same movement with different destinations,
 * so they share one implementation and one CAS. That matters for the race
 * the roadmap names: a release and a refund arriving together cannot both
 * win, because the conditional `WHERE state='LOCKED'` affects one row and
 * zero rows respectively, and the loser is told the lock is already
 * settled rather than posting a second entry.
 */
async function settleLock(
  tx: Tx,
  input: {
    readonly dealId: string;
    readonly beneficiaryId: string;
    readonly commandId: string;
    readonly settlement: Settlement;
  },
): Promise<Outcome<ValueLock>> {
  const { rows: locked } = await tx.query(
    `SELECT lock_id, deal_id, owner_id, command_id, asset::text, amount_minor::text, state,
            lock_entry_id, settle_entry_id, settle_command_id
       FROM inrp2p.value_lock WHERE deal_id = $1 FOR UPDATE`,
    [input.dealId],
  );
  const lock = locked[0];
  if (!lock) return reject('NOT_FOUND', 'No value is locked against that deal.');

  if (lock.state !== 'LOCKED') {
    /*
     * Already settled. Two cases, and they are genuinely different:
     *
     *   · the SAME command asking again is a replay — return the
     *     recorded result so a retry is safe;
     *   · a DIFFERENT command, or a different settlement, is a race
     *     whose loser must be told, not silently given a success.
     */
    if (lock.settle_command_id === input.commandId) return accept(mapLock(lock));
    return reject('DEAL_TERMINAL', 'That deal’s locked value has already been settled.');
  }

  const asset = lock.asset as LedgerAsset;
  const amount = toBigInt(lock.amount_minor as string);
  const [escrow, beneficiary] = await ensureAccounts(tx, [
    dealEscrowKey(lock.deal_id as string, asset),
    partyBalanceKey(input.beneficiaryId, asset),
  ]);

  // Debit the escrow (+, discharging what we owed the deal), credit the
  // beneficiary's balance (−, taking on what we now owe them).
  const journal = input.settlement === 'RELEASED' ? 'JD-RELEASE' : 'JD-REFUND';
  const { rows } = await tx.query(
    `SELECT inrp2p.post_entry($1, $2::jsonb, ARRAY[$3::uuid,$4::uuid],
                              ARRAY[$5::numeric,$6::numeric]) AS entry_id`,
    [
      journal,
      JSON.stringify({ dealId: input.dealId, commandId: input.commandId }),
      escrow,
      beneficiary,
      amount.toString(),
      (-amount).toString(),
    ],
  );
  const entryId = rows[0]!.entry_id as string;

  // CAS: exactly one settlement wins.
  const { rows: settled } = await tx.query(
    `UPDATE inrp2p.value_lock
        SET state = $2, settled_at = now(), settle_entry_id = $3, settle_command_id = $4
      WHERE deal_id = $1 AND state = 'LOCKED'
      RETURNING lock_id, deal_id, owner_id, asset::text, amount_minor::text, state,
                lock_entry_id, settle_entry_id`,
    [input.dealId, input.settlement, entryId, input.commandId],
  );
  if (!settled[0])
    return reject('DEAL_TERMINAL', 'That deal’s locked value has already been settled.');

  return accept(mapLock(settled[0]));
}

export function releaseDealValue(
  tx: Tx,
  input: { dealId: string; beneficiaryId: string; commandId: string },
): Promise<Outcome<ValueLock>> {
  return settleLock(tx, { ...input, settlement: 'RELEASED' });
}

export function refundDealValue(
  tx: Tx,
  input: { dealId: string; beneficiaryId: string; commandId: string },
): Promise<Outcome<ValueLock>> {
  return settleLock(tx, { ...input, settlement: 'REFUNDED' });
}

/* ------------------------------------------------------------------ *
 * Reversal
 * ------------------------------------------------------------------ */

/**
 * Undo a lock by REVERSING its entry.
 *
 * Nothing is updated and nothing is deleted: a new entry with negated
 * postings restores the balances, and both entries remain readable. An
 * auditor can see that value was locked and that the lock was undone,
 * which an UPDATE would have erased.
 *
 * Requires `ledger.reverse`, which no ordinary account holds.
 */
export async function reverseLock(
  tx: Tx,
  principal: Principal,
  input: { readonly dealId: string; readonly reason: string },
): Promise<Outcome<{ reversalEntryId: string }>> {
  if (!can(principal, 'ledger.reverse')) {
    return reject('PERMISSION_DENIED', FAILURE_COPY.PERMISSION_DENIED.reason);
  }
  if (input.reason.trim().length < 8) {
    return reject('NOT_FOUND', 'A reversal must carry a written reason.');
  }

  const { rows: locked } = await tx.query(
    `SELECT lock_id, lock_entry_id, state FROM inrp2p.value_lock
      WHERE deal_id = $1 FOR UPDATE`,
    [input.dealId],
  );
  const lock = locked[0];
  if (!lock) return reject('NOT_FOUND', 'No value is locked against that deal.');
  if (lock.state !== 'LOCKED') {
    return reject('DEAL_TERMINAL', 'That lock has already been settled.');
  }

  const { rows } = await tx.query(`SELECT inrp2p.reverse_entry($1, $2) AS entry_id`, [
    lock.lock_entry_id,
    input.reason.trim(),
  ]);

  await tx.query(
    `UPDATE inrp2p.value_lock
        SET state='REVERSED', settled_at=now(), settle_entry_id=$2
      WHERE lock_id = $1 AND state='LOCKED'`,
    [lock.lock_id, rows[0]!.entry_id],
  );
  return accept({ reversalEntryId: rows[0]!.entry_id as string });
}

function mapLock(r: Record<string, unknown>): ValueLock {
  return {
    lockId: r.lock_id as string,
    dealId: r.deal_id as string,
    ownerId: r.owner_id as string,
    asset: r.asset as LedgerAsset,
    amountMinor: r.amount_minor as string,
    state: r.state as ValueLock['state'],
    lockEntryId: r.lock_entry_id as string,
    settleEntryId: (r.settle_entry_id as string | null) ?? null,
  };
}
