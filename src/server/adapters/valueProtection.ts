import 'server-only';
import { AdapterUnavailableError, deploymentMode } from './mode';
import type { Scenario } from '@/lib/scenario';

/**
 * The value-protection adapter — the seam DEL-04 attaches to.
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
 * │  The sandbox adapter records a SIMULATED lock. It holds no funds,  │
 * │  signs nothing, touches no wallet and produces no ledger posting;  │
 * │  its reference is prefixed `SBX-` so it can never be mistaken for  │
 * │  custody in a database dump or a support ticket.                   │
 * │                                                                    │
 * │  There is no production adapter, because DEL-04 has not been       │
 * │  implemented. Production therefore never locks, never releases     │
 * │  instructions, and says so loudly instead of degrading.            │
 * └────────────────────────────────────────────────────────────────────┘
 */

export interface ValueLock {
  /** Opaque reference recorded on the deal. `SBX-` prefixed in sandbox. */
  readonly reference: string;
  /** Always true here. A real adapter would not carry this field at all. */
  readonly simulated: boolean;
}

export interface ValueProtectionAdapter {
  readonly kind: 'SANDBOX' | 'PRODUCTION';
  /**
   * Record that the value leg for this deal is locked.
   *
   * Returns the lock fact the caller writes to the deal inside its own
   * transaction — the adapter never opens one, so a lock can never exist
   * outside the transaction that created the deal.
   */
  lock(input: {
    readonly dealId: string;
    readonly scenario: Scenario;
    readonly usdtMinor: bigint | null;
    readonly inrMinor: bigint;
  }): Promise<ValueLock>;
  /** Record that the locked value is released. Releases nothing here. */
  release(dealId: string): Promise<void>;
}

class SandboxValueProtection implements ValueProtectionAdapter {
  readonly kind = 'SANDBOX' as const;

  async lock(input: { dealId: string }): Promise<ValueLock> {
    return { reference: `SBX-LOCK-${input.dealId.slice(0, 8)}`, simulated: true };
  }

  async release(): Promise<void> {
    /* Holds nothing, so there is nothing to release. Recorded by the caller. */
  }
}

/**
 * The LEDGER-BACKED lock reference, for a deal whose value really moved.
 *
 * DEL-04 gives the sandbox a genuine internal ledger, so a deal that
 * locks value now carries the lock id of a real double-entry movement
 * rather than a synthetic string. The prefix stays `SBX-` for the same
 * reason as before: the value in that ledger was never deposited by
 * anybody, and no reference produced by this repository may be mistaken
 * for custody of real funds.
 */
export function ledgerLockReference(lockId: string): string {
  return `SBX-LEDGER-${lockId}`;
}

/**
 * Resolve the adapter, or refuse.
 *
 * Production throws rather than returning `null`, because a caller that
 * received `null` would have to remember to check — and the one place
 * that forgets is the one that releases bank details against nothing.
 */
export function getValueProtectionAdapter(): ValueProtectionAdapter {
  if (deploymentMode() === 'PRODUCTION') {
    throw new AdapterUnavailableError(
      'value-protection',
      'DEL-04 (Value Protection and Double-Entry Ledger)',
      'No ledger, custody or collateral boundary exists in this repository.',
    );
  }
  return new SandboxValueProtection();
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
