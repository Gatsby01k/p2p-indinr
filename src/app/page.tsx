import Link from 'next/link';
import { Calculator } from '@/components/kit/Calculator';
import { TopBar } from '@/components/kit/AppChrome';
import { Icon, type IconName } from '@/components/kit/Icon';
import { ActionLink, Card, Label, SandboxChip, Shell } from '@/components/kit/primitives';

/**
 * Landing — the product, not a brochure.
 *
 * MOBILE: a two-line statement of what this is, then the calculator, so
 * FROM / AMOUNT / TO / RESULT / MOVE all sit inside the first viewport on a
 * 360×800 device without scrolling.
 *
 * DESKTOP: an asymmetric two-column composition — the argument on the left
 * with real width, the working product on the right. Not a narrow card
 * adrift in empty canvas.
 *
 * Trust is shown through product behaviour that actually exists: one joiner,
 * server-held terms, an honest loss of a race, a written ruling. No invented
 * volume, licences, user counts or success rates, and no claim about
 * encryption or banking partners that this build cannot back.
 */
export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
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
        <Shell width="wide" className="py-6 sm:py-12 lg:py-16">
          <div className="grid items-start gap-7 sm:gap-10 lg:grid-cols-[minmax(0,1fr)_27rem] lg:gap-16 xl:grid-cols-[minmax(0,1fr)_29rem]">
            <div className="lg:pt-6">
              <p className="flex items-center gap-2 text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.07em] text-[var(--color-brand)]">
                <Icon name="shield-check" className="h-4 w-4" />
                DealSafe India
              </p>
              <h1 className="mt-3 text-[length:var(--text-3xl)] font-semibold leading-[1.08] tracking-[-0.035em] text-[var(--color-ink)] sm:text-[length:var(--text-4xl)] lg:text-[length:var(--text-5xl)]">
                Send the money.
                <br />
                Keep the leverage.
              </h1>
              <p className="mt-4 max-w-[42ch] text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink-2)] sm:text-[length:var(--text-lg)]">
                Protected deals for Indian freelancers, buyers and traders. Fix the amount, share
                one link, and the money is only released when the person receiving it says it
                arrived.
              </p>

              {/* Desktop-only: the four-step model, given room to breathe. */}
              <ol className="mt-10 hidden gap-px overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-line)] sm:grid sm:grid-cols-2 lg:mt-12 lg:grid-cols-4">
                {STEPS.map((s, i) => (
                  <li key={s.title} className="bg-[var(--color-paper)] p-4">
                    <span className="tnum text-[length:var(--text-2xs)] font-bold text-[var(--color-brand)]">
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

            <div className="lg:sticky lg:top-24">
              <Calculator />
            </div>
          </div>
        </Shell>

        {/* Mobile: the four steps, below the fold where they belong. */}
        <Shell width="wide" className="pb-10 sm:hidden">
          <ol className="grid gap-px overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-line)]">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-3 bg-[var(--color-paper)] p-4">
                <span className="tnum mt-0.5 text-[length:var(--text-2xs)] font-bold text-[var(--color-brand)]">
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

        {/* ---- The three scenarios -------------------------------- */}
        <section className="border-t border-[var(--color-line)] bg-[var(--color-paper)]">
          <Shell width="wide" className="py-10 sm:py-14">
            <Label>Three ways to use it</Label>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              {USES.map((u) => (
                <Card key={u.title} className="h-full">
                  <span className={`grid h-11 w-11 place-items-center rounded-full ${u.tint}`}>
                    <Icon name={u.icon} className="h-5 w-5" strokeWidth={2} />
                  </span>
                  <h3 className="mt-3.5 text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
                    {u.title}
                  </h3>
                  <p className="mt-1.5 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
                    {u.body}
                  </p>
                </Card>
              ))}
            </div>
          </Shell>
        </section>

        {/* ---- What the product actually guarantees ---------------- */}
        <section className="border-t border-[var(--color-line)]">
          <Shell width="wide" className="py-10 sm:py-14">
            <Label>How it holds up</Label>
            <div className="mt-5 grid gap-8 sm:grid-cols-2 lg:grid-cols-3 lg:gap-12">
              {GUARANTEES.map((g) => (
                <div key={g.title} className="border-t-2 border-[var(--color-ink)] pt-4">
                  <h3 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                    {g.title}
                  </h3>
                  <p className="mt-1.5 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
                    {g.body}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
              <ActionLink href="/login" variant="primary" size="lg" icon="shield">
                Create a protected deal
              </ActionLink>
              <p className="text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                Sandbox sign-in. Any address works and no password is stored.
              </p>
            </div>
          </Shell>
        </section>
      </main>

      <footer className="border-t border-[var(--color-line)] bg-[var(--color-paper)]">
        <Shell
          width="wide"
          className="flex flex-col gap-3 py-6 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="max-w-[68ch] text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
            <strong className="font-semibold text-[var(--color-hold)]">Sandbox build.</strong> No
            funds are held or moved, and no bank or blockchain connection exists. No regulatory
            registration, licence or partnership is claimed or implied, and nothing here is an offer
            to trade.
          </p>
          <Link
            href="/login"
            /*
             * `min-h-6` is 24px: WCAG 2.2 AA 2.5.8. As a flex item this
             * link is block-level, so the inline-text exemption does not
             * apply to it and it was 18px tall — small enough to miss.
             * The inline-flex keeps it looking like the text link it is.
             */
            className="inline-flex min-h-6 items-center text-[length:var(--text-xs)] font-semibold text-[var(--color-ink-2)] underline underline-offset-4"
          >
            Sign in
          </Link>
        </Shell>
      </footer>
    </div>
  );
}

const STEPS = [
  { title: 'Set the terms', body: 'Fix the amount and see the fee before anything is created.' },
  { title: 'Share one link', body: 'WhatsApp, Telegram, email — anywhere a message goes.' },
  {
    title: 'One person joins',
    body: 'The first eligible person takes the other side. Only one can.',
  },
  { title: 'Release', body: 'The receiving side confirms, and both get a receipt.' },
];

const USES: readonly { title: string; body: string; icon: IconName; tint: string }[] = [
  {
    title: 'Freelance and services',
    body: 'Your client protects the money before you start, and releases it when the work lands. Neither of you has to go first on trust.',
    icon: 'briefcase',
    tint: 'bg-[var(--color-brand-tint)] text-[var(--color-brand)]',
  },
  {
    title: 'Buying and selling goods',
    body: 'The payment is held while the item moves. If it never arrives, a person reviews the case rather than a policy page.',
    icon: 'package',
    tint: 'bg-[var(--color-final-tint)] text-[var(--color-final)]',
  },
  {
    title: 'INR ⇄ USDT',
    body: 'A firm rate, one verified counterparty, and no order book full of strangers you did not choose.',
    icon: 'swap',
    tint: 'bg-[var(--color-info-tint)] text-[var(--color-info)]',
  },
];

const GUARANTEES = [
  {
    title: 'Exactly one counterparty',
    body: 'Two people opening the same link cannot both join. The database decides the winner, and the person who lost is told plainly that nothing was charged.',
  },
  {
    title: 'The terms cannot drift',
    body: 'Amounts, fees and rate are frozen when the deal is created and copied into it unchanged. No later step re-derives a figure from a rate.',
  },
  {
    title: 'Nothing moves on a timer',
    body: 'No countdown releases, refunds or completes anything. Every state change is a person acting, or an operator ruling with a written reason.',
  },
  {
    title: 'The link says what it is',
    body: 'Open, taken, expired and withdrawn are visually distinct, and a link that cannot be joined never shows a live Join button.',
  },
  {
    title: 'Private stays private',
    body: 'A shared link carries the terms and nothing else. Names, bank details, references and proofs exist only inside the deal, to the two sides.',
  },
  {
    title: 'Only your side can act',
    body: 'The server decides which of the two actions you are permitted and refuses the other. The interface only ever shows what it already allowed.',
  },
];
