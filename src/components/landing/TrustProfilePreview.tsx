import { cn } from '@/lib/cn';
import { Icon } from '@/components/kit/Icon';
import { SCORE_SPARK, TRUST_PROFILE } from './rewardsDemo';

/**
 * What the other side of a deal looks like before you agree to it.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  ILLUSTRATIVE, AND NOT A PLATFORM CLAIM.                           │
 * │                                                                    │
 * │  742, 27, 100% and 0 describe ONE imagined counterparty. They are  │
 * │  not an average, a median, a guarantee or a statistic about        │
 * │  INRP2P, and nothing on the page presents them as one.             │
 * │                                                                    │
 * │  There is also no Trust Score in the product. What exists is       │
 * │  SafePoints and a level of 1–5 earned by completed deals           │
 * │  (`levelFor`, thresholds 0/3/10/25/50). This card stands for that  │
 * │  idea at a marketing scale; it does not introduce a new number     │
 * │  into the product, and it reads no real profile — the public page  │
 * │  has no session and this component has no server import.           │
 * └────────────────────────────────────────────────────────────────────┘
 */
export function TrustProfilePreview({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'rounded-[var(--radius-lg)] bg-[var(--color-nav-2)] p-4 ring-1 ring-inset ring-[var(--color-nav-3)] sm:p-5',
        className,
      )}
    >
      {/*
        ---- Who they are ----------------------------------------

        Stacked below `sm`. The eligibility pill is 145px and cannot
        shrink, which left the name about 57px to sit in — it wrapped to
        two lines and the pill came down on top of it.
      */}
      <div className="flex flex-col items-start gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
        <span className="flex w-full min-w-0 items-center gap-3 sm:w-auto sm:flex-1">
          <span className="relative shrink-0">
            <span className="grid h-11 w-11 place-items-center rounded-full bg-[var(--color-nav-3)] text-[var(--color-nav-ink-2)]">
              <Icon name="profile" className="h-5 w-5" strokeWidth={1.7} />
            </span>
            <span className="absolute -bottom-0.5 -right-0.5 grid h-[18px] w-[18px] place-items-center rounded-full bg-[var(--color-final)] text-white ring-2 ring-[var(--color-nav-2)]">
              <Icon name="check" className="h-2.5 w-2.5" strokeWidth={3.4} />
            </span>
          </span>
          <span className="min-w-0 text-[length:var(--text-md)] font-semibold text-[var(--color-nav-ink)]">
            {TRUST_PROFILE.title}
          </span>
        </span>
        <span className="shrink-0 rounded-[var(--radius-full)] border border-[var(--color-final-line)] bg-[var(--color-final-tint)] px-2.5 py-1 text-[length:var(--text-2xs)] font-semibold text-[var(--color-final)]">
          {TRUST_PROFILE.eligibility}
        </span>
      </div>

      {/* ---- What their history says ---------------------------- */}
      <div className="mt-4 grid gap-4 border-t border-[var(--color-nav-3)] pt-4 sm:grid-cols-[minmax(0,1.25fr)_minmax(0,2fr)] sm:gap-5">
        <div>
          <p className="text-[length:var(--text-2xs)] font-medium text-[var(--color-nav-ink-3)]">
            {TRUST_PROFILE.scoreLabel}
          </p>
          <p className="tnum mt-1 text-[length:var(--text-4xl)] font-semibold leading-none tracking-[-0.035em] text-[var(--color-final)]">
            {TRUST_PROFILE.score}
          </p>
          {/*
            A trace of where the number came from, not a chart of it.
            No axis, no scale, no dates — three seconds of glance value
            and nothing anybody could read as a price.
          */}
          <svg
            viewBox="0 0 92 26"
            preserveAspectRatio="none"
            className="mt-2 h-5 w-[5.75rem]"
            fill="none"
            aria-hidden
          >
            <path
              d={SCORE_SPARK}
              stroke="var(--color-final)"
              strokeWidth={2}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <p className="mt-2 text-[length:var(--text-xs)] font-medium text-[var(--color-final)]">
            {TRUST_PROFILE.delta}
          </p>
        </div>

        <ul className="grid grid-cols-3 gap-2 sm:border-l sm:border-[var(--color-nav-3)] sm:pl-5">
          {TRUST_PROFILE.stats.map((stat) => (
            <li key={stat.label} className="min-w-0">
              <p className="tnum text-[length:var(--text-2xl)] font-semibold leading-none tracking-[-0.03em] text-[var(--color-nav-ink)]">
                {stat.value}
              </p>
              <p className="mt-1.5 text-[length:var(--text-2xs)] leading-tight text-[var(--color-nav-ink-3)]">
                {stat.label}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
