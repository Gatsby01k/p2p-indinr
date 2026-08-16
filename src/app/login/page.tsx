import { SignInFlow } from '@/components/flows/SignInFlow';
import { formatMinor } from '@/lib/format';
import { parseInrToMinor, parseUsdtToMicro } from '@/lib/parse';
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

  /*
   * Surface the carried intent so the person sees nothing was lost.
   *
   * MATCHED TO THE END OF THE VALUE, DELIBERATELY. The earlier pattern
   * was `[0-9.]+`, which matches a PREFIX: a carried "83,000" stopped at
   * the comma and this screen told the person their deal was for ₹83
   * while the deal form — applying an anchored pattern — dropped the
   * amount entirely. Showing a confidently wrong figure at the moment
   * somebody decides whether to sign in is worse than showing none, so
   * anything that is not a whole clean number now reads as absent.
   */
  const amount = /[?&]amount=(\d{1,12}(?:\.\d{1,6})?)(?:&|$)/.exec(dest)?.[1] ?? null;
  const scenario = /[?&]scenario=([A-Z_]+)(?:&|$)/.exec(dest)?.[1] ?? null;

  /*
   * Carried as a machine value, shown as a human one. The parameter is
   * an ungrouped decimal precisely so nothing has to guess at it; this
   * screen is the point it turns back into something a person reads, so
   * ₹83000 is presented as ₹83,000.00 like every other figure.
   */
  const carriedAsset = scenario === 'USDT_TO_INR' ? 'USDT' : 'INR';
  const carriedMinor =
    amount === null
      ? null
      : carriedAsset === 'USDT'
        ? parseUsdtToMicro(amount)
        : parseInrToMinor(amount);
  const amountLabel =
    carriedMinor === null ? null : formatMinor(carriedMinor.toString(), carriedAsset);
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
          {amountLabel ? (
            <Card className="mb-4" tone="brand">
              <Label>Carried from the calculator</Label>
              <p className="tnum mt-1.5 text-[length:var(--text-2xl)] font-semibold tracking-[-0.028em] text-[var(--color-ink)]">
                {carriedAsset === 'USDT' ? `${amountLabel} USDT` : `₹${amountLabel}`}
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
              {amountLabel || joining ? 'Sign in to continue' : 'Sign in'}
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
