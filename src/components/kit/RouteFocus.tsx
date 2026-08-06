'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * Move focus to the page heading after a client-side route change.
 *
 * Without this, a single-page navigation leaves focus wherever the person
 * clicked — often a link in a list that no longer exists — so a screen
 * reader announces nothing and a keyboard user's next Tab starts from the
 * document top. Browsers do this for free on a full page load; a client
 * router has to do it deliberately.
 *
 * The heading takes `tabindex="-1"` only for the moment it is focused, so
 * it never enters the tab order itself. The first render is skipped: on
 * initial load the browser's own focus behaviour is correct and stealing
 * it would fight the skip link.
 */
export function RouteFocus() {
  const pathname = usePathname();
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const target =
      document.querySelector<HTMLElement>('main h1') ?? document.querySelector<HTMLElement>('main');
    if (!target) return;

    const hadTabIndex = target.hasAttribute('tabindex');
    if (!hadTabIndex) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    // Release it so the heading is not a tab stop for the rest of the visit.
    const release = () => {
      if (!hadTabIndex) target.removeAttribute('tabindex');
      target.removeEventListener('blur', release);
    };
    target.addEventListener('blur', release);
  }, [pathname]);

  return null;
}
