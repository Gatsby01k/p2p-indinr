'use client';

import { useEffect, useState } from 'react';

/**
 * Time display.
 *
 * ⚠ NOTHING HERE GATES ANYTHING. Expiry, admissibility and every permitted
 * action are decided by the server against the database clock, after the
 * controlling row lock is held. This component only renders a deadline the
 * server already sent. A countdown reaching zero changes no state and
 * enables no button; the page must be re-read from the server for that.
 *
 * Why relative time at all: "expires 4 Aug 2026, 12:56" forces a person to
 * work out whether that is soon. "in 24 minutes" is the fact they need.
 *
 * SSR safety: the first render emits the absolute timestamp, which is
 * deterministic on server and client. The relative form only appears after
 * mount, so there is no hydration mismatch and no layout shift — the
 * absolute string is the wider of the two, so the box never grows.
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
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    // One tick per second under a minute, otherwise per half-minute: a
    // deadline an hour away does not need 60 re-renders a minute.
    const tick = () => setNow(Date.now());
    const remaining = target - Date.now();
    const interval = Math.abs(remaining) < 60_000 ? 1000 : 30_000;
    const id = window.setInterval(tick, interval);
    return () => window.clearInterval(id);
  }, [target]);

  const absolute = formatAbsolute(iso);

  // Pre-mount and for reduced-data situations: the absolute timestamp.
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
      style={urgent ? { color: 'var(--color-action)' } : undefined}
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
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [target]);

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
