import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { currentUser } from '@/server/sandbox/session';
import { signOutAction } from '@/server/sandbox/actions';
import { TopBar } from '@/components/kit/AppChrome';
import { SandboxChip } from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * Authenticated shell.
 *
 * Redirects before rendering, so a signed-out visitor never receives app
 * chrome or any hint of its contents. `pb-24 md:pb-0` reserves exactly the
 * height of the fixed mobile bottom bar so it can never cover content.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login?next=/app');

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
        href="/app"
        suffix="Sandbox"
        right={
          <>
            <SandboxChip />
            <span className="hidden text-[length:var(--text-sm)] text-[var(--color-ink-3)] lg:inline">
              {user.displayName}
            </span>
            <form action={signOutAction}>
              <button
                type="submit"
                className="tap rounded-[var(--radius-sm)] px-2 text-[length:var(--text-sm)] font-medium text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                Sign out
              </button>
            </form>
          </>
        }
      />
      <main id="main" className="flex-1 pb-24 md:pb-0">
        {children}
      </main>
    </div>
  );
}
