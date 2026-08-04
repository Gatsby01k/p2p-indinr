'use client';

import { useState } from 'react';
import { Label, buttonClass } from './primitives';

/**
 * The share moment.
 *
 * Creating a link is the point at which a person has something to send,
 * so this makes sending it the obvious next act. Uses the Web Share sheet
 * on mobile where it exists — that is how a link actually reaches
 * WhatsApp — and falls back to copy elsewhere.
 *
 * The share text carries the terms and the URL only. No identity, no
 * reference to who created it: the same disclosure rule as the page.
 */
export function ShareLink({
  url,
  headline,
  canJoin,
}: {
  url: string;
  headline: string;
  canJoin: boolean;
}) {
  const [state, setState] = useState<'idle' | 'copied'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
      window.setTimeout(() => setState('idle'), 2200);
    } catch {
      setState('idle');
    }
  };

  const share = async () => {
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try {
        await navigator.share({ title: 'INRP2P deal link', text: headline, url });
        return;
      } catch {
        /* dismissed — fall through to copy */
      }
    }
    void copy();
  };

  if (!canJoin) return null;

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-paper)] p-4">
      <Label>Send this to your counterparty</Label>
      <p className="mt-2 truncate rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2 font-mono text-[length:var(--text-xs)] text-[var(--color-ink-2)]">
        {url}
      </p>
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={share} className={buttonClass('primary', 'md', true)}>
          Share link
        </button>
        <button
          type="button"
          onClick={copy}
          aria-live="polite"
          className={buttonClass('outline', 'md')}
        >
          {state === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mt-2.5 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
        Only the first eligible person to open it can join. Everyone else is told it was taken.
      </p>
    </div>
  );
}
