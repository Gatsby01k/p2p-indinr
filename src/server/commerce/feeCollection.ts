import 'server-only';
import { toBigInt, type Tx } from '@/server/db/pool';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { ensureAccounts, partyBalanceKey, type LedgerAsset } from '@/server/ledger/accounts';
import { snapshotForDeal } from './pricing';

/**
 * Collecting the fee.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A FEE IS COLLECTED ONCE, FROM VALUE THAT IS ACTUALLY THERE, AT    │
 * │  THE MOMENT THE DEAL SUCCEEDS — AND NEVER OTHERWISE.               │
 * │                                                                    │
 * │  Not on a refund. Not on a cancellation. Not on a reversal. Those  │
 * │  are not economic successes and charging for them is charging for  │
 * │  a service that did not happen.                                    │
 * │                                                                    │
 * │  The amount comes from the SNAPSHOT, verbatim. It is not           │
 * │  recomputed at settlement, because recomputation is how a customer │
 * │  ends up paying a rate that was activated after they agreed.       │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * THE HONEST FAILURE. INRP2P holds no rupees, so an INR-denominated fee
 * has no ledger balance to come from. Rather than invent a receivable or
 * claim somebody paid outside the system, the collection row records
 * `collected = false` with a reason, and the deal completes. That is a
 * known, visible shortfall — which is the truth — instead of a fabricated
 * asset, which is not.
 */

export interface FeeCollectionResult {
  readonly collectionId: string;
  readonly collected: boolean;
  readonly amountMinor: string;
  readonly ledgerEntryId: string | null;
  readonly reason: string | null;
}

/**
 * Collect the platform fee out of a released settlement.
 *
 * Called from inside the release path, on the same transaction, so the
 * ledger entry, the collection row, the audit and the outbox commit
 * together with the settlement itself.
 *
 * `beneficiaryId` is who received the released value: the fee comes out
 * of what they were credited, which is what `fee_bearer = 'PAYEE'` means
 * and — for `'PAYER'` — is already priced into what the payer sent.
 */
