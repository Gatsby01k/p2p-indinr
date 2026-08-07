import 'server-only';
import { getPool, toBigInt, withTransaction } from '@/server/db/pool';
import {
  SandboxFailure,
  type NotificationView,
  type PaymentMethodView,
  type ReferralEntry,
  type RewardEntry,
  type SessionUser,
  type TrustProfile,
} from '@/lib/sandboxContract';

/**
 * Identity, trust, rewards and preferences.
 *
 * Everything here is DERIVED FROM WHAT ACTUALLY HAPPENED. There is no
 * hand-set reputation score, no editable deal count and no way for a person
 * to improve a number except by completing deals. A trust surface whose
 * figures can be typed in is worse than none, because it looks like evidence.
 */

/* ------------------------------------------------------------------ *
 * SafePoints → fee credit
 *
 * The single conversion, stated once: 10 SafePoints unlock ₹1.00 of fee
 * discount on THIS platform. Points are not money — they cannot be bought,
 * sold, transferred or withdrawn, and no code path exists to do so.
 * ------------------------------------------------------------------ */

const POINTS_PER_RUPEE = 10;

export function feeCreditMinorFor(points: number): bigint {
  if (points <= 0) return 0n;
  return BigInt(Math.floor(points / POINTS_PER_RUPEE)) * 100n;
}

/** Level thresholds, in completed deals. Factual, never purchased. */
const LEVEL_STEPS = [0, 3, 10, 25, 50] as const;

export function levelFor(completedDeals: number): number {
  let level = 1;
  for (let i = 0; i < LEVEL_STEPS.length; i += 1) {
    if (completedDeals >= LEVEL_STEPS[i]!) level = i + 1;
  }
  return level;
}

/** Deals still needed to reach the next level, or null at the top. */
export function dealsToNextLevel(completedDeals: number): number | null {
  const next = LEVEL_STEPS.find((step) => completedDeals < step);
  return next === undefined ? null : next - completedDeals;
}

/* ------------------------------------------------------------------ *
 * Profile
 * ------------------------------------------------------------------ */

async function ensureProfile(userId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO sandbox.user_profile (user_id, referral_code)
     VALUES ($1, substr(md5(random()::text), 1, 10))
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
}

export async function getTrustProfile(user: SessionUser): Promise<TrustProfile> {
  await ensureProfile(user.userId);

  const { rows } = await getPool().query(
    `SELECT
       u.display_name, u.email, u.telegram_username, u.created_at,
       p.identity_verified, p.upi_verified, p.wallet_verified,
       p.two_factor_enabled, p.notify_email, p.notify_push,
       p.about, p.city, p.referral_code,

       -- Every figure below is a count of real rows. None is settable.
       (SELECT count(*) FROM sandbox.deal d
          JOIN sandbox.participant pp ON pp.deal_id = d.deal_id AND pp.user_id = u.user_id
         WHERE d.state = 'COMPLETED')                                    AS completed,
       (SELECT count(*) FROM sandbox.deal d
          JOIN sandbox.participant pp ON pp.deal_id = d.deal_id AND pp.user_id = u.user_id
         WHERE d.state IN ('COMPLETED','CANCELLED','EXPIRED','REFUNDED')) AS finished,
       (SELECT coalesce(sum(d.inr_minor), 0) FROM sandbox.deal d
          JOIN sandbox.participant pp ON pp.deal_id = d.deal_id AND pp.user_id = u.user_id
         WHERE d.state = 'COMPLETED')                                    AS volume,
       (SELECT count(*) FROM sandbox.dispute di
          JOIN sandbox.participant pp ON pp.deal_id = di.deal_id AND pp.user_id = u.user_id
         WHERE di.state <> 'RESOLVED')                                   AS open_disputes,
       (SELECT count(*) FROM sandbox.dispute di
          JOIN sandbox.participant pp ON pp.deal_id = di.deal_id AND pp.user_id = u.user_id
         WHERE di.state = 'RESOLVED')                                    AS resolved_disputes,
       (SELECT coalesce(sum(points), 0) FROM sandbox.reward_event r
         WHERE r.user_id = u.user_id)                                    AS points
     FROM sandbox.app_user u
     JOIN sandbox.user_profile p ON p.user_id = u.user_id
    WHERE u.user_id = $1`,
    [user.userId],
  );
  const r = rows[0];
  if (!r) throw new SandboxFailure('NOT_FOUND', 'That profile does not exist.');

  const completed = Number(r.completed);
  const finished = Number(r.finished);
  const points = Number(r.points);

  return {
    userId: user.userId,
    displayName: r.display_name,
    email: r.email ?? null,
    telegramUsername: r.telegram_username ?? null,
    memberSince: (r.created_at as Date).toISOString(),
    completedDeals: completed,
    // Null rather than a flattering 100% when nothing has finished yet: a
    // rate with no denominator is not evidence of anything.
    completionRate: finished === 0 ? null : Math.round((completed / finished) * 100),
    openDisputes: Number(r.open_disputes),
    resolvedDisputes: Number(r.resolved_disputes),
    identityVerified: r.identity_verified,
    upiVerified: r.upi_verified,
    walletVerified: r.wallet_verified,
    twoFactorEnabled: r.two_factor_enabled,
    notifyEmail: r.notify_email,
    notifyPush: r.notify_push,
    about: r.about ?? null,
    city: r.city ?? null,
    referralCode: r.referral_code,
    safePoints: points,
    feeCreditMinor: feeCreditMinorFor(points).toString(),
    level: levelFor(completed),
    volumeInrMinor: toBigInt(r.volume).toString(),
  };
}

