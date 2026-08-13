import 'server-only';
import type { Tx } from '@/server/db/pool';

/**
 * Account keys, named once.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE ACCOUNT KEY IS THE ACCOUNT'S IDENTITY.                        │
 * │                                                                    │
 * │  `account_id` is derived from these five fields by the database    │
 * │  (CE → UUIDv5), and `ledger_account_id_derived` refuses any row    │
 * │  whose id was not. So a caller never chooses an id and never       │
 * │  passes one around: it says which account it means, and the        │
 * │  database says which id that is.                                   │
 * │                                                                    │
 * │  Building the keys here rather than at each call site means the    │
 * │  scope vocabulary — `user`, `deal` — is stated once. A typo in a   │
 * │  `scope_kind` would silently create a SECOND, empty account rather │
 * │  than failing, which is exactly the kind of mistake that is        │
 * │  invisible until a balance is wrong.                               │
 * └────────────────────────────────────────────────────────────────────┘
 */

export type LedgerAsset = 'USDT' | 'TRX';

export interface AccountKey {
  readonly asset: LedgerAsset;
  readonly family: string;
  readonly scopeKind: string;
  readonly scopeId: string;
  readonly shard: number;
}

/** A person's spendable balance. Credit-normal: we owe them. */
export function partyBalanceKey(userId: string, asset: LedgerAsset = 'USDT'): AccountKey {
  return { asset, family: 'party.balance', scopeKind: 'user', scopeId: userId, shard: 0 };
}

/** Value locked to one deal. Credit-normal: we owe it to the deal's outcome. */
export function dealEscrowKey(dealId: string, asset: LedgerAsset = 'USDT'): AccountKey {
  return { asset, family: 'escrow', scopeKind: 'deal', scopeId: dealId, shard: 0 };
}

/**
 * Where a sandbox funding entry draws value FROM.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  NOT A WALLET. DELIBERATELY.                                       │
 * │                                                                    │
 * │  The obvious counter-account for funding is `wallet.hot`, and it   │
 * │  is the wrong one. Debiting a custodial wallet asserts that the    │
 * │  custodian HOLDS that USDT — the single claim this repository is   │
 * │  forbidden to make, because nobody deposited anything.             │
 * │                                                                    │
 * │  So sandbox funding is booked as an EXPENSE instead: the platform  │
 * │  gave value away out of nothing, which is precisely what happened. │
 * │  Every `wallet.*` account therefore stays at exactly zero for the  │
 * │  life of the sandbox, and that is asserted by a test — "no wallet  │
 * │  ever holds a balance" is a stronger and more checkable statement  │
 * │  than any naming convention.                                       │
 * └────────────────────────────────────────────────────────────────────┘
 */
export function sandboxFundingSourceKey(asset: LedgerAsset = 'USDT'): AccountKey {
  return {
    asset,
    family: 'platform_compensation_expense',
    scopeKind: 'platform',
    scopeId: '',
    shard: 0,
  };
}

/**
 * The wallet a CONFIRMED external deposit lands in.
 *
 * Unlike `sandboxFundingSourceKey`, debiting this account is an honest
 * claim: a watcher observed the transfer on chain and the confirmation
 * policy was satisfied, so the custodian really does hold those tokens.
 * The difference between these two functions is the difference between
 * bookkeeping and a lie, which is why they are two functions with two
 * names rather than one with a flag.
 */
export function depositWalletKey(asset: LedgerAsset = 'USDT'): AccountKey {
  return { asset, family: 'wallet.deposit', scopeKind: 'custody', scopeId: '', shard: 0 };
}

/**
 * Materialize accounts and resolve their ids, in one round trip.
 *
 * The ids are selected as one row of N columns rather than by unnesting the
 * key array: `unnest` over a composite array expands it into its FIELDS, so
 * a column alias list would silently rename `asset` instead of naming the
 * whole key. Positional columns keep the mapping obvious and ordered.
 */
export async function ensureAccounts(tx: Tx, keys: readonly AccountKey[]): Promise<string[]> {
  if (keys.length === 0) return [];

  const literals = keys.map(
    (_, i) =>
      `ROW($${i * 5 + 1},$${i * 5 + 2},$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5})::inrp2p.account_key`,
  );
  const params = keys.flatMap((k) => [k.asset, k.family, k.scopeKind, k.scopeId, k.shard]);

  await tx.query(`SELECT inrp2p.ensure_accounts(ARRAY[${literals.join(',')}])`, params);

  const projection = literals
    .map((literal, i) => `inrp2p.account_id_of(${literal}) AS a${i}`)
    .join(', ');
  const { rows } = await tx.query(`SELECT ${projection}`, params);
  return keys.map((_, i) => rows[0][`a${i}`] as string);
}
