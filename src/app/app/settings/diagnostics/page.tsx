import { getChrome } from '@/server/sandbox/chrome';
import { telegramConfigured } from '@/server/telegram/verify';
import { MINI_APP_BASE, MINI_APP_PROBLEM, MINI_APP_RAW } from '@/lib/miniApp';
import { publicOrigin } from '@/lib/publicUrl';
import { AppHeader } from '@/components/kit/AppChrome';
import { Icon } from '@/components/kit/Icon';
import { Callout, Card, SectionHead, Shell } from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * Deployment diagnostics.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THIS PAGE EXISTS BECAUSE A MISSING SETTING WAS INVISIBLE.         │
 * │                                                                    │
 * │  `NEXT_PUBLIC_TELEGRAM_MINI_APP` was unset in production. The      │
 * │  product did not fail — it quietly shared a web link instead of a  │
 * │  Telegram one, so deals were created, shared, and opened somewhere │
 * │  the sender did not expect. Finding that required grepping the     │
 * │  compiled JavaScript of the deployed bundle.                       │
 * │                                                                    │
 * │  Every value below is a BOOLEAN or a PUBLIC address. No secret is  │
 * │  rendered: not the bot token, not the connection string, not the   │
 * │  session key. The page reports whether each is USABLE, which is    │
 * │  the only question worth answering here.                           │
 * └────────────────────────────────────────────────────────────────────┘
 */

interface Check {
  readonly label: string;
  readonly ok: boolean;
  /** What is actually configured, when it is safe to show. */
  readonly value: string;
  /** What breaks while this is wrong. */
  readonly consequence: string;
  readonly fix: string;
}

export default async function DiagnosticsPage() {
  const { user, unread } = await getChrome();
  const origin = await publicOrigin();

  const secret = process.env.SANDBOX_SESSION_SECRET ?? '';
  const checks: readonly Check[] = [
    {
      label: 'Database',
      ok: Boolean(process.env.DATABASE_URL),
      // Only the host, never the credentials in front of it.
      value: hostOf(process.env.DATABASE_URL) ?? 'not set',
      consequence: 'Nothing loads: every screen in the app reads from it.',
      fix: 'Set DATABASE_URL to a pooled connection string, then run npm run db:migrate.',
    },
    {
      label: 'Sandbox acknowledged',
      ok: process.env.INRP2P_SANDBOX === 'true',
      value: process.env.INRP2P_SANDBOX ?? 'not set',
      consequence: 'Production refuses to construct the escrow adapter and the app will not start.',
      fix: 'Set INRP2P_SANDBOX=true.',
    },
    {
      label: 'Session signing key',
      ok: secret.length >= 16,
      value:
        secret.length >= 16 ? `configured, ${secret.length} characters` : 'missing or too short',
      consequence: 'Production refuses to sign session cookies, so nobody can stay signed in.',
      fix: 'Set SANDBOX_SESSION_SECRET to a long random value: openssl rand -base64 32',
    },
    {
      label: 'Public address',
      ok: Boolean(process.env.NEXT_PUBLIC_SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL),
      value: origin,
      consequence:
        'Shared deal links are built from whatever host the creator was browsing, which on Vercel can be a protected preview URL the recipient cannot open.',
      fix: 'Set NEXT_PUBLIC_SITE_URL to your canonical https address, then redeploy.',
    },
    {
      label: 'Telegram bot token',
      ok: telegramConfigured(),
      value: telegramConfigured() ? 'configured' : 'not set',
      consequence: 'The Mini App cannot sign anyone in: every launch is rejected.',
      fix: 'Set TELEGRAM_BOT_TOKEN to the token from @BotFather, then redeploy.',
    },
    {
      label: 'Telegram Mini App address',
      ok: MINI_APP_BASE !== null,
      /*
       * Shows the RAW configured value when it was rejected, not "not set".
       * Reading "not set" while looking at a filled-in field in Vercel sends
       * you hunting for the wrong problem.
       */
      value: MINI_APP_BASE ?? (MINI_APP_RAW ? `rejected: ${MINI_APP_RAW}` : 'not set'),
      consequence:
        'Deal links shared inside Telegram fall back to a web URL, so the recipient lands in a browser instead of on the deal in this app.',
      fix:
        MINI_APP_PROBLEM?.kind === 'INVALID'
          ? `${MINI_APP_PROBLEM.reason}. Fix the value, then REDEPLOY — it is compiled into the bundle at build time.`
          : 'Set NEXT_PUBLIC_TELEGRAM_MINI_APP to https://t.me/YourBot (main Mini App) or https://t.me/YourBot/app (named one), then REDEPLOY — it is compiled into the bundle at build time, so setting it alone changes nothing.',
    },
  ];

  const failing = checks.filter((c) => !c.ok);

  return (
    <>
      <AppHeader
        title="Diagnostics"
        subtitle={`${checks.length - failing.length} of ${checks.length} configured`}
        back={{ href: '/app/settings', label: 'Back to settings' }}
        unread={unread}
      />

      <Shell width="form" className="py-5 sm:py-7">
        {failing.length === 0 ? (
          <Callout tone="final" icon="check-circle">
            <strong className="font-semibold">Everything this deployment needs is set.</strong> The
            web app and the Telegram Mini App are both fully configured.
          </Callout>
        ) : (
          <Callout tone="hold" icon="alert">
            <strong className="font-semibold">
              {failing.length} setting{failing.length === 1 ? '' : 's'} missing.
            </strong>{' '}
            The app still runs — each one below says exactly what stops working while it is unset.
          </Callout>
        )}

        <section className="mt-5">
          <SectionHead title="Configuration" />
          <ul className="mt-3 space-y-3">
            {checks.map((check) => (
              <li key={check.label}>
                <Card
                  className={check.ok ? undefined : 'border-[var(--color-hold-line)]'}
                  tone={check.ok ? 'paper' : 'sunken'}
                >
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden
                      className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ${
                        check.ok
                          ? 'bg-[var(--color-final-tint)] text-[var(--color-final)]'
                          : 'bg-[var(--color-hold-tint)] text-[var(--color-hold)]'
                      }`}
                    >
                      <Icon
                        name={check.ok ? 'check' : 'alert'}
                        className="h-3 w-3"
                        strokeWidth={3}
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                        {check.label}
                        <span className="sr-only">{check.ok ? ' — configured' : ' — missing'}</span>
                      </p>
                      <p className="break-anywhere mt-0.5 font-mono text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
                        {check.value}
                      </p>
                      {check.ok ? null : (
                        <>
                          <p className="mt-2 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-2)]">
                            {check.consequence}
                          </p>
                          <p className="mt-1.5 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-hold)]">
                            {check.fix}
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </section>

        <p className="mt-5 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
          No secret is shown on this page. Each row reports whether a value is usable, never what it
          is — the database row shows its host only, and the session key its length.
          {user.isOperator ? '' : ' Anyone signed in can read this, so it stays that way.'}
        </p>
      </Shell>
    </>
  );
}

/** The host of a connection string, with any credentials discarded. */
function hostOf(connectionString: string | undefined): string | null {
  if (!connectionString) return null;
  try {
    return new URL(connectionString).host;
  } catch {
    return 'set, but not a parseable URL';
  }
}
