import Link from 'next/link';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/kit/Icon';
import { PREMIUM_BENEFITS, REFERRAL_PREVIEW_URL, REWARD_KINDS } from './rewardsDemo';

/**
 * Three ways activity pays back: bring someone, subscribe, or just keep
 * completing deals.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHAT THESE TWO BUTTONS ACTUALLY DO, AND WHY.                      │
 * │                                                                    │
 * │  `Copy referral link` does NOT copy the address shown above it.    │
 * │  That address is an illustration. A real invite is minted on the   │
 * │  server by `referralCodeFor` — ten characters from a CSPRNG,       │
 * │  reached at `/login?invite=<CODE>` — and a public page has no      │
 * │  session to mint one for. Handing somebody a copied link that      │
 * │  credits nobody is worse than sending them to the screen that has  │
 * │  their real one, so both controls lead to `/app/rewards` through   │
 * │  the existing sign-in handoff.                                     │
 * │                                                                    │
 * │  `Explore Premium` has NO Premium destination to lead to. There is │
 * │  no `/app/premium`, no checkout and no billing provider —          │
 * │  `assertPremiumProvider()` refuses outright in production. Premium │
 * │  exists only as an entitlement an operator can grant in a sandbox. │
 * │  Rather than invent a subscription page, this points at the same   │
 * │  rewards screen, where fee credit and benefits actually live.      │
 * │                                                                    │
 * │  BOTH SAY SO IN THEIR ACCESSIBLE NAME. A visible label that        │
 * │  promises one thing and a link that quietly does another is the    │
 * │  thing being avoided; a link that goes somewhere real and explains │
 * │  itself is not.                                                    │
 * └────────────────────────────────────────────────────────────────────┘
 */

/** The existing rewards screen, across the existing sign-in continuation. */
const REWARDS_HREF = '/login?next=%2Fapp%2Frewards';

