/*
 * Everything server-side arrives through `@/services`, the one
 * application-service boundary (UX-01 §9). `tests/serviceBoundary.test.ts`
 * fails the build if an interface file reaches into `@/server/*` directly,
 * and this page did — for `currentCaller` and `countUnread`, both of which
 * the service index already re-exports.
 */
import { countUnread, currentCaller, getTrustProfile } from '@/services';
import { redirect } from 'next/navigation';
import { signOutAction } from '@/services/actions';
import { MfaChallenge, MfaEnrolment } from '@/components/flows/MfaFlow';
import { AppHeader } from '@/components/kit/AppChrome';
import { Icon } from '@/components/kit/Icon';
import { ToastProvider } from '@/components/kit/Feedback';
import { accountHandle } from '@/lib/sandboxContract';
import {
  Callout,
  Card,
  Fact,
  Facts,
  FocusLayout,
  SectionHead,
  Shell,
  buttonClass,
} from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * Security.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  THE SECOND FACTOR IS REAL. IT IS THE ONLY THING HERE THAT IS.   │
 * │                                                                  │
 * │  Sign-in proves control of a mailbox and nothing more — no       │
 * │  password is asked for, chosen or stored — and the page still    │
 * │  says so, because a person must not mistake this account for     │
 * │  something that protects money.                                  │
 * │                                                                  │
 * │  What IS real is the authenticator factor below: a TOTP secret,  │
 * │  a confirmation, single-use recovery codes and a per-session     │
 * │  challenge, all enforced server-side since DEL-03. Operator      │
 * │  tools refuse a session that has not answered it.                │
 * │                                                                  │
 * │  ⚠ DEL-10: this screen previously offered a checkbox that        │
 * │  recorded a PREFERENCE and enrolled nothing, while `/app/ops`    │
 * │  told refused operators to "set up an authenticator app in       │
 * │  Security". The instruction pointed at a page that could not     │
 * │  carry it out. That dead end is what this replaces.              │
 * └──────────────────────────────────────────────────────────────────┘
 */
export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  /*
   * ONE authentication resolution, and it does not throw.
   *
   * ⚠ This page previously resolved the caller TWICE: `currentCaller()`
   * for the factor state, and `getChrome()` — which throws — for the
   * header. Every MFA action ends by revalidating this route, so the
   * post-commit RSC render re-ran the throwing resolver. When that
   * render could not resolve the session it produced an error payload,
   * and the client never received the result of an action that had
   * ALREADY COMMITTED: a confirmed enrolment looked like a failure, and
   * a one-time secret could be lost with it.
   *
   * `currentCaller()` returns null instead of throwing, and everything
   * below is derived from that single resolution.
   */
  const caller = await currentCaller();
  if (!caller) {
    // A genuine unauthenticated arrival: no Security or MFA content is
    // rendered at all, and the same-origin route is carried back.
    redirect(`/login?next=${encodeURIComponent('/app/settings/security')}`);
  }

  const user = caller.user;
  const profile = await getTrustProfile(user);
  // Takes the caller we already resolved; it never re-reads the session.
  const unread = await countUnread(user);
  const enrolled = caller.principal.mfaEnrolled;
  const satisfied = caller.principal.mfaSatisfied;

  return (
    <ToastProvider>
      <AppHeader
        title="Security"
        back={{ href: '/app/settings', label: 'Back to settings' }}
        unread={unread}
      />

      <Shell width="wide" className="py-5 sm:py-7">
        {/*
          The TASK is the second factor; everything else on this page is
          context for it. On a phone the task comes first because it is
          why anybody opens Security; from `lg` the session facts and the
          guarantees sit beside it instead of a thousand pixels below.
        */}
        <FocusLayout
          aside={
            <>
              <Card>
                <SectionHead title="This session" level={3} />
                <Facts className="mt-3">
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
                    bot&rsquo;s token, checked on our server. That part is a genuine control —
                    unlike the email sign-in, it cannot be typed in by hand.
                  </p>
                ) : null}
                <form action={signOutAction} className="mt-4">
                  <button type="submit" className={buttonClass('outline', 'md', true)}>
                    <Icon name="logout" className="h-4 w-4" />
                    Sign out
                  </button>
                </form>
              </Card>

              <Card>
                <SectionHead title="How INRP2P protects you" level={3} />
                <ul className="mt-3 space-y-3">
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

              <Callout tone="risk" icon="lock">
                <strong className="font-semibold">
                  INRP2P never asks for a PIN or a password.
                </strong>{' '}
                No screen in this product has a field for one. A message, call or page asking for
                your UPI PIN, card number or banking password is not from us, whatever it looks
                like.
              </Callout>
            </>
          }
        >
          <Callout tone="hold" icon="alert">
            <strong className="font-semibold">This sandbox authenticates nobody.</strong> Any email
            address signs in and no password is stored, checked or accepted anywhere. Never reuse a
            real credential here, and never treat this account as protecting anything.
          </Callout>

          <section className="mt-5">
            <SectionHead title="Authenticator app" />
            {/* Status in words, since SectionHead carries no hint slot. */}
            <p className="mt-1 text-[length:var(--text-xs)] text-[var(--color-ink-2)]">
              {enrolled
                ? satisfied
                  ? 'Enrolled · answered on this device'
                  : 'Enrolled · not yet answered on this device'
                : 'Not enrolled'}
            </p>
            <div className="mt-3">
              <MfaEnrolment enrolled={enrolled} />
            </div>

            {/*
             * The challenge appears only when there is a factor to answer
             * and this session has not answered it. Offering it otherwise
             * would be a box that does nothing.
             */}
            {enrolled && !satisfied ? (
              <div className="mt-3">
                <MfaChallenge next={next} />
              </div>
            ) : null}
          </section>
        </FocusLayout>
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
