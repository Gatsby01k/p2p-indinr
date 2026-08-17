import Link from 'next/link';
import { Icon } from '@/components/kit/Icon';
import { CREATE_DEAL_HREF } from './demo';
import { LandingShell } from './LandingShell';
import { TelegramAction } from './TelegramAction';

/**
 * The last thing the page says, and the only band that is brand-coloured
 * edge to edge.
 *
 * Both actions are the real ones. `Create a protected deal` is the same
 * `/app/new` route across the same sign-in handoff every other CTA on the
 * page uses — no scenario preselected, because by this point the visitor
 * has been shown all three and should not have one chosen for them.
 * `Open Telegram` is the shared `TelegramAction`, which opens the
 * configured Mini App or states plainly that there is none. Neither is a
 * `#`.
 */
export function FinalCta({ miniAppUrl }: { miniAppUrl: string | null }) {
  return (
    <section className="bg-[var(--color-canvas)]">
      <LandingShell className="pb-14 sm:pb-20 lg:pb-24">
        <div className="overflow-hidden rounded-[var(--radius-2xl)] bg-[var(--color-brand)] px-5 py-7 sm:px-8 sm:py-8 lg:px-10">
          <div className="flex flex-col gap-6 min-[1120px]:flex-row min-[1120px]:items-center min-[1120px]:gap-10">
            <span
              aria-hidden
              className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-white/15 text-white ring-1 ring-inset ring-white/25"
            >
              <Icon name="shield-check" className="h-7 w-7" strokeWidth={1.7} />
            </span>

            <div className="min-w-0 flex-1">
              <h2 className="text-[clamp(1.5rem,2.6vw,2.05rem)] font-bold leading-[1.1] tracking-[-0.035em] text-white [text-wrap:balance]">
                Create the deal. Send the link. Keep control.
              </h2>
              <p className="mt-2 text-[length:var(--text-md)] leading-relaxed text-white/85">
                INR or USDT. Telegram or web. One protected flow.
              </p>
            </div>

            <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
              <Link
                href={CREATE_DEAL_HREF}
                prefetch={false}
                className="press tap inline-flex h-[3.25rem] items-center justify-center gap-2 rounded-[var(--radius-md)] bg-white px-6 text-[length:var(--text-md)] font-semibold text-[var(--color-ink)] shadow-[0_1px_2px_rgb(120,40,15,0.2)] hover:bg-[var(--color-canvas)]"
              >
                Create a protected deal
                <Icon name="chevron-right" className="h-4 w-4" strokeWidth={2.2} />
              </Link>
              <TelegramAction
                miniAppUrl={miniAppUrl}
                variant="onBrand"
                className="h-[3.25rem] px-6 text-[length:var(--text-md)]"
              >
                Open Telegram
              </TelegramAction>
            </div>
          </div>
        </div>
      </LandingShell>
    </section>
  );
}
