import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getPool, toBigInt, type Tx } from '@/server/db/pool';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { AdapterUnavailableError, deploymentMode } from '@/server/adapters/mode';
import { denialFor, type Principal } from '@/server/identity/rbac';
import type { Entitlements } from '@/lib/feeMath';

/**
 * Premium, referrals and rewards — the three sources of a discount.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A CLIENT CANNOT NAME ITS OWN BENEFIT. NOT ANY OF THEM.            │
 * │                                                                    │
 * │  `entitlementsFor` takes a user id and a moment, and returns what  │
 * │  the SERVER finds. It accepts no discount figure, no premium flag  │
 * │  and no referral claim from the request; a forged field has        │
 * │  nowhere to arrive, because the function has no parameter for it.  │
 * │                                                                    │
 * │  The only thing a caller may nominate is WHICH reward to spend,    │
 * │  and even that is validated against ownership, state and expiry    │
 * │  before it is worth anything.                                      │
 * └────────────────────────────────────────────────────────────────────┘
 */

/* ------------------------------------------------------------------ *
 * The subscription boundary
 * ------------------------------------------------------------------ */

/**
 * Premium is sold by somebody. Not by this repository.
 *
 * There is no billing provider, no credentials and no production
 * subscription path, so production refuses rather than pretending
 * somebody paid. The sandbox grant is a separate, explicitly labelled
 * source that cannot exist in production.
 */
export function assertPremiumProvider(): void {
  if (deploymentMode() === 'PRODUCTION') {
    throw new AdapterUnavailableError(
      'premium-subscription',
      'DEL-09 (Operations, Secrets and Dispatch)',
      'No subscription or billing provider is integrated in this repository. ' +
        'Refusing to grant a paid entitlement nobody paid for.',
    );
  }
}

export function premiumAvailable(): boolean {
  return deploymentMode() !== 'PRODUCTION';
}

/* ------------------------------------------------------------------ *
 * Premium
 * ------------------------------------------------------------------ */

export interface PremiumGrant {
  readonly grantId: string;
  readonly userId: string;
  readonly source: 'SUBSCRIPTION' | 'REWARD_CAMPAIGN' | 'SANDBOX_MANUAL';
  readonly discountBps: string;
  readonly expiresAt: string;
  readonly state: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
}

/**
 * The live premium grant, if any.
 *
 * Expiry is evaluated against the DATABASE clock in the query rather
 * than compared in TypeScript afterwards: an expired grant must be
 * invisible, not filtered — and a skewed application server must not be
 * able to extend somebody's benefit.
 */
