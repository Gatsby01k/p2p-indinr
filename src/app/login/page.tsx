import { signInAction } from '@/server/sandbox/actions';
import { TopBar } from '@/components/kit/AppChrome';
import { ExchangeRail, Label, SandboxLine, Shell, buttonClass } from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * Sign in — a continuation of an intention, not a portal door.
 *
 * INTENT: only the destination travels across authentication, and only as
 * a same-origin relative path. No rate, quote id or expiry is preserved,
 * because an indicative rate is not binding and restating one after sign-in
 * would present a stale price as if it still held. The page says so.
 *
 * ⚠ No password is asked for, accepted or stored. This authenticates
 * nobody in the real world and must never be reused for anything holding
 * value; it exists so the server has a real notion of who is asking.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; amount?: string }>;
}) {
  const { next } = await searchParams;
  const dest = next && next.startsWith('/') && !next.startsWith('//') ? next : '/app';

  // Surface the carried intent so the person sees nothing was lost.
  const amount = /\/app\/new\?amount=([0-9.]+)/.exec(dest)?.[1] ?? null;

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar suffix="Sandbox" />
      <main id="main" className="flex flex-1 items-center py-8 sm:py-12">
        <Shell width="form">
          {amount ? (
            <div className="mb-5 rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-paper)] p-4">
              <Label>Carried from the calculator</Label>
              <p className="tnum mt-1.5 text-[length:var(--text-xl)] font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
                {amount}{' '}
                <span className="text-[length:var(--text-sm)] font-medium text-[var(--color-ink-3)]">
                  USDT
                </span>
              </p>
              <div className="my-3">
                <ExchangeRail caption="rate set after sign-in" />
              </div>
              <p className="text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                Your amount is kept. The rate is not — the one you saw was indicative. The server
                issues a fresh firm quote, with its own expiry, when you create the link.
              </p>
            </div>
          ) : null}

          <div className="rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--color-paper)] p-5 sm:p-6">
            <h1 className="text-[length:var(--text-xl)] font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
              {amount ? 'Sign in to continue' : 'Sign in'}
            </h1>
            <p className="mt-1.5 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
              Sandbox sign-in. Any address works and no password is stored.
            </p>

            <form action={signInAction} className="mt-5 space-y-3">
              <input type="hidden" name="next" value={dest} />
              <div>
                <label
                  htmlFor="email"
                  className="text-[length:var(--text-xs)] font-medium text-[var(--color-ink-2)]"
                >
                  Email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.in"
                  className="tap mt-1.5 w-full rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-paper)] px-3 text-[length:var(--text-base)] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)]"
                />
              </div>
              <button type="submit" className={buttonClass('primary', 'lg', true)}>
                Continue
              </button>
            </form>

            <div className="mt-5 border-t border-[var(--color-line)] pt-4">
              <Label>Sandbox accounts</Label>
              <ul className="mt-2 space-y-1 text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
                <li>
                  <code className="font-mono text-[var(--color-ink)]">ops@…</code> — operator
                </li>
                <li>
                  <code className="font-mono text-[var(--color-ink)]">new@…</code> — unverified,
                  cannot join
                </li>
                <li>anything else — a verified trader</li>
              </ul>
            </div>
          </div>

          <SandboxLine className="mt-4" />
        </Shell>
      </main>
    </div>
  );
}
