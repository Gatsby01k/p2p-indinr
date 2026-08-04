import Link from 'next/link';
import { Calculator } from '@/components/kit/Calculator';
import { TopBar } from '@/components/kit/AppChrome';
import { Mark } from '@/components/kit/Brand';
import { ActionLink, Label, SandboxChip, Shell } from '@/components/kit/primitives';

/**
 * Landing — exchange-first.
 *
 * MOBILE: the calculator is the first element after a two-line statement
 * of what this is, so FROM / AMOUNT / TO / RESULT / MOVE all sit inside
 * the first viewport on a 360×800 device without scrolling.
 *
 * DESKTOP: an asymmetric two-column composition — the argument on the
 * left with real width, the working product on the right. Not a narrow
 * card adrift in empty canvas.
 *
 * Trust is shown through product behaviour that actually exists (one
 * joiner, server-held terms, honest loss of a race). No invented volume,
 * licences, user counts or success rates.
 */
export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
        suffix="Sandbox"
        right={
          <>
            <SandboxChip />
            <ActionLink href="/login" variant="outline" size="sm">
              Sign in
            </ActionLink>
          </>
        }
      />

      <main id="main" className="flex-1">
        {/* ---- Above the fold ------------------------------------- */}
        <Shell width="wide" className="py-4 sm:py-10 lg:py-16">
          <div className="grid items-start gap-5 sm:gap-8 lg:grid-cols-[minmax(0,1fr)_26rem] lg:gap-16 xl:grid-cols-[minmax(0,1fr)_28rem]">
            {/* Statement — short on mobile so the calculator stays visible. */}
            <div className="lg:pt-6">
              <p className="flex items-center gap-2 text-[length:var(--text-xs)] font-medium text-[var(--color-ink-3)]">
                <Mark className="text-[var(--color-action)]" />
                INR ⇄ USDT settlement
              </p>
              <h1 className="mt-2.5 text-[length:var(--text-xl)] font-semibold leading-[1.12] tracking-[-0.03em] text-[var(--color-ink)] sm:mt-3 sm:text-[length:var(--text-3xl)] lg:text-[length:var(--text-4xl)]">
                One link.
                <br />
                One counterparty.
                <br />
                <span className="text-[var(--color-ink-3)]">One settled amount.</span>
              </h1>
              <p className="mt-3 max-w-[38ch] text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)] sm:mt-4 sm:text-[length:var(--text-base)] lg:text-[length:var(--text-lg)]">
                Fix the exact amounts, send the link into any chat, and settle with the one person
                who opens it.
                <span className="hidden sm:inline">
                  {' '}
                  No order book. No browsing. No strangers you did not choose.
                </span>
              </p>

              {/* Desktop-only: the four-step model, given room to breathe. */}
              <ol className="mt-10 hidden gap-px overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-line)] sm:grid sm:grid-cols-2 lg:mt-12 lg:grid-cols-4">
                {STEPS.map((s, i) => (
                  <li key={s.title} className="bg-[var(--color-canvas)] p-4">
                    <span className="tnum text-[length:var(--text-2xs)] font-semibold text-[var(--color-action)]">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <h2 className="mt-1.5 text-[length:var(--text-sm)] font-semibold text-[var(--color-ink)]">
                      {s.title}
                    </h2>
                    <p className="mt-1 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                      {s.body}
                    </p>
                  </li>
                ))}
              </ol>
            </div>

            {/* The product. */}
            <div className="lg:sticky lg:top-20">
              <Calculator />
            </div>
          </div>
        </Shell>

        {/* Mobile: the four steps, below the fold where they belong. */}
        <Shell width="wide" className="pb-10 sm:hidden">
          <ol className="grid gap-px overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-line)]">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-3 bg-[var(--color-canvas)] p-4">
                <span className="tnum mt-0.5 text-[length:var(--text-2xs)] font-semibold text-[var(--color-action)]">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div>
                  <h2 className="text-[length:var(--text-sm)] font-semibold text-[var(--color-ink)]">
                    {s.title}
                  </h2>
                  <p className="mt-0.5 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                    {s.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Shell>

        {/* ---- What the product actually guarantees ---------------- */}
        <section className="border-t border-[var(--color-line)] bg-[var(--color-paper)]">
          <Shell width="wide" className="py-10 sm:py-14">
            <Label>How it holds up</Label>
            <div className="mt-5 grid gap-8 sm:grid-cols-2 lg:grid-cols-3 lg:gap-12">
              {GUARANTEES.map((g) => (
                <div key={g.title} className="border-t border-[var(--color-ink)] pt-4">
                  <h3 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                    {g.title}
                  </h3>
                  <p className="mt-1.5 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
                    {g.body}
                  </p>
                </div>
              ))}
            </div>
          </Shell>
        </section>
      </main>

      <footer className="border-t border-[var(--color-line)]">
        <Shell
          width="wide"
          className="flex flex-col gap-3 py-6 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="max-w-[62ch] text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
            Sandbox build. No funds are held or moved, and no bank or blockchain connection exists.
            No regulatory registration, licence or partnership is claimed or implied, and nothing
            here is an offer to trade.
          </p>
          <Link
            href="/login"
            className="text-[length:var(--text-xs)] font-medium text-[var(--color-ink-2)] underline underline-offset-4"
          >
            Sign in
          </Link>
        </Shell>
      </footer>
    </div>
  );
}

const STEPS = [
  { title: 'Create', body: 'Fix the amount and get a firm, server-issued rate.' },
  { title: 'Share', body: 'Send the link through WhatsApp, Telegram or anywhere else.' },
  { title: 'One joins', body: 'The first eligible person takes the other side. Only one can.' },
  { title: 'Complete', body: 'Both sides track it to settlement in one deal room.' },
];

const GUARANTEES = [
  {
    title: 'Exactly one counterparty',
    body: 'Two people opening the same link cannot both join. The database decides the winner, and the person who lost is told plainly that nothing was charged.',
  },
  {
    title: 'The terms cannot drift',
    body: 'Amounts and rate are frozen when the link is created and copied into the deal unchanged. No later step re-derives a figure from a rate.',
  },
  {
    title: 'Nothing moves on a timer',
    body: 'No countdown releases, refunds or completes anything. Every state change is a person acting, or an operator ruling.',
  },
  {
    title: 'The link says what it is',
    body: 'Open, taken, expired and withdrawn are visually distinct, and a link that cannot be joined never shows a live Join button.',
  },
  {
    title: 'Private stays private',
    body: 'A shared link carries the terms and nothing else — no names, bank details, wallet addresses or payment references, in the page or its preview.',
  },
  {
    title: 'Only your side can act',
    body: 'The server decides which of the two actions you are permitted, and refuses the other. The interface only ever shows what it already allowed.',
  },
];
