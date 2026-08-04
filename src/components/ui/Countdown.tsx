'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatCountdown, secondsUntil } from '@/lib/time';

/**
 * A visible deadline. Expiry here is cosmetic: the authoritative decision is
 * made server-side against a post-lock database clock (TS-01.4 T1–T4), never
 * against this timer. The UI must not imply that reaching zero performed
 * anything.
 */
export function Countdown({
  to,
  prefix,
  onElapsed,
  className,
}: {
  to: string;
  prefix?: string;
  onElapsed?: () => void;
  className?: string;
}) {
  const [remaining, setRemaining] = useState(() => secondsUntil(to));

  useEffect(() => {
    setRemaining(secondsUntil(to));
    const id = setInterval(() => {
      const next = secondsUntil(to);
      setRemaining(next);
      if (next <= 0) {
        clearInterval(id);
        onElapsed?.();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [to, onElapsed]);

  const urgent = remaining > 0 && remaining <= 60;
  const done = remaining <= 0;

  return (
    <span
      className={cn(
        'tnum text-xs font-medium',
        done
          ? 'text-[var(--color-muted)]'
          : urgent
            ? 'text-[var(--color-danger)]'
            : 'text-[var(--color-muted)]',
        className,
      )}
      aria-live={urgent ? 'polite' : 'off'}
    >
      {done ? 'Expired' : `${prefix ? `${prefix} ` : ''}${formatCountdown(remaining)}`}
    </span>
  );
}
