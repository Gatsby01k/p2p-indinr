import { getChrome } from '@/services';
import {
  dealsToNextLevel,
  getTrustProfile,
  listPaymentMethods,
  typicalResponseMinutes,
} from '@/services';
import { listDealsForUser } from '@/services';
import { formatMinor } from '@/lib/format';
import { MAX_INR_MINOR } from '@/services';
import { SCENARIO, type Scenario } from '@/lib/scenario';
import { AppHeader } from '@/components/kit/AppChrome';
import { Icon, type IconName } from '@/components/kit/Icon';
import { Ago } from '@/components/kit/Time';
import { accountHandle } from '@/lib/sandboxContract';
import {
  ActionLink,
  Avatar,
  Callout,
  Card,
  Chip,
  Divider,
  Fact,
  Facts,
  Label,
  ListRow,
  Meter,
  SectionHead,
  Shell,
  StatTile,
  VerifiedTick,
} from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * The trust profile.
 *
 * EVERY FIGURE HERE IS DERIVED FROM WHAT ACTUALLY HAPPENED. There is no
 * editable deal count, no settable score and no way to improve a number
 * except by completing deals. A trust surface whose figures can be typed in
 * is worse than none, because it looks like evidence.
 *
 * Where there is no history, the figure is absent rather than flattering:
 * a completion rate with no denominator says "no completed deals yet", not
 * "100%".
 */