/**
 * Typical response time, in whole minutes, or null when there is nothing to
 * measure.
 *
 * Measured from the moment it became this person's move to the moment they
 * moved — the fiat side from the deal opening to their payment claim, the
 * crypto side from that claim to their confirmation. The median is used, not
 * the mean, so one abandoned deal cannot make a fast trader look slow.
 */
export async function typicalResponseMinutes(userId: string): Promise<number | null> {
  const { rows } = await getPool().query(
    `WITH spans AS (
       SELECT EXTRACT(EPOCH FROM (c.submitted_at - d.created_at)) / 60 AS minutes
         FROM sandbox.payment_claim c
         JOIN sandbox.deal d ON d.deal_id = c.deal_id
        WHERE c.claimed_by = $1
       UNION ALL
       SELECT EXTRACT(EPOCH FROM (s.confirmed_at - c.submitted_at)) / 60
         FROM sandbox.settlement_confirmation s
         JOIN sandbox.payment_claim c ON c.deal_id = s.deal_id
        WHERE s.confirmed_by = $1
     )
     SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes) AS median FROM spans`,
    [userId],
  );
  const median = rows[0]?.median;
  if (median === null || median === undefined) return null;
  return Math.max(0, Math.round(Number(median)));
}

export interface ProfileEdit {
  readonly about?: string | null;
  readonly city?: string | null;
  readonly notifyEmail?: boolean;
  readonly notifyPush?: boolean;
  readonly twoFactorEnabled?: boolean;
}

export async function updateProfile(user: SessionUser, edit: ProfileEdit): Promise<void> {
  await ensureProfile(user.userId);
  await getPool().query(
    `UPDATE sandbox.user_profile
        SET about = coalesce($2, about),
            city = coalesce($3, city),
            notify_email = coalesce($4, notify_email),
            notify_push = coalesce($5, notify_push),
            two_factor_enabled = coalesce($6, two_factor_enabled),
            updated_at = now()
      WHERE user_id = $1`,
    [
      user.userId,
      edit.about === undefined ? null : (edit.about?.slice(0, 400) ?? ''),
      edit.city === undefined ? null : (edit.city?.slice(0, 80) ?? ''),
      edit.notifyEmail ?? null,
      edit.notifyPush ?? null,
      edit.twoFactorEnabled ?? null,
    ],
  );
}

/**
 * Complete a verification step.
 *
 * ⚠ THIS VERIFIES NOTHING IN THE REAL WORLD. No document is read, no bank
 * is contacted and no identity is checked. It records that a person walked
 * through the step so the journey is complete end to end, and the UI says so
 * plainly wherever the badge appears.
 */