export async function livePremium(tx: Tx, userId: string): Promise<PremiumGrant | null> {
  const { rows } = await tx.query(
    `SELECT grant_id, user_id, source, discount_bps::text AS discount_bps,
            expires_at, state
       FROM sandbox.premium_grant
      WHERE user_id = $1 AND state = 'ACTIVE'
        AND starts_at <= now() AND expires_at > now()
      ORDER BY discount_bps DESC
      LIMIT 1`,
    [userId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return {
    grantId: r.grant_id as string,
    userId: r.user_id as string,
    source: r.source as PremiumGrant['source'],
    discountBps: r.discount_bps as string,
    expiresAt: (r.expires_at as Date).toISOString(),
    state: r.state as PremiumGrant['state'],
  };
}

export async function grantPremium(
  tx: Tx,
  principal: Principal,
  input: {
    readonly userId: string;
    readonly source: 'SUBSCRIPTION' | 'REWARD_CAMPAIGN' | 'SANDBOX_MANUAL';
    readonly discountBps: bigint;
    readonly days: number;
    readonly sourceRef?: string | null;
  },
): Promise<Outcome<PremiumGrant>> {
  if (denialFor(principal, 'premium.grant') !== null) {
    return reject('PERMISSION_DENIED', FAILURE_COPY.PERMISSION_DENIED.reason);
  }
  /*
   * A manual grant is a demonstration convenience and must be
   * unreachable in production — otherwise the fastest route to free
   * premium for a real customer is an operator with a keyboard.
   */
  if (input.source === 'SANDBOX_MANUAL' && deploymentMode() === 'PRODUCTION') {
    return reject('PREMIUM_UNAVAILABLE', FAILURE_COPY.PREMIUM_UNAVAILABLE.reason);
  }
  if (input.source === 'SUBSCRIPTION') {
    // There is no provider, so nobody has paid. Refuse rather than
    // manufacture a paid entitlement.
    return reject('PREMIUM_UNAVAILABLE', FAILURE_COPY.PREMIUM_UNAVAILABLE.reason);
  }
  if (input.discountBps <= 0n || input.discountBps > 10_000n || input.days <= 0) {
    return reject('FEE_POLICY_INVALID', FAILURE_COPY.FEE_POLICY_INVALID.reason);
  }

  const { rows } = await tx.query(
    `INSERT INTO sandbox.premium_grant
       (user_id, source, source_ref, discount_bps, expires_at, granted_by)
     VALUES ($1,$2,$3,$4, now() + make_interval(days => $5), $6)
     RETURNING grant_id, user_id, source, discount_bps::text AS discount_bps,
               expires_at, state`,
    [
      input.userId,
      input.source,
      input.sourceRef ?? null,
      input.discountBps.toString(),
      input.days,
      principal.userId,
    ],
  );
  const r = rows[0]!;
  return accept({
    grantId: r.grant_id as string,
    userId: r.user_id as string,
    source: r.source as PremiumGrant['source'],
    discountBps: r.discount_bps as string,
    expiresAt: (r.expires_at as Date).toISOString(),
    state: r.state as PremiumGrant['state'],
  });
}

export async function revokePremium(
  tx: Tx,
  principal: Principal,
  input: { readonly grantId: string; readonly reason: string },
): Promise<Outcome<{ grantId: string }>> {
  if (denialFor(principal, 'premium.grant') !== null) {
    return reject('PERMISSION_DENIED', FAILURE_COPY.PERMISSION_DENIED.reason);
  }
  const reason = input.reason.trim();
  if (reason.length < 10) {
    return reject('STATEMENT_TOO_SHORT', FAILURE_COPY.STATEMENT_TOO_SHORT.reason);
  }
  const { rowCount } = await tx.query(
    `UPDATE sandbox.premium_grant
        SET state='REVOKED', revoked_at=now(), revoked_by=$2, revoke_reason=$3
      WHERE grant_id=$1 AND state='ACTIVE'`,
    [input.grantId, principal.userId, reason],
  );
  if (rowCount === 0) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);

  /*
   * Revocation is recorded as an adjustment, not just a state change.
   * "Their benefit was taken away and here is why" is a question a
   * support conversation asks, and a status column does not answer it.
   */
  await tx.query(
    `INSERT INTO sandbox.benefit_adjustment (user_id, kind, premium_grant_id, reason)
     SELECT user_id, 'PREMIUM_REVOKED', grant_id, $2
       FROM sandbox.premium_grant WHERE grant_id = $1`,
    [input.grantId, reason],
  );
  return accept({ grantId: input.grantId });
}

/* ------------------------------------------------------------------ *
 * Referrals
 * ------------------------------------------------------------------ */

/**
 * The code alphabet: no 0/O/1/I, so a code read aloud or copied by hand
 * cannot become a DIFFERENT valid code belonging to somebody else.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Ten characters from a CSPRNG. ~50 bits: not enumerable, not guessable. */
function mintCode(): string {
  const bytes = randomBytes(20);
  let out = '';
  for (let i = 0; i < 10; i += 1) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

/** The canonical form. Applied before storing, comparing and looking up. */
export function normalizeReferralCode(raw: string): string | null {
  const upper = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  return /^[2-9A-HJ-NP-Z]{10}$/.test(upper) ? upper : null;
}

export async function referralCodeFor(tx: Tx, userId: string): Promise<string> {
  const existing = await tx.query(`SELECT code FROM sandbox.referral_code WHERE owner_id = $1`, [
    userId,
  ]);
  if (existing.rows[0]) return existing.rows[0].code as string;

  // Retry on the (vanishingly unlikely) collision rather than assuming.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = mintCode();
    const { rows } = await tx.query(
      `INSERT INTO sandbox.referral_code (owner_id, code) VALUES ($1,$2)
       ON CONFLICT DO NOTHING RETURNING code`,
      [userId, code],
    );
    if (rows[0]) return rows[0].code as string;
    const mine = await tx.query(`SELECT code FROM sandbox.referral_code WHERE owner_id = $1`, [
      userId,
    ]);
    if (mine.rows[0]) return mine.rows[0].code as string;
  }
  throw new Error('could not mint a unique referral code');
}

/**
 * Would attributing `referee` to `referrer` close a loop?
 *
 * Walks the referrer chain upward. A cycle is a graph property, so no row
 * constraint can see it — which is exactly why this is a real function
 * with a real test rather than a comment saying cycles are prevented.
 * The depth bound is a safety net: the chain is acyclic by construction
 * once this holds, so it should never be reached.
 */
async function wouldCycle(tx: Tx, referrerId: string, refereeId: string): Promise<boolean> {
  let cursor: string | null = referrerId;
  for (let depth = 0; depth < 64 && cursor !== null; depth += 1) {
    if (cursor === refereeId) return true;
    const step: { rows: Record<string, unknown>[] } = await tx.query(
      `SELECT referrer_id FROM sandbox.referral_attribution WHERE referee_id = $1`,
      [cursor],
    );
    cursor = (step.rows[0]?.referrer_id as string | undefined) ?? null;
  }
  return false;
}

export interface ReferralAttribution {
  readonly referralId: string;
  readonly referrerId: string;
  readonly refereeId: string;
  readonly state: 'ATTRIBUTED' | 'QUALIFIED' | 'DISQUALIFIED';
}

export async function attributeReferral(
  tx: Tx,
  input: { readonly refereeId: string; readonly code: string },
): Promise<Outcome<ReferralAttribution>> {
  const code = normalizeReferralCode(input.code);
  if (code === null)
    return reject('REFERRAL_CODE_INVALID', FAILURE_COPY.REFERRAL_CODE_INVALID.reason);

  const { rows: codeRows } = await tx.query(
    `SELECT code_id, owner_id FROM sandbox.referral_code WHERE code = $1 AND active`,
    [code],
  );
  if (codeRows[0] === undefined) {
    return reject('REFERRAL_CODE_INVALID', FAILURE_COPY.REFERRAL_CODE_INVALID.reason);
  }
  const referrerId = codeRows[0].owner_id as string;

  if (referrerId === input.refereeId) {
    return reject('REFERRAL_SELF', FAILURE_COPY.REFERRAL_SELF.reason);
  }
  if (await wouldCycle(tx, referrerId, input.refereeId)) {
    return reject('REFERRAL_CYCLE', FAILURE_COPY.REFERRAL_CYCLE.reason);
  }

  /*
   * `ON CONFLICT DO NOTHING` against the UNIQUE on `referee_id` is what
   * decides a race between two referrers claiming the same new account.
   * The loser is told the account already has a referrer — it is not
   * overwritten, and attribution is never reconsidered afterwards.
   */
  const { rows } = await tx.query(
    `INSERT INTO sandbox.referral_attribution (referrer_id, referee_id, code_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (referee_id) DO NOTHING
     RETURNING referral_id, referrer_id, referee_id, state`,
    [referrerId, input.refereeId, codeRows[0].code_id],
  );
  if (rows[0] === undefined) {
    const { rows: prior } = await tx.query(
      `SELECT referral_id, referrer_id FROM sandbox.referral_attribution WHERE referee_id = $1`,
      [input.refereeId],
    );
    return reject('REFERRAL_ALREADY_ATTRIBUTED', FAILURE_COPY.REFERRAL_ALREADY_ATTRIBUTED.reason, {
      referrerId: prior[0]?.referrer_id as string,
    });
  }
  return accept({
    referralId: rows[0].referral_id as string,
    referrerId,
    refereeId: input.refereeId,
    state: 'ATTRIBUTED',
  });
}

/**
 * Does this completed deal qualify the payer's referral?
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  ONLY REAL ECONOMIC ACTIVITY BETWEEN DISTINCT VERIFIED PEOPLE.     │
 * │                                                                    │
 * │  A deal with yourself, a deal with your own referrer, a refunded   │
 * │  deal, a disputed deal, an unverified account — none of them       │
 * │  qualify, and each is refused explicitly rather than by an         │
 * │  omission somebody could later "fix".                              │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function qualifyReferral(
  tx: Tx,
  input: { readonly dealId: string },
): Promise<Outcome<{ referralId: string | null }>> {
  const { rows: deal } = await tx.query(
    `SELECT d.deal_id, d.state,
            (SELECT count(*) FROM sandbox.dispute_case c WHERE c.deal_id = d.deal_id) AS cases,
            l.state AS lock_state
       FROM sandbox.deal d
       LEFT JOIN inrp2p.value_lock l ON l.deal_id = d.deal_id
      WHERE d.deal_id = $1`,
    [input.dealId],
  );
  if (deal[0] === undefined) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);

  // A completed deal whose value was RELEASED. Refunded, cancelled or
  // reversed outcomes are not economic activity worth rewarding.
  if (deal[0].state !== 'COMPLETED' || deal[0].lock_state !== 'RELEASED') {
    return reject('REFERRAL_NOT_ELIGIBLE', FAILURE_COPY.REFERRAL_NOT_ELIGIBLE.reason);
  }
  if (Number(deal[0].cases) > 0) {
    return reject('REFERRAL_NOT_ELIGIBLE', FAILURE_COPY.REFERRAL_NOT_ELIGIBLE.reason, {
      reason: 'DISPUTED',
    });
  }

  const { rows: seats } = await tx.query(
    `SELECT p.user_id, u.is_verified
       FROM sandbox.participant p JOIN sandbox.app_user u ON u.user_id = p.user_id
      WHERE p.deal_id = $1`,
    [input.dealId],
  );
  if (seats.length !== 2 || seats.some((s) => s.is_verified !== true)) {
    return reject('REFERRAL_NOT_ELIGIBLE', FAILURE_COPY.REFERRAL_NOT_ELIGIBLE.reason, {
      reason: 'UNVERIFIED',
    });
  }

  const userIds = seats.map((s) => s.user_id as string);
  const { rows: attribution } = await tx.query(
    `SELECT referral_id, referrer_id, referee_id, state
       FROM sandbox.referral_attribution
      WHERE referee_id = ANY($1::uuid[]) AND state = 'ATTRIBUTED'
      FOR UPDATE`,
    [userIds],
  );
  if (attribution[0] === undefined) return accept({ referralId: null });

  // SELF-DEALING: a deal between a referrer and their own referee is not
  // two people finding the platform, it is one person using two accounts.
  if (userIds.includes(attribution[0].referrer_id as string)) {
    await tx.query(
      `UPDATE sandbox.referral_attribution
          SET state='DISQUALIFIED', disqualified_reason=$2 WHERE referral_id=$1`,
      [attribution[0].referral_id, 'The qualifying deal was between the referrer and referee.'],
    );
    return reject('REFERRAL_NOT_ELIGIBLE', FAILURE_COPY.REFERRAL_NOT_ELIGIBLE.reason, {
      reason: 'SELF_DEALING',
    });
  }

  /*
   * The partial unique index on `qualifying_deal_id` means one deal
   * qualifies at most one referral, so a redelivered completion cannot
   * qualify twice.
   */
  const { rows: qualified } = await tx.query(
    `UPDATE sandbox.referral_attribution
        SET state='QUALIFIED', qualifying_deal_id=$2, qualified_at=now()
      WHERE referral_id=$1 AND state='ATTRIBUTED'
      RETURNING referral_id`,
    [attribution[0].referral_id, input.dealId],
  );
  return accept({ referralId: (qualified[0]?.referral_id as string | undefined) ?? null });
}

