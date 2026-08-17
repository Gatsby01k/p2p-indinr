import type { ReactNode } from 'react';
import Link from 'next/link';
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
 * │  WHAT HAPPENS WHEN NO MINI APP IS CONFIGURED.                      │
 * │                                                                    │
 * │  `NEXT_PUBLIC_TELEGRAM_MINI_APP` is a per-deployment setting, and  │
 * │  a deployment without it has no Telegram address to send anyone    │
 * │  to. The control still renders — the page is a fixed composition   │
 * │  and a hole in it is not an improvement — but it leads to the web  │
 * │  entrance of the same product, and its ACCESSIBLE NAME says so.    │
 * │  A visible label that promises Telegram and a link that quietly    │
 * │  goes somewhere else is the thing being avoided here; a link that  │
 * │  goes somewhere real and explains itself is not.                   │
 * └────────────────────────────────────────────────────────────────────┘
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
  /** `solid` is the header's blue button; `outline` is the hero's secondary. */
  variant?: 'solid' | 'outline';
}) {
  const shape = cn(
    'press inline-flex shrink-0 items-center justify-center gap-2 rounded-[var(--radius-md)] font-semibold whitespace-nowrap',
    variant === 'solid'
      ? 'bg-[var(--tg)] text-white shadow-[0_1px_2px_rgb(21,111,163,0.18),0_6px_16px_-6px_rgb(21,111,163,0.38)] hover:bg-[var(--tg-hover)] active:bg-[var(--tg-press)]'
      : 'border border-[var(--color-rule)] bg-[var(--color-paper)] text-[var(--color-ink)] hover:border-[var(--color-edge)] hover:bg-[var(--color-sunken)]',
    className,
  );

  const glyph = (
    <ChannelGlyph
      channel="telegram"
      className={cn('h-[1.15em] w-[1.15em]', variant === 'outline' && 'text-[var(--tg)]')}
    />
  );

  if (miniAppUrl) {
    return (
      <a href={miniAppUrl} target="_blank" rel="noopener noreferrer" className={shape}>
        {glyph}
        {children}
      </a>
    );
  }

  return (
    <Link
      href="/login?next=%2Fapp"
      prefetch={false}
      className={shape}
      title="This deployment has no Telegram Mini App configured, so this opens INRP2P on the web."
    >
      {glyph}
      {children}
      <span className="sr-only">
        {' '}
        — opens INRP2P on the web, because this deployment has no Telegram Mini App configured
      </span>
    </Link>
  );
}
