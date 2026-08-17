import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/kit/Icon';
import { DealRoomDemo } from './DealRoomDemo';
import { LandingShell } from './LandingShell';

/**
 * The dark section: the deal, as the conversation it actually is.
 *
 * The one place on the landing page where the ground inverts, and it
 * earns that by being the only place showing the product at full size.
 * Near-black is `--color-nav` — the same ink the authenticated rail uses,
 * not a new colour — so the page still has one palette.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  ON A PHONE THE ARGUMENT COMES FIRST.                              │
 * │                                                                    │
 * │  Below `1120px` the two columns stack, and the four benefits are   │
 * │  read BEFORE the room rather than after it. Somebody scrolling a   │
 * │  390px screen should know what they are looking at before they     │
 * │  reach a screenshot of it — and the room below them keeps its own  │
 * │  type sizes rather than being scaled into a thumbnail.             │
 * └────────────────────────────────────────────────────────────────────┘
 */
export function DealRoomShowcase() {
  return (
    <section className="bg-[var(--color-canvas)]">
      <LandingShell className="pb-14 sm:pb-20 lg:pb-24">
        <div className="overflow-hidden rounded-[var(--radius-2xl)] bg-[var(--color-nav)] p-5 sm:p-8 lg:p-10 min-[1120px]:p-12">
          <div className="grid gap-9 min-[1120px]:grid-cols-[minmax(0,20.5rem)_minmax(0,1fr)] min-[1120px]:items-center min-[1120px]:gap-12">
            {/* ---- The argument ---------------------------------- */}
            <div className="min-w-0">
              <h2 className="text-[clamp(1.9rem,3.4vw,2.85rem)] font-bold leading-[1.06] tracking-[-0.04em] text-[var(--color-nav-ink)] [text-wrap:balance]">
                The deal is the conversation.
              </h2>
              <p className="mt-4 max-w-[38ch] text-[length:var(--text-md)] leading-relaxed text-[var(--color-nav-ink-2)]">
                Messages, payment proof, status and release — in one protected room.
              </p>

              <ul className="mt-7 space-y-0">
                {BENEFITS.map((benefit, i) => (
                  <li
                    key={benefit.title}
                    className={cn(
                      'flex items-start gap-3.5 py-4',
                      i > 0 && 'border-t border-dashed border-[var(--color-nav-3)]',
                    )}
                  >
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--color-nav-2)] text-[var(--color-brand)] ring-1 ring-inset ring-[var(--color-nav-3)]">
                      <Icon name={benefit.icon} className="h-5 w-5" strokeWidth={1.8} />
                    </span>
                    <span className="min-w-0">
                      <h3 className="text-[length:var(--text-md)] font-semibold text-[var(--color-nav-ink)]">
                        {benefit.title}
                      </h3>
                      <p className="mt-0.5 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-nav-ink-2)]">
                        {benefit.body}
                      </p>
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* ---- The room -------------------------------------- */}
            <div className="min-w-0">
              {/*
                The equivalent of the figure, in words. The room itself is
                `aria-hidden`: it is an illustration of the four benefits
                above, and announcing two fake participants, a fake
                transcript and two inert buttons would be a worse account
                of this section than one sentence.
              */}
              <p className="sr-only">
                An illustration of a protected deal room for a purchase of 1,000 USDT, payment
                pending, under deal code AB12CD. It shows both verified participants, a message
                reading “I have sent ₹83,600 by UPI.”, a verified payment-proof upload, the system
                event “Payment marked as sent”, the counterparty replying “Thanks, I will confirm.”,
                the 1,000 USDT held locked in escrow, a status timeline running Created, Shared,
                Joined, Paid, Released, and the two actions available at that point: open a dispute,
                or confirm and release.
              </p>
              <DealRoomDemo />
            </div>
          </div>
        </div>
      </LandingShell>
    </section>
  );
}

const BENEFITS: readonly { title: string; body: string; icon: IconName }[] = [
  { title: 'Locked terms', body: 'Agreed terms are immutable.', icon: 'lock' },
  { title: 'Proof in context', body: 'Evidence stays attached to the deal.', icon: 'image' },
  {
    title: 'Controlled release',
    body: 'Funds move through permitted actions.',
    icon: 'shield-check',
  },
  { title: 'Disputes stay attached', body: 'Everything remains in one place.', icon: 'flag' },
];
