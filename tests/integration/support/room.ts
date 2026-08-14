import { getPool } from '@/server/db/pool';
import { newCommandId } from '@/server/boundary/command';
import { grantRole, permissionsFor, type Principal, type Role } from '@/server/identity/rbac';
import { signInSandbox, type SessionUser } from '@/server/sandbox/service';
import { makeOperator } from './operator';
import { unique } from './rails';

/**
 * Fixtures for the deal-room tests.
 *
 * `operatorPrincipal` builds authority through the DEL-03 boundary — a
 * real grant and a real confirmed factor — rather than by constructing a
 * `Principal` literal with the fields set. A test that fakes its own
 * authorization proves only that the fake works.
 */

export { unique };

export async function operatorPrincipal(role: Role, label: string): Promise<Principal> {
  const op = await makeOperator(`${label}-${unique()}@example.com`);
  await grantRole({
    userId: op.user.userId,
    role,
    grantedBy: null,
    via: 'CLI',
    reason: `Deal-room test fixture: ${label}.`,
  });
  return {
    userId: op.user.userId,
    roles: [role],
    permissions: permissionsFor([role]),
    mfaSatisfied: true,
    mfaEnrolled: true,
  };
}

/** The same principal with its second factor NOT proved on this session. */
export function withoutMfa(principal: Principal): Principal {
  return { ...principal, mfaSatisfied: false };
}

/** A principal with no roles at all — an ordinary customer. */
export function bare(user: SessionUser): Principal {
  return {
    userId: user.userId,
    roles: [],
    permissions: [],
    mfaSatisfied: false,
    mfaEnrolled: false,
  };
}

export async function newUser(prefix: string): Promise<SessionUser> {
  return signInSandbox(`${prefix}-${unique()}@example.com`);
}

export function principalOf(user: SessionUser): Principal {
  return bare(user);
}

/** Raw case row, for asserting what the database actually holds. */
export async function caseRow(caseId: string) {
  const { rows } = await getPool().query(
    `SELECT state, version, disposition, resolved_by_proposal, resolution_note
       FROM sandbox.dispute_case WHERE case_id = $1`,
    [caseId],
  );
  return rows[0]!;
}

export async function proposalRow(proposalId: string) {
  const { rows } = await getPool().query(
    `SELECT state, proposed_by, approved_by, decision_note
       FROM sandbox.dispute_proposal WHERE proposal_id = $1`,
    [proposalId],
  );
  return rows[0]!;
}

export async function dealRow(dealId: string) {
  const { rows } = await getPool().query(
    `SELECT state, completed_at, version FROM sandbox.deal WHERE deal_id = $1`,
    [dealId],
  );
  return rows[0]!;
}

export async function lockRow(dealId: string) {
  const { rows } = await getPool().query(
    `SELECT state, settle_entry_id, owner_id FROM inrp2p.value_lock WHERE deal_id = $1`,
    [dealId],
  );
  return rows[0] ?? null;
}

export async function balanceOf(userId: string): Promise<string> {
  const { rows } = await getPool().query(
    `SELECT coalesce((SELECT balance_minor FROM inrp2p_read.account_balance
                       WHERE family='party.balance' AND scope_kind='user'
                         AND scope_id=$1 AND asset='USDT'), 0)::text AS b`,
    [userId],
  );
  return rows[0]!.b as string;
}

export async function incidentsFor(dealId: string) {
  const { rows } = await getPool().query(
    `SELECT kind, state, detail FROM sandbox.deal_incident WHERE deal_id = $1`,
    [dealId],
  );
  return rows;
}

/** A minimal valid PNG, so the sandbox scanner returns CLEAN. */
export function pngBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('IHDR-sandbox-evidence-fixture'),
  ]);
}

/** The EICAR test string — every scanner is required to flag this. */
export function eicarBytes(): Buffer {
  return Buffer.from(`X5O!P%@AP[4\\PZX54(P^)7CC)7}EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`);
}

/** Bytes whose content contradicts the declared media type. */
export function mismatchedBytes(): Buffer {
  return Buffer.from('this is plainly not a PNG');
}

export { newCommandId };
