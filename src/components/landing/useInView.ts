'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * "Has this been scrolled to yet?" — answered once, then forgotten.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHY NOT JUST ANIMATE ON MOUNT.                                    │
 * │                                                                    │
 * │  Everything this drives sits well below the fold. An on-mount      │
 * │  animation would finish while the visitor is still reading the     │
 * │  hero, so by the time they arrive the "entrance" has already       │
 * │  happened and they see a static picture. That is the difference    │
 * │  between motion that explains something and motion nobody sees.    │
 * │                                                                    │
 * │  It disconnects after the FIRST intersection. A section that       │
 * │  re-animates every time it scrolls back into view is the looping   │
 * │  decoration this page is not allowed to have.                      │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * SSR-SAFE BY CONSTRUCTION. The first client render returns exactly what
 * the server rendered — `armed: false`, `seen: false` — and both flags
 * only ever change inside an effect, so there is no hydration mismatch.
 * With JavaScript off, `armed` stays false and the caller renders its
 * finished state, which is why the animation is expressed as "hide, then
 * reveal" rather than as a permanent starting style.
 */
export function useInView<T extends HTMLElement>(): {
  ref: React.RefObject<T | null>;
  /** The element may take its pre-animation state. Never true on the server. */
  armed: boolean;
  /** It has been scrolled to. Play the entrance.  */
  seen: boolean;
} {
  const ref = useRef<T>(null);
  const [armed, setArmed] = useState(false);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;

    /*
     * No IntersectionObserver — an old browser, or a test environment.
     * Show the finished state rather than a permanently hidden one.
     */
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }

    setArmed(true);
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setSeen(true);
        observer.disconnect();
      },
      // A fifth of it on screen: enough that the motion is noticed, not
      // so much that a short viewport never reaches the threshold.
      { threshold: 0.2 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, armed, seen };
}
