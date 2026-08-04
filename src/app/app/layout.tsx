import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/server/sandbox/session';
import { signOutAction } from '@/server/sandbox/actions';
import { SandboxBanner } from '@/components/sandbox/SandboxChrome';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  // Redirect before rendering, so signed-out visitors never receive app chrome.
  if (!user) redirect('/login?next=/app');

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50">
      <SandboxBanner />
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/app" className="text-sm font-semibold tracking-tight text-slate-900">
            INRP2P <span className="font-normal text-slate-400">Sandbox</span>
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <span className="hidden text-slate-600 sm:inline">{user.displayName}</span>
            {user.isOperator ? (
              <Link href="/app/ops" className="font-medium text-slate-700 hover:text-slate-900">
                Operator
              </Link>
            ) : null}
            <form action={signOutAction}>
              <button type="submit" className="font-medium text-slate-700 hover:text-slate-900">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main id="main" className="flex-1">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">{children}</div>
      </main>
    </div>
  );
}
