import Link from 'next/link';
import { listDealsForUser } from '@/services';
import { getChrome } from '@/services';
import { formatMinor } from '@/lib/format';
import { DEAL_STATE } from '@/lib/dealPresenter';
import type { DealView } from '@/lib/sandboxContract';
import { cn } from '@/lib/cn';
import { AppHeader } from '@/components/kit/AppChrome';
import { DealCard, DealRow } from '@/components/deal/DealCard';
import { ActionLink, Card, EmptyState, Shell } from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * Deals — the working list and the history, in one place.
 *
 * Filtering is a URL parameter rather than client state, so a filtered view
 * is a real address: it can be linked, bookmarked, reloaded and shared with
 * support. It also means the whole screen works without JavaScript.
 *
 * Grouping is by WHOSE MOVE IT IS, not by date, because the question a
 * person opens this list with is "what do I have to do", and a date-sorted
 * list buries that under whatever happened most recently.
 */

type Filter = 'all' | 'action' | 'live' | 'settled' | 'problem';

const FILTERS: readonly { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'action', label: 'Needs you' },
  { key: 'live', label: 'In progress' },
  { key: 'settled', label: 'Completed' },
  { key: 'problem', label: 'Problems' },
];

function matches(deal: DealView, filter: Filter): boolean {
  const needsYou = deal.permitted.canClaim || deal.permitted.canConfirm;
  switch (filter) {
    case 'action':
      return needsYou;
    case 'live':
      return !DEAL_STATE[deal.state].halted && deal.state !== 'COMPLETED';
    case 'settled':
      return deal.state === 'COMPLETED';
    case 'problem':
      return deal.state === 'DISPUTED' || deal.state === 'EXPIRED' || deal.state === 'REFUNDED';
    default:
      return true;
  }
}

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { user, unread } = await getChrome();
  const [deals, params] = await Promise.all([listDealsForUser(user), searchParams]);

  const filter: Filter = FILTERS.find((f) => f.key === params.filter)?.key ?? 'all';
  const shown = deals.filter((d) => matches(d, filter));

  const needsYou = deals.filter((d) => d.permitted.canClaim || d.permitted.canConfirm);
  const completed = deals.filter((d) => d.state === 'COMPLETED');
  const volume = completed.reduce((sum, d) => sum + BigInt(d.inrMinor), 0n);

  return (
    <>
      <AppHeader
        title="Deals"
        subtitle={`${deals.length} total · ${needsYou.length} waiting on you`}
        unread={unread}
        actions={
          <ActionLink
            href="/app/new"
            variant="primary"
            size="sm"
            icon="plus"
            className="hidden sm:inline-flex"
          >
            New deal
          </ActionLink>
        }
      />

      <Shell width="wide" className="py-5 sm:py-7">
        {/*
          ⚠ THE COUNTS WERE STATED THREE TIMES.

          The page subtitle said "2 total · 1 waiting on you", this strip
          said Deals / Waiting on you / Completed, and the filter chips
          below said All 2 · Needs you 1 · Completed 1. Three renderings
          of one set of numbers is not emphasis, it is three chances to
          disagree. The chips are the ones that also DO something, so
          they keep the counts, and the only figure none of them carries
          — what has actually settled — stays.
        */}
        {completed.length > 0 ? (
          <Card className="flex items-baseline justify-between gap-3">
            <span className="text-[length:var(--text-sm)] text-[var(--color-ink-2)]">
              Settled through INRP2P
            </span>
            <span className="tnum text-[length:var(--text-xl)] font-semibold text-[var(--color-ink)]">
              ₹{formatMinor(volume.toString(), 'INR')}
            </span>
          </Card>
        ) : null}

        {/* ---- Filters, as real links -------------------------------- */}
        {/*
         * `overflow-x-clip` on the nav, not on the strip.
         *
         * The strip below bleeds to the screen edge with `-mx-4` and
         * scrolls internally. Without a clipping ancestor that bleed
         * also widened the DOCUMENT, so the whole page scrolled
         * sideways at 360 and 375 px — the narrowest phones, where it
         * is most obvious and least excusable. Clipping here keeps the
         * bleed and the internal scroll while the page itself stays put.
         */}
        <nav aria-label="Filter deals" className="mt-5 overflow-x-clip">
          <ul className="no-bar snap-x-strip -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            {FILTERS.map((f) => {
              const count = deals.filter((d) => matches(d, f.key)).length;
              const active = f.key === filter;
              return (
                <li key={f.key}>
                  <Link
                    href={f.key === 'all' ? '/app/deals' : `/app/deals?filter=${f.key}`}
                    prefetch={false}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'press inline-flex items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-full)] border px-3.5 py-2 text-[length:var(--text-sm)] font-medium transition-colors',
                      active
                        ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-paper)]'
                        : 'border-[var(--color-line)] bg-[var(--color-paper)] text-[var(--color-ink-2)] hover:border-[var(--color-rule)]',
                    )}
                  >
                    {f.label}
                    <span
                      className={cn(
                        'tnum text-[length:var(--text-2xs)]',
                        active ? 'text-[var(--color-paper)]/70' : 'text-[var(--color-ink-4)]',
                      )}
                    >
                      {count}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* ---- The list ---------------------------------------------- */}
        <section className="mt-5">
          {shown.length === 0 ? (
            <EmptyState
              icon={filter === 'problem' ? 'shield-check' : 'deals'}
              title={EMPTY[filter].title}
              body={EMPTY[filter].body}
              action={
                filter === 'all' || filter === 'live'
                  ? { href: '/app/new', label: 'Create a protected deal' }
                  : { href: '/app/deals', label: 'Show all deals' }
              }
            />
          ) : (
            <>
              {/* Cards on small screens where each deal deserves room; a
                  dense rail on desktop where scanning many at once wins. */}
              {/*
               * `min-w-0` on the grid items.
               *
               * A grid child defaults to `min-width: auto`, so an
               * unbreakable string inside a card — a deal reference, a
               * long title — makes the TRACK wider than the container
               * and the whole page scrolls sideways. At 360 and 375 px
               * that is every narrow phone. Letting the item shrink is
               * what keeps the card inside the screen.
               */}
              <ul className="grid gap-3 sm:grid-cols-2 lg:hidden">
                {shown.map((deal) => (
                  <li key={deal.dealId} className="min-w-0">
                    <DealCard deal={deal} />
                  </li>
                ))}
              </ul>
              <Card className="hidden lg:block" flush seam>
                {shown.map((deal) => (
                  <DealRow key={deal.dealId} deal={deal} />
                ))}
              </Card>
            </>
          )}
        </section>

        {/*
          The "Deal types" grid that used to sit here showed three cards
          with a count each — usually two zeros — under a list whose every
          row already names its type. It was filler, and on a page about
          somebody's money filler is the thing that makes it feel like a
          demo. Removed rather than restyled.
        */}
      </Shell>

      {/* Mobile: the create action stays in thumb reach, above the tabs. */}
      <div className="pb-safe fixed inset-x-0 bottom-[var(--h-tabbar)] z-30 px-4 pb-3 sm:hidden">
        <ActionLink href="/app/new" variant="primary" size="lg" full icon="plus">
          New protected deal
        </ActionLink>
      </div>
    </>
  );
}

const EMPTY: Readonly<Record<Filter, { title: string; body: string }>> = {
  all: {
    title: 'No deals yet',
    body: 'Create a protected deal, share the link, and it will appear here the moment someone joins.',
  },
  action: {
    title: 'Nothing is waiting on you',
    body: 'When a payment is due or a confirmation is yours to make, it shows up here first.',
  },
  live: {
    title: 'No deals in progress',
    body: 'Deals appear here between the moment someone joins and the moment they settle.',
  },
  settled: {
    title: 'No completed deals yet',
    body: 'Once a deal settles it stays here as a receipt you can download.',
  },
  problem: {
    title: 'No problems',
    body: 'Disputed, expired and refunded deals collect here. Yours is a clean sheet.',
  },
};
