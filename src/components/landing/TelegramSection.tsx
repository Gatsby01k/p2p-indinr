import { cn } from '@/lib/cn';
import { Mark } from '@/components/kit/Brand';
import { Avatar } from '@/components/kit/primitives';
import { Icon, type IconName } from '@/components/kit/Icon';
import { CAPABILITIES } from './demo';
import { FlowConnector, ReadReceipt } from './Glyphs';
import { LandingShell } from './LandingShell';
import { MiniAppPreview } from './MiniAppPreview';
import { CHAT, TELEGRAM_BENEFITS } from './telegramDemo';
import { TelegramAction } from './TelegramAction';

/**
 * The shortest path there is: a message, a card, a deal.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE PHONE IS THE SAME COMPONENT THE HERO USES.                    │
 * │                                                                    │
 * │  `MiniAppPreview` was built for LANDING-01 and is reused here      │
 * │  unchanged, fed the `Send INR` capability. That is not thrift — it │
 * │  is the claim this section is making. The composer somebody meets  │
 * │  after tapping a deal card in Telegram is the same composer the    │
 * │  hero showed them, because there is one create-deal flow.          │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ⚠ NOTHING HERE IS LIVE. The chat is a drawing, `Open Deal` is an inert
 * `<span>`, and the phone creates nothing. The only real control is the
 * Telegram action, which either opens the configured Mini App or says
 * plainly that this deployment has none.
 *
 * NO PHOTOGRAPHS. `Rahul` is drawn by the product's own `Avatar`, which
 * derives an initial and a tint from the name — the same mark the deal
 * room uses for a counterparty.
 */
export function TelegramSection({ miniAppUrl }: { miniAppUrl: string | null }) {
  return (
    <section
      id="telegram"
      className="scroll-mt-24 border-t border-[var(--color-line)] bg-[var(--color-canvas)]"
    >
      <LandingShell className="py-14 sm:py-20 lg:py-24">
        <div className="grid gap-10 min-[1120px]:grid-cols-[minmax(0,25rem)_minmax(0,17.5rem)_minmax(0,20rem)] min-[1120px]:items-start min-[1120px]:gap-12">
          {/* ---- The message it starts from -------------------- */}
          <div className="min-w-0">
            <p className="text-[length:var(--text-2xs)] font-bold uppercase tracking-[0.14em] text-[var(--color-brand)]">
              Made for the chat where the deal starts.
            </p>
            <h2 className="mt-4 text-[clamp(1.9rem,3.4vw,2.6rem)] font-bold leading-[1.06] tracking-[-0.04em] text-[var(--color-ink)] [text-wrap:balance]">
              From Telegram message to protected deal in one tap.
            </h2>
            <p className="mt-4 max-w-[46ch] text-[length:var(--text-md)] leading-relaxed text-[var(--color-ink-2)]">
              Open the Mini App, set the terms, and share the deal back to any chat.
            </p>

            <ChatFragment className="mt-7" />
          </div>

          {/* ---- What the card opens --------------------------- */}
          <div className="min-w-0">
            <FlowConnector direction="down" className="mx-auto my-1 h-9 w-6 min-[1120px]:hidden" />
            <MiniAppPreview
              capability={CAPABILITIES.SEND_INR}
              className="mx-auto w-full max-w-[17.5rem]"
            />
          </div>

          {/* ---- Why it is worth opening ----------------------- */}
          <div className="min-w-0">
            <ul className="space-y-5">
              {TELEGRAM_BENEFITS.map((benefit) => (
                <li key={benefit.title} className="flex items-start gap-3.5">
                  <span
                    className={cn(
                      'grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-md)]',
                      BENEFIT_TINT[benefit.icon],
                    )}
                  >
                    <Icon name={benefit.icon as IconName} className="h-5 w-5" strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0">
                    <h3 className="text-[length:var(--text-md)] font-semibold text-[var(--color-ink)]">
                      {benefit.title}
                    </h3>
                    <p className="mt-0.5 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-3)]">
                      {benefit.body}
                    </p>
                  </span>
                </li>
              ))}
            </ul>

            <TelegramAction
              miniAppUrl={miniAppUrl}
              className="mt-7 h-[3.25rem] w-full px-5 text-[length:var(--text-md)]"
            >
              Open Telegram Mini App
            </TelegramAction>
          </div>
        </div>
      </LandingShell>
    </section>
  );
}

