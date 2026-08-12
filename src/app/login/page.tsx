import { SignInFlow } from '@/components/flows/SignInFlow';
import { TopBar } from '@/components/kit/AppChrome';
import { Callout, Card, Label, SandboxChip, SandboxLine, Shell } from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * Sign in — a continuation of an intention, not a portal door.
 *
 * INTENT: only the destination travels across authentication, and only as a
 * same-origin relative path. No rate, quote id or expiry is preserved,
 * because an indicative rate is not binding and restating one after sign-in
 * would present a stale price as if it still held. The page says so.
 *
 * ⚠ No password is asked for, accepted or stored — and nothing is signed in
 * without proof either. A one-time code goes to the address and must come
 * back before a session exists (DEL-03). The code proves control of that
 * mailbox and the copy says exactly that, rather than implying an identity
 * check nobody performed.
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
              We email you a one-time code. No password is asked for, chosen or stored.
            </p>

            <SignInFlow next={dest} invite={code} />
          </Card>

          <Callout tone="risk" icon="lock" className="mt-4">
            <strong className="font-semibold">We will never ask you for a password.</strong> There
            is no password field anywhere in this product, and nobody from INRP2P will ever ask you
            for your sign-in code.
          </Callout>

          <SandboxLine className="mt-3" full />
        </Shell>
      </main>
    </div>
  );
}
