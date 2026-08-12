import { signInAction } from '@/services/actions';
import { TopBar } from '@/components/kit/AppChrome';
import { Icon } from '@/components/kit/Icon';
import {
  Callout,
  Card,
  Label,
  SandboxChip,
  SandboxLine,
  Shell,
  buttonClass,
} from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * Sign in — a continuation of an intention, not a portal door.
 *
 * INTENT: only the destination travels across authentication, and only as a
 * same-origin relative path. No rate, quote id or expiry is preserved,
 * because an indicative rate is not binding and restating one after sign-in
 * would present a stale price as if it still held. The page says so.
 *
 * ⚠ No password is asked for, accepted or stored. This authenticates nobody
 * in the real world and must never be reused for anything holding value; it
 * exists so the server has a real notion of who is asking.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; invite?: string }>;
}) {
  const { next, invite } = await searchParams;
  const dest = next && next.startsWith('/') && !next.startsWith('//') ? next : '/app';

  // Surface the carried intent so the person sees nothing was lost.
  const amount = /[?&]amount=([0-9.]+)/.exec(dest)?.[1] ?? null;
  const scenario = /[?&]scenario=([A-Z_]+)/.exec(dest)?.[1] ?? null;
  const joining = dest.startsWith('/d/');
  const code = /^[a-z0-9]{6,16}$/.test(invite ?? '') ? invite! : '';

  const scenarioLabel =
    scenario === 'INR_TO_USDT'
      ? 'Buy USDT'
      : scenario === 'USDT_TO_INR'
        ? 'Sell USDT'
        : scenario === 'INR_TO_INR'
          ? 'Protected payment'
          : null;

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar right={<SandboxChip />} />

      <main id="main" className="flex flex-1 items-center py-6 sm:py-12">
        <Shell width="form">
          {/* ---- What is being carried across --------------------- */}
          {amount ? (
            <Card className="mb-4" tone="brand">
              <Label>Carried from the calculator</Label>
              <p className="tnum mt-1.5 text-[length:var(--text-2xl)] font-semibold tracking-[-0.028em] text-[var(--color-ink)]">
                {scenario === 'USDT_TO_INR' ? `${amount} USDT` : `₹${amount}`}
              </p>
              {scenarioLabel ? (
                <p className="mt-0.5 text-[length:var(--text-xs)] font-medium text-[var(--color-brand-ink)]">
                  {scenarioLabel}
                </p>
              ) : null}
              <p className="mt-3 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-2)]">
                Your amount is kept. The rate is not — the one you saw was indicative. The server
                issues a fresh firm quote, with its own expiry, when you create the deal.
              </p>
            </Card>
          ) : null}

          {joining ? (
            <Callout tone="info" icon="shield" className="mb-4">
              You will come straight back to the deal you were opening. Joining is first-come — if
              someone takes it moments before you, the server says so and nothing is charged.
            </Callout>
          ) : null}

          {code ? (
            <Callout tone="action" icon="gift" className="mb-4">
              You were invited. Your inviter earns SafePoints when you complete your first protected
              deal — never for signing up.
            </Callout>
          ) : null}

          {/* ---- The form ----------------------------------------- */}
          <Card>
            <h1 className="text-[length:var(--text-xl)] font-semibold tracking-[-0.025em] text-[var(--color-ink)]">
              {amount || joining ? 'Sign in to continue' : 'Sign in'}
            </h1>
            <p className="mt-1.5 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
              Sandbox sign-in. Any address works, and no password is asked for or stored.
            </p>

            <form action={signInAction} className="mt-5 space-y-3">
              <input type="hidden" name="next" value={dest} />
              <input type="hidden" name="invite" value={code} />
              <div>
                <label
                  htmlFor="email"
                  className="text-[length:var(--text-xs)] font-semibold text-[var(--color-ink-2)]"
                >
                  Email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  autoFocus
                  placeholder="you@example.in"
                  className="field mt-1.5 text-[length:var(--text-base)]"
                />
              </div>
              <button type="submit" className={buttonClass('primary', 'lg', true)}>
                <Icon name="arrow-right" className="h-4 w-4" />
                Continue
              </button>
            </form>

            <div className="mt-5 border-t border-[var(--color-line)] pt-4">
              <Label>Sandbox accounts</Label>
              <ul className="mt-2 space-y-1.5 text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
                <li>
                  <code className="font-mono font-semibold text-[var(--color-ink)]">ops@…</code> —
                  an operator, with the Deal Desk
                </li>
                <li>
                  <code className="font-mono font-semibold text-[var(--color-ink)]">new@…</code> —
                  unverified, cannot join a deal
                </li>
                <li>anything else — a verified trader</li>
              </ul>
            </div>
          </Card>

          <Callout tone="risk" icon="lock" className="mt-4">
            <strong className="font-semibold">Never enter a real password here.</strong> There is no
            password field, nothing is stored, and this account protects nothing.
          </Callout>

          <SandboxLine className="mt-3" full />
        </Shell>
      </main>
    </div>
  );
}
