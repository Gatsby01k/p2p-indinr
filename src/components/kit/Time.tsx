'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * Time display.
 *
 * ⚠ NOTHING HERE GATES ANYTHING. Expiry, admissibility and every permitted
 * action are decided by the server against the database clock, after the
 * controlling row lock is held. These components only render a deadline the
 * server already sent. A countdown reaching zero changes no state and
 * enables no button; the page must be re-read from the server for that.
 *
 * Why relative time at all: "expires 4 Aug 2026, 12:56" forces a person to
 * work out whether that is soon. "in 24 minutes" is the fact they need.
 *
 * SSR safety: the first render emits the absolute timestamp, which is
 * deterministic on server and client. The relative form only appears after
 * mount, so there is no hydration mismatch — and because the absolute string
 * is the wider of the two, the box never grows when it swaps.
 */

function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Whole units, never rounded up — "in 1 minute" must not mean 119 seconds. */
function formatRelative(target: number, now: number): { text: string; urgent: boolean } {
  const deltaMs = target - now;
  const past = deltaMs <= 0;
  const secs = Math.floor(Math.abs(deltaMs) / 1000);

  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? '' : 's'}`;

  let body: string;
  if (secs < 60) body = unit(secs, 'second');
  else if (secs < 3600) body = unit(Math.floor(secs / 60), 'minute');
  else if (secs < 86_400) body = unit(Math.floor(secs / 3600), 'hour');
  else body = unit(Math.floor(secs / 86_400), 'day');

  return {
    text: past ? `${body} ago` : `in ${body}`,
    // Under five minutes is where a person's behaviour should change.
    urgent: !past && secs < 300,
  };
}

/**
 * A ticking clock, shared by every time component.
 *
 * Returns `null` until mounted, which is the hydration-safe signal to render
 * the absolute form. The interval adapts: one tick a second when the target
 * is close, one every half-minute when it is not, because a deadline an hour
 * away does not need sixty re-renders a minute on a mid-range phone.
 */
function useClock(target: number, fast = false): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const remaining = Math.abs(target - Date.now());
    const interval = fast || remaining < 60_000 ? 1000 : 30_000;
    const id = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(id);
  }, [target, fast]);

  return now;
}

/**
 * A deadline, shown relatively once mounted.
 *
 * `title` keeps the absolute timestamp available on hover and to assistive
 * technology, so precision is never lost — only de-emphasised.
 */
export function Deadline({
  iso,
  prefix,
  className,
}: {
  iso: string;
  prefix?: string;
  className?: string;
}) {
  const target = new Date(iso).getTime();
  const now = useClock(target);
  const absolute = formatAbsolute(iso);

  if (now === null) {
    return (
      <time dateTime={iso} className={className}>
        {prefix ? `${prefix} ` : ''}
        {absolute}
      </time>
    );
  }

  const { text, urgent } = formatRelative(target, now);

  return (
    <time
      dateTime={iso}
      title={absolute}
      className={className}
      style={urgent ? { color: 'var(--color-brand)' } : undefined}
    >
      {prefix ? `${prefix} ` : ''}
      <span className="tnum">{text}</span>
      <span className="sr-only"> ({absolute})</span>
    </time>
  );
}

/**
 * A past event — "2 minutes ago", with the exact time on hover.
 *
 * Used on receipts and audit rows, where the relative form is what a person
 * scans and the exact stamp is what they quote.
 */
export function Ago({ iso, className }: { iso: string; className?: string }) {
  const target = new Date(iso).getTime();
  const now = useClock(target);
  const absolute = formatAbsolute(iso);

  if (now === null) {
    return (
      <time dateTime={iso} className={className}>
        {absolute}
      </time>
    );
  }
  return (
    <time dateTime={iso} title={absolute} className={className}>
      {formatRelative(target, now).text}
      <span className="sr-only"> ({absolute})</span>
    </time>
  );
}

/** Just the wall-clock time — for a chat bubble, where the day is obvious. */
export function ClockTime({ iso, className }: { iso: string; className?: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
  }, [iso]);
  return (
    <time dateTime={iso} className={cn('tnum', className)} title={formatAbsolute(iso)}>
      {text ?? ''}
    </time>
  );
}

/**
 * A digital countdown — `MM:SS`, or `H:MM:SS` past an hour.
 *
 * Used where the reference screens show one: a firm quote's validity window
 * and a payment deadline. It is decoration over an authoritative server
 * deadline, so reaching zero swaps the label to `lapsedLabel` and CHANGES
 * NOTHING ELSE. The page must be re-read for the server's verdict, and the
 * copy says so where it matters.
 */
export function Countdown({
  iso,
  className,
  lapsedLabel = 'Time is up',
  onLapse,
}: {
  iso: string;
  className?: string;
  lapsedLabel?: string;
  onLapse?: () => void;
}) {
  const target = new Date(iso).getTime();
  const now = useClock(target, true);
  const [fired, setFired] = useState(false);

  const remaining = now === null ? target - Date.now() : target - now;
  const lapsed = remaining <= 0;

  useEffect(() => {
    if (lapsed && !fired && onLapse) {
      setFired(true);
      onLapse();
    }
  }, [lapsed, fired, onLapse]);

  if (now === null) {
    // Pre-mount: render a stable placeholder of the same width rather than a
    // server-computed figure, which would be stale by the time it painted.
    return (
      <span className={cn('tnum', className)} suppressHydrationWarning>
        --:--
      </span>
    );
  }

  if (lapsed) {
    return (
      <span className={cn('tnum', className)} style={{ color: 'var(--color-risk)' }}>
        {lapsedLabel}
      </span>
    );
  }

  const total = Math.floor(remaining / 1000);
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const text = hours > 0 ? `${hours}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;

  return (
    <span
      className={cn('tnum', className)}
      style={total < 60 ? { color: 'var(--color-risk)' } : undefined}
      // Announced once a minute rather than once a second: a screen reader
      // reading a ticking clock aloud is unusable.
      aria-live={secs === 0 ? 'polite' : 'off'}
    >
      {text}
      <span className="sr-only"> remaining</span>
    </span>
  );
}
