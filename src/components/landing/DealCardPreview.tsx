import { cn } from '@/lib/cn';
import { Mark } from '@/components/kit/Brand';
import { Icon } from '@/components/kit/Icon';
import { CHANNELS, ChannelDisc } from './Glyphs';
import { DEMO_DEAL_CODE, type CapabilityDemo } from './demo';

/**
 * The thing that actually travels: one card, pasted into one chat.
 *
 * ⚠ A DEMONSTRATION, NOT A CONTROL. `Join Deal` is rendered as an inert
 * `<span>`, not a button or a link. Joining is an atomic server-side
 * transaction against a real deal and there is no real deal here — a
 * button that looks live and does nothing is worse than no button, and a
 * button that DID something would be a second create-deal path. The whole
 * figure is `aria-hidden`; the surrounding stage states the same thing in
 * words for anyone not looking at it.
 */
export function DealCardPreview({
  capability,
  className,
}: {
  capability: CapabilityDemo;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-paper)] shadow-[var(--shadow-lift)]',
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-3.5 py-3">
        <Mark className="h-6 w-6 text-[var(--color-brand)]" />
        <span className="flex min-w-0 flex-col leading-none">
          <span className="text-[12.5px] font-semibold text-[var(--color-ink)]">INRP2P Deal</span>
          <span className="mt-1 text-[10.5px] font-medium text-[var(--color-ink-4)]">
            DealSafe India
          </span>
        </span>
      </div>

      <div className="px-3.5 pb-3.5 pt-3">
        <p
          key={capability.cardLine}
          className="tnum animate-value text-[14.5px] font-semibold tracking-[-0.02em] text-[var(--color-ink)]"
        >
          {capability.cardLine}
        </p>

        <ul className="mt-2.5 space-y-1.5">
          <li className="flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--color-ink-3)]">
            <Icon name="lock" className="h-3.5 w-3.5 text-[var(--color-ink-4)]" strokeWidth={1.9} />
            Terms locked
          </li>
          <li className="flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--color-ink-3)]">
            <Icon
              name="profile"
              className="h-3.5 w-3.5 text-[var(--color-ink-4)]"
              strokeWidth={1.9}
            />
            1 counterparty
          </li>
        </ul>

        <span className="mt-3 flex h-9 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-brand)] text-[12.5px] font-semibold text-white shadow-[var(--shadow-brand)]">
          Join Deal
        </span>

        {/*
          The gap and right padding are 4px, not 6px: the URL needs
          129.4px and this row was giving it 129.3, so the card showed
          `inrp2p.link/deal/AB12…` — a truncated link, in the one
          component whose entire subject is a link you can read.
        */}
        <span className="mt-2.5 flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-[var(--color-sunken)] py-2 pl-2 pr-1">
          <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] tracking-[-0.01em] text-[var(--color-ink-3)]">
            inrp2p.link/deal/{DEMO_DEAL_CODE}
          </span>
          <Icon name="copy" className="h-3 w-3 shrink-0 text-[var(--color-ink-4)]" />
        </span>
      </div>
    </div>
  );
}

/** The chats the card above is pasted into. Four discs, no labels. */
export function ChannelRow({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-2.5', className)}>
      {CHANNELS.filter((c) => c.key !== 'code').map((channel) => (
        <ChannelDisc
          key={channel.key}
          channel={channel}
          className="h-9 w-9 shadow-[var(--shadow-card)]"
          glyphClassName="h-[18px] w-[18px]"
        />
      ))}
    </div>
  );
}
