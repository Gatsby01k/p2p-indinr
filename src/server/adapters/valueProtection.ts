import 'server-only';
import { AdapterUnavailableError, deploymentMode } from './mode';
import type { Scenario } from '@/lib/scenario';
import type { Tx } from '@/server/db/pool';
import { accept, type Outcome } from '@/server/boundary/outcome';
import { lockDealValue, releaseDealValue } from '@/server/ledger/valueProtection';

/**
 * The value-protection adapter — what makes "protected" mean something.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THIS IS THE ONLY THING THAT MAY ASSERT VALUE IS LOCKED.           │
 * │                                                                    │
 * │  `sandbox.deal.value_locked_at` gates bank/UPI instruction release │
 * │  (UX-01 §3, TS-01.4 I7, roadmap B5). Nothing else in the codebase  │
 * │  writes that column, so "instructions cannot appear before a lock" │
 * │  is enforced by there being exactly one writer, not by remembering │
 * │  to check in each screen.                                          │
 * │                                                                    │
 * │  ⚠ IT USED TO ASSERT A LOCK THAT DID NOT EXIST.                    │
 * │                                                                    │
 * │  The sandbox implementation returned `SBX-LOCK-<id>` and, in its   │
 * │  own words, held no funds, signed nothing and made no posting.     │
 * │  Meanwhile DEL-04 had built a real double-entry escrow next door   │
 * │  in `@/server/ledger/valueProtection` — reachable only through     │
 * │  standalone commands that an ordinary deal never called.           │
 * │                                                                    │
 * │  So a USDT seller could complete a deal, be paid in rupees, and    │
 * │  the buyer received nothing while the product said "completed".    │
 * │  The escrow existed; the deal was simply not attached to it.       │
 * │                                                                    │
 * │  This file is now that attachment. The seam did not need moving —  │
 * │  `lock()` was already called inside the transaction that creates   │
 * │  the deal, and `release()` inside the one that completes it.       │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ON WHAT CAN AND CANNOT BE ESCROWED. The platform can hold USDT in its
 * ledger, so an exchange corridor gets a REAL lock: the crypto side's
 * balance is debited into the deal's escrow and released to the
 * counterparty on completion. It holds no rupees and no bank account, so
 * `INR_TO_INR` has nothing to escrow — there the platform witnesses and
 * arbitrates, and the reference says so rather than implying custody.
 */

export interface ValueLock {
  /** Opaque reference recorded on the deal. */
  readonly reference: string;
  /**
   * Whether value is actually held against this deal.
   *
   * False for a corridor the platform cannot custody. It replaces the old
   * `simulated` flag, which was true for every lock this file ever issued
   * and therefore told a reader nothing.
   */
  readonly custodied: boolean;
}

export interface ValueProtectionAdapter {
  readonly kind: 'LEDGER' | 'PRODUCTION';

  /**
   * Take the crypto side's value into the deal's escrow.
   *
   * Runs on the CALLER'S transaction — the adapter never opens one — so a
   * lock cannot exist outside the transaction that created the deal, and
   * a deal cannot exist without its lock.
   *
   * Returns an `Outcome` rather than throwing: "you have not deposited
   * enough USDT" is an ordinary refusal a person can act on, not a fault.
   */
  lock(input: {
    readonly tx: Tx;
    /** The deal's UUID, allocated before the row so the escrow can name it. */
    readonly dealId: string;
    /** Who puts the value up — the crypto side, not whoever clicked. */
    readonly ownerId: string;
    readonly commandId: string;
    readonly scenario: Scenario;
    readonly usdtMinor: bigint | null;
    readonly inrMinor: bigint;
  }): Promise<Outcome<ValueLock>>;

  /** Hand the escrowed value to the counterparty and close the lock. */
  release(input: {
    readonly tx: Tx;
    readonly dealId: string;
    /** Who receives the value — the fiat side of an exchange corridor. */
    readonly beneficiaryId: string;
    readonly commandId: string;
  }): Promise<Outcome<void>>;
}

