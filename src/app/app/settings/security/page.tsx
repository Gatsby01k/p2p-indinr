import { getChrome } from '@/server/sandbox/chrome';
import { getTrustProfile } from '@/server/sandbox/identity';
import { setTwoFactorAction, signOutAction } from '@/server/sandbox/actions';
import { AppHeader } from '@/components/kit/AppChrome';
import { Icon } from '@/components/kit/Icon';
import { ToastProvider } from '@/components/kit/Feedback';
import { ActionSwitch } from '@/components/flows/ActionButton';
import { accountHandle } from '@/lib/sandboxContract';
import {
  Callout,
  Card,
  Fact,
  Facts,
  SectionHead,
  Shell,
  buttonClass,
} from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * Security.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  ⚠ THIS SANDBOX AUTHENTICATES NOBODY.                            │
 * │                                                                  │
 * │  Sign-in accepts any email address and stores no password. The   │
 * │  session is a signed cookie carrying a user id — enough for the  │
 * │  server to enforce authorization honestly, and nothing like an   │
 * │  authentication system. The toggle below records a PREFERENCE;   │
 * │  it enrols no second factor, because there is no first one.      │
 * │                                                                  │
 * │  This page says so at the top rather than presenting a security  │
 * │  theatre that a person might rely on.                            │
 * └──────────────────────────────────────────────────────────────────┘
 */
export default async function SecurityPage() {
  const { user, unread } = await getChrome();
  const profile = await getTrustProfile(user);

  return (
    <ToastProvider>
      <AppHeader
        title="Security"
        back={{ href: '/app/settings', label: 'Back to settings' }}
        unread={unread}
      />

      <Shell width="form" className="py-5 sm:py-7">
        <Callout tone="hold" icon="alert">
          <strong className="font-semibold">This sandbox authenticates nobody.</strong> Any email
          address signs in and no password is stored, checked or accepted anywhere. Never reuse a
          real credential here, and never treat this account as protecting anything.
        </Callout>

        <section className="mt-5">
          <SectionHead title="Sign-in" />
          <Card className="mt-3" flush seam>
            <ActionSwitch
              checked={profile.twoFactorEnabled}
              action={setTwoFactorAction}
              label="Two-factor authentication"
              description="Records your preference. No factor is enrolled in this sandbox, because there is no password to add a second factor to."
              success="Preference saved"
            />
          </Card>
        </section>

        <section className="mt-6">
          <SectionHead title="This session" />
          <Card className="mt-3">
            <Facts>
              <Fact term="Signed in as">{accountHandle(profile)}</Fact>
              <Fact term="Sign-in method">
                {profile.telegramUsername ? 'Telegram' : 'Email address'}
              </Fact>
              <Fact term="Account type">{user.isOperator ? 'Operator' : 'Trader'}</Fact>
              <Fact term="Session">Signed cookie, 8 hours</Fact>
              <Fact term="Cookie">
                {/*
                  Stated exactly, because it differs by how you signed in. A
                  Mini App is hosted in a cross-site iframe on Telegram Web
                  and Desktop, and only a SameSite=None cookie is sent from
                  one — so a Telegram session is issued that way and an
                  ordinary web session is not.
                */}
                HTTP-only, SameSite={profile.telegramUsername ? 'None · Secure' : 'Lax'}
              </Fact>
            </Facts>
            <p className="mt-3 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
              The session cookie is signed, so it cannot be edited to become another user or an
              operator. That signature is what the authorization tests depend on — it is a real
              control, unlike the sign-in itself.
            </p>
            {profile.telegramUsername ? (
              <p className="mt-2 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                Your Telegram identity was proven by a signature Telegram computed with this
                bot&rsquo;s token, checked on our server. That part is a genuine control — unlike
                the email sign-in, it cannot be typed in by hand.
              </p>
            ) : null}
            <form action={signOutAction} className="mt-4">
              <button type="submit" className={buttonClass('outline', 'md', true)}>
                <Icon name="logout" className="h-4 w-4" />
                Sign out
              </button>
            </form>
          </Card>
        </section>

        <section className="mt-6">
          <SectionHead title="How INRP2P protects you" />
          <Card className="mt-3">
            <ul className="space-y-3">
              {GUARANTEES.map((g) => (
                <li key={g.title} className="flex gap-2.5">
                  <Icon
                    name="shield-check"
                    className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-final)]"
                  />
                  <div className="min-w-0">
                    <p className="text-[length:var(--text-sm)] font-semibold text-[var(--color-ink)]">
                      {g.title}
                    </p>
                    <p className="mt-0.5 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                      {g.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </section>

        <Callout tone="risk" icon="lock" className="mt-6">
          <strong className="font-semibold">INRP2P never asks for a PIN or a password.</strong> No
          screen in this product has a field for one. A message, call or page asking for your UPI
          PIN, card number or banking password is not from us, whatever it looks like.
        </Callout>
      </Shell>
    </ToastProvider>
  );
}

const GUARANTEES = [
  {
    title: 'Only your side can act',
    body: 'The server decides which of the two actions you are permitted and refuses the other. The interface only ever shows what it already allowed.',
  },
  {
    title: 'A deal is private to its two sides',
    body: 'Knowing a deal id grants nothing. Every read re-checks that you hold a seat, in the database, on every request.',
  },
  {
    title: 'One counterparty, decided by the database',
    body: 'Two people opening the same link cannot both join. The loser is told plainly that nothing was charged.',
  },
  {
    title: 'Nothing moves on a timer',
    body: 'No countdown releases, refunds or completes anything. Every state change is a person acting, or an operator ruling with a written reason.',
  },
  {
    title: 'The record is append-only',
    body: 'Every transition and every rejection is written to an audit trail that cannot be updated or deleted, not even by an operator.',
  },
];
