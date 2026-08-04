import Link from 'next/link';
import { cn } from '@/lib/cn';
import type { PreviewStatus } from '@/lib/sandboxContract';

/**
 * Sandbox chrome and status primitives.
 *
 * The status components here take a SINGLE server-computed value. That is the
 * structural fix for the "Open and Expired at the same time" contradiction:
 * there is one field, it has one value, and no component may compose two
 * independent badges from separate booleans.
 */

/** Persistent, unmissable statement that nothing here is real money. */
export function SandboxBanner() {
  return (
    <div
      role="note"
      className="border-b border-amber-500/30 bg-amber-50 px-4 py-2 text-center text-xs font-medium leading-relaxed text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <strong className="font-semibold">Sandbox.</strong> No real funds are held or moved. No bank
      transfer, blockchain transaction or custody takes place. Every amount, counterparty and
      reference on this site is test data.
    </div>
  );
}

/** Inline variant for placing next to a specific figure or action. */
export function SandboxNote({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        'rounded-md border border-amber-500/30 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900',
        className,
      )}
    >
      Sandbox — nothing is settled and no money moves. Do not send a real bank transfer.
    </p>
  );
}

const STATUS_STYLE: Readonly<Record<PreviewStatus, { label: string; className: string }>> = {
  OPEN: { label: 'Open', className: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20' },
  EXPIRED: { label: 'Expired', className: 'bg-amber-50 text-amber-900 ring-amber-600/20' },
  CONSUMED: { label: 'Already taken', className: 'bg-slate-100 text-slate-700 ring-slate-500/20' },
  CLOSED: { label: 'Withdrawn', className: 'bg-slate-100 text-slate-700 ring-slate-500/20' },
};

/**
 * The link's status. Exactly one badge, from exactly one value.
 *
 * Rendering two of these, or pairing one with a separate "expired" flag, is
 * the defect this component exists to prevent.
 */
export function LinkStatusBadge({ status }: { status: PreviewStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      data-testid="link-status"
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
        s.className,
      )}
    >
      {s.label}
    </span>
  );
}

/**
 * A blocked state that says the reason AND the next step.
 *
 * "Something is wrong" is not an acceptable message: it tells a customer
 * nothing about whether they lost money, whether to wait, or what to do. Every
 * blocked screen here names the cause and the one action available.
 */
export function BlockedState({
  title,
  reason,
  nextStep,
  action,
}: {
  title: string;
  reason: string;
  nextStep: string;
  action?: { href: string; label: string };
}) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
      data-testid="blocked-state"
    >
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-slate-700">{reason}</p>
      <div className="mt-4 rounded-lg bg-slate-50 p-3">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          What to do next
        </p>
        <p className="mt-1 text-sm leading-relaxed text-slate-800">{nextStep}</p>
      </div>
      {action ? (
        <Link
          href={action.href}
          className="mt-5 inline-flex h-10 items-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Operator access denial.
 *
 * Rendered INSTEAD OF the operator page, never inside it. The queue is not
 * fetched, not rendered and not present in the HTML for a non-operator — the
 * server refuses before any row is read.
 */
export function AccessDenied({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-16" data-testid="access-denied">
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <p className="text-5xl font-semibold tracking-tight text-slate-300">403</p>
        <h1 className="mt-3 text-xl font-semibold text-slate-900">
          This area is restricted to operators
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          {signedIn
            ? 'Your account does not have operator permissions, so the queue was not loaded.'
            : 'You are not signed in, so the queue was not loaded.'}
        </p>
        <div className="mt-4 rounded-lg bg-slate-50 p-3 text-left">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            What to do next
          </p>
          <p className="mt-1 text-sm leading-relaxed text-slate-800">
            {signedIn
              ? 'If you should have operator access, ask an administrator to grant it. Otherwise return to your deals.'
              : 'Sign in with an operator account. In this sandbox, any address starting with ops@ is an operator.'}
          </p>
        </div>
        <Link
          href={signedIn ? '/app' : '/login?next=/app/ops'}
          className="mt-5 inline-flex h-10 items-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800"
        >
          {signedIn ? 'Back to your deals' : 'Sign in'}
        </Link>
      </div>
    </div>
  );
}
