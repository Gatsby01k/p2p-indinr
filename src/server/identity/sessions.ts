import 'server-only';
import { getPool, withTransaction, type Tx } from '@/server/db/pool';
import { writeAudit } from '@/server/boundary/command';
import { digestsEqual, hashToken, mintToken } from './tokens';

/**
 * Server-side sessions.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHAT REPLACED `userId.HMAC(userId)`.                              │
 * │                                                                    │
 * │  The DEL-02 cookie was a signature over a user id. It carried no   │
 * │  expiry, no version and no identity of its own, so:                │
 * │    · a captured value authenticated forever;                       │
 * │    · nothing could revoke it;                                      │
 * │    · signing out cleared a browser, not a credential;              │
 * │    · a privilege change could not invalidate anything.             │
 * │                                                                    │
 * │  A session is now a row with a hashed token, a database-clock      │
 * │  expiry, a revocation column and a version. `resolveSession` is    │
 * │  the single place any of that is evaluated, so no caller can       │
 * │  forget one of the four checks.                                    │
 * └────────────────────────────────────────────────────────────────────┘
 */

/** Eight hours of inactivity-independent life. Bounded, never sliding. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

/** Rotate a session this often, so a stolen cookie has a short useful life. */
export const SESSION_ROTATE_AFTER_SECONDS = 30 * 60;

export type SessionOrigin = 'EMAIL_OTP' | 'TELEGRAM' | 'ROTATION';

