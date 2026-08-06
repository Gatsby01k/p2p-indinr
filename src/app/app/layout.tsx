import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { currentUser } from '@/server/sandbox/session';
import { getChrome } from '@/server/sandbox/chrome';
import { signOutAction } from '@/server/sandbox/actions';
import { sweepLapsedDeals } from '@/server/sandbox/service';
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
 * The lapsed-window sweep runs here rather than on a schedule because this
 * sandbox has no worker process. It is idempotent, evaluated against the
 * database clock, and only ever touches deals nobody has paid on — so
 * running it on every authenticated navigation is safe and keeps the state
 * a person sees honest. It releases, refunds and completes nothing.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login?next=/app');

  const [{ disputeCount }] = await Promise.all([getChrome(), sweepLapsedDeals()]);

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
