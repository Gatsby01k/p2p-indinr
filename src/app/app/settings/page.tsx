import { getChrome } from '@/services';
import { getTrustProfile } from '@/services';
import { updateProfileAction } from '@/services/actions';
import { AppHeader } from '@/components/kit/AppChrome';
import { ToastProvider } from '@/components/kit/Feedback';
import { ProfileForm } from '@/components/flows/ProfileForm';
import { Callout, Card, ListRow, SectionHead, Shell } from '@/components/kit/primitives';
import { accountHandle } from '@/lib/sandboxContract';

export const dynamic = 'force-dynamic';

/**
 * Settings.
 *
 * Preferences that change how the product behaves for one person, and
 * nothing else. Anything that changes what other people can see about them —
 * verification, payment methods — lives under the profile, because that is
 * where a person looks for it.
 */
export default async function SettingsPage() {
  const { user, unread } = await getChrome();
  const profile = await getTrustProfile(user);

  return (
    <ToastProvider>
      <AppHeader
        title="Settings"
        back={{ href: '/app/profile', label: 'Back to profile' }}
        unread={unread}
      />

      <Shell width="form" className="py-5 sm:py-7">
        <section>
          <SectionHead title="Profile" />
          <Card className="mt-3">
            <ProfileForm
              action={updateProfileAction}
              about={profile.about ?? ''}
              city={profile.city ?? ''}
              notifyEmail={profile.notifyEmail}
              notifyPush={profile.notifyPush}
            />
          </Card>
        </section>

        <section className="mt-6">
          <SectionHead title="Account" />
          <Card className="mt-3" flush seam>
            <ListRow
              icon="profile"
              title="Signed in as"
              subtitle={accountHandle(profile)}
              value={user.isOperator ? 'Operator' : undefined}
            />
            <ListRow
              href="/app/profile/verification"
              icon="shield-check"
              title="Verification"
              subtitle={
                profile.identityVerified && profile.upiVerified && profile.walletVerified
                  ? 'All steps complete'
                  : 'Some steps outstanding'
              }
            />
            <ListRow
              href="/app/profile/payment-methods"
              icon="wallet"
              title="Payment methods"
              subtitle="Where people send you money"
            />
            <ListRow
              href="/app/settings/security"
              icon="lock"
              title="Security"
              subtitle={profile.twoFactorEnabled ? 'Two-factor on' : 'Two-factor off'}
            />
            <ListRow
              href="/app/notifications"
              icon="bell"
              title="Notifications"
              subtitle={unread > 0 ? `${unread} unread` : 'All caught up'}
            />
            <ListRow
              href="/app/help"
              icon="help"
              title="Help and support"
              subtitle="How protection works"
            />
            <ListRow
              href="/app/settings/diagnostics"
              icon="settings"
              title="Diagnostics"
              subtitle="What this deployment has configured"
            />
          </Card>
        </section>

        <Callout tone="hold" icon="info" className="mt-6">
          This is a sandbox account. It holds no funds, authenticates nobody in the real world, and
          may be reset at any time. Do not use it for anything that matters.
        </Callout>
      </Shell>
    </ToastProvider>
  );
}
