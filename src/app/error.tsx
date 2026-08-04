'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaced to the console only; no telemetry vendor is wired up.
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="text-[22px] font-semibold tracking-tight text-[var(--color-ink)]">
          Something broke on our side
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--color-muted)]">
          No deal was changed by this error. You can retry safely.
        </p>
        <Button className="mt-6" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
