'use client';

import { useEffect } from 'react';
import { Notice, Shell, buttonClass } from '@/components/kit/primitives';

/**
 * Recoverable error boundary.
 *
 * Says what happened, that nothing was changed, and offers the one safe
 * action — retry. It never says "Something went wrong": for a failure
 * during a render there IS a precise safe statement, namely that no
 * transaction was altered, because every mutation is a server action
 * that either committed or rolled back before this boundary was reached.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[inrp2p] render error', error);
  }, [error]);

  return (
    <main id="main" className="flex min-h-dvh items-center py-10">
      <Shell width="prose">
        <Notice
          tone="risk"
          title="This screen could not be displayed"
          body="The page failed while loading its data. This is a display failure, not a transaction failure."
          reassurance="No deal was created, changed or completed. Your transactions are unaffected."
          nextStep="Try again. If it keeps failing, return to your deals — the current state of every transaction is held on the server, not in this page."
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
    </main>
  );
}
