'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Notice a change somebody ELSE made.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  EVERY REFRESH IN THIS APP USED TO BE SELF-INFLICTED.              │
 * │                                                                    │
 * │  `router.refresh()` was called only from the handler for the       │
 * │  viewer's OWN action — send a message, claim a payment, confirm a  │
 * │  receipt. That is correct and it is not enough: this is a product  │
 * │  about two people, and the screens that matter most are the ones   │
 * │  waiting on the other one.                                         │
 * │                                                                    │
 * │  The share screen is the clearest case. Its entire purpose is to   │
 * │  wait for a counterparty to join, and it sat on "Shared" forever   │
 * │  after they had — the server knew, the page never asked. The deal  │
 * │  room had the same hole: a chat that only updates when YOU type    │
 * │  is not a chat.                                                    │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Polling, not a socket. A socket would mean holding a connection per
 * viewer on a serverless runtime that charges for exactly that, to carry
 * an event that arrives a handful of times per deal. Re-asking a
 * `force-dynamic` page every few seconds costs one query and is honest
 * about what it is.
 *
 * Three things keep that from being wasteful:
 *
 *   · a HIDDEN tab does not poll at all, and refreshes once the moment it
 *     comes back — a backgrounded deal is the common case, not the rare
 *     one, because people share the link and then go to WhatsApp;
 *   · polling STOPS after `stopAfterMs`, so a tab left open overnight is
 *     not still asking in the morning;
 *   · it renders nothing, so it can be dropped into a server component
 *     without changing a single line of layout.
 */
export function LiveRefresh({
  intervalMs = 5_000,
  stopAfterMs = 15 * 60 * 1_000,
}: {
  /** How often to re-ask, while the tab is visible. */
  readonly intervalMs?: number;
  /** Give up after this long, so an abandoned tab goes quiet. */
  readonly stopAfterMs?: number;
}) {
  const router = useRouter();

  useEffect(() => {
    const startedAt = Date.now();
    const expired = () => Date.now() - startedAt > stopAfterMs;
    let timer: number | undefined;

    const tick = () => {
      if (expired()) return;
      /*
       * Skipped rather than cancelled while hidden: the schedule keeps
       * running so the poll resumes on its own cadence, and the
       * visibility handler below covers the "came back just now" case.
       */
      if (document.visibilityState === 'visible') router.refresh();
      timer = window.setTimeout(tick, intervalMs);
    };
    timer = window.setTimeout(tick, intervalMs);

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !expired()) router.refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router, intervalMs, stopAfterMs]);

  return null;
}
