'use client';

import { useEffect } from 'react';
import { Notice, Shell, buttonClass } from '@/components/kit/primitives';

/**
 * Error boundary for the authenticated section.
 *
 * Scoped here rather than only at the root so a failure inside one screen
 * keeps the app shell — header, navigation, sign-out — usable. A person
 * whose deal room failed to load should not lose the way back to their
 * other deals.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[inrp2p] app segment error', error);
  }, [error]);

  return (
    <Shell width="prose" className="py-10">
      <Notice
        tone="risk"
        title="This screen could not be loaded"
        body="The page failed while fetching its data. That is a display failure, not a transaction failure."
        reassurance="No deal was created, changed or completed, and nothing was charged. Every transaction's state is held on the server, not in this page."
        nextStep="Try again. If it keeps failing, go back to your deals — the list is loaded separately and will show the current state of everything."
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={reset} className={buttonClass('primary', 'md')}>
          Try again
        </button>
        <a href="/app" className={buttonClass('outline', 'md')}>
          Back to your deals
        </a>
      </div>
      {error.digest ? (
        <p className="mt-4 font-mono text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">
          Reference {error.digest}
        </p>
      ) : null}
    </Shell>
  );
}
