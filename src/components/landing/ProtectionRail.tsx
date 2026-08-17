import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/kit/Icon';
import { LandingShell } from './LandingShell';

/**
 * Every state a deal can be in, and what protects it there.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  NOT A PROGRESS BAR.                                               │
 * │                                                                    │
 * │  A filled stepper claims a position — "you are here, three of five │
 * │  done" — and this rail is not about anybody's deal. It is the      │
 * │  vocabulary: five named states, each with the thing that holds     │
 * │  true while a deal sits in it. So every mark is drawn the same     │
 * │  weight, the runs between them are dashed rather than filled, and  │
 * │  nothing is coloured to look "reached". `Paid` carries the mint    │
 * │  only because verification is mint everywhere in this product.     │
 * │                                                                    │
 * │  Below `lg` it becomes what it always was underneath — a vertical  │
 * │  list — instead of five columns squeezed to 70px each.             │
 * └────────────────────────────────────────────────────────────────────┘
 */
export function ProtectionRail() {
  return (
    <section className="border-t border-[var(--color-line)] bg-[var(--color-paper)]">
      <LandingShell className="py-12 sm:py-16 lg:py-20">
        <h2 className="text-[length:var(--text-2xs)] font-bold uppercase tracking-[0.14em] text-[var(--color-brand)] lg:text-center">
          Protection at every state
        </h2>

        <ol className="mt-8 grid gap-0 lg:mt-10 lg:grid-cols-5 lg:gap-0">
          {STATES.map((state, i) => (
            <li
              key={state.label}
              className={cn(
                'relative flex items-center gap-4 py-4',
                /* Vertical run on a phone, horizontal run from `lg`. */
                'lg:flex-col lg:items-start lg:gap-0 lg:py-0 lg:pr-8',
              )}
            >
              {/* The dashed run to the PREVIOUS state. Owned by the
                  later of the two, so it never escapes the last item. */}
              {i > 0 ? (
                <span
                  aria-hidden
                  className={cn(
                    'absolute border-dashed border-[var(--color-rule)]',
                    /* `-top-4` reaches back across the previous row's
                       padding, so the run is continuous between two
                       marks rather than a floating stub under each. */
                    'bottom-1/2 left-[1.6875rem] -top-4 border-l',
                    'lg:bottom-auto lg:left-auto lg:right-[calc(100%-1.6875rem)] lg:top-[1.6875rem] lg:w-8 lg:border-l-0 lg:border-t',
                  )}
                />
              ) : null}

              <span
                className={cn(
                  'relative grid h-[3.375rem] w-[3.375rem] shrink-0 place-items-center rounded-full border bg-[var(--color-paper)]',
                  state.mint
                    ? 'border-[var(--color-final-line)] text-[var(--color-final)]'
                    : 'border-[var(--color-rule)] text-[var(--color-ink-2)]',
                )}
              >
                <Icon name={state.icon} className="h-[22px] w-[22px]" strokeWidth={1.7} />
              </span>

              <span className="min-w-0 lg:mt-4">
                <span className="block text-[length:var(--text-md)] font-semibold text-[var(--color-ink)]">
                  {state.label}
                </span>
                <span className="mt-0.5 block text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
                  {state.note}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </LandingShell>
    </section>
  );
}

const STATES: readonly { label: string; note: string; icon: IconName; mint?: boolean }[] = [
  { label: 'Created', note: 'Terms locked', icon: 'clock' },
  { label: 'Shared', note: 'Deal link generated', icon: 'telegram' },
  { label: 'Joined', note: 'Counterparty joined', icon: 'profile' },
  { label: 'Paid', note: 'Payment marked', icon: 'shield-check', mint: true },
  { label: 'Released', note: 'Funds released', icon: 'lock' },
];