export default async function ProfilePage() {
  const { user, unread } = await getChrome();
  const [profile, deals, methods, responseMinutes] = await Promise.all([
    getTrustProfile(user),
    listDealsForUser(user),
    listPaymentMethods(user),
    typicalResponseMinutes(user.userId),
  ]);

  const completed = deals.filter((d) => d.state === 'COMPLETED');
  const byScenario = (Object.keys(SCENARIO) as Scenario[]).map((key) => ({
    key,
    label: SCENARIO[key].short,
    count: completed.filter((d) => d.direction === key).length,
  }));
  const toNext = dealsToNextLevel(profile.completedDeals);

  const badges: readonly { label: string; got: boolean; icon: IconName; why: string }[] = [
    {
      label: 'Identity verified',
      got: profile.identityVerified,
      icon: 'shield-check',
      why: 'Completed the identity step',
    },
    {
      label: 'Payment verified',
      got: profile.upiVerified,
      icon: 'wallet',
      why: 'A payment handle is on file',
    },
    {
      label: 'Wallet verified',
      got: profile.walletVerified,
      icon: 'link',
      why: 'A TRC-20 address is on file',
    },
    {
      label: 'Trusted member',
      got: profile.completedDeals >= 10 && profile.openDisputes === 0,
      icon: 'star',
      why: '10+ completed deals, no open disputes',
    },
    {
      label: 'Timely responder',
      got: responseMinutes !== null && responseMinutes <= 15,
      icon: 'clock',
      why: 'Typically acts within 15 minutes',
    },
  ];

  return (
    <>
      <AppHeader title="Your trust" unread={unread} />

      <Shell width="wide" className="py-5 sm:py-7">
        {/* ---- Who you are --------------------------------------- */}
        <Card>
          <div className="flex items-center gap-4">
            <Avatar name={user.displayName} size="lg" verified={profile.identityVerified} />
            <div className="min-w-0 flex-1">
              <h2 className="flex items-center gap-2 truncate text-[length:var(--text-xl)] font-semibold tracking-[-0.025em] text-[var(--color-ink)]">
                {user.displayName}
                {profile.identityVerified ? <VerifiedTick /> : null}
              </h2>
              <p className="mt-0.5 truncate text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
                {accountHandle(profile)} · member since <Ago iso={profile.memberSince} />
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Chip tone="brand" icon="star">
                  Level {profile.level}
                </Chip>
                {user.isOperator ? <Chip icon="briefcase">Operator</Chip> : null}
                {!user.isVerified ? (
                  <Chip tone="quiet" icon="alert">
                    Unverified — cannot join deals
                  </Chip>
                ) : null}
              </div>
            </div>
          </div>

          {toNext !== null ? (
            <div className="mt-4 border-t border-[var(--color-line)] pt-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
                  Progress to level {profile.level + 1}
                </span>
                <span className="tnum text-[length:var(--text-xs)] font-semibold text-[var(--color-ink)]">
                  {toNext} more deal{toNext === 1 ? '' : 's'}
                </span>
              </div>
              <Meter
                className="mt-2"
                percent={Math.max(6, 100 - (toNext / 5) * 100)}
                tone="brand"
                label="Level progress"
              />
            </div>
          ) : null}
        </Card>

        {/* ---- The summary --------------------------------------- */}
        <Card className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatTile value={profile.completedDeals} label="Completed deals" />
          <StatTile
            value={profile.completionRate === null ? '—' : `${profile.completionRate}%`}
            label="Completion rate"
            tone={profile.completionRate !== null && profile.completionRate >= 90 ? 'final' : 'ink'}
          />
          <StatTile
            value={responseMinutes === null ? '—' : `${responseMinutes} min`}
            label="Typical response"
          />
          <StatTile
            value={profile.openDisputes}
            label="Open disputes"
            tone={profile.openDisputes > 0 ? 'risk' : 'ink'}
          />
        </Card>

        {profile.completedDeals === 0 ? (
          <Callout tone="info" icon="info" className="mt-3">
            These figures fill in as you trade. Nothing here can be set by hand — a completion rate
            with no completed deals is shown as a dash, not as 100%.
          </Callout>
        ) : null}

        <div className="mt-6 grid gap-4 lg:grid-cols-2 lg:items-start">
          {/* ---- Experience -------------------------------------- */}
          <div className="space-y-4">
            <section>
              <SectionHead title="Direction experience" />
              <Card className="mt-3" flush seam>
                {byScenario.map((s) => (
                  <div
                    key={s.key}
                    className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5"
                  >
                    <span className="text-[length:var(--text-sm)] font-medium text-[var(--color-ink)]">
                      {s.label}
                    </span>
                    <span className="tnum text-[length:var(--text-sm)] text-[var(--color-ink-3)]">
                      {s.count} completed
                    </span>
                  </div>
                ))}
                <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                  <span className="text-[length:var(--text-sm)] font-medium text-[var(--color-ink)]">
                    Settled volume
                  </span>
                  <span className="tnum text-[length:var(--text-sm)] font-semibold text-[var(--color-ink)]">
                    ₹{formatMinor(profile.volumeInrMinor, 'INR')}
                  </span>
                </div>
              </Card>
            </section>

            <section>
              <SectionHead title="Badges" />
              <Card className="mt-3">
                <ul className="grid gap-2.5 sm:grid-cols-2">
                  {badges.map((b) => (
                    <li
                      key={b.label}
                      className={
                        b.got
                          ? 'flex items-center gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-final-line)] bg-[var(--color-final-tint)] p-2.5'
                          : 'flex items-center gap-2.5 rounded-[var(--radius-md)] border border-dashed border-[var(--color-line)] p-2.5'
                      }
                    >
                      <Icon
                        name={b.icon}
                        className={
                          b.got
                            ? 'h-[18px] w-[18px] shrink-0 text-[var(--color-final)]'
                            : 'h-[18px] w-[18px] shrink-0 text-[var(--color-ink-4)]'
                        }
                      />
                      <span className="min-w-0">
                        <span
                          className={
                            b.got
                              ? 'block truncate text-[length:var(--text-xs)] font-semibold text-[var(--color-ink)]'
                              : 'block truncate text-[length:var(--text-xs)] font-medium text-[var(--color-ink-4)]'
                          }
                        >
                          {b.label}
                        </span>
                        <span className="block truncate text-[10px] text-[var(--color-ink-3)]">
                          {b.why}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                <Callout tone="hold" icon="info" className="mt-3">
                  In this sandbox a badge records that a step was completed. No document is read and
                  no bank is contacted — nothing here verifies a real identity.
                </Callout>
              </Card>
            </section>
          </div>

          {/* ---- Account ------------------------------------------ */}
          <div className="space-y-4">
            <section>
              <SectionHead title="Limits" />
              <Card className="mt-3">
                <Facts>
                  <Fact term="Per deal" hint="Raised by verification and completed deals.">
                    <span className="tnum">
                      up to ₹{formatMinor(MAX_INR_MINOR.toString(), 'INR')}
                    </span>
                  </Fact>
                  <Fact term="Minimum deal">
                    <span className="tnum">₹100.00</span>
                  </Fact>
                  <Fact term="Payment methods">{methods.length} on file</Fact>
                </Facts>
                <p className="mt-3 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                  Limits exist to bound what a single mistake or a single bad actor can cost the
                  people on the other side of a deal.
                </p>
              </Card>
            </section>

            <section>
              <SectionHead title="Account" />
              <Card className="mt-3" flush seam>
                <ListRow
                  href="/app/profile/verification"
                  icon="shield-check"
                  tone={profile.identityVerified ? 'neutral' : 'brand'}
                  title="Verification"
                  subtitle={
                    profile.identityVerified && profile.upiVerified && profile.walletVerified
                      ? 'All steps complete'
                      : 'Raise your limits and earn points'
                  }
                />
                <ListRow
                  href="/app/profile/payment-methods"
                  icon="wallet"
                  title="Payment methods"
                  subtitle={
                    methods.length === 0
                      ? 'None yet — add one so people can pay you'
                      : `${methods.length} on file`
                  }
                />
                <ListRow
                  href="/app/rewards"
                  icon="gift"
                  title="Rewards"
                  subtitle={`${profile.safePoints.toLocaleString('en-IN')} SafePoints`}
                />
                <ListRow
                  href="/app/settings"
                  icon="settings"
                  title="Settings"
                  subtitle="Notifications and preferences"
                />
                <ListRow
                  href="/app/settings/security"
                  icon="lock"
                  title="Security"
                  subtitle={profile.twoFactorEnabled ? 'Two-factor on' : 'Two-factor off'}
                />
                <ListRow
                  href="/app/help"
                  icon="help"
                  title="Help and support"
                  subtitle="How protection works, and how to reach us"
                />
              </Card>
            </section>

            {profile.about || profile.city ? (
              <section>
                <SectionHead title="About" />
                <Card className="mt-3">
                  {profile.city ? (
                    <p className="text-[length:var(--text-sm)] font-medium text-[var(--color-ink)]">
                      {profile.city}
                    </p>
                  ) : null}
                  {profile.about ? (
                    <p className="mt-1 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
                      {profile.about}
                    </p>
                  ) : null}
                  <Divider className="my-3" />
                  <ActionLink href="/app/settings" variant="outline" size="sm">
                    Edit profile
                  </ActionLink>
                </Card>
              </section>
            ) : null}
          </div>
        </div>

        <div className="mt-6">
          <Label>Signed in as</Label>
          <p className="mt-1 text-[length:var(--text-sm)] text-[var(--color-ink-2)]">
            {accountHandle(profile)}
          </p>
        </div>
      </Shell>
    </>
  );
}
