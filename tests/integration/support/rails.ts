import { createHash } from 'node:crypto';
import { getPool, withTransaction } from '@/server/db/pool';
import { newCommandId } from '@/server/boundary/command';
import { permissionsFor, grantRole, type Principal } from '@/server/identity/rbac';
import { signDelivery, type SignedDelivery } from '@/server/rails/webhook';
import type { ProviderEvent } from '@/server/rails/observations';
import {
  createDealCommand,
  fundSandboxCommand,
  joinCommand,
  lockValueCommand,
} from '@/services/commands';
import { signInSandbox, type SessionUser } from '@/server/sandbox/service';
import { makeOperator } from './operator';

/**
 * Fixtures for the payment-rail tests.
 *
 * The signing helper deliberately uses the PRODUCTION verifier's own
 * `signDelivery`, so a passing signature test proves the verifier accepts
 * genuine provider signatures — not that two test-local implementations
 * of HMAC happen to agree with each other.
 */

export const unique = () => Math.random().toString(36).slice(2, 10);

/** A signed delivery, built the way a real provider would build one. */
export function sign(
  providerKey: string,
  body: unknown,
  options: { at?: Date; tamperBody?: boolean; signature?: string } = {},
): SignedDelivery {
  const rawBody = JSON.stringify(body);
  const at = options.at ?? new Date();
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const signature = options.signature ?? signDelivery(providerKey, timestamp, rawBody);
  return {
    providerKey,
    // Tampering AFTER signing is the attack: a body edited in flight must
    // no longer verify against the signature that covered the original.
    rawBody: options.tamperBody === true ? `${rawBody} ` : rawBody,
    signatureHeader: signature,
    timestampHeader: timestamp,
  };
}

/** A distinct 64-hex transaction hash per call. */
export function txHash(seed: string = unique()): string {
  return createHash('sha256').update(`tx:${seed}:${Math.random()}`).digest('hex');
}

/** A distinct, well-formed UTR per call. */
export function utr(seed: string = unique()): string {
  return createHash('sha256')
    .update(`utr:${seed}:${Math.random()}`)
    .digest('hex')
    .replace(/[^0-9a-f]/g, '')
    .slice(0, 12)
    .toUpperCase();
}

export interface RailFixture {
  readonly alice: SessionUser;
  readonly bob: SessionUser;
  readonly dealId: string;
}

let ledgerAdmin: Principal | null = null;

/** An ADMIN with a satisfied factor, for the sandbox funding fixture. */
export async function ledgerAdminPrincipal(): Promise<Principal> {
  if (ledgerAdmin !== null) return ledgerAdmin;
  const op = await makeOperator(`rail-admin-${unique()}@example.com`);
  await grantRole({
    userId: op.user.userId,
    role: 'ADMIN',
    grantedBy: null,
    via: 'CLI',
    reason: 'Ledger administrator for the payment-rail fixtures.',
  });
  ledgerAdmin = {
    userId: op.user.userId,
    roles: ['ADMIN'],
    permissions: permissionsFor(['ADMIN']),
    mfaSatisfied: true,
    mfaEnrolled: true,
  };
  return ledgerAdmin;
}

/** A live two-seat deal. */
export async function liveDeal(alice: SessionUser, bob: SessionUser): Promise<string> {
  const created = await createDealCommand(alice, {
    commandId: newCommandId(),
    scenario: 'INR_TO_INR',
    inrAmount: '2500',
    intent: 'PAY',
  });
  if (!created.ok) throw new Error(`deal fixture: ${created.code}`);
  const joined = await joinCommand(bob, newCommandId(), created.value.publicId);
  if (!joined.ok) throw new Error(`join fixture: ${joined.code}`);
  return joined.value.dealId;
}