export interface IssuedSession {
  readonly sessionId: string;
  /** The secret that goes in the cookie. Never stored, never logged. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface ResolvedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly mfaSatisfied: boolean;
  readonly origin: string;
}

/**
 * Why a presented cookie was refused.
 *
 * A closed union rather than `null`, because the reasons are operationally
 * different: `REVOKED` on a live token is a signal worth alerting on
 * (somebody is using a credential that was taken away), while `EXPIRED` is
 * the ordinary end of a day's work.
 */
export type SessionRejection = 'ABSENT' | 'UNKNOWN' | 'EXPIRED' | 'REVOKED' | 'STALE_VERSION';

export type SessionLookup =
  | { readonly ok: true; readonly session: ResolvedSession }
  | { readonly ok: false; readonly reason: SessionRejection };

/* ------------------------------------------------------------------ *
 * Issue
 * ------------------------------------------------------------------ */

export async function issueSessionIn(
  tx: Tx,
  input: {
    readonly userId: string;
    readonly origin: SessionOrigin;
    readonly deviceLabel?: string | null;
    readonly rotatedFrom?: string | null;
    /** Carried across a rotation so a satisfied factor is not re-demanded. */
    readonly mfaSatisfiedAt?: Date | null;
  },
): Promise<IssuedSession> {
  const token = mintToken();

  const { rows } = await tx.query(
    `INSERT INTO sandbox.session
       (user_id, token_hash, expires_at, version, rotated_from, device_label, origin,
        mfa_satisfied_at)
     VALUES ($1, $2, now() + ($3 || ' seconds')::interval,
             (SELECT session_version FROM sandbox.app_user WHERE user_id = $1),
             $4, $5, $6, $7)
     RETURNING session_id, expires_at`,
    [
      input.userId,
      hashToken(token),
      String(SESSION_TTL_SECONDS),
      input.rotatedFrom ?? null,
      input.deviceLabel?.slice(0, 80) ?? null,
      input.origin,
      input.mfaSatisfiedAt ?? null,
    ],
  );
  const r = rows[0]!;
  return { sessionId: r.session_id, token, expiresAt: r.expires_at as Date };
}

/* ------------------------------------------------------------------ *
 * Resolve
 * ------------------------------------------------------------------ */

/**
 * Turn a presented cookie into a session, or say why not.
 *
 * Every condition is evaluated in ONE statement against the database
 * clock, so there is no window between "is it expired?" and "use it", and
 * no caller can check three of the four things and forget the fourth.
 *
 * The lookup is by `token_hash`, which is the primary secret index — a
 * caller who does not hold the token cannot name a session at all.
 */
export async function resolveSession(token: string | undefined): Promise<SessionLookup> {
  if (!token) return { ok: false, reason: 'ABSENT' };

  const presented = hashToken(token);
  const { rows } = await getPool().query(
    `SELECT s.session_id, s.user_id, s.token_hash, s.issued_at, s.expires_at,
            s.revoked_at, s.version, s.origin, s.mfa_satisfied_at,
            u.session_version,
            (s.expires_at <= now()) AS is_expired
       FROM sandbox.session s
       JOIN sandbox.app_user u ON u.user_id = s.user_id
      WHERE s.token_hash = $1`,
    [presented],
  );
  const s = rows[0];
  if (!s) return { ok: false, reason: 'UNKNOWN' };

  // Constant-time even though the lookup already matched: the column is
  // indexed on equality, and this keeps the comparison discipline in one
  // place rather than depending on how a future query is written.
  if (!digestsEqual(s.token_hash as string, presented)) return { ok: false, reason: 'UNKNOWN' };

  if (s.revoked_at !== null) return { ok: false, reason: 'REVOKED' };
  if (s.is_expired) return { ok: false, reason: 'EXPIRED' };
  // A role or 2FA change bumped the user; every older session dies with it.
  if (Number(s.version) < Number(s.session_version)) {
    return { ok: false, reason: 'STALE_VERSION' };
  }

  return {
    ok: true,
    session: {
      sessionId: s.session_id,
      userId: s.user_id,
      issuedAt: s.issued_at as Date,
      expiresAt: s.expires_at as Date,
      mfaSatisfied: s.mfa_satisfied_at !== null,
      origin: s.origin,
    },
  };
}

/** Note that a session was used. Best-effort; never gates a request. */
export async function touchSession(sessionId: string): Promise<void> {
  await getPool().query(`UPDATE sandbox.session SET last_seen_at = now() WHERE session_id = $1`, [
    sessionId,
  ]);
}

/* ------------------------------------------------------------------ *
 * Rotate
 * ------------------------------------------------------------------ */

/**
 * Replace a live session with a fresh one, preserving the lineage.
 *
 * The old row is revoked rather than deleted and points at its successor,
 * so an investigator can follow a chain of rotations back to the sign-in
 * that started it. A stolen cookie therefore has a bounded useful life
 * even if nobody notices the theft.
 */
export async function rotateSession(
  currentToken: string,
  deviceLabel?: string | null,
): Promise<IssuedSession | null> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT s.session_id, s.user_id, s.mfa_satisfied_at
         FROM sandbox.session s
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        FOR UPDATE`,
      [hashToken(currentToken)],
    );
    const current = rows[0];
    if (!current) return null;

    const next = await issueSessionIn(tx, {
      userId: current.user_id,
      origin: 'ROTATION',
      deviceLabel,
      rotatedFrom: current.session_id,
      mfaSatisfiedAt: current.mfa_satisfied_at,
    });

    await tx.query(
      `UPDATE sandbox.session
          SET revoked_at = now(), revoked_reason = 'ROTATED'
        WHERE session_id = $1`,
      [current.session_id],
    );
    await writeAudit(tx, {
      actorId: current.user_id,
      action: 'SESSION_ROTATE',
      subjectKind: 'user',
      subjectId: current.user_id,
      outcome: 'OK',
      detail: { from: current.session_id, to: next.sessionId },
    });
    return next;
  });
}

/* ------------------------------------------------------------------ *
 * Revoke
 * ------------------------------------------------------------------ */

export async function revokeSession(
  sessionId: string,
  actorId: string,
  reason: string,
): Promise<boolean> {
  return withTransaction(async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE sandbox.session
          SET revoked_at = now(), revoked_reason = $2
        WHERE session_id = $1 AND revoked_at IS NULL`,
      [sessionId, reason],
    );
    if (rowCount !== 1) return false;
    await writeAudit(tx, {
      actorId,
      action: 'SESSION_REVOKE',
      subjectKind: 'user',
      subjectId: actorId,
      outcome: 'OK',
      detail: { sessionId, reason },
    });
    return true;
  });
}

/**
 * Sign out everywhere.
 *
 * Two things happen, and both are necessary. Revoking the rows ends every
 * session that exists now; bumping `session_version` ends every session
 * that might be issued from a credential already in flight, and makes the
 * guarantee hold even if a row is missed. `exceptSessionId` keeps the
 * device the person is currently using, which is what "sign out my other
 * devices" means.
 */