export function BenefitBand() {
  /*
   * ⚠ NAMED BREAKPOINTS ONLY, because two rules set `grid-template-
   * columns` here. `sm:grid-cols-2` and an arbitrary `min-[1120px]:`
   * variant are both live at 1440px, and Tailwind's ordering put the
   * arbitrary one FIRST — so the three-column layout lost to the
   * two-column one and `Useful rewards` sat alone on its own row.
   * `xl` is 1280px and is guaranteed to sort after `sm`.
   */
  return (
    <div className="mt-5 grid gap-4 sm:mt-6 sm:grid-cols-2 sm:gap-5 xl:grid-cols-[minmax(0,1.12fr)_minmax(0,0.76fr)_minmax(0,1fr)] xl:gap-6">
      {/* ---- Bring somebody you already deal with -------------- */}
      <section className={CARD}>
        <h3 className={CARD_TITLE}>Trade with people you already trust.</h3>
        <p className={CARD_BODY}>
          Invite a counterparty. After the first protected deal, both of you save.
        </p>

        <div
          aria-hidden
          className="mx-auto mt-6 flex max-w-[22rem] items-start justify-center gap-2 sm:gap-3"
        >
          <Party label="You" tone="final" />
          <Dashes />
          <span className="mt-2 grid h-11 w-11 shrink-0 place-items-center rounded-full border border-[var(--color-final-line)] bg-[var(--color-final-tint)] text-[var(--color-final)]">
            <Icon name="link" className="h-5 w-5" strokeWidth={1.8} />
          </span>
          <Dashes />
          <Party label="Counterparty" tone="info" />
        </div>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-center">
          <span className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
              {REFERRAL_PREVIEW_URL}
            </span>
            <Icon name="copy" className="h-4 w-4 shrink-0 text-[var(--color-ink-4)]" />
          </span>
          <Link href={REWARDS_HREF} prefetch={false} className={cn(PRIMARY, 'sm:shrink-0')}>
            Copy referral link
            <span className="sr-only">
              {' '}
              — opens your rewards screen, where your own invite link is created
            </span>
          </Link>
        </div>
      </section>

      {/* ---- Subscribe ----------------------------------------- */}
      <section className={cn(CARD, 'flex flex-col')}>
        <h3 className={CARD_TITLE}>Premium</h3>
        <ul className="mt-5 flex-1 space-y-3.5">
          {PREMIUM_BENEFITS.map((benefit) => (
            <li key={benefit} className="flex items-center gap-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[var(--color-sunken)] text-[var(--color-ink-2)]">
                <Icon
                  name={PREMIUM_ICON[benefit]}
                  className="h-[18px] w-[18px]"
                  strokeWidth={1.8}
                />
              </span>
              <span className="text-[length:var(--text-md)] text-[var(--color-ink)]">
                {benefit}
              </span>
            </li>
          ))}
        </ul>
        <Link href={REWARDS_HREF} prefetch={false} className={cn(PRIMARY, 'mt-6 w-full')}>
          Explore Premium
          <Icon name="chevron-right" className="h-4 w-4" strokeWidth={2.2} />
          <span className="sr-only">
            {' '}
            — Premium cannot be bought in this build; this opens your rewards and fee credit
          </span>
        </Link>
      </section>

      {/* ---- Or simply keep completing deals -------------------- */}
      <section className={cn(CARD, 'sm:col-span-2 xl:col-span-1')}>
        <h3 className={CARD_TITLE}>Useful rewards after real activity.</h3>
        <p className="mt-1.5 text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
          Unlocked after successful deals
        </p>
        <ul className="mt-4 space-y-2">
          {REWARD_KINDS.map((kind) => (
            <li
              key={kind.label}
              className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-line)] px-3 py-2.5"
            >
              <Icon
                name={kind.icon}
                className="h-[18px] w-[18px] shrink-0 text-[var(--color-brand)]"
                strokeWidth={1.8}
              />
              <span className="text-[length:var(--text-md)] text-[var(--color-ink)]">
                {kind.label}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Parts
 * ------------------------------------------------------------------ */

/**
 * A person, drawn rather than photographed.
 *
 * No stock portrait and no avatar service: the two sides of a deal are
 * whoever the reader already talks to, and a smiling model would be
 * telling them it is somebody else.
 */
function Party({ label, tone }: { label: string; tone: 'final' | 'info' }) {
  return (
    <span className="flex w-16 shrink-0 flex-col items-center gap-2">
      <span
        className={cn(
          'grid h-14 w-14 place-items-center rounded-full',
          tone === 'final'
            ? 'bg-[var(--color-final-tint)] text-[var(--color-final)]'
            : 'bg-[var(--color-info-tint)] text-[var(--color-info)]',
        )}
      >
        <Icon name="profile" className="h-6 w-6" strokeWidth={1.7} />
      </span>
      <span className="text-[length:var(--text-2xs)] text-[var(--color-ink-3)]">{label}</span>
    </span>
  );
}

function Dashes() {
  return (
    <span className="mt-7 h-px min-w-4 flex-1 border-t border-dashed border-[var(--color-rule)]" />
  );
}

const CARD =
  'rounded-[var(--radius-xl)] border border-[var(--color-line)] bg-[var(--color-paper)] p-5 shadow-[var(--shadow-card)] sm:p-6';

const CARD_TITLE =
  'text-[length:var(--text-lg)] font-semibold tracking-[-0.02em] text-[var(--color-ink)]';

const CARD_BODY = 'mt-1.5 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]';

const PRIMARY =
  'press tap inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-brand)] px-4 text-[length:var(--text-base)] font-semibold text-white shadow-[var(--shadow-brand)] hover:bg-[var(--color-brand-hover)] active:bg-[var(--color-brand-press)]';

const PREMIUM_ICON: Readonly<Record<(typeof PREMIUM_BENEFITS)[number], IconName>> = {
  'Lower fees': 'percent',
  'Faster deals': 'bolt',
  'Priority benefits': 'crown',
};
