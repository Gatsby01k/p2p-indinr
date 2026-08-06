import Link from 'next/link';
import { listDealsForUser } from '@/server/sandbox/service';
import { getChrome } from '@/server/sandbox/chrome';
import { formatMinor } from '@/lib/format';
import { DEAL_STATE } from '@/lib/dealPresenter';
import { SCENARIO, type Scenario } from '@/lib/scenario';
import type { DealView } from '@/lib/sandboxContract';
import { cn } from '@/lib/cn';
import { AppHeader } from '@/components/kit/AppChrome';
import { DealCard, DealRow } from '@/components/deal/DealCard';
import { Icon } from '@/components/kit/Icon';
import {
  ActionLink,
  Card,
  EmptyState,
  SectionHead,
  Shell,
  StatTile,
} from '@/components/kit/primitives';

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

  const filter: Filter =
    FILTERS.find((f) => f.key === params.filter)?.key ?? 'all';
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
        {/* ---- What this list adds up to ----------------------------- */}
        {deals.length > 0 ? (
          <Card className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatTile value={deals.length} label="Deals" />
            <StatTile
              value={needsYou.length}
              label="Waiting on you"
              tone={needsYou.length > 0 ? 'brand' : 'ink'}
            />
            <StatTile value={completed.length} label="Completed" tone="final" />
            <StatTile
              value={`₹${formatMinor(volume.toString(), 'INR')}`}
              label="Settled volume"
            />
          </Card>
        ) : null}

        {/* ---- Filters, as real links -------------------------------- */}
        <nav aria-label="Filter deals" className="mt-5">
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
              <ul className="grid gap-3 sm:grid-cols-2 lg:hidden">
                {shown.map((deal) => (
                  <li key={deal.dealId}>
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

        {/* ---- What each scenario means, once ------------------------ */}
        {deals.length > 0 ? (
          <section className="mt-8">
            <SectionHead title="Deal types" />
            <ul className="mt-3 grid gap-3 sm:grid-cols-3">
              {(Object.keys(SCENARIO) as Scenario[]).map((key) => {
                const meta = SCENARIO[key];
                const count = deals.filter((d) => d.direction === key).length;
                return (
                  <li key={key}>
                    <Card className="h-full">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[length:var(--text-sm)] font-semibold text-[var(--color-ink)]">
                          {meta.title}
                        </span>
                        <span className="tnum text-[length:var(--text-xs)] text-[var(--color-ink-4)]">
                          {count}
                        </span>
                      </div>
                      <p className="mt-1 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                        {meta.blurb}
                      </p>
                    </Card>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
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

/** Used by the header on narrow screens where the button does not fit. */
export function NewDealFab() {
  return (
    <Link
      href="/app/new"
      prefetch={false}
      aria-label="Create a protected deal"
      className="press grid h-10 w-10 place-items-center rounded-full bg-[var(--color-brand)] text-white shadow-[var(--shadow-brand)]"
    >
      <Icon name="plus" className="h-5 w-5" strokeWidth={2.2} />
    </Link>
  );
}