export async function revokeAllSessions(
  userId: string,
  reason: string,
  exceptSessionId?: string | null,
): Promise<number> {
  return withTransaction(async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE sandbox.session
          SET revoked_at = now(), revoked_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL
          AND ($3::uuid IS NULL OR session_id <> $3::uuid)`,
      [userId, reason, exceptSessionId ?? null],
    );
    await tx.query(
      `UPDATE sandbox.app_user SET session_version = session_version + 1 WHERE user_id = $1`,
      [userId],
    );
    // The surviving session must move to the new version or it would be
    // refused as stale by the very bump that protects it.
    if (exceptSessionId) {
      await tx.query(
        `UPDATE sandbox.session s
            SET version = u.session_version
           FROM sandbox.app_user u
          WHERE s.session_id = $1 AND u.user_id = s.user_id`,
        [exceptSessionId],
      );
    }
    await writeAudit(tx, {
      actorId: userId,
      action: 'SESSION_REVOKE_ALL',
      subjectKind: 'user',
      subjectId: userId,
      outcome: 'OK',
      detail: { revoked: rowCount ?? 0, reason, kept: exceptSessionId ?? null },
    });
    return rowCount ?? 0;
  });
}

/**
 * Invalidate every session for a user because their authority changed.
 *
 * Called by the role and 2FA boundaries. It bumps the version rather than
 * touching rows, so it is O(1) and cannot miss a session created in the
 * same instant.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  `keepSessionId` — THE DEVICE THAT MADE THE CHANGE.                │
 * │                                                                    │
 * │  The guarantee this function exists for is that no OTHER device    │
 * │  inherits authority it did not establish. The device performing    │
 * │  the change is not one of those: it is authenticated, it is        │
 * │  present, and in the 2FA case it has just proved possession of the │
 * │  new factor in the same request.                                   │
 * │                                                                    │
 * │  Bumping it too is not extra safety, it is a dead end — enrolling  │
 * │  an authenticator signed you out on the very device you enrolled   │
 * │  from, and dropped you at a login screen holding a factor you had  │
 * │  no way to answer. Carrying the one named session to the new       │
 * │  version keeps exactly the "everywhere else" meaning that          │
 * │  `revokeAllSessions` already has, and it is written the same way.  │
 * │                                                                    │
 * │  Omitting the argument keeps the old, stricter behaviour, which is │
 * │  what a ROLE change wants: authority granted by somebody else is   │
 * │  not something the holder just demonstrated.                       │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function bumpSessionVersionIn(
  tx: Tx,
  userId: string,
  keepSessionId?: string | null,
): Promise<void> {
  await tx.query(
    `UPDATE sandbox.app_user SET session_version = session_version + 1 WHERE user_id = $1`,
    [userId],
  );
  if (!keepSessionId) return;
  // Ownership is re-checked here rather than trusted: a session id from
  // elsewhere must not be able to survive another user's bump.
  await tx.query(
    `UPDATE sandbox.session s
        SET version = u.session_version
       FROM sandbox.app_user u
      WHERE s.session_id = $1 AND u.user_id = $2 AND s.user_id = u.user_id`,
    [keepSessionId, userId],
  );
}

/* ------------------------------------------------------------------ *
 * Device / session listing
 * ------------------------------------------------------------------ */

export interface SessionSummary {
  readonly sessionId: string;
  readonly issuedAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly origin: string;
  readonly deviceLabel: string | null;
  readonly current: boolean;
  readonly mfaSatisfied: boolean;
}

export async function listSessions(
  userId: string,
  currentSessionId: string | null,
): Promise<readonly SessionSummary[]> {
  const { rows } = await getPool().query(
    `SELECT session_id, issued_at, last_seen_at, expires_at, origin, device_label,
            mfa_satisfied_at
       FROM sandbox.session
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_seen_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    sessionId: r.session_id,
    issuedAt: (r.issued_at as Date).toISOString(),
    lastSeenAt: (r.last_seen_at as Date).toISOString(),
    expiresAt: (r.expires_at as Date).toISOString(),
    origin: r.origin,
    deviceLabel: r.device_label ?? null,
    current: r.session_id === currentSessionId,
    mfaSatisfied: r.mfa_satisfied_at !== null,
  }));
}

/** Record that this session has cleared its second factor. */
export async function markMfaSatisfiedIn(tx: Tx, sessionId: string): Promise<void> {
  await tx.query(`UPDATE sandbox.session SET mfa_satisfied_at = now() WHERE session_id = $1`, [
    sessionId,
  ]);
}
