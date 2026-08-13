import 'server-only';
import { createHash } from 'node:crypto';
import { AdapterUnavailableError, deploymentMode } from './mode';

/**
 * The USDT rail adapter — custody allocation and chain watching.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  "USDT" IS NOT A NETWORK. THE NETWORK IS THE WHOLE QUESTION.       │
 * │                                                                    │
 * │  The same ticker exists on TRON, Ethereum, Solana and a dozen      │
 * │  others, with different addresses, different decimals in some      │
 * │  cases, and no way to recover a transfer sent to the wrong one.    │
 * │  So the network is a typed, validated, non-defaulted parameter     │
 * │  everywhere in this file, and TRC20 is the only value this stage   │
 * │  accepts. A caller cannot omit it and get a guess.                 │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * There is no production custody adapter. Production therefore allocates
 * no address and watches no chain — it refuses, because the alternative
 * is showing a customer an address that nobody holds the keys to.
 */

export type UsdtNetwork = 'TRC20';

/** TRC20 USDT has six decimals. Not eighteen, not eight. */
export const USDT_DECIMALS = 6;

export interface UsdtAddress {
  readonly address: string;
  readonly network: UsdtNetwork;
}

/** What a watcher reports about one on-chain transfer. */
export interface ChainObservation {
  readonly txHash: string;
  readonly network: UsdtNetwork;
  readonly toAddress: string;
  readonly amountMinor: bigint;
  readonly confirmations: number;
  readonly status: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REORGED';
  readonly observedAt: Date;
}

export interface UsdtRailAdapter {
  readonly providerKey: string;
  readonly kind: 'SANDBOX' | 'PRODUCTION';
  readonly network: UsdtNetwork;
  /** How many confirmations this network requires before value is believed. */
  readonly requiredConfirmations: number;

  allocateAddress(input: {
    readonly idempotencyKey: string;
    readonly network: UsdtNetwork;
  }): Promise<UsdtAddress>;
}

/**
 * TRON's confirmation policy, stated as a number rather than assumed.
 *
 * TRON finalises by super-representative consensus at roughly 19 blocks;
 * this is deliberately at that boundary rather than at 1. A single
 * confirmation is not settlement on any chain, and treating it as one is
 * how reorg losses happen.
 */
const TRC20_REQUIRED_CONFIRMATIONS = 19;

class SandboxUsdtRail implements UsdtRailAdapter {
  readonly providerKey = 'sandbox-usdt';
  readonly kind = 'SANDBOX' as const;
  readonly network = 'TRC20' as const;
  readonly requiredConfirmations = TRC20_REQUIRED_CONFIRMATIONS;

  async allocateAddress(input: {
    idempotencyKey: string;
    network: UsdtNetwork;
  }): Promise<UsdtAddress> {
    if (input.network !== 'TRC20') {
      throw new TypeError(`unsupported USDT network: ${String(input.network)}`);
    }
    /*
     * `TSBX` + 30 base58 characters: the right shape for TRON validation
     * and the wrong prefix for a real address, so it is recognisable as
     * fictitious at a glance and by the database CHECK. Derived from the
     * idempotency key so a retry allocates the same address instead of
     * stranding the payer's funds at an abandoned one.
     */
    const base58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const digest = createHash('sha256').update(input.idempotencyKey).digest();
    let suffix = '';
    for (let i = 0; i < 30; i += 1) suffix += base58[digest[i]! % base58.length];
    return { address: `TSBX${suffix}`, network: 'TRC20' };
  }
}

export function getUsdtRailAdapter(): UsdtRailAdapter {
  if (deploymentMode() === 'PRODUCTION') {
    throw new AdapterUnavailableError(
      'usdt-rail',
      'DEL-05 (INR and USDT Payment Rails)',
      'No custody provider or chain watcher is integrated in this repository. ' +
        'Refusing to allocate a deposit address that nobody holds the keys to.',
    );
  }
  return new SandboxUsdtRail();
}

export function usdtRailAvailable(): boolean {
  return deploymentMode() !== 'PRODUCTION';
}