/** A deal whose value is locked, so instructions may be issued. */
export async function lockedDeal(
  alice: SessionUser,
  bob: SessionUser,
  amountMinor = 100_000n,
): Promise<string> {
  const dealId = await liveDeal(alice, bob);
  const admin = await ledgerAdminPrincipal();
  const funded = await fundSandboxCommand(admin, newCommandId(), {
    userId: alice.userId,
    asset: 'USDT',
    amountMinor,
  });
  if (!funded.ok) throw new Error(`funding fixture: ${funded.code}`);
  const locked = await lockValueCommand(alice, newCommandId(), {
    dealId,
    asset: 'USDT',
    amountMinor,
  });
  if (!locked.ok) throw new Error(`lock fixture: ${locked.code}`);
  return dealId;
}

export async function newUser(prefix: string): Promise<SessionUser> {
  return signInSandbox(`${prefix}-${unique()}@example.com`);
}

/** The state of one intent, read straight from the table. */
export async function intentState(intentId: string): Promise<{
  state: string;
  ledgerEntryId: string | null;
  reversalEntryId: string | null;
}> {
  const { rows } = await getPool().query(
    `SELECT state, ledger_entry_id, reversal_entry_id
       FROM sandbox.payment_intent WHERE intent_id = $1`,
    [intentId],
  );
  return {
    state: rows[0]!.state as string,
    ledgerEntryId: (rows[0]!.ledger_entry_id as string | null) ?? null,
    reversalEntryId: (rows[0]!.reversal_entry_id as string | null) ?? null,
  };
}

/** Every observation recorded against one intent, oldest first. */
export async function observationsFor(
  intentId: string,
): Promise<readonly { source: string; kind: string; matchOutcome: string; accepted: boolean }[]> {
  const { rows } = await getPool().query(
    `SELECT source, kind, match_outcome, accepted FROM sandbox.payment_observation
      WHERE intent_id = $1 ORDER BY recorded_at, observation_id`,
    [intentId],
  );
  return rows.map((r) => ({
    source: r.source as string,
    kind: r.kind as string,
    matchOutcome: r.match_outcome as string,
    accepted: r.accepted as boolean,
  }));
}

/** The deal escrow balance, in minor units. */
export async function escrowBalance(dealId: string): Promise<string> {
  const { rows } = await getPool().query(
    `SELECT coalesce((SELECT balance_minor FROM inrp2p_read.account_balance
                       WHERE family='escrow' AND scope_id=$1 AND asset='USDT'), 0)::text AS b`,
    [dealId],
  );
  return rows[0]!.b as string;
}

/** A confirmed-shaped USDT watcher event for an allocated address. */
export function usdtEvent(input: {
  providerEventId?: string;
  address: string;
  amountMinor: string;
  hash?: string;
  status?: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REORGED';
  confirmations?: number;
  network?: 'TRC20' | 'UPI';
}): ProviderEvent {
  return {
    providerKey: 'sandbox-usdt',
    providerEventId: input.providerEventId ?? `evt-${unique()}`,
    rail: 'USDT',
    network: (input.network ?? 'TRC20') as ProviderEvent['network'],
    status: input.status ?? 'CONFIRMED',
    reference: input.hash ?? txHash(),
    destination: input.address,
    amountMinor: input.amountMinor,
    asset: 'USDT',
    confirmations: input.confirmations ?? 25,
  };
}

/** A confirmed-shaped INR provider event for an issued reference. */
export function inrEvent(input: {
  providerEventId?: string;
  reference: string;
  amountMinor: string;
  utr?: string;
  status?: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REORGED';
  beneficiaryAccount?: string;
  network?: 'UPI' | 'IMPS' | 'NEFT';
}): ProviderEvent {
  return {
    providerKey: 'sandbox-inr',
    providerEventId: input.providerEventId ?? `evt-${unique()}`,
    rail: 'INR',
    network: input.network ?? 'UPI',
    status: input.status ?? 'CONFIRMED',
    reference: input.utr ?? utr(),
    destination: input.reference,
    amountMinor: input.amountMinor,
    asset: 'INR',
    beneficiaryAccount: input.beneficiaryAccount,
  };
}

/** Force an intent's expiry deadline into the past. */
export async function expireNow(intentId: string): Promise<void> {
  await withTransaction((tx) =>
    tx.query(
      `UPDATE sandbox.payment_intent SET expires_at = now() - interval '1 second'
        WHERE intent_id = $1`,
      [intentId],
    ),
  );
}
