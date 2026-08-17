/**
 * The figures behind the LANDING-03 demonstration.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  NOTHING HERE TOUCHES A REAL ACCOUNT.                              │
 * │                                                                    │
 * │  No import from `@/server`, no session, no query. The public page   │
 * │  cannot read a trust profile, mint a referral code, issue a reward │
 * │  grant, award a point or move a fee. Every number below is a        │
 * │  constant, and the components that render them are inert.          │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ════════════════════════════════════════════════════════════════════
 *  WHAT IS REAL, AND WHAT IS AN ILLUSTRATION
 * ════════════════════════════════════════════════════════════════════
 *
 * REAL product concepts these previews stand for:
 *   · SafePoints → fee credit, at 10 points per ₹1.00
 *     (`feeCreditMinorFor`, src/server/sandbox/identity.ts)
 *   · Levels earned by completed deals, thresholds 0/3/10/25/50
 *     (`levelFor`, same file)
 *   · Discounts from three sources — premium, referral, reward — each in
 *     basis points and all bounded by the policy's `discountCapBps`
 *     (`Entitlements`, src/lib/feeMath.ts)
 *   · The referral discount, 500 bps (`REFERRAL_DISCOUNT_BPS`)
 *   · Reward grants, whose `benefit_kind` is FEE_DISCOUNT or PREMIUM_DAYS
 *     (src/server/commerce/entitlements.ts) — which is exactly what
 *     `Fee discount` and `1 day Premium` below refer to
 *
 * ILLUSTRATIVE, and labelled as such on the page:
 *   · The 1.00 / 0.80 / 0.60 % ladder. THE PRODUCT HAS NO ACTIVITY
 *     TIERS. Its base fee is 1.50% protection (INR→INR) or 1.25% service
 *     plus ₹180 network (exchange), and a fee falls through ENTITLEMENTS,
 *     not through a completed-deal ladder. This ladder is a marketing
 *     illustration of the same idea and the card says so in as many words.
 *   · `Trust Score 742`. There is no score. The product keeps SafePoints
 *     and a level of 1–5.
 *   · `Trust +12` on one deal, and the 27 / 100% / 0 profile figures.
 *   · The referral URL. A real invite is `<origin>/login?invite=<CODE>`
 *     with a 10-character CSPRNG code minted server-side.
 *
 * ⚠ NONE OF THIS CHANGES THE FEE ENGINE. `src/lib/fees.ts`,
 * `src/lib/feeMath.ts` and `src/server/commerce/*` are untouched by
 * LANDING-03. If the marketing ladder is ever meant to be real, it has to
 * be built there first, and this file deleted rather than promoted.
 */

/* ------------------------------------------------------------------ *
 * Section 1 — the fee ladder
 * ------------------------------------------------------------------ */

export interface FeeStage {
  readonly key: 'standard' | 'active' | 'trusted';
  readonly label: string;
  readonly rate: string;
  /** Where this stage sits on the illustration, as a percentage of width. */
  readonly at: number;
  readonly current?: boolean;
}

export const FEE_STAGES: readonly FeeStage[] = [
  { key: 'standard', label: 'Standard', rate: '1.00%', at: 16.667 },
  { key: 'active', label: 'Active', rate: '0.80%', at: 50, current: true },
  { key: 'trusted', label: 'Trusted', rate: '0.60%', at: 83.333 },
];

export const FEE_LADDER = {
  title: 'Your fee can fall as your completed-deal history grows.',
  progress: '5 protected deals completed',
  disclosure: 'Illustrative activity tiers. Final fees are shown before every deal.',
  trustLegend: 'Trust grows',
  feeLegend: 'Fees fall',
} as const;

/**
 * The two paths, in the illustration's own 0–100 × 0–40 space.
 *
 * Deliberately gentle: two curves that cross once. Anything with
 * volatility, candles, gridlines or a value axis would read as a price
 * chart, and this is not a claim about markets or returns — it is a
 * picture of one sentence, "do more protected deals, pay less".
 */
/*
 * The trust curve starts at the first zone boundary rather than at the
 * Standard stop — trust has nothing to show before any deal is complete,
 * and starting it further right leaves the lower-left corner free for the
 * legend, exactly as the reference lays it out.
 */
export const TRUST_PATH = 'M30 29.5 C 38 29, 43 22.6, 50 20.5 S 71 12.4, 83.333 11';
export const FEE_PATH = 'M16.667 13 L 83.333 33.6';

/* ------------------------------------------------------------------ *
 * Section 2 — the receipt
 * ------------------------------------------------------------------ */

export interface ReceiptLine {
  readonly id: string;
  readonly value: string;
  readonly note?: string;
  readonly kind: 'inr' | 'usdt' | 'trust';
}

export const RECEIPT = {
  status: 'Deal complete',
  lines: [
    { id: 'paid', value: '₹83,600', note: 'paid', kind: 'inr' },
    { id: 'released', value: '1,000 USDT', note: 'released', kind: 'usdt' },
    { id: 'trust', value: 'Trust +12', kind: 'trust' },
  ] as readonly ReceiptLine[],
  reward: { headline: '10% off', tail: 'your next fee' },
  perk: '1 day Premium',
  action: 'View receipt',
} as const;

/* ------------------------------------------------------------------ *
 * Section 3 — referral, Premium, reward kinds
 * ------------------------------------------------------------------ */

/**
 * An obviously-illustrative invite address.
 *
 * Not a real code and not a real host: a real invite is minted by
 * `referralCodeFor` on the server, ten characters from a CSPRNG, and
 * reached at `/login?invite=<CODE>`. Putting a plausible-looking live
 * link on a public page is how people end up sharing one that credits
 * nobody.
 */
export const REFERRAL_PREVIEW_URL = 'inrp2p.link/ref/AB12CD';

export const PREMIUM_BENEFITS = ['Lower fees', 'Faster deals', 'Priority benefits'] as const;

export const REWARD_KINDS = [
  { label: 'Fee discount', icon: 'tag' },
  { label: '1 day Premium', icon: 'star' },
  { label: 'Bonus perk', icon: 'gift' },
] as const;

/* ------------------------------------------------------------------ *
 * Section 4 — the trust profile
 * ------------------------------------------------------------------ */

export const TRUST_PROFILE = {
  title: 'Verified counterparty',
  eligibility: 'Eligible for lower fees',
  scoreLabel: 'Trust Score',
  score: '742',
  delta: 'Trust +12 this deal',
  stats: [
    { value: '27', label: 'completed deals' },
    { value: '100%', label: 'completion' },
    { value: '0', label: 'unresolved disputes' },
  ],
} as const;

/** The sparkline under the score. Same discipline as the ladder: no axis. */
export const SCORE_SPARK = 'M0 22 C 12 21, 20 23, 30 19 S 48 14, 60 12 S 78 6, 92 3';
