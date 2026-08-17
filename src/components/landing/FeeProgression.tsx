'use client';

import { cn } from '@/lib/cn';
import { Icon } from '@/components/kit/Icon';
import { FEE_LADDER, FEE_PATH, FEE_STAGES, TRUST_PATH } from './rewardsDemo';
import { useInView } from './useInView';

/**
 * Two lines that cross once: trust rising, fees falling.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THIS IS NOT A CHART, AND IT WAS DRAWN SO IT CANNOT BE READ AS ONE.│
 * │                                                                    │
 * │  No axis, no gridlines, no scale, no time, no volatility, no       │
 * │  candles, no legend of instruments. Two smooth paths, three named  │
 * │  stops and a percentage at each — the picture of one sentence,     │
 * │  "do more protected deals and pay less". A person must not be able │
 * │  to mistake it for a price, a return or a performance history.     │
 * │                                                                    │
 * │  THE FIGURES ARE ILLUSTRATIVE and the card says so, in the copy    │
 * │  and in `rewardsDemo.ts`. The product's real fee is 1.50% (or      │
 * │  1.25% plus network on an exchange), reduced by entitlements —     │
 * │  there is no completed-deal ladder in the fee engine, and this     │
 * │  component does not create one.                                    │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * TWO COMPOSITIONS. Below `sm` the crossing lines become a vertical
 * ladder at full type size, because a 933px illustration squeezed into
 * 310px is three unreadable percentages and a squiggle.
 */