export async function markVerified(
  user: SessionUser,
  step: 'identity' | 'upi' | 'wallet',
): Promise<void> {
  await ensureProfile(user.userId);
  const column = { identity: 'identity_verified', upi: 'upi_verified', wallet: 'wallet_verified' }[
    step
  ];
  await getPool().query(
    `UPDATE sandbox.user_profile SET ${column} = TRUE, updated_at = now() WHERE user_id = $1`,
    [user.userId],
  );
  await getPool().query(
    `INSERT INTO sandbox.reward_event (user_id, deal_id, kind, points, note)
     VALUES ($1, NULL, 'VERIFICATION', 100, $2)
     ON CONFLICT DO NOTHING`,
    [user.userId, `${step} verified`],
  );
}

/* ------------------------------------------------------------------ *
 * Payment methods
 * ------------------------------------------------------------------ */

const UPI_PATTERN = /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z]{2,32}$/;
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export async function listPaymentMethods(user: SessionUser): Promise<readonly PaymentMethodView[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM sandbox.payment_method
      WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC`,
    [user.userId],
  );
  return rows.map((r) => ({
    methodId: r.method_id,
    kind: r.kind,
    label: r.label,
    handle: r.handle,
    bankName: r.bank_name ?? null,
    ifsc: r.ifsc ?? null,
    isDefault: r.is_default,
    verified: r.verified,
    createdAt: (r.created_at as Date).toISOString(),
  }));
}

export interface NewPaymentMethod {
  readonly kind: 'UPI' | 'BANK' | 'WALLET';
  readonly label: string;
  readonly handle: string;
  readonly bankName?: string | null;
  readonly ifsc?: string | null;
  readonly makeDefault?: boolean;
}

/**
 * Add a way to be paid.
 *
 * ⚠ NO CREDENTIAL IS ACCEPTED. Anything that looks like a PIN, password,
 * CVV or full card number is refused outright rather than stored — this
 * table addresses a transfer, it does not authorise one.
 */
export async function addPaymentMethod(user: SessionUser, method: NewPaymentMethod): Promise<void> {
  const handle = method.handle.trim();
  const label = method.label.trim().slice(0, 60) || 'Payment method';

  if (method.kind === 'UPI' && !UPI_PATTERN.test(handle)) {
    throw new SandboxFailure(
      'NOT_FOUND',
      'That is not a valid UPI ID — it should look like name@bank.',
    );
  }
  if (method.kind === 'BANK') {
    if (!/^\d{6,18}$/.test(handle.replace(/\s/g, ''))) {
      throw new SandboxFailure('NOT_FOUND', 'An account number is 6 to 18 digits.');
    }
    if (!method.ifsc || !IFSC_PATTERN.test(method.ifsc.trim().toUpperCase())) {
      throw new SandboxFailure('NOT_FOUND', 'That IFSC is not valid — for example HDFC0001234.');
    }
  }
  if (method.kind === 'WALLET' && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(handle)) {
    throw new SandboxFailure('NOT_FOUND', 'That is not a valid TRC-20 address.');
  }

  // Only the last four digits of a bank account are ever stored.
  const stored = method.kind === 'BANK' ? `••••${handle.replace(/\s/g, '').slice(-4)}` : handle;

  await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT count(*)::int AS n FROM sandbox.payment_method WHERE user_id = $1`,
      [user.userId],
    );
    // The first method a person adds is their default, because a payment
    // screen with no default is a dead end.
    const makeDefault = method.makeDefault === true || Number(rows[0]!.n) === 0;
    if (makeDefault) {
      await tx.query(
        `UPDATE sandbox.payment_method SET is_default = FALSE WHERE user_id = $1 AND is_default`,
        [user.userId],
      );
    }
    await tx.query(
      `INSERT INTO sandbox.payment_method
         (user_id, kind, label, handle, bank_name, ifsc, is_default, verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE)`,
      [
        user.userId,
        method.kind,
        label,
        stored,
        method.bankName?.trim()?.slice(0, 80) || null,
        method.ifsc?.trim()?.toUpperCase() || null,
        makeDefault,
      ],
    );
  });
}

