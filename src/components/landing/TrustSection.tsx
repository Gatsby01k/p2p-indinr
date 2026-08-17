'use client';

import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/kit/Icon';
import { LandingShell } from './LandingShell';
import { TrustProfilePreview } from './TrustProfilePreview';
import { useInView } from './useInView';

/**
 * The loop, and the reason it is a loop.
 *
 * Complete → Earn Trust → Pay Less → Invite → Repeat. Each step is the
 * cause of the next, which is why they are drawn as one connected run
 * rather than five feature cards: the argument is the ARROWS, and a grid
 * of tiles would throw exactly the part worth saying.
 *
 * Near-black again, matching the Deal Room section — the two dark bands
 * are the two places the product itself is on screen at size, and using
 * the same ground ties them together down the page.
 *
 * ⚠ WHY THIS IS A CLIENT MODULE. One thing: the retention loop reveals
 * itself when it is scrolled to rather than on mount, because it sits
 * near the bottom of a long page and an on-mount reveal would be over
 * before anybody arrived. Everything else here is static markup.
 */
export function TrustSection() {
  const { ref, armed, seen } = useInView<HTMLOListElement>();

  return (
    <section className="bg-[var(--color-paper)]">
      <LandingShell className="pb-14 sm:pb-20 lg:pb-24">
        <div className="overflow-hidden rounded-[var(--radius-2xl)] bg-[var(--color-nav)] p-5 sm:p-8 lg:p-10 min-[1120px]:p-12">
          {/* 26rem, not 20.5: four trust dimensions share this column and
              `Completed deals` needs a line of its own to stay one line. */}
          <div className="grid gap-10 min-[1120px]:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] min-[1120px]:gap-12">
            {/* ---- The claim ------------------------------------ */}
            <div className="min-w-0">
              <h2 className="text-[clamp(1.9rem,3.4vw,2.85rem)] font-bold leading-[1.06] tracking-[-0.04em] text-[var(--color-nav-ink)] [text-wrap:balance]">
                Trust that compounds.
              </h2>
              <p className="mt-4 max-w-[40ch] text-[length:var(--text-md)] leading-relaxed text-[var(--color-nav-ink-2)]">
                Your history belongs to your next deal — not to a forgotten chat thread.
              </p>

              {/* What "history" is made of. */}
              <ul className="mt-8 grid grid-cols-2 gap-x-2 gap-y-6 sm:grid-cols-4 min-[1120px]:mt-10">
                {DIMENSIONS.map((dimension, i) => (
                  <li
                    key={dimension.label}
                    className={cn(
                      'flex flex-col items-center gap-3 text-center',
                      i > 0 && 'sm:border-l sm:border-[var(--color-nav-3)]',
                    )}
                  >
                    <span className="grid h-10 w-10 place-items-center rounded-full border border-[var(--color-nav-3)] text-[var(--color-nav-ink)]">
                      <Icon name={dimension.icon} className="h-5 w-5" strokeWidth={1.7} />
                    </span>
                    <span className="text-[length:var(--text-xs)] leading-tight text-[var(--color-nav-ink-2)]">
                      {dimension.label}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* ---- The evidence, and the loop it feeds ---------- */}
            <div className="min-w-0">
              <p className="sr-only">
                An illustration of one counterparty&rsquo;s trust profile: verified, eligible for
                lower fees, an illustrative trust score of 742 rising by 12 on this deal, 27
                completed deals, 100% completion and no unresolved disputes. These figures describe
                a single imagined profile, not the platform.
              </p>
              <TrustProfilePreview />

              <ol
                ref={ref}
                className="mt-8 grid grid-cols-2 gap-x-2 gap-y-6 sm:grid-cols-5 sm:gap-x-1 min-[1120px]:mt-10"
              >
                {LOOP.map((step, i) => (
                  <li
                    key={step.label}
                    className="relative flex flex-col items-center gap-2.5 text-center"
                    style={
                      armed
                        ? {
                            opacity: seen ? 1 : 0,
                            transform: seen ? 'none' : 'translateY(6px)',
                            transition: `opacity var(--dur-base) var(--ease-out) ${i * 70}ms, transform var(--dur-base) var(--ease-out) ${i * 70}ms`,
                          }
                        : undefined
                    }
                  >
                    {/* The run to the previous step, owned by the later
                        of the two so it cannot escape the last item. */}
                    {i > 0 ? (
                      <span
                        aria-hidden
                        className="absolute right-[calc(50%+1.5rem)] top-[1.375rem] hidden w-[calc(100%-3rem)] items-center sm:flex"
                      >
                        <span className="h-px flex-1 border-t border-dashed border-[var(--color-nav-3)]" />
                        <Icon
                          name="chevron-right"
                          className="-ml-1 h-3 w-3 shrink-0 text-[var(--color-nav-ink-3)]"
                          strokeWidth={2.2}
                        />
                      </span>
                    ) : null}

                    <span className="relative grid h-11 w-11 shrink-0 place-items-center rounded-full border border-[var(--color-nav-3)] bg-[var(--color-nav)] text-[var(--color-nav-ink)]">
                      <Icon name={step.icon} className="h-5 w-5" strokeWidth={1.7} />
                    </span>
                    <span className="text-[length:var(--text-xs)] font-medium leading-tight text-[var(--color-nav-ink-2)]">
                      {step.label}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </LandingShell>
    </section>
  );
}

/** What a history is actually made of — all four are facts, never bought. */
const DIMENSIONS: readonly { label: string; icon: IconName }[] = [
  { label: 'Completed deals', icon: 'check-circle' },
  { label: 'Completion rate', icon: 'bars' },
  { label: 'Dispute history', icon: 'x-circle' },
  { label: 'Verified identity', icon: 'user-check' },
];

const LOOP: readonly { label: string; icon: IconName }[] = [
  { label: 'Complete', icon: 'shield-check' },
  { label: 'Earn Trust', icon: 'bars' },
  { label: 'Pay Less', icon: 'percent' },
  { label: 'Invite', icon: 'user-plus' },
  { label: 'Repeat', icon: 'refresh' },
];
