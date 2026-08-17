import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { ChannelGlyph } from './Glyphs';

/**
 * The one place Telegram blue is allowed.
 *
 * Everywhere else on this page the action colour is INRP2P vermilion. This
 * control is the exception because it is not an INRP2P action at all — it
 * hands the person to Telegram — and colouring it in the brand's own orange
 * would claim the destination is ours.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHEN NO MINI APP IS CONFIGURED, THIS GOES NOWHERE — ON PURPOSE.   │
 * │                                                                    │
 * │  It used to fall back to `/login`. That is a control labelled      │
 * │  `Open Telegram` quietly delivering somebody to a sign-in form,    │
 * │  and LANDING-04 rules it out in as many words: do not invent a     │
 * │  URL, and do not silently redirect the Telegram CTA somewhere      │
 * │  unrelated. So without `NEXT_PUBLIC_TELEGRAM_MINI_APP` the control │
 * │  renders as what it is — present, visibly inactive, `aria-disabled`│
 * │  and still reachable by keyboard, carrying the reason in its       │
 * │  accessible name and its tooltip.                                  │
 * │                                                                    │
 * │  It stays FOCUSABLE rather than taking the `disabled` attribute:   │
 * │  a control that vanishes from the tab order cannot tell anybody    │
 * │  why it is unavailable, and the reason is the whole point.         │
 * │                                                                    │
 * │  Set the address and every one of these becomes an ordinary link,  │
 * │  with no other change anywhere.                                    │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * The address itself comes from `@/lib/miniApp`, which is the single typed
 * place it is parsed and validated. Nothing here guesses a bot username,
 * and the bot TOKEN never leaves the server.
 */
export function TelegramAction({
  miniAppUrl,
  children,
  className,
  variant = 'solid',
}: {
  miniAppUrl: string | null;
  children: ReactNode;
  className?: string;
  /** `solid` is the blue button; `outline` and `onBrand` are its two hosts. */
  variant?: 'solid' | 'outline' | 'onBrand';
}) {
  const available = miniAppUrl !== null;

  const shape = cn(
    'press inline-flex shrink-0 items-center justify-center gap-2 rounded-[var(--radius-md)] font-semibold whitespace-nowrap',
    variant === 'solid'
      ? 'bg-[var(--tg)] text-white shadow-[0_1px_2px_rgb(21,111,163,0.18),0_6px_16px_-6px_rgb(21,111,163,0.38)]'
      : variant === 'onBrand'
        ? 'bg-[var(--tg)] text-white shadow-[0_1px_2px_rgb(12,52,78,0.24)]'
        : 'border border-[var(--color-rule)] bg-[var(--color-paper)] text-[var(--color-ink)]',
    available &&
      (variant === 'outline'
        ? 'hover:border-[var(--color-edge)] hover:bg-[var(--color-sunken)]'
        : 'hover:bg-[var(--tg-hover)] active:bg-[var(--tg-press)]'),
    !available && 'cursor-not-allowed opacity-55',
    className,
  );

  const glyph = (
    <ChannelGlyph
      channel="telegram"
      className={cn('h-[1.15em] w-[1.15em]', variant === 'outline' && 'text-[var(--tg)]')}
    />
  );

  if (available) {
    return (
      <a href={miniAppUrl} target="_blank" rel="noopener noreferrer" className={shape}>
        {glyph}
        {children}
      </a>
    );
  }

  return (
    <button
      type="button"
      aria-disabled="true"
      title="Telegram is not connected on this deployment yet. Every deal also opens on the web."
      className={shape}
    >
      {glyph}
      {children}
      <span className="sr-only">
        {' '}
        — unavailable: Telegram is not connected on this deployment yet. Every deal also opens on
        the web.
      </span>
    </button>
  );
}