export async function setDefaultPaymentMethod(user: SessionUser, methodId: string): Promise<void> {
  await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT 1 FROM sandbox.payment_method WHERE method_id = $1 AND user_id = $2`,
      [methodId, user.userId],
    );
    if (!rows[0]) throw new SandboxFailure('NOT_FOUND', 'That payment method does not exist.');
    await tx.query(
      `UPDATE sandbox.payment_method SET is_default = FALSE WHERE user_id = $1 AND is_default`,
      [user.userId],
    );
    await tx.query(`UPDATE sandbox.payment_method SET is_default = TRUE WHERE method_id = $1`, [
      methodId,
    ]);
  });
}

export async function removePaymentMethod(user: SessionUser, methodId: string): Promise<void> {
  // Ownership is in the WHERE clause, so a crafted id deletes nothing.
  await getPool().query(
    `DELETE FROM sandbox.payment_method WHERE method_id = $1 AND user_id = $2`,
    [methodId, user.userId],
  );
}

/* ------------------------------------------------------------------ *
 * Notifications
 * ------------------------------------------------------------------ */

export async function listNotifications(
  user: SessionUser,
  limit = 40,
): Promise<readonly NotificationView[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM sandbox.notification
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [user.userId, limit],
  );
  return rows.map((r) => ({
    notificationId: r.notification_id,
    severity: r.severity,
    title: r.title,
    body: r.body,
    dealId: r.deal_id ?? null,
    read: r.read_at !== null,
    createdAt: (r.created_at as Date).toISOString(),
  }));
}

export async function countUnread(user: SessionUser): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM sandbox.notification
      WHERE user_id = $1 AND read_at IS NULL`,
    [user.userId],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function markAllRead(user: SessionUser): Promise<void> {
  await getPool().query(
    `UPDATE sandbox.notification SET read_at = now()
      WHERE user_id = $1 AND read_at IS NULL`,
    [user.userId],
  );
}

/* ------------------------------------------------------------------ *
 * Rewards and referrals
 * ------------------------------------------------------------------ */

export async function listRewards(user: SessionUser, limit = 40): Promise<readonly RewardEntry[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM sandbox.reward_event
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [user.userId, limit],
  );
  return rows.map((r) => ({
    rewardId: r.reward_id,
    kind: r.kind,
    points: r.points,
    note: r.note ?? null,
    createdAt: (r.created_at as Date).toISOString(),
  }));
}

export async function listReferrals(user: SessionUser): Promise<readonly ReferralEntry[]> {
  const { rows } = await getPool().query(
    `SELECT r.referral_id, r.created_at, r.qualified_at, u.display_name
       FROM sandbox.referral r
       JOIN sandbox.app_user u ON u.user_id = r.invitee_id
      WHERE r.referrer_id = $1
      ORDER BY r.created_at DESC`,
    [user.userId],
  );
  return rows.map((r) => ({
    referralId: r.referral_id,
    inviteeName: r.display_name,
    joinedAt: (r.created_at as Date).toISOString(),
    qualifiedAt: r.qualified_at ? (r.qualified_at as Date).toISOString() : null,
    // Only a qualified referral has earned anything, and the figure says so.
    points: r.qualified_at ? 500 : 0,
  }));
}

/**
 * Record who invited whom.
 *
 * Called once, when a new account arrives carrying a referral code. It never
 * overwrites an existing referrer (`UNIQUE(invitee_id)`), so a code cannot be
 * used to claim someone else's invitee later.
 */
export async function attachReferrer(inviteeId: string, code: string): Promise<void> {
  const normalized = code.trim().toLowerCase();
  if (!/^[a-z0-9]{6,16}$/.test(normalized)) return;
  await getPool().query(
    `INSERT INTO sandbox.referral (referrer_id, invitee_id)
     SELECT p.user_id, $1 FROM sandbox.user_profile p
      WHERE p.referral_code = $2 AND p.user_id <> $1
     ON CONFLICT (invitee_id) DO NOTHING`,
    [inviteeId, normalized],
  );
}
