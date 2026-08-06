import { headers } from 'next/headers';
import { getChrome } from '@/server/sandbox/chrome';
import {
  dealsToNextLevel,
  getTrustProfile,
  listReferrals,
  listRewards,
} from '@/server/sandbox/identity';
import { formatMinor } from '@/lib/format';
import type { RewardEntry } from '@/lib/sandboxContract';
import { AppHeader } from '@/components/kit/AppChrome';
import { Icon, type IconName } from '@/components/kit/Icon';
import { Ago } from '@/components/kit/Time';
import { ToastProvider } from '@/components/kit/Feedback';
import { InviteBlock } from '@/components/flows/InviteBlock';
import {
  Callout,
  Card,
  EmptyState,
  Meter,
  SectionHead,
  Shell,
  StatTile,
} from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * Rewards and referrals.
 *
 * ⚠ SafePoints are NOT money. They cannot be bought, sold, transferred or
 * withdrawn, and no code path exists to do any of those — the closed `kind`
 * catalogue in the schema is what makes that structural rather than a
 * promise. They unlock a fee discount on this platform and nothing else, and
 * every surface here says so rather than styling them like a balance.
 *
 * Every figure is derived from rows that exist: points come from award
 * events, referrals qualify only when the invited person completes a deal,
 * and the fee credit is a fixed conversion of the two. Nothing here can be
 * increased except by using the product.
 */

const POINTS_PER_RUPEE = 10;

