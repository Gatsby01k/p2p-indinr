'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { joinAction } from '@/server/sandbox/actions';
import { FAILURE_COPY, type PreviewStatus, type Role } from '@/lib/sandboxContract';

/**
 * The Join affordance.
 *
 * ⚠ THE BUTTON IS NOT THE CONCURRENCY CONTROL. Disabling it is a courtesy that
 * saves a doomed round trip; it decides nothing. The single-winner guarantee is
 * enforced by PostgreSQL inside `joinDealLink` — `SELECT ... FOR UPDATE`, a
 * conditional state change, and `UNIQUE(deal.link_id)`. Two people who click at
 * the same instant both reach the server, and the database picks the winner.
 *
 * `joinable` comes from the server, so a consumed or expired link can never
 * present an active Join button.
 */
export function JoinPanel({
  publicId,
  joinable,
  status,
  signedIn,
  viewerWouldBe,
}: {
  publicId: string;
  joinable: boolean;
  status: PreviewStatus;
  signedIn: boolean;
  viewerWouldBe: Role;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<{ reason: string; nextStep: string } | null>(null);

  // Not joinable: state the reason and the next step. Never a live button.
  if (!joinable) {
    const copy =
      status === 'CONSUMED'
        ? FAILURE_COPY.LINK_CONSUMED
        : status === 'EXPIRED'
          ? FAILURE_COPY.LINK_EXPIRED
          : FAILURE_COPY.LINK_CLOSED;
    return (
      <div data-testid="join-unavailable">
        <p className="text-sm font-semibold text-slate-900">{copy.reason}</p>
        <p className="mt-1 text-sm leading-relaxed text-slate-600">{copy.nextStep}</p>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className="space-y-3">
        <a
          href={`/login?next=/d/${publicId}`}
          className="flex h-11 w-full items-center justify-center rounded-lg bg-slate-900 text-sm font-medium text-white hover:bg-slate-800"
        >
          Sign in to join
        </a>
        <p className="text-center text-xs leading-relaxed text-slate-500">
          You will come straight back here. Joining is first-come — if someone joins moments before
          you, the server will say so and nothing will be charged.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {failure ? (
        <div
          role="alert"
          className="rounded-lg border border-amber-500/30 bg-amber-50 px-3 py-2.5"
          data-testid="join-failure"
        >
          <p className="text-sm font-semibold text-amber-900">{failure.reason}</p>
          <p className="mt-1 text-sm leading-relaxed text-amber-900">{failure.nextStep}</p>
        </div>
      ) : null}

      <button
        type="button"
        disabled={pending}
        data-testid="join-button"
        onClick={() =>
          startTransition(async () => {
            setFailure(null);
            const result = await joinAction(publicId);
            if (result.ok && result.dealId) {
              router.push(`/app/deal/${result.dealId}`);
              return;
            }
            const copy =
              result.code && result.code !== 'UNKNOWN' ? FAILURE_COPY[result.code] : null;
            setFailure(
              copy ?? {
                reason: result.message ?? 'That did not work.',
                nextStep: 'Try again in a moment, or ask the sender for a fresh link.',
              },
            );
            router.refresh();
          })
        }
        className="flex h-11 w-full items-center justify-center rounded-lg bg-slate-900 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {pending ? 'Joining…' : 'Join this deal'}
      </button>

      <p className="text-center text-xs leading-relaxed text-slate-500">
        You would be the{' '}
        <strong className="font-medium text-slate-700">
          {viewerWouldBe === 'FIAT_SIDE' ? 'INR sender' : 'USDT supplier'}
        </strong>
        . Joining is first-come and decided by the server, not by this button.
      </p>
    </div>
  );
}
