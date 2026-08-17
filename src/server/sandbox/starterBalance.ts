import 'server-only';
import { createHash } from 'node:crypto';
import { withTransaction, type Tx } from '@/server/db/pool';
import { deploymentMode } from '@/server/adapters/mode';
import { permissionsFor, type Principal } from '@/server/identity/rbac';
import { fundSandboxBalance } from '@/server/ledger/valueProtection';

/**
 * Give a new sandbox account something to trade with.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WITHOUT THIS, THE USDT CORRIDOR CANNOT BE TRIED AT ALL.           │
 * │                                                                    │
 * │  Selling USDT now takes the seller's balance into escrow — which   │
 * │  is the point. But the only way value ever entered the ledger was  │
 * │  an administrator command nobody outside this repository knows     │
 * │  about, so every new account started at zero and every attempt to  │
 * │  sell was refused for being broke.                                 │
 * │                                                                    │
 * │  A demonstration account with nothing in it demonstrates nothing.  │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ⚠ SANDBOX ONLY, AND LOUDLY SO. The posting is `JD-SBX-FUND` from a
 * sandbox funding source — a real double-entry record of value that
 * nobody deposited. In production this is a no-op and the corridor stays
 * closed until a custodian credits balances from an observed transfer,
 * because handing out USDT nobody sent is not a starting balance, it is
 * an invented liability.
 */

/** 5,000 USDT, in micro. Enough for many deals at the sizes this UI suggests. */
const STARTING_USDT_MICRO = 5_000_000_000n;

/**
 * A principal that exists only to make the credit go through the same
 * permissioned path an administrator would use.
 *
 * Constructed rather than faked around: `fundSandboxBalance` checks
 * `ledger.fund`, and routing this through a second, unchecked entry point
 * would mean two ways for value to enter the ledger — which is exactly one
 * more than a money system should have.
 */
function systemPrincipal(userId: string): Principal {
  return {
    userId,
    roles: ['ADMIN'],
    permissions: permissionsFor(['ADMIN']),
    mfaSatisfied: true,
    mfaEnrolled: true,
  };
}

/**
 * A command id derived from the account, so a retry credits once.
 *
 * This runs inside account creation and should therefore happen exactly
 * once by construction — but "should" is not a constraint. A deterministic
 * id makes the ledger itself refuse a second credit for the same account,
 * whatever calls this and however often.
 */
function creditCommandId(userId: string): string {
  const h = createHash('sha256').update(`starter-balance:${userId}`).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    // Version 4 and the RFC variant bits, so it is a well-formed UUID the
    // column will accept rather than 32 hex characters that merely look
    // like one.
    `4${h.slice(13, 16)}`,
    `${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join('-');
}

/**
 * Credit the starting balance. Safe to call for every new account.
 *
 * Failures are swallowed on purpose: a person who cannot be given play
 * money must still be able to sign in. The refusal is logged, and the
 * consequence — being unable to sell USDT — surfaces honestly at the
 * point of trying rather than as a broken sign-in.
 */
export type ClaimResult =
  | { readonly ok: true; readonly amountMinor: bigint }
  | { readonly ok: false; readonly code: 'ALREADY_CLAIMED' | 'NOT_SANDBOX' };

/**
 * Claim the test balance. ASKED FOR, never automatic.
 *
 * ⚠ THIS WAS A SIDE EFFECT OF SIGNING IN, AND THAT WAS WRONG.
 *
 * Crediting on sign-in worked, and it hid what it was doing: an account
 * silently acquired money from nowhere. It also made every test that
 * asserted a new account starts at zero suddenly false — not by accident
 * but because the assertion had stopped being true, which is the kind of
 * signal worth listening to rather than adjusting away.
 *
 * A person now asks, once, and sees what they were given. The ledger
 * enforces the "once": the command id is derived from the account, so a
 * second claim finds an entry already recorded under it.
 */
export async function claimTestFunds(userId: string): Promise<ClaimResult> {
  if (deploymentMode() !== 'SANDBOX') return { ok: false, code: 'NOT_SANDBOX' };

  try {
    const funded = await withTransaction((tx: Tx) =>
      fundSandboxBalance(tx, systemPrincipal(userId), {
        userId,
        asset: 'USDT',
        amountMinor: STARTING_USDT_MICRO,
        commandId: creditCommandId(userId),
      }),
    );
    if (!funded.ok) return { ok: false, code: 'ALREADY_CLAIMED' };
    return { ok: true, amountMinor: STARTING_USDT_MICRO };
  } catch {
    /*
     * A repeat claim arrives as a thrown uniqueness violation rather than
     * an Outcome, because the journal refuses the duplicate command id
     * before the function returns. Expected, and the honest answer to
     * "can I have more" is no.
     */
    return { ok: false, code: 'ALREADY_CLAIMED' };
  }
}
