import { currentCaller, denialFor, getChrome, listVerificationQueue } from '@/services';
import { AppHeader } from '@/components/kit/AppChrome';
import { Icon, type IconName } from '@/components/kit/Icon';
import { Ago } from '@/components/kit/Time';
import { ToastProvider } from '@/components/kit/Feedback';
import { VerificationReview } from '@/components/flows/VerificationReview';
import { Card, EmptyState, Label, Notice, Shell, Status } from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * The verification review queue.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  THE SCREEN WITHOUT WHICH NOBODY COULD USE THIS PRODUCT.         │
 * │                                                                  │
 * │  Verification stopped being a boolean in DEL-03 and became a     │
 * │  CASE that a reviewer who is not the subject has to decide. The  │
 * │  decision function was written and tested; the queue that lets a │
 * │  reviewer reach it was not. So every case a person submitted     │
 * │  stayed SUBMITTED for ever, no account was ever verified, and    │
 * │  every attempt to join a protected deal was refused — the whole  │
 * │  product, for everybody.                                         │
 * │                                                                  │
 * │  Authorization is decided BEFORE the queue is read, exactly as   │
 * │  on the Deal Desk: a denied visitor's HTML never contains        │
 * │  anybody else's case.                                            │
 * │                                                                  │
 * │  ⚠ DISCLOSURE. A row names the subject and the local part of     │
 * │  their address, because a reviewer deciding "is this a real      │
 * │  person" cannot work with an opaque id. It carries no full email │
 * │  address, no bank handle and no wallet address.                  │
 * └──────────────────────────────────────────────────────────────────┘
 */

const KIND: Readonly<Record<string, { label: string; grants: string; icon: IconName }>> = {
  IDENTITY: {
    label: 'Identity',
    grants: 'Approving lets this account join protected deals.',
    icon: 'profile',
  },
  UPI: {
    label: 'Payment handle',
    grants: 'Approving lets this account receive rupees.',
    icon: 'wallet',
  },
  WALLET: {
    label: 'Wallet',
    grants: 'Approving lets this account take the crypto leg of an exchange.',
    icon: 'link',
  },
};

export default async function VerificationQueuePage() {
  const caller = await currentCaller();
  const denial = caller ? denialFor(caller.principal, 'verification.review') : 'NO_PERMISSION';

  if (denial !== null || !caller) {
    return (
      <Shell width="prose" className="py-10 sm:py-16">
        <div data-testid="access-denied">
          <p className="tnum text-[length:var(--text-5xl)] font-semibold tracking-[-0.04em] text-[var(--color-ink-4)]">
            403
          </p>
          <Notice
            className="mt-4"
            tone="risk"
            title={
              denial === 'MFA_REQUIRED' || denial === 'MFA_NOT_ENROLLED'
                ? 'Reviewing needs your second factor'
                : 'This area is restricted to reviewers'
            }
            body={
              !caller
                ? 'You are not signed in, so no case was loaded.'
                : denial === 'MFA_NOT_ENROLLED'
                  ? 'Reviewing requires an authenticator app. Nothing was loaded.'
                  : denial === 'MFA_REQUIRED'
                    ? 'Your account may review verifications, but this device has not answered your second factor. Nothing was loaded.'
                    : 'Your account does not have the reviewer permission, so no case was loaded.'
            }
            reassurance="No case data was sent to this page, and nobody's verification was affected."
            nextStep={
              !caller
                ? 'Sign in with an account that has been granted reviewer access.'
                : denial === 'NO_PERMISSION'
                  ? 'Reviewer access is granted out of band — ask an administrator. It cannot be self-assigned.'
                  : 'Answer your authenticator in Security, then reopen this queue.'
            }
            action={
              !caller
                ? { href: '/login?next=/app/ops/verification', label: 'Sign in' }
                : denial === 'NO_PERMISSION'
                  ? { href: '/app', label: 'Back to your deals' }
                  : {
                      href: '/app/settings/security?next=%2Fapp%2Fops%2Fverification',
                      label: 'Go to Security',
                    }
            }
          />
        </div>
      </Shell>
    );
  }

  const [{ unread }, queue] = await Promise.all([
    getChrome(),
    listVerificationQueue(caller.principal),
  ]);
  // The permission was already checked above; a rejection here would mean
  // the two disagreed, which is worth saying rather than rendering empty.
  const rows = queue.ok ? queue.value : [];

  return (
    <ToastProvider>
      <AppHeader
        title="Verification review"
        subtitle="Cases waiting on a reviewer. Nothing here decides itself."
        back={{ href: '/app/ops', label: 'Back to the Deal Desk' }}
        unread={unread}
      />

      <Shell width="ops" className="py-5 sm:py-7">
        <p className="max-w-[76ch] text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
          Approving a case is what lets an account take part in a deal, so each decision carries a
          written reason and is recorded against the case for good. You cannot decide a case about
          yourself.
        </p>

        {rows.length === 0 ? (
          <EmptyState
            className="mt-5"
            icon="check-circle"
            title="Nothing waiting"
            body="Every submitted verification has been decided."
            action={{ href: '/app/ops', label: 'Back to the Deal Desk' }}
          />
        ) : (
          <ul className="mt-5 grid gap-3 lg:grid-cols-2" data-testid="verification-queue">
            {rows.map((row) => {
              const kind = KIND[row.kind] ?? {
                label: row.kind,
                grants: '',
                icon: 'shield' as IconName,
              };
              return (
                <li key={row.caseId}>
                  <Card>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--color-sunken)] text-[var(--color-ink-3)]">
                          <Icon name={kind.icon} className="h-[18px] w-[18px]" />
                        </span>
                        <div className="min-w-0">
                          <Label>{kind.label}</Label>
                          <h2 className="mt-0.5 truncate text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                            {row.subjectName}
                          </h2>
                          <p className="mt-0.5 truncate text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
                            {row.subjectHandle} · submitted <Ago iso={row.submittedAt} />
                          </p>
                        </div>
                      </div>
                      <Status tone="hold" size="sm">
                        {row.state === 'UNDER_REVIEW' ? 'Under review' : 'Submitted'}
                      </Status>
                    </div>

                    <p className="mt-3 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                      {kind.grants}
                    </p>

                    <VerificationReview
                      caseId={row.caseId}
                      subjectName={row.subjectName}
                      kind={kind.label}
                      isOwnCase={row.isOwnCase}
                    />
                  </Card>
                </li>
              );
            })}
          </ul>
        )}

        <p className="mt-5 max-w-[76ch] text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
          This is a sandbox: no document was read, no bank was contacted and no provider was called.
          A real deployment attaches evidence and a provider decision to each case and keeps this
          same shape — one reviewer, not the subject, with a reason on the record.
        </p>
      </Shell>
    </ToastProvider>
  );
}
