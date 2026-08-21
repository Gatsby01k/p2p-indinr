import Link from 'next/link';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/kit/Icon';
import { LandingShell } from './LandingShell';
import { SAFEGUARDS, SETTLEMENT, VALUE_STATES } from './telegramDemo';

/**
 * Where protected value can be, and what it takes to move it.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE PRODUCT'S VOCABULARY, NOT THE CODE'S.                         │
 * │                                                                    │
 * │  Available → Locked in escrow → Released or Refunded is exactly    │
 * │  what the server enforces, and this panel says so in the words a   │
 * │  person uses about their own money. No table, no transaction, no   │
 * │  migration, no ledger row appears on a public page.                │
 * │                                                                    │
 * │  It also claims nothing it cannot keep. No recovery guarantee, no  │
 * │  deposit insurance, no regulator, no promise that fraud is         │
 * │  impossible — the headline is the point: a SYSTEM of permitted     │
 * │  moves, which is a smaller and truer claim than a promise.         │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * `See how protection works` goes to the FAQ rather than to a page that
 * does not exist. The FAQ is where the single-counterparty rule, the
 * dispute pause and the fee timing are actually written down.
 */
export function ProtectionSystem() {
  return (
    <section id="protection" className="scroll-mt-24 bg-[var(--color-canvas)]">
      <LandingShell className="pb-14 sm:pb-20 lg:pb-24">
        <div className="overflow-hidden rounded-[var(--radius-2xl)] bg-[var(--color-nav)] p-5 sm:p-8 lg:p-10 min-[1120px]:p-12">
          <div className="grid gap-9 min-[1120px]:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_minmax(0,23rem)] min-[1120px]:items-start min-[1120px]:gap-10">
            {/* ---- The claim ---------------------------------- */}
            <div className="min-w-0">
              <h2 className="text-[clamp(1.7rem,3vw,2.35rem)] font-bold leading-[1.08] tracking-[-0.04em] text-[var(--color-nav-ink)] [text-wrap:balance]">
                Protection is a system, not a promise.
              </h2>
              <p className="mt-4 max-w-[38ch] text-[length:var(--text-sm)] leading-relaxed text-[var(--color-nav-ink-2)]">
                Funds, terms and evidence move through controlled states.
              </p>
              <Link
                href="#faq"
                className="press mt-6 inline-flex min-h-6 items-center gap-1.5 rounded-[var(--radius-sm)] text-[length:var(--text-sm)] font-semibold text-[var(--color-brand)] underline-offset-4 hover:underline"
              >
                See how protection works
                <Icon name="chevron-right" className="h-4 w-4" strokeWidth={2.2} />
              </Link>
            </div>

            {/* ---- Where the value can be --------------------- */}
            <div className="min-w-0">
              <div
                aria-hidden
                className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center"
              >
                <StateCard state="available" icon="wallet" />
                <Arrow />
                <StateCard state="locked" icon="lock" badge />
                <Arrow branched />
                {/* The two permitted ends. Neither is a failure state; a
                    refund is as legitimate an outcome as a release. */}
                <div className="flex flex-col gap-2">
                  <Outcome state="released" icon="check" tone="final" />
                  <Outcome state="refunded" icon="close" tone="risk" />
                </div>
              </div>

              {/* What holds those transitions in place. */}
              {/*
                ⚠ NAMED BREAKPOINTS. `sm:grid-cols-2` and an arbitrary
                `min-[1120px]:grid-cols-4` both applied at 1440 and
                Tailwind sorted the arbitrary one FIRST, so this stayed a
                2×2 block on a desktop that had room for one row.
              */}
              <ul className="mt-4 grid overflow-hidden rounded-[var(--radius-lg)] ring-1 ring-inset ring-[var(--color-nav-3)] sm:grid-cols-2 xl:grid-cols-4">
                {SAFEGUARDS.map((safeguard, i) => (
                  <li
                    key={safeguard.label}
                    className={cn(
                      'flex items-center gap-2.5 px-3.5 py-3.5',
                      i > 0 && 'border-t border-[var(--color-nav-3)] sm:border-t-0',
                      i % 2 === 1 && 'sm:border-l sm:border-[var(--color-nav-3)]',
                      i >= 2 && 'sm:border-t sm:border-[var(--color-nav-3)]',
                      'xl:border-t-0 xl:[&:not(:first-child)]:border-l xl:[&:not(:first-child)]:border-[var(--color-nav-3)]',
                    )}
                  >
                    <Icon
                      name={safeguard.icon as IconName}
                      className="h-[18px] w-[18px] shrink-0 text-[var(--color-nav-ink)]"
                      strokeWidth={1.7}
                    />
                    <span className="text-[length:var(--text-xs)] leading-tight text-[var(--color-nav-ink-2)]">
                      {safeguard.label}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* ---- What actually settles ---------------------- */}
            <div
              aria-hidden
              className="min-w-0 rounded-[var(--radius-lg)] bg-[var(--color-nav-2)] p-4 ring-1 ring-inset ring-[var(--color-nav-3)] sm:p-5"
            >
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-3">
                <Leg
                  title={SETTLEMENT.from.title}
                  note={SETTLEMENT.from.note}
                  foot={SETTLEMENT.from.foot}
                  icon="bank"
                />
                <span className="flex flex-col items-center gap-2 pt-8">
                  <span className="grid h-11 w-11 place-items-center rounded-full border border-[var(--color-final-line)] bg-[var(--color-final-tint)] text-[var(--color-final)]">
                    <Icon name="shield" className="h-5 w-5" strokeWidth={1.8} />
                  </span>
                </span>
                <Leg
                  title={SETTLEMENT.to.title}
                  note={SETTLEMENT.to.note}
                  foot={SETTLEMENT.to.foot}
                  icon="shield-check"
                  align="right"
                />
              </div>
            </div>
          </div>
        </div>
      </LandingShell>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Parts
 * ------------------------------------------------------------------ */

function StateCard({
  state,
  icon,
  badge = false,
}: {
  state: 'available' | 'locked';
  icon: IconName;
  badge?: boolean;
}) {
  return (
    <span className="relative flex min-w-0 flex-1 flex-col items-center gap-2.5 rounded-[var(--radius-lg)] bg-[var(--color-nav-2)] px-3 py-4 ring-1 ring-inset ring-[var(--color-nav-3)]">
      {state === 'available' ? (
        <span className="absolute left-3 top-3 h-1.5 w-1.5 rounded-full bg-[var(--color-final)]" />
      ) : null}
      <span className="relative text-[var(--color-nav-ink)]">
        <Icon name={icon} className="h-6 w-6" strokeWidth={1.6} />
        {badge ? (
          <span className="absolute -bottom-1 -right-1.5 grid h-[14px] w-[14px] place-items-center rounded-full bg-[var(--color-final)] text-white">
            <Icon name="check" className="h-2 w-2" strokeWidth={4} />
          </span>
        ) : null}
      </span>
      <span className="text-center text-[length:var(--text-xs)] font-medium text-[var(--color-nav-ink)]">
        {VALUE_STATES[state].label}
      </span>
    </span>
  );
}

function Outcome({
  state,
  icon,
  tone,
}: {
  state: 'released' | 'refunded';
  icon: IconName;
  tone: 'final' | 'risk';
}) {
  return (
    <span className="flex items-center gap-2.5 rounded-[var(--radius-md)] bg-[var(--color-nav-2)] px-3 py-2.5 ring-1 ring-inset ring-[var(--color-nav-3)]">
      <span
        className={cn(
          'grid h-6 w-6 shrink-0 place-items-center rounded-full text-white',
          tone === 'final' ? 'bg-[var(--color-final)]' : 'bg-[var(--color-risk)]',
        )}
      >
        <Icon name={icon} className="h-3 w-3" strokeWidth={3.4} />
      </span>
      <span className="whitespace-nowrap text-[length:var(--text-xs)] font-medium text-[var(--color-nav-ink)]">
        {VALUE_STATES[state].label}
      </span>
    </span>
  );
}

/** A permitted move. `branched` forks into the two possible ends. */
function Arrow({ branched = false }: { branched?: boolean }) {
  return (
    <span className="flex shrink-0 items-center justify-center self-center py-1 sm:py-0">
      <svg
        viewBox={branched ? '0 0 48 44' : '0 0 34 44'}
        className={cn(
          'h-6 rotate-90 text-[var(--color-nav-ink-3)] sm:h-11 sm:rotate-0',
          branched ? 'w-6 sm:w-12' : 'w-6 sm:w-[2.125rem]',
        )}
        fill="none"
        aria-hidden
      >
        {branched ? (
          /*
            The fork, given real room. At 34px the two curves left and
            arrived in the same six pixels and read as a smudge; 48px is
            enough for the split to be the thing you notice, which is the
            whole point — a locked deal has exactly two permitted ends.
          */
          <>
            <path
              d="M2 22h10c5 0 6-4 8-7s4-4 8-4h8"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeDasharray="3 3"
            />
            <path
              d="M2 22h10c5 0 6 4 8 7s4 4 8 4h8"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeDasharray="3 3"
            />
            <path
              d="m38 8 4 3-4 3M38 30l4 3-4 3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <>
            <path
              d="M2 22h24"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeDasharray="3 3"
            />
            <path
              d="m26 19 4 3-4 3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}
      </svg>
    </span>
  );
}

function Leg({
  title,
  note,
  foot,
  icon,
  align = 'left',
}: {
  title: string;
  note: string;
  foot: string;
  icon: IconName;
  align?: 'left' | 'right';
}) {
  return (
    <span className={cn('flex min-w-0 flex-col gap-1', align === 'right' && 'text-right')}>
      <span className="text-[length:var(--text-xs)] font-semibold text-[var(--color-nav-ink)]">
        {title}
      </span>
      <span className="text-[length:var(--text-2xs)] leading-tight text-[var(--color-nav-ink-3)]">
        {note}
      </span>
      <span
        className={cn(
          'mt-2 grid h-12 w-12 place-items-center rounded-full border border-[var(--color-nav-3)] text-[var(--color-nav-ink)]',
          align === 'right' && 'ml-auto',
        )}
      >
        <Icon name={icon} className="h-5 w-5" strokeWidth={1.6} />
      </span>
      <span className="mt-1.5 text-[length:var(--text-2xs)] text-[var(--color-nav-ink-3)]">
        {foot}
      </span>
    </span>
  );
}
