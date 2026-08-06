'use client';

import { useEffect, useState } from 'react';

/**
 * Keyboard navigation for the operator queue.
 *
 * An operator working a queue should never need the mouse. `j`/`k` (and the
 * arrow keys) move between rows, `Enter` opens the focused one, `g g` jumps
 * to the top and `G` to the bottom — the conventions of every serious
 * triage tool, so the muscle memory transfers.
 *
 * Rows are real focusable table rows, so this augments native tabbing
 * rather than replacing it: Tab still works, and a screen reader still
 * reads the row as a row. Keys are ignored while a field has focus, so
 * typing in a filter never moves the selection.
 */
export function QueueKeys() {
  const [hint, setHint] = useState(false);

  useEffect(() => {
    let lastG = 0;

    const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-queue-row]'));

    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      const all = rows();
      if (all.length === 0) return;
      const current = all.findIndex((r) => r === document.activeElement);

      const focusAt = (i: number) => {
        const next = all[Math.max(0, Math.min(all.length - 1, i))];
        next?.focus();
        next?.scrollIntoView({ block: 'nearest' });
      };

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          focusAt(current === -1 ? 0 : current + 1);
          break;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          focusAt(current === -1 ? 0 : current - 1);
          break;
        case 'G':
          e.preventDefault();
          focusAt(all.length - 1);
          break;
        case 'g': {
          const now = Date.now();
          if (now - lastG < 500) {
            e.preventDefault();
            focusAt(0);
            lastG = 0;
          } else {
            lastG = now;
          }
          break;
        }
        case 'Enter': {
          // Open the focused case. The row carries its own destination, so
          // this never has to guess a URL from the table's shape.
          const row = all[current];
          const href = row?.getAttribute('data-href');
          if (href) {
            e.preventDefault();
            window.location.assign(href);
          }
          break;
        }
        case '?':
          e.preventDefault();
          setHint((v) => !v);
          break;
        case 'Escape':
          setHint(false);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <p className="mt-3 text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">
        <kbd className="font-mono">j</kbd> / <kbd className="font-mono">k</kbd> move ·{' '}
        <kbd className="font-mono">Enter</kbd> open · <kbd className="font-mono">g g</kbd> top ·{' '}
        <kbd className="font-mono">G</kbd> bottom · <kbd className="font-mono">?</kbd> shortcuts
      </p>
      {hint ? (
        <div
          role="dialog"
          aria-label="Keyboard shortcuts"
          className="fixed inset-x-4 bottom-4 z-40 mx-auto max-w-sm rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--color-paper)] p-4 shadow-[var(--shadow-lift)] sm:inset-x-auto sm:right-6"
        >
          <h2 className="text-[length:var(--text-sm)] font-semibold text-[var(--color-ink)]">
            Keyboard
          </h2>
          <dl className="mt-2 space-y-1 text-[length:var(--text-xs)] text-[var(--color-ink-2)]">
            {[
              ['j / ↓', 'Next row'],
              ['k / ↑', 'Previous row'],
              ['Enter', 'Open the case'],
              ['g g', 'First row'],
              ['G', 'Last row'],
              ['Esc', 'Close this'],
            ].map(([key, what]) => (
              <div key={key} className="flex justify-between gap-4">
                <dt className="font-mono text-[var(--color-ink)]">{key}</dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </>
  );
}
