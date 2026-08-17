'use client';

import { useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/kit/Icon';
import { ActionLink } from '@/components/kit/primitives';
import { HeroStage } from './HeroStage';
import { LandingShell } from './LandingShell';
import { TelegramAction } from './TelegramAction';
import { CAPABILITIES, CAPABILITY_KEYS, createDealHref, type CapabilityKey } from './demo';

/**
 * The first viewport.
 *
 * An asymmetric pair: the argument on the left with real width, the working
 * product on the right. The capability control in the left column drives the
 * demonstration in the right one AND the destination of the primary call to
 * action — so choosing `Buy USDT` and pressing `Create a protected deal`
 * opens the existing create-deal route already set to `INR_TO_USDT`. The
 * control is not decoration; it is the first field of the real form.
 *
 * ⚠ WHY THIS IS A CLIENT MODULE. One piece of state — which capability is
 * selected — is shared by the control, the demonstration and the CTA's
 * `href`. Everything else it renders is static markup that server-renders
 * exactly as it would from a server component.
 */
export function Hero({ miniAppUrl }: { miniAppUrl: string | null }) {
  const [selected, setSelected] = useState<CapabilityKey>('SEND_INR');
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  /*
   * Roving arrow keys, as a radio group is required to have. Without them
   * the group is three separate tab stops that announce themselves as
   * radios and then do not behave like any radio the person has met.
   */
  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const delta =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = (index + delta + CAPABILITY_KEYS.length) % CAPABILITY_KEYS.length;
    setSelected(CAPABILITY_KEYS[next]!);
    radios.current[next]?.focus();
  };

  return (
    <section className="border-b border-[var(--color-line)] bg-[var(--color-canvas)]">
      <LandingShell className="py-10 sm:py-14 min-[1440px]:py-[4.5rem]">
        {/*
          TWO COLUMNS FROM 1440px, AND NOT A PIXEL EARLIER.
          The copy column needs 32rem for the headline to hold its two
          lines, and the demonstration needs 49.5rem to lay its three
          layers out without the deal room sliding over the phone. Those
          two plus the gutter are 1440px of viewport. Below that the hero
          is one column with the demonstration full-width beneath it,
          which is a better layout than a squeezed version of this one.
        */}
        <div className="grid items-center gap-12 min-[1440px]:grid-cols-[minmax(0,32rem)_minmax(0,1fr)] min-[1440px]:gap-14">
          {/* ---- The argument ------------------------------------- */}
          {/*
            The measure is capped while the hero is ONE column. Without
            it the sub-heading, the three capability controls and the
            trust line stretch to 944px on a small laptop and the column
            stops reading as a column. From 1440 the grid track sets the
            width and the cap gets out of the way.
          */}
          <div className="stagger max-w-[42rem] min-[1440px]:max-w-none">
            <p className="text-[length:var(--text-2xs)] font-bold uppercase tracking-[0.14em] text-[var(--color-brand)]">
              Protected deals for India
            </p>

            {/*
              The measure is set by the LONGEST LINE, not by taste: at this
              size `One protected link.` is 485px, so a column narrower than
              that breaks the headline into three lines and the composition
              stops working. Anything wider and the two lines drift apart.
            */}
            {/*
              `[text-wrap:wrap]` defeats the `text-wrap: balance` the base
              stylesheet puts on every heading. Balancing is right for a
              heading whose line breaks are incidental; here they are the
              design, stated as two block spans, and balance was rewriting
              them into `One` / `protected link.` / `Any deal.`
            */}
            <h1 className="mt-4 text-[clamp(2.3rem,5vw,4rem)] font-bold leading-[1] tracking-[-0.045em] text-[var(--color-ink)] [text-wrap:wrap]">
              <span className="block">One protected link.</span>
              <span className="block">Any deal.</span>
            </h1>

            <p className="mt-5 max-w-[36rem] text-[length:var(--text-lg)] leading-relaxed text-[var(--color-ink-2)] sm:text-[1.15rem]">
              Create an INR or USDT deal, share it in any chat, and release funds only when both
              sides complete the terms.
            </p>

            {/* ---- The two ways in ------------------------------- */}
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <ActionLink
                href={createDealHref(selected)}
                variant="primary"
                size="lg"
                iconAfter="chevron-right"
                className="px-6"
              >
                Create a protected deal
              </ActionLink>
              <TelegramAction
                miniAppUrl={miniAppUrl}
                variant="outline"
                className="h-[3.25rem] px-5 text-[length:var(--text-md)]"
              >
                Open Telegram Mini App
              </TelegramAction>
            </div>

            {/* ---- What the engine does -------------------------- */}
            <div
              role="radiogroup"
              aria-label="What kind of deal to create"
              className="mt-5 grid grid-cols-3 gap-2 sm:gap-3"
            >
              {CAPABILITY_KEYS.map((key, index) => {
                const capability = CAPABILITIES[key];
                const active = key === selected;
                return (
                  <button
                    key={key}
                    ref={(node) => {
                      radios.current[index] = node;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    tabIndex={active ? 0 : -1}
                    onClick={() => setSelected(key)}
                    onKeyDown={(event) => onKeyDown(event, index)}
                    className={cn(
                      'press tap flex flex-col items-center justify-center gap-1.5 rounded-[var(--radius-md)] border bg-[var(--color-paper)] px-2 py-3',
                      'text-[length:var(--text-sm)] font-semibold text-[var(--color-ink)] transition-colors duration-[var(--dur-fast)]',
                      'sm:h-14 sm:flex-row sm:justify-start sm:gap-2.5 sm:px-3.5 sm:py-0 sm:text-[length:var(--text-base)]',
                      active
                        ? 'border-[var(--color-brand-line)] bg-[var(--color-brand-tint)] shadow-[var(--shadow-card)]'
                        : 'border-[var(--color-line)] hover:border-[var(--color-rule)] hover:bg-[var(--color-sunken)]',
                    )}
                  >
                    <span
                      className={cn(
                        'grid h-7 w-7 shrink-0 place-items-center rounded-full',
                        CAPABILITY_TINT[key],
                      )}
                    >
                      <Icon name={CAPABILITY_ICON[key]} className="h-4 w-4" strokeWidth={1.9} />
                    </span>
                    <span className="whitespace-nowrap">{capability.label}</span>
                    <span className="sr-only"> — {capability.summary}</span>
                  </button>
                );
              })}
            </div>

            {/* ---- What holds it together ------------------------ */}
            <p className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--text-base)] font-medium text-[var(--color-ink-2)] sm:text-[1rem]">
              <Icon
                name="shield-check"
                className="h-6 w-6 shrink-0 text-[var(--color-brand)]"
                strokeWidth={1.7}
              />
              Locked terms <span className="text-[var(--color-ink-4)]">·</span> One counterparty{' '}
              <span className="text-[var(--color-ink-4)]">·</span> Protected release
            </p>
          </div>

          {/* ---- The product -------------------------------------- */}
          <HeroStage
            capability={CAPABILITIES[selected]}
            className="animate-fade min-[1440px]:[animation-delay:120ms]"
          />
        </div>
      </LandingShell>
    </section>
  );
}

/**
 * One tint each, and they are the product's own asset colours: vermilion is
 * the rupee leg, teal is USDT, blue is the exchange between them. Nothing
 * here is chosen to look lively.
 */
const CAPABILITY_TINT: Readonly<Record<CapabilityKey, string>> = {
  SEND_INR: 'bg-[var(--color-inr-tint)] text-[var(--color-inr)]',
  BUY_USDT: 'bg-[var(--color-usdt-tint)] text-[var(--color-usdt)]',
  SELL_USDT: 'bg-[var(--color-info-tint)] text-[var(--color-info)]',
};

const CAPABILITY_ICON: Readonly<Record<CapabilityKey, IconName>> = {
  SEND_INR: 'rupee',
  BUY_USDT: 'shield',
  SELL_USDT: 'swap',
};
