'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { NavKey } from './AppChrome';

/**
 * Which navigation destination the current URL belongs to.
 *
 * Derived from the pathname in one place rather than passed down by every
 * page, because a page that forgets the prop leaves the tab bar showing the
 * wrong tab — a small bug that makes the whole app feel broken.
 *
 * The mapping is deliberately by PREFIX: `/app/deal/abc/pay` is still the
 * Deals section, and `/app/profile/payment-methods` is still Profile.
 */
export function activeNavFor(pathname: string): NavKey {
  if (pathname.startsWith('/app/ops')) return 'ops';
  if (pathname.startsWith('/app/rewards')) return 'rewards';
  if (
    pathname.startsWith('/app/profile') ||
    pathname.startsWith('/app/settings') ||
    pathname.startsWith('/app/help') ||
    pathname.startsWith('/app/notifications')
  ) {
    return 'profile';
  }
  if (pathname.startsWith('/app/deal') || pathname.startsWith('/app/new')) return 'deals';
  return 'home';
}

export function NavActive({ children }: { children: (active: NavKey) => ReactNode }) {
  return <>{children(activeNavFor(usePathname()))}</>;
}