/* ------------------------------------------------------------------ *
 * Rewards
 * ------------------------------------------------------------------ */

export interface RewardGrant {
  readonly grantId: string;
  readonly campaignId: string;
  readonly benefitKind: 'FEE_DISCOUNT' | 'PREMIUM_DAYS';
  readonly discountBps: string;
  readonly maxBenefitMinor: string;
  readonly expiresAt: string;
  readonly state: 'GRANTED' | 'REDEEMED' | 'EXPIRED' | 'CANCELLED';
}

/**
 * A person's spendable rewards.
 *
 * Expiry filtered by the DATABASE clock, for the same reason as premium.
 */
export async function rewardInventory(userId: string): Promise<readonly RewardGrant[]> {
  const { rows } = await getPool().query(
    `SELECT g.grant_id, g.campaign_id, c.benefit_kind, c.discount_bps::text AS discount_bps,
            c.max_benefit_minor::text AS max_benefit_minor, g.expires_at, g.state
       FROM sandbox.reward_grant g
       JOIN sandbox.reward_campaign c ON c.campaign_id = g.campaign_id
      WHERE g.user_id = $1 AND g.state = 'GRANTED' AND g.expires_at > now()
      ORDER BY g.expires_at`,
    [userId],
  );
  return rows.map((r) => ({
    grantId: r.grant_id as string,
    campaignId: r.campaign_id as string,
    benefitKind: r.benefit_kind as 'FEE_DISCOUNT' | 'PREMIUM_DAYS',
    discountBps: r.discount_bps as string,
    maxBenefitMinor: r.max_benefit_minor as string,
    expiresAt: (r.expires_at as Date).toISOString(),
    state: r.state as RewardGrant['state'],
  }));
}

