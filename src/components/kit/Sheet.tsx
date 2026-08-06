'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { Icon } from './Icon';

/**
 * The bottom sheet — and, above 640px, the same component as a dialog.
 *
 * One implementation for both postures, because a modal that behaves
 * differently on a phone and a laptop is two components to keep in step and
 * two sets of focus bugs.
 *
 * What it does that a styled `<div>` does not:
 *   · traps Tab inside itself while open, and restores focus on close;
 *   · closes on Escape and on the scrim, and nowhere else — never on a
 *     stray click inside;
 *   · locks the page behind it, so the body does not scroll under the sheet;
 *   · is a real `role="dialog"` with `aria-modal`, labelled by its heading.
 *
 * It renders through a portal so a sheet opened from deep inside a card is
 * not clipped by that card's `overflow: hidden`.
 */

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
}) {
  const panel = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    if (!open) return;

    restoreTo.current = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    // Focus the first control, or the panel itself when there is none, so a
    // screen reader starts inside the dialog rather than behind it.
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;

      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
      restoreTo.current?.focus({ preventScroll: true });
    };
  }, [open, close]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <>
      <div className="scrim" onClick={close} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        aria-describedby={description ? 'sheet-desc' : undefined}
        tabIndex={-1}
        className={cn('sheet outline-none', size === 'lg' && 'sm:!w-[min(38rem,calc(100vw-3rem))]')}
      >
        <div className="sheet-grip" aria-hidden />
        <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-4 sm:px-6 sm:pt-5">
          <div className="min-w-0">
            <h2
              id="sheet-title"
              className="text-[length:var(--text-lg)] font-semibold tracking-[-0.02em] text-[var(--color-ink)]"
            >
              {title}
            </h2>
            {description ? (
              <p
                id="sheet-desc"
                className="mt-1 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-3)]"
              >
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="press -mr-1.5 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--color-ink-3)] hover:bg-[var(--color-sunken)]"
          >
            <Icon name="close" className="h-4.5 w-4.5" strokeWidth={2} />
          </button>
        </div>

        <div className="px-5 pb-4 sm:px-6">{children}</div>

        {footer ? (
          <div className="sticky bottom-0 border-t border-[var(--color-line)] bg-[var(--color-paper)] px-5 py-3.5 sm:px-6">
            {footer}
          </div>
        ) : null}
      </div>
    </>,
    document.body,
  );
}
