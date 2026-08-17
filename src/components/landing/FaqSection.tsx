'use client';

import { useId, useState } from 'react';
import { cn } from '@/lib/cn';
import { LandingShell } from './LandingShell';
import { FAQ } from './telegramDemo';

/**
 * Four questions, answered before anybody commits to anything.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A REAL ACCORDION, NOT A DISCLOSURE PRETENDING TO BE ONE.          │
 * │                                                                    │
 * │  Each header is a `<button>` carrying `aria-expanded` and          │
 * │  `aria-controls`; each panel is a labelled `region` pointing back  │
 * │  at its header with `aria-labelledby`. One panel is open at a      │
 * │  time and the first is open on arrival, so the pattern teaches     │
 * │  itself without anybody having to click to discover it.            │
 * │                                                                    │
 * │  THE PANEL IS ALWAYS IN THE DOM. It collapses by animating a grid  │
 * │  row from `0fr` to `1fr`, which means the open height is measured  │
 * │  by the browser rather than guessed by us — no fixed max-height,   │
 * │  no jump when an answer wraps to one more line at 390px, and       │
 * │  nothing to recalculate on resize. A closed panel is `hidden` to   │
 * │  assistive technology via `inert`-like semantics: it is behind     │
 * │  `overflow: hidden` and marked `aria-hidden` so a screen reader    │
 * │  never reads an answer nobody has opened.                          │
 * │                                                                    │
 * │  `prefers-reduced-motion` is handled globally — the base stylesheet │
 * │  cuts every transition to 0.01ms, so the row snaps instead of      │
 * │  sliding and the accordion still works exactly the same.           │
 * └────────────────────────────────────────────────────────────────────┘
 */
export function FaqSection() {
  const [open, setOpen] = useState<string>(FAQ[0]!.id);
  const baseId = useId();

  return (
    <section
      id="faq"
      className="scroll-mt-24 border-t border-[var(--color-line)] bg-[var(--color-canvas)]"
    >
      <LandingShell className="py-14 sm:py-20 lg:py-24">
        <div className="grid gap-8 min-[1120px]:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] min-[1120px]:gap-14">
          <h2 className="text-[clamp(1.9rem,3.4vw,2.6rem)] font-bold leading-[1.06] tracking-[-0.04em] text-[var(--color-ink)]">
            <span className="block">Clear before</span>
            <span className="block">you create.</span>
          </h2>

          <ul className="min-w-0 space-y-2.5">
            {FAQ.map((item, index) => {
              const expanded = open === item.id;
              const headerId = `${baseId}-h-${item.id}`;
              const panelId = `${baseId}-p-${item.id}`;
              return (
                <li
                  key={item.id}
                  className={cn(
                    'overflow-hidden rounded-[var(--radius-lg)] border bg-[var(--color-paper)] transition-colors duration-[var(--dur-base)]',
                    expanded
                      ? 'border-[var(--color-rule)] shadow-[var(--shadow-card)]'
                      : 'border-[var(--color-line)]',
                  )}
                >
                  <h3>
                    <button
                      type="button"
                      id={headerId}
                      aria-expanded={expanded}
                      aria-controls={panelId}
                      onClick={() => setOpen(expanded ? '' : item.id)}
                      className="tap flex w-full items-center gap-3 px-4 py-3.5 text-left sm:px-5"
                    >
                      <span className="tnum w-4 shrink-0 text-[length:var(--text-xs)] font-semibold text-[var(--color-brand)]">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 text-[length:var(--text-md)] font-semibold text-[var(--color-ink)]">
                        {item.question}
                      </span>
                      {/*
                        A plus that becomes a minus: one bar stays, the
                        other rotates away. Drawn rather than swapped, so
                        the control never reflows and the state change is
                        legible without colour.
                      */}
                      <span
                        aria-hidden
                        className="relative grid h-5 w-5 shrink-0 place-items-center text-[var(--color-ink-3)]"
                      >
                        <span className="absolute h-[1.5px] w-3.5 rounded-full bg-current" />
                        <span
                          className={cn(
                            'absolute h-[1.5px] w-3.5 rounded-full bg-current transition-transform duration-[var(--dur-base)]',
                            expanded ? 'rotate-0' : 'rotate-90',
                          )}
                        />
                      </span>
                    </button>
                  </h3>

                  <div
                    className={cn(
                      'grid transition-[grid-template-rows] duration-[var(--dur-slow)] ease-[var(--ease-out)]',
                      expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
                    )}
                  >
                    <div className="overflow-hidden">
                      <p
                        id={panelId}
                        role="region"
                        aria-labelledby={headerId}
                        aria-hidden={!expanded}
                        className="px-4 pb-4 pl-11 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)] sm:px-5 sm:pl-12"
                      >
                        {item.answer}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </LandingShell>
    </section>
  );
}
