import 'server-only';

/**
 * SandboxEscrowService — a deliberately non-custodial stand-in.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THIS HOLDS NO FUNDS AND MOVES NO FUNDS.                           │
 * │                                                                    │
 * │  It exists so the sandbox journey has the same *shape* as the real │
 * │  one — something is "held" against a deal and "released" on        │
 * │  confirmation — without any of the substance. Every method below   │
 * │  returns a record of an assertion. None of them:                   │
 * │    · debits or credits an account (there are no accounts);         │
 * │    · signs, broadcasts or observes a chain transaction;            │
 * │    · touches a wallet, key, HSM or custodian;                      │
 * │    · produces a ledger posting or journal entry.                   │
 * │                                                                    │
 * │  The real implementation is a TS-03 concern governed by TS-01.4    │
 * │  §13.2 and is NOT implemented anywhere in this repository.         │
 * └────────────────────────────────────────────────────────────────────┘
 */

export interface EscrowHold {
  readonly reference: string;
  readonly dealId: string;
  readonly usdtMinor: bigint;
  readonly heldAt: string;
  /** Always true here. A real adapter would never return this field at all. */
  readonly simulated: true;
}

export interface EscrowService {
  readonly kind: 'SANDBOX' | 'PRODUCTION';
  /** Records that a deal *would* lock collateral. Locks nothing. */
  hold(dealId: string, usdtMinor: bigint): Promise<EscrowHold>;
  /** Records that a deal *would* release collateral. Releases nothing. */
  release(dealId: string): Promise<{ readonly dealId: string; readonly simulated: true }>;
}

class SandboxEscrowService implements EscrowService {
  readonly kind = 'SANDBOX' as const;

  async hold(dealId: string, usdtMinor: bigint): Promise<EscrowHold> {
    return {
      reference: `SBX-HOLD-${dealId.slice(0, 8)}`,
      dealId,
      usdtMinor,
      heldAt: new Date().toISOString(),
      simulated: true,
    };
  }

  async release(dealId: string) {
    return { dealId, simulated: true as const };
  }
}

/**
 * Fail closed.
 *
 * If the app is running in production mode and the only escrow adapter
 * available is the sandbox one, that is a misconfiguration that could put a
 * "no real funds" simulation in front of real users. Refuse to construct the
 * service rather than degrade quietly.
 *
 * `INRP2P_ESCROW_ADAPTER=sandbox` is required to acknowledge the choice, and
 * even then production is refused: there is no production adapter to fall back
 * to, because none has been implemented.
 */
export function getEscrowService(): EscrowService {
  const isProduction = process.env.NODE_ENV === 'production';
  const isSandboxDeployment = process.env.INRP2P_SANDBOX === 'true';

  if (isProduction && !isSandboxDeployment) {
    throw new Error(
      'Refusing to start: NODE_ENV=production but the only configured escrow adapter is ' +
        'SandboxEscrowService, which holds no funds. No production custody adapter exists ' +
        'in this repository. Set INRP2P_SANDBOX=true to run an explicitly-labelled sandbox ' +
        'deployment, or implement and configure a real adapter under TS-03.',
    );
  }

  return new SandboxEscrowService();
}

/** True when the running deployment is the funds-free sandbox. Drives UI notices. */
export const IS_SANDBOX_DEPLOYMENT = true;