/**
 * Verify a campaign's revealed seed against its published commitment.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THIS IS WHAT SEPARATES A LOTTERY FROM A DECISION MADE AFTERWARDS. │
 * │                                                                    │
 * │  The commitment — SHA-256 of the seed — is published BEFORE        │
 * │  eligibility opens. The seed is revealed at selection. Anybody can │
 * │  recompute the hash and confirm the operator did not look at who   │
 * │  entered and then choose a seed that produced the winners they     │
 * │  wanted.                                                           │
 * │                                                                    │
 * │  Constant-time comparison, because the commitment is public but    │
 * │  the seed is not, and a timing oracle on a hash comparison is a    │
 * │  free hint.                                                        │
 * └────────────────────────────────────────────────────────────────────┘
 */
export function verifyCommitment(commitment: string, seed: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(commitment)) return false;
  const expected = Buffer.from(commitment, 'hex');
  const actual = createHash('sha256').update(seed).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Deterministic, auditable selection.
 *
 * The winner is a pure function of the revealed seed and the entrant's
 * id — so given the seed, anybody can recompute every outcome, and no
 * client ever chooses. `thresholdBps` is the campaign's declared win
 * rate; the draw is the first 4 bytes of the hash taken modulo 10,000.
 */
export function selectionWins(seed: string, subjectId: string, thresholdBps: bigint): boolean {
  const digest = createHash('sha256').update(`${seed}:${subjectId}`).digest();
  const draw = BigInt(digest.readUInt32BE(0) % 10_000);
  return draw < thresholdBps;
}

