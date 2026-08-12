'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState, useTransition } from 'react';
import { joinAction } from '@/services/actions';
import { useCommandId } from '@/lib/commandId';
import { FAILURE_COPY, type PreviewStatus, type Role, type Scenario } from '@/lib/sandboxContract';
import { SCENARIO } from '@/lib/scenario';
import { haptic } from '@/lib/telegramSdk';
import { TelegramMainButton } from '@/components/telegram/TelegramButtons';
import { Icon } from './Icon';
import { Notice, buttonClass } from './primitives';

/**
 * The Join affordance.
 *
 * ⚠ THE BUTTON IS NOT THE CONCURRENCY CONTROL. Disabling it saves a doomed
 * round trip and decides nothing. The single-winner guarantee is
 * PostgreSQL's — `SELECT ... FOR UPDATE`, a conditional state change and
 * `UNIQUE(deal.link_id)`. Two people tapping in the same instant both reach
 * the server; the database picks the winner and tells the loser plainly.
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
  scenario,
  amountLabel,
}: {
  publicId: string;
  joinable: boolean;
  status: PreviewStatus;
  signedIn: boolean;
  viewerWouldBe: Role;
  scenario: Scenario;
  amountLabel: string;
}) {
  const router = useRouter();
  const command = useCommandId();
  const [pending, startTransition] = useTransition();
  const [accepted, setAccepted] = useState(false);
  const [failure, setFailure] = useState<{ reason: string; nextStep: string } | null>(null);

  /*
   * One handler, shared by the in-page button and Telegram's MainButton, so
   * the two can never drift into doing subtly different things. Haptics are
   * a no-op outside Telegram.
   */
  const join = useCallback(() => {
    startTransition(async () => {
      setFailure(null);
      const result = await joinAction(command.next(), publicId);
      command.settleIfDefinitive(result);
      if (result.ok && result.dealId) {
        haptic('success');
        router.push(`/app/deal/${result.dealId}`);
        return;
      }
      haptic('error');
      const copy = result.code && result.code !== 'UNKNOWN' ? FAILURE_COPY[result.code] : null;
      setFailure(
        copy ?? {
          reason: result.message ?? 'That did not work.',
          nextStep: 'Refresh the page to see the current state of this link.',
        },
      );
      router.refresh();
    });
  }, [command, publicId, router]);

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
          <Icon name="lock" className="h-4 w-4" />
          Sign in to join
        </a>
        <p className="text-center text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
          You will come straight back here. Joining is first-come — if someone takes it moments
          before you, the server says so and nothing is charged.
        </p>
      </div>
    );
  }

  const seat = SCENARIO[scenario].roleAction[viewerWouldBe];

  return (
    <div className="space-y-3">
      {failure ? (
        <Notice
          tone="hold"
          title={failure.reason}
          reassurance="Nothing was charged to you."
          nextStep={failure.nextStep}
        />
      ) : null}

      {/*
        The confirmation is a real gate, not decoration: joining assigns a
        seat in a deal with a payment deadline attached, and the person
        should say once that they know what they are taking on.
      */}
      <label className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-paper)] p-3">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(e) => setAccepted(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-brand)]"
        />
        {/*
          The role is quoted, not lower-cased into the sentence. `INR` and
          `USDT` are acronyms — "I will pay the inr" reads as a typo, and a
          consent line that looks sloppy is a consent line people distrust.
        */}
        <span className="text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-2)]">
          I understand my side of this deal is to{' '}
          <strong className="font-semibold text-[var(--color-ink)]">{seat}</strong>, and that it is
          for a legitimate service or exchange.{' '}
          <a
            href="/app/help#terms"
            className="font-semibold text-[var(--color-brand)] underline underline-offset-2"
          >
            Protection terms
          </a>
        </span>
      </label>

      {/*
        Joining is the single most important tap in the product for someone
        arriving from a shared link, and inside Telegram it belongs on
        Telegram's own MainButton rather than halfway up a scrolling page.
        The in-page button stays for the browser and for assistive
        technology; the CSS only stops it occupying space.
      */}
      <TelegramMainButton
        text="Join protected deal"
        disabled={!accepted}
        loading={pending}
        onClick={join}
      />

      <button
        type="button"
        disabled={pending || !accepted}
        data-testid="join-button"
        data-mirrored-cta
        onClick={join}
        className={buttonClass('primary', 'lg', true)}
      >
        {pending ? (
          <>
            <Icon name="refresh" className="h-4 w-4 animate-spin" />
            Joining…
          </>
        ) : (
          <>
            <Icon name="shield" className="h-4 w-4" />
            Join protected deal
          </>
        )}
      </button>

      <p className="text-center text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
        Your side: <strong className="font-semibold text-[var(--color-ink-2)]">{seat}</strong> ·{' '}
        <strong className="tnum font-semibold text-[var(--color-ink-2)]">{amountLabel}</strong>.
        First come, decided by the server.
      </p>
    </div>
  );
}
