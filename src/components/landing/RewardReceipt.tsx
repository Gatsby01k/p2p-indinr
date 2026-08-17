import { cn } from '@/lib/cn';
import { AssetMark, Icon } from '@/components/kit/Icon';
import { RECEIPT } from './rewardsDemo';

/**
 * What a finished deal leaves behind.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A RECEIPT, NOT A PRIZE.                                           │
 * │                                                                    │
 * │  The brief for this component was mostly a list of things it must  │
 * │  not be — no wheel, no chest, no jackpot, no confetti. The         │
 * │  positive form of that rule is simpler: it should look like the    │
 * │  document a bank gives you after a transfer, and the reward should │
 * │  look like a line on that document. So the figures are tabular,    │
 * │  the ticks are the product's mint, the benefit sits in a bordered  │
 * │  row rather than a burst, and nothing moves.                       │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ⚠ A DEMONSTRATION. It reads no account and issues no benefit — the
 * public page has no session and `rewardsDemo.ts` has no server import.
 * `View receipt` is an inert `<span>`: a real receipt belongs to a real
 * deal and is reached from inside the product. The figure is
 * `aria-hidden` and the section states it in words.
 */
export function RewardReceipt({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'flex flex-col rounded-[var(--radius-xl)] border border-[var(--color-line)] bg-[var(--color-paper)] p-5 shadow-[var(--shadow-card)]',
        className,
      )}
    >
      {/* ---- What happened ------------------------------------- */}
      <div className="flex items-start justify-between gap-3">
        <span className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--color-final)] text-white">
            <Icon name="check" className="h-4 w-4" strokeWidth={3.2} />
          </span>
          <span className="text-[length:var(--text-lg)] font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
            {RECEIPT.status}
          </span>
        </span>
        {/* The one ornament, and it is 14px of hairline. */}
        <Icon name="sparkle" className="h-4 w-4 shrink-0 text-[var(--color-ink-5)]" />
      </div>

      {/* ---- What it settled ----------------------------------- */}
      <ul className="mt-4 space-y-3">
        {RECEIPT.lines.map((line) => (
          <li key={line.id} className="flex items-center gap-2.5">
            {line.kind === 'usdt' ? (
              <AssetMark asset="USDT" size="sm" />
            ) : line.kind === 'inr' ? (
              <AssetMark asset="INR" size="sm" />
            ) : (
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[var(--color-ink-3)]">
                <Icon name="shield-check" className="h-[18px] w-[18px]" strokeWidth={1.8} />
              </span>
            )}
            <span className="min-w-0 text-[length:var(--text-md)]">
              <span className="tnum font-semibold text-[var(--color-ink)]">{line.value}</span>
              {line.note ? <span className="text-[var(--color-ink-3)]"> {line.note}</span> : null}
            </span>
          </li>
        ))}
      </ul>

      {/* ---- What it earned ------------------------------------ */}
      <div className="mt-5 space-y-2 border-t border-[var(--color-line)] pt-5">
        <p className="flex items-center gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-brand-line)] bg-[var(--color-brand-tint)] px-3 py-2.5">
          <Icon
            name="tag"
            className="h-[18px] w-[18px] shrink-0 text-[var(--color-brand)]"
            strokeWidth={1.8}
          />
          <span className="min-w-0 text-[length:var(--text-md)]">
            <span className="font-semibold text-[var(--color-brand-ink)]">
              {RECEIPT.reward.headline}
            </span>
            <span className="text-[var(--color-ink-2)]"> {RECEIPT.reward.tail}</span>
          </span>
        </p>
        <p className="flex items-center gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-paper)] px-3 py-2.5">
          <Icon
            name="star"
            className="h-[18px] w-[18px] shrink-0 text-[var(--color-ink-3)]"
            strokeWidth={1.8}
          />
          <span className="text-[length:var(--text-md)] text-[var(--color-ink)]">
            {RECEIPT.perk}
          </span>
        </p>
      </div>

      <span className="mt-4 flex h-11 items-center justify-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-brand)] text-[length:var(--text-base)] font-semibold text-white shadow-[var(--shadow-brand)]">
        {RECEIPT.action}
        <Icon name="chevron-right" className="h-4 w-4" strokeWidth={2.2} />
      </span>
    </div>
  );
}
