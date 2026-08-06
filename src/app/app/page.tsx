import Link from 'next/link';
import { listDealsForUser } from '@/server/sandbox/service';
import { getTrustProfile } from '@/server/sandbox/identity';
import { getChrome } from '@/server/sandbox/chrome';
import { formatMinor } from '@/lib/format';
import { DEAL_STATE, dealTitle, settlementLegs } from '@/lib/dealPresenter';
import type { DealView } from '@/lib/sandboxContract';
import { AppHeader } from '@/components/kit/AppChrome';
import { DealCard, DealRow } from '@/components/deal/DealCard';
import { Icon, type IconName } from '@/components/kit/Icon';
import { Deadline } from '@/components/kit/Time';
import {
  ActionLink,
  Card,
  Chip,
  EmptyState,
  SectionHead,
  Shell,
  VerifiedTick,
} from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * Home.
 *
 * Answers one question first — *what are you doing today* — because this is
 * a product people arrive at WITH an intention rather than one they browse.
 * The three intents are the whole surface, so they come first and largest.
 *
 * Below them, and only when it has content, comes what needs the person.
 * That section is the only one carrying the action colour, so a glance
 * answers "is anything on me?" without reading a word.
 */
export default async function HomePage() {
  const { user, unread } = await getChrome();
  const [deals, profile] = await Promise.all([listDealsForUser(user), getTrustProfile(user)]);

  const needsYou = deals.filter((d) => d.permitted.canClaim || d.permitted.canConfirm);
  const live = deals.filter(
    (d) =>
      !DEAL_STATE[d.state].halted &&
      d.state !== 'COMPLETED' &&
      !d.permitted.canClaim &&
      !d.permitted.canConfirm,
  );
  const recent = deals.slice(0, 6);

  return (
    <>
      <AppHeader
        title={
          <span className="flex items-center gap-2">
            <span>Welcome back, {user.displayName.split(' ')[0]}</span>
            {profile.identityVerified ? <VerifiedTick /> : null}
          </span>
        }
        subtitle={`${profile.safePoints.toLocaleString('en-IN')} SafePoints · Level ${profile.level}`}
        unread={unread}
      />

      <Shell width="wide" className="py-5 sm:py-7">
        {/* ---- The three intents ------------------------------------- */}
        <section aria-labelledby="intents">
          <h2
            id="intents"
            className="text-[length:var(--text-xl)] font-semibold tracking-[-0.028em] text-[var(--color-ink)] sm:text-[length:var(--text-2xl)]"
          >
            What are you doing today?
          </h2>
          <p className="mt-1 text-[length:var(--text-base)] text-[var(--color-ink-3)]">
            Protected deals for payments, and for INR ⇄ USDT exchanges.
          </p>

          <ul className="stagger mt-4 grid gap-3 sm:grid-cols-3">
            {INTENTS.map((intent) => (
              <li key={intent.href}>
                <IntentCard {...intent} />
              </li>
            ))}
          </ul>
        </section>

        {/* ---- Waiting on you ---------------------------------------- */}
        {needsYou.length > 0 ? (
          <section className="mt-8">
            <SectionHead title="Waiting on you" count={needsYou.length} accent />
            <ul className="mt-3 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
              {needsYou.map((deal) => (
                <li key={deal.dealId}>
                  <AttentionCard deal={deal} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* ---- In progress ------------------------------------------- */}
        {live.length > 0 ? (
          <section className="mt-8">
            <SectionHead title="In progress" count={live.length} />
            <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {live.map((deal) => (
                <li key={deal.dealId}>
                  <DealCard deal={deal} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* ---- The rail ---------------------------------------------- */}
        <section className="mt-8">
          <SectionHead
            title="Deal rail"
            action={deals.length > 0 ? { href: '/app/deals', label: 'View all' } : undefined}
          />
          {deals.length === 0 ? (
            <EmptyState
              className="mt-3"
              icon="shield"
              title="Your first protected deal starts with a link"
              body="Fix the amount, protect it, and send the link to the person you are dealing with. Exactly one person can take it."
              action={{ href: '/app/new', label: 'Create a protected deal' }}
            />
          ) : (
            <Card className="mt-3" flush seam>
              {recent.map((deal) => (
                <DealRow key={deal.dealId} deal={deal} />
              ))}
            </Card>
          )}
        </section>

        {/* ---- Trust and rewards, quietly ---------------------------- */}
        <section className="mt-8 grid gap-3 sm:grid-cols-2">
          <SummaryCard
            href="/app/profile"
            icon="shield-check"
            tone="final"
            title={`${profile.completedDeals} completed${
              profile.completionRate !== null ? ` · ${profile.completionRate}% completion` : ''
            }`}
            body={
              profile.openDisputes === 0
                ? 'No unresolved disputes.'
                : `${profile.openDisputes} case${profile.openDisputes === 1 ? '' : 's'} open.`
            }
            label="Open your trust profile"
          />
          <SummaryCard
            href="/app/rewards"
            icon="gift"
            tone="brand"
            title={`${profile.safePoints.toLocaleString('en-IN')} SafePoints`}
            body={`₹${formatMinor(profile.feeCreditMinor, 'INR')} of fee credit available`}
            label="Open rewards"
          />
        </section>
      </Shell>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The three intents
 * ------------------------------------------------------------------ */

interface Intent {
  readonly href: string;
  readonly title: string;
  readonly body: string;
  readonly icon: IconName;
  readonly tone: 'brand' | 'final' | 'info';
}

const INTENTS: readonly Intent[] = [
  {
    href: '/app/new?intent=pay',
    title: 'Pay safely',
    body: 'Pay for work or goods. The money stays protected until you confirm.',
    icon: 'arrow-right',
    tone: 'brand',
  },
  {
    href: '/app/new?intent=receive',
    title: 'Get paid',
    body: 'Send a request. Your client protects the money before you start.',
    icon: 'arrow-down',
    tone: 'final',
  },
  {
    href: '/app/new?scenario=INR_TO_USDT',
    title: 'Exchange',
    body: 'INR ⇄ USDT at a firm rate, with one verified counterparty.',
    icon: 'swap',
    tone: 'info',
  },
];

const TONE_BUBBLE = {
  brand: 'bg-[var(--color-brand-tint)] text-[var(--color-brand)]',
  final: 'bg-[var(--color-final-tint)] text-[var(--color-final)]',
  info: 'bg-[var(--color-info-tint)] text-[var(--color-info)]',
} as const;

function IntentCard({ href, title, body, icon, tone }: Intent) {
  return (
    <Link
      href={href}
      prefetch={false}
      className="lift group flex h-full items-center gap-3.5 rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-paper)] p-4 shadow-[var(--shadow-card)] sm:flex-col sm:items-start sm:gap-3 sm:p-5"
    >
      <span
        className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${TONE_BUBBLE[tone]}`}
      >
        <Icon name={icon} className="h-5 w-5" strokeWidth={2} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
          {title}
        </span>
        <span className="mt-1 block text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-3)]">
          {body}
        </span>
      </span>
      <Icon
        name="chevron-right"
        className="h-4 w-4 shrink-0 text-[var(--color-ink-4)] transition-transform duration-[var(--dur-fast)] group-hover:translate-x-0.5 sm:hidden"
      />
    </Link>
  );
}

function SummaryCard({
  href,
  icon,
  tone,
  title,
  body,
  label,
}: {
  href: string;
  icon: IconName;
  tone: 'brand' | 'final' | 'info';
  title: string;
  body: string;
  label: string;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      aria-label={label}
      className="lift flex items-center gap-4 rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-paper)] p-4 shadow-[var(--shadow-card)]"
    >
      <span
        className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${TONE_BUBBLE[tone]}`}
      >
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="tnum block truncate text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
          {title}
        </span>
        <span className="mt-0.5 block truncate text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
          {body}
        </span>
      </span>
      <Icon name="chevron-right" className="h-4 w-4 shrink-0 text-[var(--color-ink-4)]" />
    </Link>
  );
}

/* ------------------------------------------------------------------ *
 * Attention card
 * ------------------------------------------------------------------ */

/**
 * A deal waiting on the viewer.
 *
 * Deliberately louder than a deal card: it names the action in the button
 * label, so a person does not have to open the deal to discover what is
 * being asked of them.
 */
function AttentionCard({ deal }: { deal: DealView }) {
  const settle = settlementLegs(deal);
  const isFiat = deal.viewerRole === 'FIAT_SIDE';
  const amount = isFiat ? settle.payerSends : settle.payeeReceives;
  const paying = deal.permitted.canClaim;

  return (
    <Card tone="brand">
      <div className="flex items-start justify-between gap-3">
        <Chip tone="brand" icon={paying ? 'clock' : 'check-circle'}>
          {paying ? 'Payment due' : 'Confirmation due'}
        </Chip>
        {deal.actionDeadline ? (
          <span className="text-[length:var(--text-xs)] font-semibold text-[var(--color-brand-ink)]">
            <Deadline iso={deal.actionDeadline} />
          </span>
        ) : null}
      </div>

      {/* The same fallback the deal card uses, so one deal is not called two
          different things on two screens of the same product. */}
      <p className="mt-3 truncate text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
        {dealTitle(deal)}
      </p>
      <p className="mt-0.5 truncate text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
        {deal.counterpartyName}
      </p>
      <p className="tnum mt-1 text-[length:var(--text-2xl)] font-semibold tracking-[-0.028em] text-[var(--color-ink)]">
        {amount.display}
        <span className="sr-only"> {amount.srLabel}</span>
      </p>

      <div className="mt-3.5 flex items-center gap-2">
        <ActionLink
          href={paying ? `/app/deal/${deal.dealId}/pay` : `/app/deal/${deal.dealId}`}
          variant="primary"
          size="sm"
          className="flex-1"
        >
          {paying ? 'Pay now' : 'Review and release'}
        </ActionLink>
        <ActionLink href={`/app/deal/${deal.dealId}`} variant="outline" size="sm">
          Open
        </ActionLink>
      </div>
    </Card>
  );
}
