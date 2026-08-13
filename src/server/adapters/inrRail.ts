import 'server-only';
import { AdapterUnavailableError, deploymentMode } from './mode';

/**
 * The INR rail adapter — collections in, payouts out.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  PROVIDER-NEUTRAL, AND NO PROVIDER IS NAMED ANYWHERE.              │
 * │                                                                    │
 * │  The interface speaks UPI/IMPS/NEFT because those are the rails    │
 * │  Indian banking actually has, and a vocabulary that cannot express │
 * │  them would have to be replaced the moment a real provider is      │
 * │  chosen. It does NOT speak any provider's dialect: no endpoint, no │
 * │  credential, no field named after somebody's API.                  │
 * │                                                                    │
 * │  The sandbox implementation issues a destination that is shaped    │
 * │  like a VPA and is not one, and settles nothing. There is no       │
 * │  production implementation, so production refuses instead of       │
 * │  quietly handing a customer a fake account to pay into.            │
 * └────────────────────────────────────────────────────────────────────┘
 */

export type InrNetwork = 'UPI' | 'IMPS' | 'NEFT';

export interface InrDestination {
  /** A VPA for UPI; an account reference for IMPS/NEFT. */
  readonly destination: string;
  /** Beneficiary name, bank and IFSC where the network requires them. */
  readonly detail: Readonly<Record<string, string>>;
  /** What the payer must quote on the transfer so it can be reconciled. */
  readonly reference: string;
}

export interface InrRailAdapter {
  readonly providerKey: string;
  readonly kind: 'SANDBOX' | 'PRODUCTION';

  /**
   * Ask the provider for somewhere to collect INR.
   *
   * `idempotencyKey` is the caller's, not the adapter's: a retry after a
   * timeout must reach the provider with the same key, or the retry
   * allocates a second destination and the payer's transfer arrives at
   * whichever one they happened to see first.
   */
  allocateCollection(input: {
    readonly idempotencyKey: string;
    readonly network: InrNetwork;
    readonly amountMinor: bigint;
    readonly reference: string;
  }): Promise<InrDestination>;

  /**
   * Instruct a payout.
   *
   * Returns the provider's own reference. It is NOT a settlement: the
   * payout is settled when the provider says so through a signed webhook,
   * which is a different code path with different evidence.
   */
  requestPayout(input: {
    readonly idempotencyKey: string;
    readonly network: InrNetwork;
    readonly amountMinor: bigint;
    readonly beneficiary: string;
  }): Promise<{ readonly providerRef: string }>;
}

/**
 * Sandbox INR rail.
 *
 * Every value it produces is prefixed or suffixed so it announces itself.
 * `@sbxbank` is not a real PSP handle and `SBX-` references are refused by
 * the production-shaped reconciliation path.
 */
class SandboxInrRail implements InrRailAdapter {
  readonly providerKey = 'sandbox-inr';
  readonly kind = 'SANDBOX' as const;

  async allocateCollection(input: {
    idempotencyKey: string;
    network: InrNetwork;
    reference: string;
  }): Promise<InrDestination> {
    // Derived from the idempotency key, so a retry gets the SAME
    // destination rather than a second one — the behaviour a real
    // provider's idempotency contract gives, reproduced honestly.
    const slug = input.idempotencyKey.replace(/-/g, '').slice(0, 12);
    return {
      destination: input.network === 'UPI' ? `sbx.${slug}@sbxbank` : `SBX${slug.toUpperCase()}`,
      detail: {
        beneficiaryName: 'INRP2P Sandbox Collections',
        note: 'Simulated destination. No bank account exists behind this value.',
        ...(input.network === 'UPI' ? {} : { ifsc: 'SBXB0000001', bankName: 'Sandbox Bank' }),
      },
      reference: input.reference,
    };
  }

  async requestPayout(input: { idempotencyKey: string }): Promise<{ providerRef: string }> {
    return { providerRef: `SBXPAYOUT${input.idempotencyKey.replace(/-/g, '').slice(0, 10)}` };
  }
}

export function getInrRailAdapter(): InrRailAdapter {
  if (deploymentMode() === 'PRODUCTION') {
    throw new AdapterUnavailableError(
      'inr-rail',
      'DEL-05 (INR and USDT Payment Rails)',
      'No INR collection or payout provider is integrated in this repository, ' +
        'and no provider credentials exist. Refusing to issue payment ' +
        'instructions that no bank will honour.',
    );
  }
  return new SandboxInrRail();
}

/** Non-throwing probe, for read paths that must not 500 a page render. */
export function inrRailAvailable(): boolean {
  return deploymentMode() !== 'PRODUCTION';
}
