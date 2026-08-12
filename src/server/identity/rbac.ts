import 'server-only';
import { getPool, withTransaction, type Tx } from '@/server/db/pool';
import { writeAudit } from '@/server/boundary/command';
import { bumpSessionVersionIn } from './sessions';

/**
 * Role-based access control.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  AUTHORITY IS GRANTED OUT OF BAND. THERE IS NO WEB ROUTE.          │
 * │                                                                    │
 * │  TS-00 `AUD-P0-001`: operator status came from an `ops@` email     │
 * │  prefix, so anyone who could reach the sign-in page could become   │
 * │  an operator by typing an address.                                 │
 * │                                                                    │
 * │  Now authority is a row in `role_grant`, and `granted_via` has a   │
 * │  closed catalogue of `CLI` and `MIGRATION` — no `WEB` member       │
 * │  exists. A self-grant is refused by a CHECK constraint. So the     │
 * │  guarantee is not "no route calls this function"; it is "a row     │
 * │  representing a web-issued grant cannot be stored at all".         │
 * │                                                                    │
 * │  `grantRole` is exported for `scripts/grant-role.mjs`, which runs  │
 * │  on an operator's own machine against the database — never through │
 * │  the application.                                                  │
 * └────────────────────────────────────────────────────────────────────┘
 */

export { mfaEnrolled } from './auth';

export type Role = 'OPERATOR' | 'REVIEWER' | 'ADMIN';

/**
 * What a role lets someone do.
 *
 * Permissions are named separately from roles so a check reads as the
 * thing being protected — `deal.rule` — rather than as a job title. A
 * later stage can split a role without hunting for every `isOperator`.
 */
export type Permission =
  | 'ops.queue.read'
  | 'ops.case.read'
  | 'deal.rule'
  | 'verification.review'
  | 'role.grant';

const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  OPERATOR: ['ops.queue.read', 'ops.case.read', 'deal.rule'],
  // Reviewers decide verification cases and see nothing financial.
  REVIEWER: ['verification.review'],
  // Admin grants roles — and only ever through the out-of-band tool.
  ADMIN: ['role.grant'],
};

export interface Principal {
  readonly userId: string;
  readonly roles: readonly Role[];
  readonly permissions: readonly Permission[];
  /** True when this SESSION has cleared a second factor. */
  readonly mfaSatisfied: boolean;
  /** True when the account has a confirmed second factor enrolled. */
  readonly mfaEnrolled: boolean;
}

/**
 * Permissions that may not be exercised without a second factor.
 *
 * Everything an operator can do is on this list, because every one of
 * them reads other people's private dealings or terminates a deal.
 */
const MFA_REQUIRED: ReadonlySet<Permission> = new Set<Permission>([
  'ops.queue.read',
  'ops.case.read',
  'deal.rule',
  'verification.review',
  'role.grant',
]);

export function permissionsFor(roles: readonly Role[]): readonly Permission[] {
  const out = new Set<Permission>();
  for (const role of roles) for (const p of ROLE_PERMISSIONS[role]) out.add(p);
  return [...out];
}