/**
 * A reference that names the ledger movement behind it.
 *
 * `SBX-` is retained deliberately while the ledger is funded by an
 * administrator rather than by a deposit anybody made: the balances are
 * real double-entry records of value that never arrived on a chain, and
 * no reference this repository produces may be mistaken for custody of
 * real funds. It becomes `LEDGER-` the day deposits do.
 */
export function ledgerLockReference(lockId: string): string {
  return `SBX-LEDGER-${lockId}`;
}

/**
 * The reference for a corridor with nothing to custody.
 *
 * Named for what it is. `INR_TO_INR` moves rupees between two banks the
 * platform does not touch; calling that a lock would be the same lie this
 * file exists to remove.
 */
function witnessReference(dealId: string): string {
  return `WITNESS-${dealId.slice(0, 8)}`;
}

class LedgerValueProtection implements ValueProtectionAdapter {
  readonly kind = 'LEDGER' as const;

  async lock(input: {
    tx: Tx;
    dealId: string;
    ownerId: string;
    commandId: string;
    scenario: Scenario;
    usdtMinor: bigint | null;
  }): Promise<Outcome<ValueLock>> {
    /*
     * Nothing to hold. The platform custodies no rupees, so an INR→INR
     * deal is witnessed rather than escrowed — and the deal still needs a
     * reference, because `value_locked_at` gates the pay screen and a
     * protected payment must reach it.
     */
    if (input.scenario === 'INR_TO_INR' || input.usdtMinor === null) {
      return accept({ reference: witnessReference(input.dealId), custodied: false });
    }

    const locked = await lockDealValue(input.tx, {
      dealId: input.dealId,
      ownerId: input.ownerId,
      commandId: input.commandId,
      asset: 'USDT',
      amountMinor: input.usdtMinor,
    });
    // Passed through unchanged — INSUFFICIENT_BALANCE is the one the
    // person acts on, and rewording it here would lose the detail the
    // ledger attached about how much is short.
    if (!locked.ok) return locked;

    return accept({
      reference: ledgerLockReference(locked.value.lockId),
      custodied: true,
    });
  }

  async release(input: {
    tx: Tx;
    dealId: string;
    beneficiaryId: string;
    commandId: string;
  }): Promise<Outcome<void>> {
    const released = await releaseDealValue(input.tx, {
      dealId: input.dealId,
      beneficiaryId: input.beneficiaryId,
      commandId: input.commandId,
    });
    /*
     * A witnessed deal has no lock, and `NOT_FOUND` is the correct and
     * expected answer for one. Every other refusal is a real failure and
     * must stop the completion rather than be swallowed — releasing the
     * rupee side while the USDT stays locked is the asymmetry this whole
     * change exists to remove.
     */
    if (!released.ok) {
      if (released.code === 'NOT_FOUND') return accept(undefined);
      return released;
    }
    return accept(undefined);
  }
}

/**
 * Resolve the adapter, or refuse.
 *
 * Production throws rather than returning `null`, because a caller that
 * received `null` would have to remember to check — and the one place
 * that forgets is the one that releases bank details against nothing.
 *
 * The refusal survives DEL-04 for a reason the ledger does not fix: the
 * balances it moves were credited by an administrator, not deposited by
 * anybody. Escrow that holds nothing a customer put in is not custody, so
 * production still fails closed until a real deposit path exists.
 */
export function getValueProtectionAdapter(): ValueProtectionAdapter {
  if (deploymentMode() === 'PRODUCTION') {
    throw new AdapterUnavailableError(
      'value-protection',
      'DEL-04 (Value Protection and Double-Entry Ledger) — custody integration',
      'The internal ledger escrows and releases value correctly, but nothing ' +
        'deposits into it: balances are credited by an administrator, never by ' +
        'a customer transfer observed on a chain. Holding value nobody sent is ' +
        'not custody.',
    );
  }
  return new LedgerValueProtection();
}

/**
 * Whether value protection is available at all, without throwing.
 *
 * Read paths need to answer "may this deal show payment instructions?"
 * without turning an ordinary page render into a 500. Mutation paths use
 * `getValueProtectionAdapter()` and fail closed loudly.
 */
export function valueProtectionAvailable(): boolean {
  return deploymentMode() !== 'PRODUCTION';
}
