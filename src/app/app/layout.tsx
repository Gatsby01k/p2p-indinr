import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { currentUser, getChrome } from '@/services';
import { signOutAction } from '@/services/actions';
import { AppFrame } from '@/components/kit/AppChrome';
import { ToastProvider } from '@/components/kit/Feedback';
import { Icon } from '@/components/kit/Icon';

export const dynamic = 'force-dynamic';

/**
 * The authenticated shell.
 *
 * Redirects before rendering, so a signed-out visitor never receives app
 * chrome or any hint of its contents.
 *
 * ⚠ NO LIFECYCLE MUTATION HAPPENS HERE ANY MORE.
 *
 * This layout used to call `sweepLapsedDeals()` on every authenticated
 * navigation, which meant a financial state transition — `FIAT_PENDING →
 * EXPIRED`, for deals belonging to other people — occurred as a side
 * effect of somebody loading a page. An idle system expired nothing; a
 * busy one expired things at arbitrary moments (TS-00 `AUD-P1-003`).
 *
 * Expiry is now decided authoritatively at the boundary that touches a
 * deal, under its row lock, and by `runLifecycleSweep()` which DEL-09 will
 * schedule. Rendering reads; it does not decide.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login?next=/app');

  const { disputeCount } = await getChrome();

  return (
    <ToastProvider>
      <AppFrame
        isOperator={user.isOperator}
        displayName={user.displayName}
        disputeCount={disputeCount}
        /*
         * Rendered here, on the server, and handed across as an element.
         * That keeps `signOutAction` a real server action — a function
         * cannot cross the boundary, but the form that carries it can.
         */
        signOut={
          <form action={signOutAction}>
            <button
              type="submit"
              className="flex w-full items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2.5 text-left text-[length:var(--text-base)] font-medium text-[var(--color-nav-ink-2)] transition-colors hover:bg-[var(--color-nav-3)] hover:text-[var(--color-nav-ink)]"
            >
              <Icon name="logout" className="h-[18px] w-[18px]" />
              Sign out
            </button>
          </form>
        }
      >
        {children}
      </AppFrame>
    </ToastProvider>
  );
}