export default async function RewardsPage() {
  const { user, unread } = await getChrome();
  const [profile, rewards, referrals, h] = await Promise.all([
    getTrustProfile(user),
    listRewards(user),
    listReferrals(user),
    headers(),
  ]);

  const host = h.get('host') ?? 'localhost';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const inviteUrl = `${proto}://${host}/login?invite=${profile.referralCode}`;

  const qualified = referrals.filter((r) => r.qualifiedAt !== null);
  const toNext = dealsToNextLevel(profile.completedDeals);
  const levelProgress = toNext === null ? 100 : Math.max(6, 100 - (toNext / 5) * 100);

  return (
    <ToastProvider>
      <AppHeader
        title="Rewards"
        subtitle={`Level ${profile.level} · ${profile.completedDeals} completed deals`}
        unread={unread}
      />

      <Shell width="wide" className="py-5 sm:py-7">
        {/* ---- The balance that is not a balance ------------------ */}
        <Card tone="brand">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <span className="text-[length:var(--text-2xs)] font-semibold uppercase tracking-[0.07em] text-[var(--color-brand-ink)]">
                SafePoints
              </span>
              <p className="tnum mt-1 flex items-baseline gap-2 text-[length:var(--text-4xl)] font-semibold tracking-[-0.03em] text-[var(--color-ink)]">
                {profile.safePoints.toLocaleString('en-IN')}
                <Icon name="sparkle" className="h-6 w-6 text-[var(--color-brand)]" />
              </p>
            </div>
            <div className="shrink-0 text-right">
              <span className="text-[length:var(--text-2xs)] font-semibold uppercase tracking-[0.07em] text-[var(--color-brand-ink)]">
                Fee credit
              </span>
              <p className="tnum mt-1 text-[length:var(--text-2xl)] font-semibold tracking-[-0.028em] text-[var(--color-ink)]">
                ₹{formatMinor(profile.feeCreditMinor, 'INR')}
              </p>
            </div>
          </div>

          <p className="mt-3 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-2)]">
            {POINTS_PER_RUPEE} SafePoints unlock ₹1 off a future protection fee. They are not money:
            they cannot be bought, sold, transferred or withdrawn, and there is no cash payout.
          </p>

          {/* Level progress — from completed deals, nothing else. */}
          <div className="mt-4 border-t border-[var(--color-brand-line)] pt-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[length:var(--text-xs)] font-semibold text-[var(--color-ink)]">
                Level {profile.level}
              </span>
              <span className="text-[length:var(--text-2xs)] text-[var(--color-ink-2)]">
                {toNext === null
                  ? 'Top level reached'
                  : `${toNext} more deal${toNext === 1 ? '' : 's'} to level ${profile.level + 1}`}
              </span>
            </div>
            <Meter
              className="mt-2"
              percent={levelProgress}
              tone="brand"
              label={`Level ${profile.level} progress`}
            />
          </div>
        </Card>

        {/* ---- What earns what ------------------------------------ */}
        <section className="mt-6">
          <SectionHead title="How you earn" />
          <ul className="mt-3 grid gap-3 sm:grid-cols-3">
            {EARNING.map((e) => (
              <li key={e.title}>
                <Card className="h-full">
                  <span className="grid h-10 w-10 place-items-center rounded-full bg-[var(--color-sunken)] text-[var(--color-ink-2)]">
                    <Icon name={e.icon} className="h-[18px] w-[18px]" />
                  </span>
                  <p className="mt-3 text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                    {e.title}
                  </p>
                  <p className="mt-1 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                    {e.body}
                  </p>
                  <p className="tnum mt-2.5 text-[length:var(--text-sm)] font-semibold text-[var(--color-brand)]">
                    {e.points}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        </section>

        {/* ---- Invite --------------------------------------------- */}
        <section className="mt-6">
          <SectionHead title="Invite people you trust" />
          <Card className="mt-3">
            <p className="text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
              You earn 500 SafePoints when someone you invited completes their first protected deal
              — never on sign-up. An invitation that never trades is worth nothing, which is what
              keeps this from paying for empty accounts.
            </p>
            <div className="mt-4">
              <InviteBlock url={inviteUrl} code={profile.referralCode} />
            </div>
          </Card>
        </section>

        {/* ---- Referrals ------------------------------------------ */}
        <section className="mt-6">
          <SectionHead title="Your referrals" count={referrals.length} />
          {referrals.length === 0 ? (
            <EmptyState
              className="mt-3"
              icon="users"
              title="Nobody has joined through you yet"
              body="Share your invite link. When someone uses it and completes their first protected deal, 500 SafePoints are added here."
            />
          ) : (
            <Card className="mt-3" flush>
              <div className="grid grid-cols-3 gap-4 border-b border-[var(--color-line)] px-4 py-3 sm:px-5">
                <StatTile value={referrals.length} label="Invited" />
                <StatTile value={qualified.length} label="Qualified" tone="final" />
                <StatTile value={qualified.length * 500} label="Points earned" tone="brand" />
              </div>
              <ul className="divide-y divide-[var(--color-line)]">
                {referrals.map((r) => (
                  <li key={r.referralId} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[length:var(--text-sm)] font-medium text-[var(--color-ink)]">
                        {r.inviteeName}
                      </span>
                      <span className="block truncate text-[length:var(--text-2xs)] text-[var(--color-ink-3)]">
                        Joined <Ago iso={r.joinedAt} />
                        {r.qualifiedAt ? (
                          <>
                            {' · first deal '}
                            <Ago iso={r.qualifiedAt} />
                          </>
                        ) : null}
                      </span>
                    </span>
                    <span
                      className={
                        r.qualifiedAt
                          ? 'tnum shrink-0 text-[length:var(--text-sm)] font-semibold text-[var(--color-brand)]'
                          : 'shrink-0 text-[length:var(--text-2xs)] text-[var(--color-ink-4)]'
                      }
                    >
                      {r.qualifiedAt ? `+${r.points}` : 'Not yet qualified'}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>

        {/* ---- History -------------------------------------------- */}
        <section className="mt-6">
          <SectionHead title="Points history" count={rewards.length} />
          {rewards.length === 0 ? (
            <EmptyState
              className="mt-3"
              icon="sparkle"
              title="No points yet"
              body="Complete a protected deal and 250 SafePoints land here, for both sides."
              action={{ href: '/app/new', label: 'Create a protected deal' }}
            />
          ) : (
            <Card className="mt-3" flush seam>
              {rewards.map((entry) => (
                <RewardRow key={entry.rewardId} entry={entry} />
              ))}
            </Card>
          )}
        </section>

        <Callout tone="hold" icon="info" className="mt-6">
          <strong className="font-semibold">No cash payouts.</strong> SafePoints have no monetary
          value, cannot be bought, sold or transferred, and exist only to discount this
          platform&rsquo;s own fees. Abuse of the referral programme removes the points it produced.
        </Callout>
      </Shell>
    </ToastProvider>
  );
}

const EARNING: readonly { title: string; body: string; points: string; icon: IconName }[] = [
  {
    title: 'Complete protected deals',
    body: 'Both sides earn on every deal that settles. Awarded once per deal, per person.',
    points: '250 points each',
    icon: 'shield-check',
  },
  {
    title: 'Refer people who trade',
    body: 'Awarded when your invitee completes their first deal, not when they sign up.',
    points: '500 points',
    icon: 'users',
  },
  {
    title: 'Verify your account',
    body: 'Each verification step you complete adds points and raises your limits.',
    points: '100 points each',
    icon: 'check-circle',
  },
];

const KIND_COPY: Readonly<Record<RewardEntry['kind'], { label: string; icon: IconName }>> = {
  DEAL_COMPLETED: { label: 'Deal completed', icon: 'shield-check' },
  REFERRAL_COMPLETED: { label: 'Referral qualified', icon: 'users' },
  VERIFICATION: { label: 'Verification', icon: 'check-circle' },
  FEE_CREDIT_APPLIED: { label: 'Fee credit applied', icon: 'rupee' },
};

function RewardRow({ entry }: { entry: RewardEntry }) {
  const copy = KIND_COPY[entry.kind];
  const positive = entry.points >= 0;
  return (
    <div className="flex items-center gap-3 px-4 py-3 sm:px-5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--color-sunken)] text-[var(--color-ink-3)]">
        <Icon name={copy.icon} className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[length:var(--text-sm)] font-medium text-[var(--color-ink)]">
          {copy.label}
        </span>
        <span className="block truncate text-[length:var(--text-2xs)] text-[var(--color-ink-3)]">
          {entry.note ? `${entry.note} · ` : ''}
          <Ago iso={entry.createdAt} />
        </span>
      </span>
      <span
        className={
          positive
            ? 'tnum shrink-0 text-[length:var(--text-sm)] font-semibold text-[var(--color-brand)]'
            : 'tnum shrink-0 text-[length:var(--text-sm)] font-semibold text-[var(--color-ink-3)]'
        }
      >
        {positive ? '+' : ''}
        {entry.points.toLocaleString('en-IN')}
      </span>
    </div>
  );
}
