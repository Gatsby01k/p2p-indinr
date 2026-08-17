import { getChrome } from '@/services';
import { getTrustProfile } from '@/services';
import { listVerificationCases, type VerificationKind } from '@/services';
import { verifyStepAction } from '@/services/actions';
import { formatMinor } from '@/lib/format';
import { MAX_INR_MINOR } from '@/services';
import { AppHeader } from '@/components/kit/AppChrome';
import { Icon, type IconName } from '@/components/kit/Icon';
import { Ago } from '@/components/kit/Time';
import { ToastProvider } from '@/components/kit/Feedback';
import { ActionButton } from '@/components/flows/ActionButton';
import {
  Callout,
  Card,
  FocusLayout,
  Meter,
  SandboxLine,
  Shell,
  Status,
} from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * Verification.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  ⚠ THIS VERIFIES NOTHING IN THE REAL WORLD.                      │
 * │                                                                  │
 * │  No document is read, no bank is contacted and no identity is    │
 * │  checked. Completing a step records that a person walked through │
 * │  it, so the journey exists end to end. The page says this        │
 * │  plainly, at the top, rather than letting a green tick imply     │
 * │  something the system did not do.                                │
 * │                                                                  │
 * │  A real deployment replaces each step with an actual provider    │
 * │  and keeps the same shape: one server action per step, points    │
 * │  awarded once, limits derived from the result.                   │
 * └──────────────────────────────────────────────────────────────────┘
 */
export default async function VerificationPage() {
  const { user, unread } = await getChrome();
  const profile = await getTrustProfile(user);
  /*
   * ⚠ THE PAGE USED TO SHOW ONLY THE BOOLEAN, AND THAT WAS A LIE OF
   * OMISSION.
   *
   * Since DEL-03 a step does not complete when you press the button: it
   * opens a CASE that a reviewer who is not you has to decide. A person
   * who pressed the button saw a screen identical to the one before
   * they pressed it — same "Complete this step", same 0 of 3 — so the
   * only sensible reading was that nothing had happened, and they
   * pressed it again. The case state is now shown, because "waiting on
   * a reviewer" is the true answer and it is not the same as "not
   * started".
   */
  const cases = await listVerificationCases(user.userId);
  const openFor = (kind: VerificationKind) =>
    cases.find((c) => c.kind === kind && (c.state === 'SUBMITTED' || c.state === 'UNDER_REVIEW')) ??
    null;
  const rejectedFor = (kind: VerificationKind) =>
    cases.find((c) => c.kind === kind && c.state === 'REJECTED') ?? null;

  const steps: readonly {
    key: 'identity' | 'upi' | 'wallet';
    kind: VerificationKind;
    title: string;
    body: string;
    unlocks: string;
    icon: IconName;
    done: boolean;
  }[] = [
    {
      key: 'identity',
      kind: 'IDENTITY',
      title: 'Identity',
      body: 'Confirms who you are, so a counterparty knows they are dealing with a real person.',
      unlocks: 'Required to join any protected deal',
      icon: 'profile',
      done: profile.identityVerified,
    },
    {
      key: 'upi',
      kind: 'UPI',
      title: 'Payment handle',
      body: 'Confirms a UPI ID or bank account you control, so payments reach you and not someone else.',
      unlocks: 'Required to receive rupees',
      icon: 'wallet',
      done: profile.upiVerified,
    },
    {
      key: 'wallet',
      kind: 'WALLET',
      title: 'Wallet',
      body: 'Confirms a TRC-20 address you control, for the crypto leg of an exchange.',
      unlocks: 'Required for INR ⇄ USDT deals',
      icon: 'link',
      done: profile.walletVerified,
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;

  return (
    <ToastProvider>
      <AppHeader
        title="Verification"
        subtitle={`${doneCount} of ${steps.length} steps complete`}
        back={{ href: '/app/profile', label: 'Back to profile' }}
        unread={unread}
      />

      <Shell width="wide" className="py-5 sm:py-7">
        {/*
          The STEPS are the task; the progress meter, the caveat and the
          sandbox line are context about them. Side by side from `lg`
          instead of a 27.5rem ribbon down the middle of a laptop.
        */}
        <FocusLayout
          aside={
            <>
              <Card>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                    Verification progress
                  </span>
                  <span className="tnum text-[length:var(--text-sm)] text-[var(--color-ink-3)]">
                    {doneCount}/{steps.length}
                  </span>
                </div>
                <Meter
                  className="mt-3"
                  percent={(doneCount / steps.length) * 100}
                  tone={doneCount === steps.length ? 'final' : 'brand'}
                  label="Verification progress"
                />
                <p className="mt-3 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                  Each completed step adds 100 SafePoints and raises what you can transact. The
                  current ceiling is ₹{formatMinor(MAX_INR_MINOR.toString(), 'INR')} per deal.
                </p>
              </Card>

              <Callout tone="hold" icon="alert">
                <strong className="font-semibold">Nothing here checks a real identity.</strong> This
                is a sandbox: no document is read, no bank is contacted and no provider is called.
                Completing a step records that you walked through it, so the rest of the product
                works.
              </Callout>

              <SandboxLine full />
            </>
          }
        >
          <ul className="space-y-3">
            {steps.map((step) => {
              const open = step.done ? null : openFor(step.kind);
              const rejected = step.done || open ? null : rejectedFor(step.kind);
              return (
                <li key={step.key}>
                  <Card>
                    <div className="flex items-start gap-3">
                      <span
                        className={
                          step.done
                            ? 'grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--color-final-tint)] text-[var(--color-final)]'
                            : 'grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--color-sunken)] text-[var(--color-ink-3)]'
                        }
                      >
                        <Icon
                          name={step.done ? 'check' : step.icon}
                          className="h-[18px] w-[18px]"
                          strokeWidth={step.done ? 2.6 : 1.7}
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                            {step.title}
                          </h2>
                          {step.done ? (
                            <Status tone="final" size="sm">
                              Verified
                            </Status>
                          ) : open ? (
                            <Status tone="hold" size="sm">
                              In review
                            </Status>
                          ) : rejected ? (
                            <Status tone="risk" size="sm">
                              Not approved
                            </Status>
                          ) : null}
                        </div>
                        <p className="mt-1 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
                          {step.body}
                        </p>
                        <p className="mt-1.5 text-[length:var(--text-2xs)] font-medium text-[var(--color-ink-4)]">
                          {step.unlocks}
                        </p>

                        {/*
                      Three states, three different things to say. Offering
                      "Complete this step" again while a case is open is the
                      button that made people press it repeatedly and get
                      nowhere: a second submission joins the first, by
                      design, so pressing it changes nothing at all.
                    */}
                        {step.done ? null : open ? (
                          <p
                            className="mt-3 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]"
                            data-testid={`verification-pending-${step.key}`}
                          >
                            Submitted <Ago iso={open.submittedAt} /> and waiting on a reviewer.
                            Nobody can approve their own verification, so this is decided by someone
                            else. Pressing submit again would join the same case.
                          </p>
                        ) : (
                          <div className="mt-3">
                            {rejected ? (
                              <p className="mb-2 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
                                A reviewer did not approve the last submission. You can submit
                                again.
                              </p>
                            ) : null}
                            <ActionButton
                              action={verifyStepAction.bind(null, step.key)}
                              success={`${step.title} submitted for review`}
                              icon="shield-check"
                              variant="primary"
                              size="md"
                            >
                              {rejected ? 'Submit again' : 'Submit this step'}
                            </ActionButton>
                          </div>
                        )}
                      </div>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        </FocusLayout>
      </Shell>
    </ToastProvider>
  );
}