export async function collectFee(
  tx: Tx,
  input: {
    readonly dealId: string;
    readonly beneficiaryId: string;
    readonly commandId: string;
    readonly asset: LedgerAsset;
  },
): Promise<Outcome<FeeCollectionResult>> {
  /*
   * A LEGACY DEAL HAS NO SNAPSHOT, AND THAT IS NOT AN ERROR.
   *
   * Deals priced before versioned policy existed carry their fee in the
   * old quote columns and were never promised a policy version. The
   * correct behaviour is to collect nothing new — never to price them
   * under a schedule they never saw. This is the non-retroactive
   * migration strategy, and it is a branch rather than a comment.
   */
  const snapshot = await snapshotForDeal(tx, input.dealId);
  if (snapshot === null) {
    return accept({
      collectionId: '',
      collected: false,
      amountMinor: '0',
      ledgerEntryId: null,
      reason: 'QUOTE_SNAPSHOT_MISSING',
    });
  }

  const amountMinor = toBigInt(snapshot.finalFeeMinor);

  /*
   * ONE COLLECTION PER DEAL, decided by the unique constraint.
   *
   * `ON CONFLICT DO NOTHING` means a replayed settlement and two
   * concurrent settlements both land here and neither posts a second
   * entry — the loser reads the committed row and reports it.
   */
  const claim = await tx.query(
    `INSERT INTO sandbox.fee_collection
       (deal_id, snapshot_id, command_id, fee_asset, amount_minor, collected,
        uncollectible_reason)
     VALUES ($1,$2,$3,$4,$5,FALSE,'PENDING')
     ON CONFLICT (deal_id) DO NOTHING
     RETURNING collection_id`,
    [input.dealId, snapshot.snapshotId, input.commandId, snapshot.feeAsset, amountMinor.toString()],
  );

  if (claim.rowCount === 0) {
    const { rows } = await tx.query(
      `SELECT collection_id, collected, amount_minor::text AS amount_minor,
              ledger_entry_id, uncollectible_reason
         FROM sandbox.fee_collection WHERE deal_id = $1`,
      [input.dealId],
    );
    const prior = rows[0]!;
    // A replay of the SAME command replays the recorded result; a
    // different command is told the fee is already taken.
    return accept({
      collectionId: prior.collection_id as string,
      collected: prior.collected as boolean,
      amountMinor: prior.amount_minor as string,
      ledgerEntryId: (prior.ledger_entry_id as string | null) ?? null,
      reason: (prior.uncollectible_reason as string | null) ?? null,
    });
  }

  const collectionId = claim.rows[0]!.collection_id as string;

  /* ---- The honest refusal ---- */

  if (snapshot.feeAsset !== 'USDT') {
    /*
     * An INR fee on a non-custodial INR transfer. The rupees moved
     * between two bank accounts INRP2P does not hold, so there is
     * nothing here to take a cut of. Recorded as an uncollectible
     * shortfall — not a receivable, which would assert somebody owes
     * money nobody agreed to owe.
     */
    await tx.query(
      `UPDATE sandbox.fee_collection
          SET collected=FALSE, uncollectible_reason=$2 WHERE collection_id=$1`,
      [collectionId, 'The fee is denominated in INR and INRP2P holds no custodial INR balance.'],
    );
    return accept({
      collectionId,
      collected: false,
      amountMinor: amountMinor.toString(),
      ledgerEntryId: null,
      reason: 'FEE_ASSET_UNSUPPORTED',
    });
  }

  if (amountMinor <= 0n) {
    await tx.query(
      `UPDATE sandbox.fee_collection
          SET collected=FALSE, uncollectible_reason=$2 WHERE collection_id=$1`,
      [collectionId, 'The snapshotted fee for this deal is zero.'],
    );
    return accept({
      collectionId,
      collected: false,
      amountMinor: '0',
      ledgerEntryId: null,
      reason: 'ZERO_FEE',
    });
  }

  /* ---- The posting ---- */

  const [beneficiary, revenue] = await ensureAccounts(tx, [
    partyBalanceKey(input.beneficiaryId, input.asset),
    { asset: input.asset, family: 'fee_revenue', scopeKind: 'platform', scopeId: '', shard: 0 },
  ]);

  /*
   * Debit the beneficiary's balance (+, reducing what we owe them) and
   * credit platform revenue (−). Sums to zero per asset, which DEL-04's
   * constraint trigger verifies at commit, and the beneficiary's balance
   * cannot go negative because `account_balance_credit_normal_not_debit`
   * refuses it — so a fee larger than the settlement fails loudly
   * instead of overdrawing a customer.
   */
  const { rows } = await tx.query(
    `SELECT inrp2p.post_entry('JD-FEE', $1::jsonb, ARRAY[$2::uuid,$3::uuid],
                              ARRAY[$4::numeric,$5::numeric]) AS entry_id`,
    [
      JSON.stringify({
        dealId: input.dealId,
        snapshotId: snapshot.snapshotId,
        commandId: input.commandId,
      }),
      beneficiary,
      revenue,
      amountMinor.toString(),
      (-amountMinor).toString(),
    ],
  );
  const entryId = rows[0]!.entry_id as string;

  await tx.query(
    `UPDATE sandbox.fee_collection
        SET collected=TRUE, ledger_entry_id=$2, uncollectible_reason=NULL
      WHERE collection_id=$1`,
    [collectionId, entryId],
  );

  return accept({
    collectionId,
    collected: true,
    amountMinor: amountMinor.toString(),
    ledgerEntryId: entryId,
    reason: null,
  });
}

/**
 * Reverse a collected fee.
 *
 * Used when a settlement it depended on is itself reversed. The original
 * entry is NOT edited — DEL-04 has no path that could — so this posts a
 * reversal and records it alongside.
 */
export async function reverseFee(
  tx: Tx,
  input: { readonly dealId: string; readonly reason: string },
): Promise<Outcome<{ reversalEntryId: string | null }>> {
  const { rows } = await tx.query(
    `SELECT collection_id, collected, ledger_entry_id, reversal_entry_id
       FROM sandbox.fee_collection WHERE deal_id = $1 FOR UPDATE`,
    [input.dealId],
  );
  const row = rows[0];
  if (row === undefined) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);
  if (row.collected !== true || row.ledger_entry_id === null) {
    return accept({ reversalEntryId: null });
  }
  if (row.reversal_entry_id !== null) {
    return accept({ reversalEntryId: row.reversal_entry_id as string });
  }

  const { rows: reversed } = await tx.query(
    `SELECT inrp2p.reverse_entry($1::uuid, $2) AS reversal_id`,
    [row.ledger_entry_id, input.reason],
  );
  await tx.query(`UPDATE sandbox.fee_collection SET reversal_entry_id=$2 WHERE collection_id=$1`, [
    row.collection_id,
    reversed[0]!.reversal_id,
  ]);
  return accept({ reversalEntryId: reversed[0]!.reversal_id as string });
}
