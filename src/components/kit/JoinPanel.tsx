'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { joinAction } from '@/server/sandbox/actions';
import { FAILURE_COPY, type PreviewStatus, type Role } from '@/lib/sandboxContract';
import { Notice, buttonClass } from './primitives';

/**
 * The Join affordance.
 *
 * ⚠ THE BUTTON IS NOT THE CONCURRENCY CONTROL. Disabling it saves a
 * doomed round trip and decides nothing. The single-winner guarantee is
 * PostgreSQL's — `SELECT ... FOR UPDATE`, a conditional state change and
 * `UNIQUE(deal.link_id)`. Two people clicking in the same instant both
 * reach the server; the database picks the winner.
 *
 * `joinable` is the server's verdict, so a consumed, expired or withdrawn
 * link structurally cannot present a live Join button.
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

  if (!joinable) {
    const copy =
      status === 'CONSUMED'
        ? FAILURE_COPY.LINK_CONSUMED
        : status === 'EXPIRED'
          ? FAILURE_COPY.LINK_EXPIRED
          : FAILURE_COPY.LINK_CLOSED;
    const title =
      status === 'CONSUMED'
        ? 'Someone joined first'
        : status === 'EXPIRED'
          ? 'This link expired'
          : 'This link was withdrawn';
    return (
      <div data-testid="join-unavailable">
        <Notice
          tone={status === 'EXPIRED' ? 'hold' : 'idle'}
          title={title}
          body={copy.reason}
          reassurance="Nothing was charged to you and no deal was created on your side."
          nextStep={copy.nextStep}
        />
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className="space-y-2.5">
        <a href={`/login?next=/d/${publicId}`} className={buttonClass('primary', 'lg', true)}>
          Sign in to join
        </a>
        <p className="text-center text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
          You will come straight back here. Joining is first-come — if someone takes it moments
          before you, the server says so and nothing is charged.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {failure ? (
        <Notice
          tone="hold"
          title={failure.reason}
          reassurance="Nothing was charged to you."
          nextStep={failure.nextStep}
        />
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
                nextStep: 'Refresh the page to see the current state of this link.',
              },
            );
            router.refresh();
          })
        }
        className={buttonClass('primary', 'lg', true)}
      >
        {pending ? 'Joining…' : 'Take the other side'}
      </button>

      <p className="text-center text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
        You would be the{' '}
        <strong className="font-semibold text-[var(--color-ink-2)]">
          {viewerWouldBe === 'FIAT_SIDE' ? 'INR sender' : 'USDT supplier'}
        </strong>
        . First come, decided by the server.
      </p>
    </div>
  );
}
