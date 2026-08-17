import Link from 'next/link';
import { Calculator } from '@/components/kit/Calculator';
import { Icon, type IconName } from '@/components/kit/Icon';
import { ActionLink, Card, Label, Shell } from '@/components/kit/primitives';
import { DealEngine } from '@/components/landing/DealEngine';
import { DealRoomShowcase } from '@/components/landing/DealRoomShowcase';
import { Hero } from '@/components/landing/Hero';
import { LandingHeader } from '@/components/landing/LandingHeader';
import { ProtectionRail } from '@/components/landing/ProtectionRail';
import { RewardsSection } from '@/components/landing/RewardsSection';
import { ShareAnywhere } from '@/components/landing/ShareAnywhere';
import { TrustSection } from '@/components/landing/TrustSection';
import { MINI_APP_BASE } from '@/lib/miniApp';

/**
 * Landing — the product, not a brochure.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  LANDING-01 rebuilt everything down to `Create once. Share         │
 * │  anywhere.`: the header, the hero, and the layered product         │
 * │  demonstration beside it.                                          │
 * │                                                                    │
 * │  Everything BELOW that line is the previous landing page, kept     │
 * │  deliberately and untouched. The calculator is a working product   │
 * │  surface with a real handoff into `/app/new`, and the two sections │
 * │  under it are the honest statement of what the product guarantees. │
 * │  Deleting them now would leave the page ending mid-sentence and    │
 * │  would break the calculator journey the browser gate exercises;    │
 * │  the later landing stages replace them in place.                   │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Trust is shown through product behaviour that actually exists: one joiner,
 * server-held terms, an honest loss of a race, a written ruling. No invented
 * volume, licences, user counts or success rates, and no claim about
 * encryption or banking partners that this build cannot back.
 */
export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      {/*
        `MINI_APP_BASE` is read once, here, and handed down. It is compiled
        from `NEXT_PUBLIC_TELEGRAM_MINI_APP` at build time, so a deployment
        that has not set it renders Telegram controls that say — in their
        accessible name — that they open the web app instead.
      */}
      <LandingHeader miniAppUrl={MINI_APP_BASE} />

      <main id="main" className="flex-1">
        <Hero miniAppUrl={MINI_APP_BASE} />
        <ShareAnywhere />

        {/* ---- LANDING-02 ----------------------------------------- */}
        <DealEngine />
        <DealRoomShowcase />
        <ProtectionRail />

        {/* ---- LANDING-03 ----------------------------------------- */}
        <RewardsSection />
        <TrustSection />

        {/* ---- Retained from the previous landing page ------------ */}

        {/* The calculator: the product itself, and the existing route
            into `/app/new` across sign-in. */}
        <section className="border-t border-[var(--color-line)] bg-[var(--color-canvas)]">
          <Shell width="wide" className="py-12 sm:py-16">
            <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_27rem] lg:gap-16">
              <div>
                <Label>Work out a deal</Label>
                <h2 className="mt-3 text-[length:var(--text-3xl)] font-semibold leading-[1.08] tracking-[-0.035em] text-[var(--color-ink)] sm:text-[length:var(--text-4xl)]">
                  See the figure before
                  <br />
                  anything is created.
                </h2>
                <p className="mt-4 max-w-[42ch] text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink-2)] sm:text-[length:var(--text-lg)]">
                  Fix the amount and see the fee first. Nothing is created, quoted or charged until
                  you say so.
                </p>
              </div>
              <Calculator />
            </div>
          </Shell>
        </section>

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
        <section id="safety" className="scroll-mt-24 border-t border-[var(--color-line)]">
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
          {/*
            The sandbox position, stated in full. LANDING-01 removed the
            `Sandbox · no real funds` CHIP from the header — the badge a
            visitor met before they knew what the product was — and not
            this. A build that holds no funds has to say so somewhere a
            person can read it, and this is that place.
          */}
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
