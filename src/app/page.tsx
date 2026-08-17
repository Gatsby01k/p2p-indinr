import { Calculator } from '@/components/kit/Calculator';
import { Label, Shell } from '@/components/kit/primitives';
import { DealEngine } from '@/components/landing/DealEngine';
import { DealRoomShowcase } from '@/components/landing/DealRoomShowcase';
import { FaqSection } from '@/components/landing/FaqSection';
import { FinalCta } from '@/components/landing/FinalCta';
import { Hero } from '@/components/landing/Hero';
import { LandingHeader } from '@/components/landing/LandingHeader';
import { ProtectionRail } from '@/components/landing/ProtectionRail';
import { ProtectionSystem } from '@/components/landing/ProtectionSystem';
import { RewardsSection } from '@/components/landing/RewardsSection';
import { ShareAnywhere } from '@/components/landing/ShareAnywhere';
import { SiteFooter } from '@/components/landing/SiteFooter';
import { TelegramSection } from '@/components/landing/TelegramSection';
import { TrustSection } from '@/components/landing/TrustSection';
import { MINI_APP_BASE } from '@/lib/miniApp';

/**
 * The landing page, in the order the product happens.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  CREATE → SHARE → JOIN → DEAL ROOM → PROTECT → COMPLETE →          │
 * │  EARN TRUST → PAY LESS → REPEAT                                    │
 * │                                                                    │
 * │  Every section below answers exactly one step of that sentence,    │
 * │  and none of them answers a step twice:                            │
 * │                                                                    │
 * │    Hero            what this is                                    │
 * │    Share anywhere  where the link goes, and the four moves         │
 * │    Deal engine     the three directions, one composer              │
 * │    Deal room       what happens after somebody joins               │
 * │    Protection rail the five states a deal passes through           │
 * │    Rewards         what completing deals is worth                  │
 * │    Trust           why the history compounds, and the loop         │
 * │    Telegram        the fastest way in, and the web fallback        │
 * │    Protection      where protected value can be, and who may move  │
 * │    FAQ             the four questions asked before committing      │
 * │    Fee check       your own amount, priced before anything exists  │
 * │    Final CTA       the two ways to start                           │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ⚠ WHAT LANDING-04 REMOVED, AND WHY.
 *
 * Three blocks from the pre-LANDING-01 page were carried along through
 * the earlier stages because their replacements had not been built yet.
 * They now say something a purpose-built section says better, so they
 * are gone rather than left to compete:
 *
 *   `Three ways to use it`  three cards for the three corridors — the
 *                           Deal Engine is those three corridors, live.
 *   `How it holds up`       six written guarantees — the Protection
 *                           section states the same rules as the states
 *                           and safeguards that enforce them.
 *   the old footer          replaced by `SiteFooter`, and with it the
 *                           public sandbox disclosure, which LANDING-04
 *                           removes from the marketing page. It still
 *                           renders on `/login` and on a shared deal
 *                           link — where somebody is about to act.
 *
 * THE CALCULATOR STAYS. It is the one surface that prices an ARBITRARY
 * amount and carries it across sign-in, which the Deal Engine's fixed
 * illustration cannot do, and it is the subject of a journey in the
 * repository's browser gate. It sits after the FAQ, where "when do I see
 * the fee?" has just been answered and the answer can be tried.
 */
export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      {/*
        `MINI_APP_BASE` is read once, here, and handed down. It is the
        single typed place `NEXT_PUBLIC_TELEGRAM_MINI_APP` is parsed and
        validated. When it is null every Telegram control renders as
        visibly unavailable and says why — it never guesses an address
        and never quietly sends anybody somewhere else.
      */}
      <LandingHeader miniAppUrl={MINI_APP_BASE} />

      <main id="main" className="flex-1">
        {/* ---- LANDING-01 ----------------------------------------- */}
        <Hero miniAppUrl={MINI_APP_BASE} />
        <ShareAnywhere />

        {/* ---- LANDING-02 ----------------------------------------- */}
        <DealEngine />
        <DealRoomShowcase />
        <ProtectionRail />

        {/* ---- LANDING-03 ----------------------------------------- */}
        <RewardsSection />
        <TrustSection />

        {/* ---- LANDING-04 ----------------------------------------- */}
        <TelegramSection miniAppUrl={MINI_APP_BASE} />
        <ProtectionSystem />
        <FaqSection />

        {/* The live figure, for the amount somebody actually has. */}
        <section className="border-t border-[var(--color-line)] bg-[var(--color-paper)]">
          <Shell width="wide" className="py-12 sm:py-16">
            <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_27rem] lg:gap-16">
              <div>
                <Label>Check the figure</Label>
                <h2 className="mt-3 text-[length:var(--text-3xl)] font-semibold leading-[1.08] tracking-[-0.035em] text-[var(--color-ink)] sm:text-[length:var(--text-4xl)]">
                  Your amount, priced
                  <br />
                  before anything exists.
                </h2>
                <p className="mt-4 max-w-[42ch] text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink-2)] sm:text-[length:var(--text-lg)]">
                  Put in the figure you actually have. Nothing is created, quoted or charged until
                  you say so.
                </p>
              </div>
              <Calculator />
            </div>
          </Shell>
        </section>

        <FinalCta miniAppUrl={MINI_APP_BASE} />
      </main>

      <SiteFooter />
    </div>
  );
}
