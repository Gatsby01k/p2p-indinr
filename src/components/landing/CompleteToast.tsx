import { cn } from '@/lib/cn';
import { Icon } from '@/components/kit/Icon';

/**
 * The end of the sequence, one line long.
 *
 * ⚠ A DEMONSTRATION, and the close control is a `<span>` rather than a
 * button for exactly that reason: a dismissible-looking notification on a
 * marketing page that cannot be dismissed is a broken promise, and one
 * that CAN be dismissed leaves a hole in a fixed composition.
 *
 * The mint tick is the only success colour on the page, and it is the same
 * `--color-final` the product uses for a completed deal.
 */
export function CompleteToast({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-paper)] px-3 py-3 shadow-[var(--shadow-lift)]',
        className,
      )}
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--color-final-tint)] text-[var(--color-final)]">
        <Icon name="check-circle" className="h-[18px] w-[18px]" strokeWidth={2} />
      </span>
      <p className="min-w-0 flex-1 text-[12px] font-semibold tracking-[-0.015em] text-[var(--color-ink)] lg:whitespace-nowrap">
        Deal complete <span className="text-[var(--color-ink-4)]">·</span> Fee dropped to 0.8%{' '}
        <span className="text-[var(--color-ink-4)]">·</span>{' '}
        <span className="text-[var(--color-final)]">+12 Trust</span>
      </p>
      <Icon name="close" className="h-4 w-4 shrink-0 text-[var(--color-ink-4)]" strokeWidth={2} />
    </div>
  );
}