/**
 * Resolve everything a person is entitled to, for one quote.
 *
 * The reward is the only nominated input, and it is checked for
 * ownership, state and expiry under `FOR UPDATE` so two quotes cannot
 * spend the same one.
 */
export async function entitlementsFor(
  tx: Tx,
  input: { readonly userId: string; readonly rewardGrantId?: string | null },
): Promise<{
  readonly entitlements: Entitlements;
  readonly premiumGrantId: string | null;
  readonly referralId: string | null;
  readonly rewardGrantId: string | null;
}> {
  const premium = await livePremium(tx, input.userId);

  /*
   * A QUALIFIED referral earns the referee a standing discount. The rate
   * is not stored on the attribution — it comes from the active policy's
   * cap regime via `REFERRAL_DISCOUNT_BPS`, so changing the offer is a
   * policy change and never a per-user edit.
   */
  const { rows: referral } = await tx.query(
    `SELECT referral_id FROM sandbox.referral_attribution
      WHERE referee_id = $1 AND state = 'QUALIFIED'`,
    [input.userId],
  );

  let rewardBps = 0n;
  let rewardMaxMinor: bigint | undefined;
  let rewardGrantId: string | null = null;

  if (input.rewardGrantId) {
    const { rows } = await tx.query(
      `SELECT g.grant_id, c.benefit_kind, c.discount_bps, c.max_benefit_minor
         FROM sandbox.reward_grant g
         JOIN sandbox.reward_campaign c ON c.campaign_id = g.campaign_id
        WHERE g.grant_id = $1 AND g.user_id = $2 AND g.state = 'GRANTED'
          AND g.expires_at > now()
        FOR UPDATE OF g`,
      [input.rewardGrantId, input.userId],
    );
    if (rows[0] && rows[0].benefit_kind === 'FEE_DISCOUNT') {
      rewardBps = toBigInt(rows[0].discount_bps);
      rewardMaxMinor = toBigInt(rows[0].max_benefit_minor);
      rewardGrantId = rows[0].grant_id as string;
    }
  }

  return {
    entitlements: {
      premiumBps: premium === null ? 0n : BigInt(premium.discountBps),
      referralBps: referral[0] ? REFERRAL_DISCOUNT_BPS : 0n,
      rewardBps,
      rewardMaxMinor,
    },
    premiumGrantId: premium?.grantId ?? null,
    referralId: (referral[0]?.referral_id as string | undefined) ?? null,
    rewardGrantId,
  };
}

/**
 * The referral discount, stated once.
 *
 * A modest 5%: enough to be worth sharing a code for, small enough that
 * referral farming is not a business model. It composes inside the
 * policy's `discount_cap_bps` like every other discount.
 */
export const REFERRAL_DISCOUNT_BPS = 500n;
