'use client';

import { useId, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/kit/Icon';
import { buttonClass } from '@/components/kit/primitives';
import Link from 'next/link';
import { CAPABILITY_KEYS, createDealHref, type CapabilityKey } from './demo';
import { ENGINE_MODES } from './engineDemo';
import { NoOrderBookGlyph } from './Glyphs';
import { LandingShell } from './LandingShell';

/**
 * One engine, three directions.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE POINT OF THIS COMPONENT IS THAT IT IS ONE COMPONENT.          │
 * │                                                                    │
 * │  Three separate cards would say "three products". One composer     │
 * │  whose LEGS swap while its frame, its locks and its button stay    │
 * │  put says what is actually true: the same protected deal, pointed  │
 * │  in a different direction. That is why the mode control is a       │
 * │  tablist over a single panel rather than three panels shown at     │
 * │  once, and why nothing outside the two amount cells moves when the │
 * │  mode changes.                                                     │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ⚠ THIS IS NOT A SECOND TRANSACTION ENGINE. The figures are constants
 * from `engineDemo.ts`; nothing is priced, quoted, created or mutated
 * here. `Create deal` is a link into the EXISTING `/app/new` route,
 * through the existing sign-in handoff, carrying only the scenario — the
 * same contract the hero and the calculator already use. The server
 * issues the only quote that binds.
 */
export function DealEngine() {
  const [mode, setMode] = useState<CapabilityKey>('BUY_USDT');
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();
  const tabId = (key: CapabilityKey) => `${baseId}-tab-${key}`;
  const panelId = `${baseId}-panel`;

  const active = ENGINE_MODES[mode];

  /*
   * Arrow keys move the selection, Home and End jump to the ends. A
   * tablist that only responds to clicks is a row of buttons wearing a
   * tablist's name.
   */
  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const last = CAPABILITY_KEYS.length - 1;
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? (index + 1) % CAPABILITY_KEYS.length
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? (index + last) % CAPABILITY_KEYS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : -1;
    if (next < 0) return;
    event.preventDefault();
    setMode(CAPABILITY_KEYS[next]!);
    tabs.current[next]?.focus();
  };

  return (
    <section
      id="deal-engine"
      className="scroll-mt-24 border-t border-[var(--color-line)] bg-[var(--color-canvas)]"
    >
      <LandingShell className="py-14 sm:py-20 lg:py-24">
        <p className="text-[length:var(--text-2xs)] font-bold uppercase tracking-[0.14em] text-[var(--color-brand)]">
          One engine. Three ways to move.
        </p>
        <h2 className="mt-4 max-w-[22ch] text-[clamp(1.9rem,3.4vw,2.85rem)] font-bold leading-[1.06] tracking-[-0.04em] text-[var(--color-ink)] [text-wrap:balance]">
          However value moves, the deal stays protected.
        </h2>
        <p className="mt-4 max-w-[46ch] text-[length:var(--text-lg)] leading-relaxed text-[var(--color-ink-2)]">
          Send INR, buy USDT or sell USDT through the same clear flow.
        </p>

        {/*
          Capped at 74rem rather than run to the shell's full 92rem. The
          engine is a CONTROL, and a control stretched across 1360px puts
          `You pay` and `You receive` so far apart that the one sentence
          this section is making — these are two ends of the same deal —
          stops being legible in a glance.
        */}
        <div className="mt-9 grid max-w-[74rem] gap-8 min-[1120px]:grid-cols-[minmax(0,1fr)_20rem] min-[1120px]:gap-12 lg:mt-11">
          {/* ---- The engine -------------------------------------- */}
          <div className="overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-line)] bg-[var(--color-paper)] shadow-[var(--shadow-raised)]">
            {/* The three directions. */}
            <div className="relative">
              <div
                role="tablist"
                aria-label="Which direction the value moves"
                aria-orientation="horizontal"
                className="grid grid-cols-1 sm:grid-cols-3"
              >
                {CAPABILITY_KEYS.map((key, index) => {
                  const item = ENGINE_MODES[key];
                  const selected = key === mode;
                  return (
                    <button
                      key={key}
                      ref={(node) => {
                        tabs.current[index] = node;
                      }}
                      type="button"
                      role="tab"
                      id={tabId(key)}
                      aria-selected={selected}
                      aria-controls={panelId}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => setMode(key)}
                      onKeyDown={(event) => onKeyDown(event, index)}
                      className={cn(
                        'press flex items-center gap-3 px-4 py-4 text-left transition-colors duration-[var(--dur-base)] sm:px-5',
                        /*
                          The selected tab drops its bottom hairline so it
                          merges into the composer below it — the border
                          IS the connection between the direction you
                          chose and the deal it produces.

                          The marker moves with the axis: a LEFT bar while
                          the three are stacked on a phone, a TOP bar once
                          they sit side by side. A top bar on a stacked
                          list points at the gap above the selected row
                          and reads as belonging to the row before it.
                        */
                        'border-b border-l-[3px] sm:border-l-0 sm:border-t-[3px]',
                        selected
                          ? 'border-b-transparent border-l-[var(--color-brand)] bg-[var(--color-paper)] sm:border-t-[var(--color-brand)]'
                          : 'border-b-[var(--color-line)] border-l-transparent bg-[var(--color-sunken)]/50 hover:bg-[var(--color-sunken)] sm:border-t-transparent',
                      )}
                    >
                      <span
                        className={cn(
                          'grid h-9 w-9 shrink-0 place-items-center rounded-full transition-opacity duration-[var(--dur-base)]',
                          MODE_TINT[key],
                          !selected && 'opacity-70',
                        )}
                      >
                        <Icon
                          name={MODE_ICON[key]}
                          className="h-[18px] w-[18px]"
                          strokeWidth={1.9}
                        />
                      </span>
                      <span className="min-w-0">
                        <span
                          className={cn(
                            'block text-[length:var(--text-md)] font-semibold',
                            selected ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-2)]',
                          )}
                        >
                          {item.label}
                        </span>
                        <span className="tnum mt-0.5 block truncate text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
                          {item.summary}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {/*
                The dashed hops between the three. Decoration, so they sit
                OUTSIDE the tablist — a tablist whose children are not all
                tabs is a tablist an assistive technology cannot count.
              */}
              <span aria-hidden className="pointer-events-none absolute inset-0 hidden sm:block">
                <ModeHop className="left-[33.333%]" />
                <ModeHop className="left-[66.666%]" />
              </span>
            </div>

            {/* The deal that direction produces. */}
            <div
              role="tabpanel"
              id={panelId}
              aria-labelledby={tabId(mode)}
              tabIndex={-1}
              className="p-4 sm:p-5"
            >
              <p className="sr-only">{active.spoken}</p>

              {/*
                Near-equal thirds, the middle a little narrower. `auto`
                on the lock cell gave the two amount cells everything
                left over and left ₹83,600 marooned in 300px of nothing.
              */}
              {/*
                ⚠ THREE ACROSS ONLY FROM `lg`. Between 640 and 1023 the
                card is ~660px wide, which gives each amount cell 235px —
                four pixels less than `1,000 USDT` plus its unit selector
                needs, so the receive leg took an ellipsis. Stacking is
                the right answer rather than shrinking the figure: the
                amount is the one thing in this card that has to be
                legible at a glance.
              */}
              <div className="grid overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-line)] lg:grid-cols-[minmax(0,1fr)_minmax(0,0.82fr)_minmax(0,1fr)]">
                <Leg
                  caption={active.payLabel}
                  amount={active.pay.amount}
                  unit={active.pay.unit}
                  modeKey={mode}
                />

                {/* What is frozen the moment the deal is created. */}
                <div className="flex flex-col items-center justify-center gap-1 border-t border-[var(--color-line)] px-5 py-4 text-center lg:border-l lg:border-t-0">
                  <span className="flex items-center gap-1.5 text-[length:var(--text-xs)] font-semibold text-[var(--color-final)]">
                    <Icon name="lock" className="h-3.5 w-3.5" strokeWidth={2} />
                    {active.lockLabel}
                  </span>
                  <span
                    key={`lock-${mode}`}
                    className="tnum animate-value whitespace-nowrap text-[length:var(--text-xs)] text-[var(--color-ink-3)]"
                  >
                    {active.lockValue}
                  </span>
                </div>

                <Leg
                  caption={active.receiveLabel}
                  amount={active.receive.amount}
                  unit={active.receive.unit}
                  modeKey={mode}
                  className="border-t border-[var(--color-line)] lg:border-l lg:border-t-0"
                />
              </div>

              <Link
                href={createDealHref(mode)}
                prefetch={false}
                className={cn(buttonClass('primary', 'md', true), 'mt-3')}
              >
                Create deal
              </Link>

              <ul className="mt-3 grid overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-line)] sm:grid-cols-3">
                {ASSURANCES.map((item, i) => (
                  <li
                    key={item.label}
                    className={cn(
                      'flex items-center justify-center gap-2 px-3 py-3 text-[length:var(--text-xs)] font-medium text-[var(--color-ink-2)]',
                      i > 0 && 'border-t border-[var(--color-line)] sm:border-l sm:border-t-0',
                    )}
                  >
                    {item.label === 'No order book' ? (
                      <NoOrderBookGlyph className="h-4 w-4 text-[var(--color-ink-4)]" />
                    ) : (
                      <Icon
                        name={item.icon}
                        className={cn(
                          'h-4 w-4',
                          item.mint ? 'text-[var(--color-final)]' : 'text-[var(--color-ink-4)]',
                        )}
                        strokeWidth={1.9}
                      />
                    )}
                    {item.label}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* ---- What does not change ---------------------------- */}
          <aside className="min-[1120px]:self-center min-[1120px]:border-l min-[1120px]:border-dashed min-[1120px]:border-[var(--color-rule)] min-[1120px]:pl-10">
            <Icon
              name="shield-check"
              className="h-7 w-7 text-[var(--color-brand)]"
              strokeWidth={1.6}
            />
            <p className="mt-4 text-[length:var(--text-lg)] leading-[1.6] text-[var(--color-ink-2)]">
              <span className="block font-semibold text-[var(--color-ink)]">Same Deal Room.</span>
              <span className="block font-semibold text-[var(--color-ink)]">Same protection.</span>
              <span className="block">Only the value direction changes.</span>
            </p>
          </aside>
        </div>
      </LandingShell>
    </section>
  );
}

/**
 * One side of the deal.
 *
 * `key` on the figure, not the cell: re-keying the amount replays the
 * short `value-in` the product already uses when a quantity is replaced,
 * so switching mode reads as the number CHANGING rather than the panel
 * being rebuilt. The cell itself never moves.
 */
function Leg({
  caption,
  amount,
  unit,
  modeKey,
  className,
}: {
  caption: string;
  amount: string;
  unit: 'INR' | 'USDT';
  modeKey: CapabilityKey;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0 px-4 py-4 sm:px-5', className)}>
      <p className="text-[length:var(--text-xs)] font-medium text-[var(--color-ink-3)]">
        {caption}
      </p>
      <div className="mt-1.5 flex items-center justify-between gap-3">
        <span
          key={`${caption}-${modeKey}`}
          className="tnum animate-value min-w-0 truncate text-[length:var(--text-2xl)] font-semibold tracking-[-0.03em] text-[var(--color-ink)]"
        >
          {amount}
        </span>
        <span className="flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-[var(--color-paper)] px-2 py-1 text-[length:var(--text-2xs)] font-semibold text-[var(--color-ink-2)]">
          {unit}
          <Icon
            name="chevron-down"
            className="h-3 w-3 text-[var(--color-ink-4)]"
            strokeWidth={2.2}
          />
        </span>
      </div>
    </div>
  );
}

/** `○ — — ○`, the hop between two directions of the same engine. */
function ModeHop({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1',
        className,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full border border-[var(--color-edge)] bg-[var(--color-paper)]" />
      <span className="h-px w-6 border-t border-dashed border-[var(--color-edge)]" />
      <span className="h-1.5 w-1.5 rounded-full border border-[var(--color-edge)] bg-[var(--color-paper)]" />
    </span>
  );
}

const MODE_TINT: Readonly<Record<CapabilityKey, string>> = {
  SEND_INR: 'bg-[var(--color-inr-tint)] text-[var(--color-inr)]',
  BUY_USDT: 'bg-[var(--color-usdt-tint)] text-[var(--color-usdt)]',
  SELL_USDT: 'bg-[var(--color-info-tint)] text-[var(--color-info)]',
};

/** The same three marks the hero uses, so a mode is recognisable twice. */
const MODE_ICON: Readonly<Record<CapabilityKey, IconName>> = {
  SEND_INR: 'rupee',
  BUY_USDT: 'shield',
  SELL_USDT: 'swap',
};

const ASSURANCES: readonly { label: string; icon: IconName; mint?: boolean }[] = [
  { label: 'Terms locked', icon: 'shield-check', mint: true },
  { label: 'One counterparty', icon: 'profile' },
  { label: 'No order book', icon: 'deals' },
];