/** Read live roles from the grant table — never from a cached boolean. */
export async function rolesFor(userId: string): Promise<readonly Role[]> {
  const { rows } = await getPool().query(
    `SELECT role FROM sandbox.role_grant WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return rows.map((r) => r.role as Role);
}

/**
 * Whether a principal may do a thing, here and now.
 *
 * Two conditions, and the second is the one that is easy to forget: the
 * permission must be granted AND, for anything sensitive, the second
 * factor must have been cleared in this session. An operator who signed
 * in but has not answered their authenticator holds a session that can
 * read their own deals and nothing else.
 */
export function can(principal: Principal, permission: Permission): boolean {
  if (!principal.permissions.includes(permission)) return false;
  if (MFA_REQUIRED.has(permission)) {
    /*
     * BOTH conditions, and they are genuinely different facts.
     *
     * `mfaEnrolled` is a property of the ACCOUNT: a confirmed factor
     * exists. `mfaSatisfied` is a property of the SESSION: it has been
     * answered on this device. Checking only the second used to be
     * enough — until the recovery path could set it without a confirmed
     * factor behind it. Requiring both means a bypass has to defeat two
     * independent records to grant anything, and the sensitive
     * permissions are exactly the ones worth that belt and braces.
     */
    if (!principal.mfaEnrolled) return false;
    if (!principal.mfaSatisfied) return false;
  }
  return true;
}

/** Why a permission check failed, for an honest screen and an audit row. */
export type DenialReason = 'NO_PERMISSION' | 'MFA_NOT_ENROLLED' | 'MFA_REQUIRED';

export function denialFor(principal: Principal, permission: Permission): DenialReason | null {
  if (!principal.permissions.includes(permission)) return 'NO_PERMISSION';
  if (MFA_REQUIRED.has(permission)) {
    if (!principal.mfaEnrolled) return 'MFA_NOT_ENROLLED';
    if (!principal.mfaSatisfied) return 'MFA_REQUIRED';
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Granting — out of band only
 * ------------------------------------------------------------------ */

export type GrantVia = 'CLI' | 'MIGRATION';

export interface GrantResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Grant a role.
 *
 * Reachable from `scripts/grant-role.mjs` and from nothing that serves a
 * request. Three protections, in order:
 *
 *   1. `granted_via` is `CLI` or `MIGRATION`; the CHECK rejects anything
 *      else, so a web-issued grant cannot be represented;
 *   2. `role_grant_not_self` refuses a self-grant even from the tool;
 *   3. the session version is bumped, so the new authority requires a
 *      fresh sign-in rather than silently upgrading a live session — and
 *      a REVOKED role likewise takes effect immediately.
 */
export async function grantRole(input: {
  readonly userId: string;
  readonly role: Role;
  readonly grantedBy: string | null;
  readonly via: GrantVia;
  readonly reason: string;
}): Promise<GrantResult> {
  if (input.grantedBy !== null && input.grantedBy === input.userId) {
    return { ok: false, reason: 'A role may not be granted to oneself.' };
  }
  if (input.reason.trim().length < 8) {
    return { ok: false, reason: 'A grant must carry a written reason.' };
  }

  return withTransaction(async (tx) => {
    const existing = await tx.query(
      `SELECT 1 FROM sandbox.role_grant
        WHERE user_id = $1 AND role = $2 AND revoked_at IS NULL`,
      [input.userId, input.role],
    );
    if (existing.rowCount) return { ok: true };

    await tx.query(
      `INSERT INTO sandbox.role_grant (user_id, role, granted_by, granted_via, reason)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.userId, input.role, input.grantedBy, input.via, input.reason.trim()],
    );
    await syncOperatorCacheIn(tx, input.userId);
    await bumpSessionVersionIn(tx, input.userId);
    await writeAudit(tx, {
      actorId: input.grantedBy,
      action: 'ROLE_GRANT',
      subjectKind: 'user',
      subjectId: input.userId,
      toState: input.role,
      outcome: 'OK',
      detail: { role: input.role, via: input.via, reason: input.reason.trim() },
    });
    return { ok: true };
  });
}

export async function revokeRole(input: {
  readonly userId: string;
  readonly role: Role;
  readonly revokedBy: string | null;
}): Promise<GrantResult> {
  return withTransaction(async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE sandbox.role_grant
          SET revoked_at = now(), revoked_by = $3
        WHERE user_id = $1 AND role = $2 AND revoked_at IS NULL`,
      [input.userId, input.role, input.revokedBy],
    );
    if (rowCount !== 1) return { ok: false, reason: 'No live grant to revoke.' };

    await syncOperatorCacheIn(tx, input.userId);
    // Authority removed takes effect NOW, not when a session happens to
    // expire — which is the whole reason sessions carry a version.
    await bumpSessionVersionIn(tx, input.userId);
    await writeAudit(tx, {
      actorId: input.revokedBy,
      action: 'ROLE_REVOKE',
      subjectKind: 'user',
      subjectId: input.userId,
      fromState: input.role,
      outcome: 'OK',
      detail: { role: input.role },
    });
    return { ok: true };
  });
}

/**
 * Keep `app_user.is_operator` in step with the grant table.
 *
 * The column survives as a CACHE so existing read paths and screens keep
 * working unchanged. It is derived here and nowhere else, so it can no
 * longer disagree with the authority it represents.
 */
async function syncOperatorCacheIn(tx: Tx, userId: string): Promise<void> {
  await tx.query(
    `UPDATE sandbox.app_user u
        SET is_operator = EXISTS (
          SELECT 1 FROM sandbox.role_grant g
           WHERE g.user_id = u.user_id AND g.role = 'OPERATOR' AND g.revoked_at IS NULL)
      WHERE u.user_id = $1`,
    [userId],
  );
}