export function FeeProgression() {
  const { ref, armed, seen } = useInView<HTMLDivElement>();

  return (
    <div
      ref={ref}
      className="rounded-[var(--radius-xl)] border border-[var(--color-line)] bg-[var(--color-paper)] p-5 shadow-[var(--shadow-card)] sm:p-6"
    >
      <h3 className="text-[length:var(--text-md)] font-semibold text-[var(--color-ink)] sm:text-[length:var(--text-lg)]">
        {FEE_LADDER.title}
      </h3>

      {/* ---- The ladder, on a phone --------------------------- */}
      <ol className="mt-5 sm:hidden">
        {FEE_STAGES.map((stage, i) => (
          <li key={stage.key} className="relative flex items-center gap-3 py-2.5 pl-0">
            {i > 0 ? (
              <span
                aria-hidden
                className={cn(
                  'absolute -top-2.5 bottom-1/2 left-[9px] w-px',
                  stage.current || FEE_STAGES[i - 1]!.current
                    ? 'bg-[var(--color-final)]'
                    : 'bg-[var(--color-rule)]',
                )}
              />
            ) : null}
            <span
              aria-hidden
              className={cn(
                'relative grid h-[19px] w-[19px] shrink-0 place-items-center rounded-full border-2',
                stage.current
                  ? 'border-[var(--color-final)] bg-[var(--color-final)] text-white'
                  : 'border-[var(--color-rule)] bg-[var(--color-paper)]',
              )}
            >
              {stage.current ? (
                <Icon name="check" className="h-2.5 w-2.5" strokeWidth={3.5} />
              ) : null}
            </span>
            <span
              className={cn(
                'flex-1 text-[length:var(--text-base)] font-semibold',
                stage.current ? 'text-[var(--color-final)]' : 'text-[var(--color-ink-2)]',
              )}
            >
              {stage.label}
            </span>
            <span
              className={cn(
                'tnum rounded-[var(--radius-sm)] border px-2.5 py-1 text-[length:var(--text-base)] font-semibold',
                stage.current
                  ? 'border-[var(--color-final-line)] bg-[var(--color-final-tint)] text-[var(--color-final)]'
                  : 'border-[var(--color-line)] bg-[var(--color-paper)] text-[var(--color-ink)]',
              )}
            >
              {stage.rate}
            </span>
          </li>
        ))}
      </ol>

      {/* ---- The crossing paths, from `sm` -------------------- */}
      <div className="hidden sm:block">
        <div className="mt-5 grid grid-cols-3">
          {FEE_STAGES.map((stage) => (
            <div key={stage.key} className="flex flex-col items-center gap-2">
              <span
                className={cn(
                  'text-[length:var(--text-sm)] font-medium',
                  stage.current ? 'text-[var(--color-final)]' : 'text-[var(--color-ink-3)]',
                )}
              >
                {stage.label}
              </span>
              <span
                className={cn(
                  'tnum rounded-[var(--radius-sm)] border px-3 py-1 text-[length:var(--text-lg)] font-semibold',
                  stage.current
                    ? 'border-[var(--color-final-line)] bg-[var(--color-final-tint)] text-[var(--color-final)]'
                    : 'border-[var(--color-line)] bg-[var(--color-paper)] text-[var(--color-ink)]',
                )}
              >
                {stage.rate}
              </span>
            </div>
          ))}
        </div>

        <div className="relative mt-4 h-[9.5rem]">
          {/*
            `preserveAspectRatio="none"` stretches the geometry to the
            card's width at any size; `vector-effect` keeps the strokes
            1.6px through that stretch. Everything ROUND — the stops and
            the dividers — is HTML positioned at the same coordinates,
            because a stretched circle is an ellipse.
          */}
          <svg
            aria-hidden
            viewBox="0 0 100 40"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
            fill="none"
          >
            <path
              d={FEE_PATH}
              stroke="var(--color-edge)"
              strokeWidth={1.6}
              strokeDasharray="4 4"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              style={{
                opacity: armed && !seen ? 0 : 1,
                transition: 'opacity var(--dur-slow) var(--ease-out) 120ms',
              }}
            />
            <path
              d={TRUST_PATH}
              stroke="var(--color-final)"
              strokeWidth={2.2}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              /*
                ⚠ THE DASH IS IN SCREEN PIXELS, NOT USER UNITS.

                `vector-effect: non-scaling-stroke` moves the whole stroke
                — width AND dash pattern — into screen space. The first
                attempt normalised the curve with `pathLength={100}` and
                set a 100-unit dash, which Chrome then read as 100 CSS
                PIXELS: the line drew itself as four detached segments
                across a 950px card. One dash longer than any width this
                card can reach is the fix, and 2400 is comfortably past
                the ~1050px the path spans at its widest.
              */
              style={
                armed
                  ? {
                      strokeDasharray: 2400,
                      strokeDashoffset: seen ? 0 : 2400,
                      transition: 'stroke-dashoffset 900ms var(--ease-out)',
                    }
                  : undefined
              }
            />
          </svg>

          {/* The two zone divisions. */}
          {[33.333, 66.667].map((at) => (
            <span
              key={at}
              aria-hidden
              className="absolute inset-y-0 w-px bg-[var(--color-line)]"
              style={{ left: `${at}%` }}
            />
          ))}

          {/* Where the fee sits at each stage. */}
          {FEE_STAGES.map((stage, i) => (
            <span
              key={stage.key}
              aria-hidden
              className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-[var(--color-edge)] bg-[var(--color-paper)]"
              style={{ left: `${stage.at}%`, top: `${FEE_TOP[i]}%` }}
            />
          ))}

          {/* Where the trust stands: reached, and still to come. */}
          <span
            aria-hidden
            className="absolute grid h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-[var(--color-final)] text-white ring-4 ring-[var(--color-paper)]"
            style={{ left: '50%', top: '51.25%' }}
          >
            <Icon name="check" className="h-3 w-3" strokeWidth={3.4} />
          </span>
          <span
            aria-hidden
            className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-[var(--color-final)] bg-[var(--color-paper)]"
            style={{ left: '83.333%', top: '27.5%' }}
          />
          {/* Where the fee line is still heading. */}
          <span
            aria-hidden
            className="absolute -translate-y-1/2 text-[var(--color-edge)]"
            style={{ left: 'calc(83.333% + 0.6rem)', top: '84%' }}
          >
            <Icon name="chevron-right" className="h-3.5 w-3.5" strokeWidth={2} />
          </span>

          {/* How far along this illustration is. */}
          <span className="tnum absolute bottom-0 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-paper)] px-3 py-1.5 text-[length:var(--text-xs)] font-medium text-[var(--color-ink-2)] shadow-[var(--shadow-card)]">
            {FEE_LADDER.progress}
          </span>

          {/* What the two paths mean. */}
          <ul className="absolute bottom-0 left-0 space-y-1.5">
            <li className="flex items-center gap-2 text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
              <span aria-hidden className="h-[2px] w-5 rounded-full bg-[var(--color-final)]" />
              {FEE_LADDER.trustLegend}
            </li>
            <li className="flex items-center gap-2 text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
              <span
                aria-hidden
                className="w-5 border-t-[2px] border-dashed border-[var(--color-edge)]"
              />
              {FEE_LADDER.feeLegend}
            </li>
          </ul>
        </div>
      </div>

      {/* On a phone the progress line has no plot to sit in. */}
      <p className="tnum mt-4 text-[length:var(--text-xs)] font-medium text-[var(--color-ink-2)] sm:hidden">
        {FEE_LADDER.progress}
      </p>

      <p className="mt-5 border-t border-[var(--color-line)] pt-4 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-4)] sm:mt-6">
        {FEE_LADDER.disclosure}
      </p>
    </div>
  );
}

/**
 * Where the dashed fee line sits at each stage, as a percentage of the
 * plot's height. Derived from `FEE_PATH`: a straight run from y=13 to
 * y=33.6 in a 40-unit box, sampled at the three stage positions.
 */
const FEE_TOP = [32.5, 58.25, 84] as const;