/**
 * A chat, with a protected deal in it.
 *
 * The wallpaper is a flat sage rather than a photographic pattern — this
 * is a depiction of somebody's chat, and a busy background would compete
 * with the one thing in it that matters.
 */
function ChatFragment({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-paper)] shadow-[var(--shadow-lift)]',
        className,
      )}
    >
      {/* Telegram's own chat header. */}
      <div className="flex items-center gap-2.5 border-b border-[var(--color-line)] px-3.5 py-2.5">
        <Icon
          name="chevron-left"
          className="h-[18px] w-[18px] shrink-0 text-[var(--tg)]"
          strokeWidth={2}
        />
        <Avatar name={CHAT.contact} size="sm" />
        <span className="min-w-0 flex-1 leading-none">
          <span className="block truncate text-[length:var(--text-sm)] font-semibold text-[var(--color-ink)]">
            {CHAT.contact}
          </span>
          <span className="mt-1 block text-[length:var(--text-2xs)] text-[var(--tg)]">
            {CHAT.presence}
          </span>
        </span>
        <Icon name="users" className="h-[18px] w-[18px] shrink-0 text-[var(--tg)]" />
        <Icon
          name="more"
          className="h-4 w-4 shrink-0 text-[var(--color-ink-4)]"
          strokeWidth={2.6}
        />
      </div>

      {/* The conversation. */}
      <div className="space-y-2 bg-[#dde5d6] px-3 py-3.5">
        <p className="max-w-[85%] rounded-[var(--radius-md)] rounded-tl-[var(--radius-xs)] bg-white px-3 py-2 text-[length:var(--text-sm)] leading-snug text-[var(--color-ink)] shadow-[var(--shadow-card)]">
          {CHAT.message}
        </p>

        {/* The deal, as it arrives in a chat. */}
        <div className="overflow-hidden rounded-[var(--radius-md)] bg-white shadow-[var(--shadow-raised)]">
          <div className="flex items-center gap-2.5 px-3 pb-2 pt-2.5">
            <Mark className="h-7 w-7 shrink-0 text-[var(--color-brand)]" />
            <span className="min-w-0 leading-none">
              <span className="block text-[length:var(--text-xs)] font-semibold text-[var(--color-ink)]">
                {CHAT.card.title}
              </span>
              <span className="tnum mt-1.5 block text-[length:var(--text-base)] font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
                {CHAT.card.terms}
              </span>
            </span>
          </div>
          <p className="flex items-center gap-1.5 px-3 pb-2.5 text-[length:var(--text-2xs)] font-medium text-[var(--color-ink-3)]">
            <Icon name="lock" className="h-3 w-3 text-[var(--color-ink-4)]" strokeWidth={2} />
            {CHAT.card.locked}
          </p>
          <span className="mx-3 mb-3 flex h-9 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-brand)] text-[length:var(--text-sm)] font-semibold text-white">
            {CHAT.card.action}
          </span>
        </div>

        <p className="tnum flex items-center justify-end gap-1 pr-1 text-[length:var(--text-2xs)] text-[var(--color-ink-3)]">
          {CHAT.at}
          <ReadReceipt className="text-[var(--color-final)]" />
        </p>
      </div>
    </div>
  );
}

/** Telegram blue for Telegram, neutral for the two web fallbacks. */
const BENEFIT_TINT: Readonly<Record<TelegramBenefitIcon, string>> = {
  telegram: 'bg-[var(--color-info-tint)] text-[var(--tg)]',
  globe: 'bg-[var(--color-sunken)] text-[var(--color-ink-2)]',
  code: 'bg-[var(--color-sunken)] text-[var(--color-ink-2)]',
};

type TelegramBenefitIcon = (typeof TELEGRAM_BENEFITS)[number]['icon'];
