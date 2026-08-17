import { BenefitBand } from './BenefitBand';
import { FeeProgression } from './FeeProgression';
import { LandingShell } from './LandingShell';
import { RewardReceipt } from './RewardReceipt';

/**
 * What completing deals is worth.
 *
 * The fee path and the receipt sit side by side on a wide screen because
 * they are the two halves of one claim — the ladder says fees CAN fall,
 * the receipt shows what one finished deal actually produced. Reading
 * either alone leaves the claim unsupported, which is why the brief asks
 * for them together and why the grid keeps them on one row from 1120px.
 *
 * On a phone the order is the argument's own: headline, the ladder, then
 * the receipt directly beneath it.
 */
export function RewardsSection() {
  return (
    <section
      id="rewards"
      className="scroll-mt-24 border-t border-[var(--color-line)] bg-[var(--color-canvas)]"
    >
      <LandingShell className="py-14 sm:py-20 lg:py-24">
        <p className="text-[length:var(--text-2xs)] font-bold uppercase tracking-[0.14em] text-[var(--color-brand)]">
          Rewards, not gimmicks.
        </p>
        <h2 className="mt-4 max-w-[24ch] text-[clamp(1.9rem,3.4vw,2.85rem)] font-bold leading-[1.06] tracking-[-0.04em] text-[var(--color-ink)] [text-wrap:balance]">
          Every good deal makes the next one better.
        </h2>
        <p className="mt-4 max-w-[52ch] text-[length:var(--text-lg)] leading-relaxed text-[var(--color-ink-2)]">
          Complete safely. Build trust. Unlock lower fees and useful perks.
        </p>

        <div className="mt-9 grid items-start gap-4 min-[1120px]:grid-cols-[minmax(0,1fr)_25rem] min-[1120px]:gap-6 lg:mt-11">
          <FeeProgression />

          <div className="min-w-0">
            {/*
              The receipt in words. The card is `aria-hidden`: it is an
              illustration of one completed deal, nothing in it is
              focusable, and `View receipt` opens nothing.
            */}
            <p className="sr-only">
              An illustration of a completed deal: ₹83,600 paid, 1,000 USDT released, Trust +12
              earned, and the two benefits it unlocked — 10% off the next fee, and one day of
              Premium.
            </p>
            <RewardReceipt />
          </div>
        </div>

        <BenefitBand />
      </LandingShell>
    </section>
  );
}
