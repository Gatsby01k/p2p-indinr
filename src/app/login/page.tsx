import Link from 'next/link';
import { signInAction } from '@/server/sandbox/actions';
import { SandboxBanner } from '@/components/sandbox/SandboxChrome';

export const dynamic = 'force-dynamic';

/**
 * Sandbox sign-in.
 *
 * No password is asked for, accepted or stored — this authenticates nobody in
 * the real world and must never be reused for anything that holds value. It
 * exists so the server has a real notion of "who is asking".
 *
 * INTENT PRESERVATION: only the destination is carried across sign-in, via
 * `next`, and only when it is a same-origin relative path. No rate, no quote
 * id and no expiry is preserved, because an indicative rate is not binding and
 * re-showing one after sign-in would present a stale price as if it still held.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const dest = next && next.startsWith('/') && !next.startsWith('//') ? next : '/app';

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50">
      <SandboxBanner />
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-3xl items-center px-4 sm:px-6">
          <Link href="/" className="text-sm font-semibold tracking-tight text-slate-900">
            INRP2P <span className="font-normal text-slate-400">Sandbox</span>
          </Link>
        </div>
      </header>

      <main id="main" className="flex flex-1 items-center">
        <div className="mx-auto w-full max-w-sm px-4 py-10 sm:px-6">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h1 className="text-lg font-semibold tracking-tight text-slate-900">Sign in</h1>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
              Sandbox sign-in. Any address works and no password is stored.
            </p>

            <form action={signInAction} className="mt-5 space-y-4">
              <input type="hidden" name="next" value={dest} />
              <label className="block">
                <span className="text-xs font-medium text-slate-700">Email</span>
                <input
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.in"
                  aria-label="Email"
                  className="mt-1 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm"
                />
              </label>
              <button
                type="submit"
                className="h-11 w-full rounded-lg bg-slate-900 text-sm font-medium text-white hover:bg-slate-800"
              >
                Continue
              </button>
            </form>

            <div className="mt-5 rounded-lg bg-slate-50 p-3">
              <p className="text-xs font-medium text-slate-700">Sandbox accounts</p>
              <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                <li>
                  <code className="text-slate-800">ops@…</code> — operator
                </li>
                <li>
                  <code className="text-slate-800">new@…</code> — unverified, cannot join
                </li>
                <li>anything else — a verified trader</li>
              </ul>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
