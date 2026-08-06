import Link from 'next/link';
import { cn } from '@/lib/cn';
import { DEAL_STATE, dealTitle, legsFor, roleLabel, settlementLegs } from '@/lib/dealPresenter';
import type { DealView } from '@/lib/sandboxContract';
import { Avatar, Status } from '@/components/kit/primitives';
import { Icon } from '@/components/kit/Icon';
import { AssetMark } from '@/components/kit/Icon';
import { Deadline } from '@/components/kit/Time';

/**
 * A deal, as it appears in a list.
 *
 * Ordered by what a person actually scans for: is this mine to act on, how
 * much, with whom, and by when. The amount is the largest thing in the card
 * because it is the fact people recognise their own deal by — not the code,
 * not the title.
 *
 * A deal awaiting the viewer carries the action border and a saffron call to
 * action. Everything else is graphite, so a list of twelve deals still has
 * exactly as many highlighted rows as there are things to do.
 */
export function DealCard({ deal, className }: { deal: DealView; className?: string }) {
  const meta = DEAL_STATE[deal.state];
  const mine = deal.permitted.canClaim || deal.permitted.canConfirm;
  const settle = settlementLegs(deal);
  const legs = legsFor(deal, deal.viewerRole);
  const isFiat = deal.viewerRole === 'FIAT_SIDE';

  // The figure that matters to THIS viewer: what leaves if they pay, what
  // lands if they receive.
  const headline = isFiat ? settle.payerSends : settle.payeeReceives;

  return (
    <Link
      href={`/app/deal/${deal.dealId}`}
      prefetch={false}
      className={cn(
        'lift block rounded-[var(--radius-lg)] border bg-[var(--color-paper)] p-4 shadow-[var(--shadow-card)]',
        mine
          ? 'border-[var(--color-brand-line)]'
          : 'border-[var(--color-line)] hover:border-[var(--color-rule)]',
        meta.halted && 'opacity-95',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
            {dealTitle(deal)}
          </p>
          <p className="mt-0.5 font-mono text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">
            {deal.dealCode}
          </p>
        </div>
        <Status tone={meta.tone} size="sm">
          {meta.label}
        </Status>
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="tnum text-[length:var(--text-2xl)] font-semibold tracking-[-0.028em] text-[var(--color-ink)]">
            {headline.display}
            <span className="sr-only"> {headline.srLabel}</span>
          </p>
          {deal.direction !== 'INR_TO_INR' ? (
            <p className="mt-0.5 flex items-center gap-1.5 text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
              <Icon name="swap" className="h-3.5 w-3.5" />
              <span className="tnum">{isFiat ? legs.receive.display : legs.send.display}</span>
            </p>
          ) : null}
        </div>
        <AssetMark asset={isFiat ? 'INR' : legs.send.asset} size="md" />
      </div>

      <div className="mt-3.5 flex items-center gap-2 border-t border-[var(--color-line)] pt-3">
        <Avatar name={deal.counterpartyName} size="xs" verified={deal.counterpartyVerified} />
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
          <span className="capitalize text-[var(--color-ink-2)]">{deal.counterpartyName}</span>
          {' · '}
          {roleLabel(deal.direction, deal.viewerRole === 'FIAT_SIDE' ? 'CRYPTO_SIDE' : 'FIAT_SIDE')}
        </span>
        {mine ? (
          <span className="shrink-0 text-[length:var(--text-xs)] font-semibold text-[var(--color-brand)]">
            {deal.permitted.canClaim ? 'Pay now' : 'Confirm'}
          </span>
        ) : deal.actionDeadline && !meta.halted ? (
          <span className="shrink-0 text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">
            <Deadline iso={deal.actionDeadline} />
          </span>
        ) : null}
      </div>
    </Link>
  );
}

/**
 * The dense variant, for the desktop Deal Rail and the history table.
 *
 * Same facts, one line. A person moving between the card grid and the rail
 * should recognise the same deal instantly, so the amount keeps its weight
 * and the status keeps its badge.
 */
export function DealRow({ deal }: { deal: DealView }) {
  const meta = DEAL_STATE[deal.state];
  const mine = deal.permitted.canClaim || deal.permitted.canConfirm;
  const settle = settlementLegs(deal);
  const isFiat = deal.viewerRole === 'FIAT_SIDE';
  const headline = isFiat ? settle.payerSends : settle.payeeReceives;

  return (
    <Link
      href={`/app/deal/${deal.dealId}`}
      prefetch={false}
      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-sunken)] sm:px-5"
    >
      <span
        aria-hidden
        className={cn(
          'grid h-9 w-9 shrink-0 place-items-center rounded-full',
          meta.tone === 'final'
            ? 'bg-[var(--color-final-tint)] text-[var(--color-final)]'
            : meta.tone === 'risk'
              ? 'bg-[var(--color-risk-tint)] text-[var(--color-risk)]'
              : mine
                ? 'bg-[var(--color-brand-tint)] text-[var(--color-brand)]'
                : 'bg-[var(--color-sunken)] text-[var(--color-ink-3)]',
        )}
      >
        <Icon
          name={
            meta.tone === 'final'
              ? 'check'
              : meta.tone === 'risk'
                ? 'alert'
                : deal.direction === 'INR_TO_INR'
                  ? 'shield'
                  : 'swap'
          }
          className="h-4 w-4"
        />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[length:var(--text-base)] font-medium text-[var(--color-ink)]">
          {dealTitle(deal)}
        </span>
        <span className="mt-0.5 block truncate text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
          <span className="capitalize">{deal.counterpartyName}</span>
          {' · '}
          <span className="font-mono">{deal.dealCode}</span>
        </span>
      </span>

      <span className="hidden shrink-0 sm:block">
        <Status tone={meta.tone} size="sm">
          {meta.label}
        </Status>
      </span>

      <span className="shrink-0 text-right">
        <span className="tnum block text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
          {headline.display}
        </span>
        {mine ? (
          <span className="block text-[length:var(--text-2xs)] font-semibold text-[var(--color-brand)]">
            {deal.permitted.canClaim ? 'Pay now' : 'Confirm'}
          </span>
        ) : deal.actionDeadline && !meta.halted ? (
          <span className="block text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">
            <Deadline iso={deal.actionDeadline} />
          </span>
        ) : null}
      </span>

      <Icon name="chevron-right" className="h-4 w-4 shrink-0 text-[var(--color-ink-4)]" />
    </Link>
  );
}
