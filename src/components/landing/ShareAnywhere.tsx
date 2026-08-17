import { Icon, type IconName } from '@/components/kit/Icon';
import { CHANNELS, ChannelDisc } from './Glyphs';
import { LandingShell } from './LandingShell';

/**
 * Create once. Share anywhere.
 *
 * The section that answers the question the hero raises: if a deal is a
 * LINK, where does the link go? Answer — wherever the two people already
 * talk, plus a typed code for the case where they do not share an app.
 *
 * Three zones on a wide screen: the claim, the channels it holds for, and
 * the four steps it takes. Below `lg` they stack in that same order, which
 * is also the order somebody reads them aloud.
 */
export function ShareAnywhere() {
  return (
    <section id="how-it-works" className="scroll-mt-24 bg-[var(--color-paper)]">
      <LandingShell className="py-12 sm:py-16 lg:py-20">
        {/* 21rem is what `Share anywhere.` needs at 2.5rem to stay on one line. */}
        <div className="grid gap-10 lg:grid-cols-[minmax(0,21rem)_minmax(0,15rem)_minmax(0,1fr)] lg:items-center lg:gap-12">
          {/* `[text-wrap:wrap]`: the two lines are the design, not a balance. */}
          <h2 className="text-[clamp(1.9rem,3vw,2.5rem)] font-bold leading-[1.05] tracking-[-0.04em] text-[var(--color-ink)] [text-wrap:wrap]">
            <span className="block">Create once.</span>
            <span className="block">Share anywhere.</span>
          </h2>

          {/* ---- Where a link can go ------------------------------ */}
          <ul className="grid grid-cols-3 gap-x-4 gap-y-6 sm:max-w-[22rem]">
            {CHANNELS.map((channel) => (
              <li key={channel.key} className="flex flex-col items-center gap-2 text-center">
                <ChannelDisc
                  channel={channel}
                  className="h-12 w-12 shadow-[var(--shadow-card)]"
                  glyphClassName="h-6 w-6"
                />
                <span className="text-[length:var(--text-xs)] font-semibold text-[var(--color-ink-2)]">
                  {channel.label}
                </span>
              </li>
            ))}
          </ul>

          {/* ---- What happens, in four moves ---------------------- */}
          <ol className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-4 lg:border-l lg:border-[var(--color-line)] lg:pl-14">
            {STEPS.map((step, index) => (
              <li key={step.title} className="relative flex flex-col items-center text-center">
                {/*
                  The dashed run between steps. Drawn from each step back
                  to the previous one rather than as a single line behind
                  the row, so it cannot escape the row on the wrap to two
                  columns on a phone.
                */}
                {index > 0 ? (
                  <span
                    aria-hidden
                    className="absolute right-1/2 top-[3.65rem] hidden h-px w-full border-t border-dashed border-[var(--color-rule)] sm:block"
                  />
                ) : null}

                <span className="tnum grid h-6 w-6 place-items-center rounded-full bg-[var(--color-brand-tint)] text-[length:var(--text-2xs)] font-bold text-[var(--color-brand)]">
                  {index + 1}
                </span>
                <span className="relative mt-3 grid h-[3.25rem] w-[3.25rem] place-items-center rounded-full border border-[var(--color-brand-line)] bg-[var(--color-brand-tint)] text-[var(--color-brand)]">
                  <Icon name={step.icon} className="h-5 w-5" strokeWidth={1.8} />
                </span>
                <span className="mt-3 text-[length:var(--text-md)] font-semibold text-[var(--color-ink)]">
                  {step.title}
                </span>
                <span className="mt-1 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                  {step.body}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </LandingShell>
    </section>
  );
}

const STEPS: readonly { title: string; body: string; icon: IconName }[] = [
  { title: 'Create', body: 'Set amount and terms.', icon: 'edit' },
  { title: 'Share', body: 'Send in any chat.', icon: 'telegram' },
  { title: 'Join', body: 'They review and join.', icon: 'users' },
  { title: 'Complete', body: 'Upload proof. Release.', icon: 'shield-check' },
];
