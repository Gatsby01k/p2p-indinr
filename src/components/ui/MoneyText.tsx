import { cn } from '@/lib/cn';
import { formatMoney, moneyAriaLabel, type Money } from '@/lib/money';

type Emphasis = 'display' | 'strong' | 'body' | 'muted';

const EMPHASIS: Record<Emphasis, string> = {
  display: 'text-[28px] leading-tight font-semibold tracking-tight sm:text-[32px]',
  strong: 'text-[17px] font-semibold',
  body: 'text-[15px] font-medium',
  muted: 'text-sm text-[var(--color-muted)]',
};

/**
 * Renders an exact amount. Never rounds, never uses floats, always tabular so
 * columns of figures do not shift between renders.
 */
export function MoneyText({
  value,
  emphasis = 'body',
  showSymbol = true,
  className,
}: {
  value: Money;
  emphasis?: Emphasis;
  showSymbol?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn('tnum text-[var(--color-ink)]', EMPHASIS[emphasis], className)}
      aria-label={moneyAriaLabel(value)}
    >
      {formatMoney(value, { symbol: showSymbol })}
    </span>
  );
}
