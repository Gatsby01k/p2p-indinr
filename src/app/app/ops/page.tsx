import Link from 'next/link';
import { currentUser } from '@/server/sandbox/session';
import { AT_RISK_MINUTES, countBy, deskQueue, type DeskFilter } from '@/server/sandbox/ops';
import { getChrome } from '@/server/sandbox/chrome';
import { formatMinor } from '@/lib/format';
import { DEAL_STATE } from '@/lib/dealPresenter';
import { DISPUTE_REASON_COPY, type OperatorRow } from '@/lib/sandboxContract';
import { SCENARIO } from '@/lib/scenario';
import { cn } from '@/lib/cn';
import { AppHeader } from '@/components/kit/AppChrome';
import { Icon } from '@/components/kit/Icon';
import { QueueKeys } from '@/components/kit/QueueKeys';
import { Card, EmptyState, Notice, Shell, StatTile, Status } from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * The Operator Deal Desk.
 *
 * Settlement operations, not an admin table. Scan order matches how an
 * operator triages: what is escalated, what is going stale, then who owes
 * the move and how much is at stake.
 *
 * Authorization is decided BEFORE any queue data is fetched, so a denied
 * visitor's HTML never contains operator content at all — not hidden, not
 * collapsed, not present.
 *
 * ⚠ DISCLOSURE. This queue names the two parties, because a person
 * triaging disputes cannot work without knowing who is involved. It carries
 * no email address, no bank handle, no wallet address and no payment
 * reference — those live in the case view, are shown only for a deal that
 * is actually blocked, and opening one is itself written to the audit trail.
 */

const TABS: readonly { key: DeskFilter; label: string }[] = [
  { key: 'ALL', label: 'All open' },
  { key: 'DISPUTED', label: 'Escalations' },
  { key: 'AT_RISK', label: 'At risk' },
  { key: 'AWAITING_PAYMENT', label: 'Awaiting payment' },
  { key: 'AWAITING_CONFIRM', label: 'Awaiting confirm' },
];

export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const user = await currentUser();

  if (!user || !user.isOperator) {
    return (
      <Shell width="prose" className="py-10 sm:py-16">
        <div data-testid="access-denied">
          <p className="tnum text-[length:var(--text-5xl)] font-semibold tracking-[-0.04em] text-[var(--color-ink-4)]">
            403
          </p>
          <Notice
            className="mt-4"
            tone="risk"
            title="This area is restricted to operators"
            body={
              user
                ? 'Your account does not have operator permissions, so the queue was never loaded.'
                : 'You are not signed in, so the queue was never loaded.'
            }
            reassurance="No operator data was sent to this page, and no transaction was affected."
            nextStep={
              user
                ? 'If you should have operator access, ask an administrator to grant it. Otherwise return to your deals.'
                : 'Sign in with an operator account. In this sandbox, any address starting with ops@ is an operator.'
            }
            action={
              user
                ? { href: '/app', label: 'Back to your deals' }
                : { href: '/login?next=/app/ops', label: 'Sign in' }
            }
          />
        </div>
      </Shell>
    );
  }

  const { unread } = await getChrome();
  const params = await searchParams;
  const view: DeskFilter = TABS.find((t) => t.key === params.view)?.key ?? 'ALL';

  const [all, rows] = await Promise.all([deskQueue(user, 'ALL'), deskQueue(user, view)]);
  const counts = countBy(all);

  return (
    <>
      <AppHeader
        title="Deal Desk"
        subtitle="Deals that cannot progress without a person. Nothing here resolves on a timer."
        unread={unread}
      />

      <Shell width="ops" className="py-5 sm:py-7">
        {/* ---- What the desk is carrying ------------------------- */}
        <Card className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatTile value={counts.all} label="Open" />
          <StatTile
            value={counts.disputed}
            label="Escalations"
            tone={counts.disputed > 0 ? 'risk' : 'ink'}
          />
          <StatTile
            value={counts.atRisk}
            label={`Over ${AT_RISK_MINUTES}m`}
            tone={counts.atRisk > 0 ? 'brand' : 'ink'}
          />
          <StatTile value={counts.awaitingConfirm} label="Awaiting confirm" />
        </Card>

        {/* ---- Views, as real addresses -------------------------- */}
        <nav aria-label="Queue views" className="mt-5">
          <ul className="no-bar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            {TABS.map((tab) => {
              const count = {
                ALL: counts.all,
                DISPUTED: counts.disputed,
                AT_RISK: counts.atRisk,
                AWAITING_PAYMENT: counts.awaitingPayment,
                AWAITING_CONFIRM: counts.awaitingConfirm,
              }[tab.key];
              const active = tab.key === view;
              return (
                <li key={tab.key}>
                  <Link
                    href={tab.key === 'ALL' ? '/app/ops' : `/app/ops?view=${tab.key}`}
                    prefetch={false}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'press inline-flex items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-full)] border px-3.5 py-2 text-[length:var(--text-sm)] font-medium transition-colors',
                      active
                        ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-paper)]'
                        : 'border-[var(--color-line)] bg-[var(--color-paper)] text-[var(--color-ink-2)] hover:border-[var(--color-rule)]',
                    )}
                  >
                    {tab.label}
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

        {/* ---- The queue ----------------------------------------- */}
        {rows.length === 0 ? (
          <EmptyState
            className="mt-5"
            icon="check-circle"
            title="Nothing in this view"
            body="No deal here is waiting on an operator right now."
            action={{ href: '/app/ops', label: 'Show all open deals' }}
          />
        ) : (
          <>
            {/* Cards on narrow screens: a nine-column table on a phone is
                a table nobody can read. */}
            <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:hidden">
              {rows.map((row) => (
                <li key={row.dealId}>
                  <CaseCard row={row} />
                </li>
              ))}
            </ul>

            <Card className="mt-5 hidden lg:block" flush>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[64rem] border-collapse text-[length:var(--text-sm)]">
                  <caption className="sr-only">
                    Deals awaiting an operator, escalations first then oldest. {rows.length} shown.
                  </caption>
                  <thead>
                    <tr className="border-b border-[var(--color-rule)] bg-[var(--color-sunken)] text-left">
                      <Th className="w-[6rem]">Age</Th>
                      <Th className="w-[7.5rem]">Deal</Th>
                      <Th className="w-[7rem]">Type</Th>
                      <Th className="w-[11rem]">State</Th>
                      <Th>Parties</Th>
                      <Th className="w-[8rem]">Trail</Th>
                      <Th className="w-[9.5rem] text-right">Amount</Th>
                      <Th className="w-[10rem]">Next action</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-line)]">
                    {rows.map((row) => (
                      <QueueRow key={row.dealId} row={row} />
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <div className="hidden lg:block">
              <QueueKeys />
            </div>
          </>
        )}

        <p className="mt-5 max-w-[76ch] text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
          The queue carries the parties and the amounts, because triage needs both. It carries no
          email address, bank handle, wallet address or payment reference — those appear only in a
          case, only for a deal that is actually blocked, and opening one is written to the audit
          trail.
        </p>
      </Shell>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

function nextAction(row: OperatorRow): { label: string; tone: 'risk' | 'brand' | 'idle' } {
  if (row.disputed) return { label: 'Review case', tone: 'risk' };
  if (row.waitingMinutes >= AT_RISK_MINUTES) {
    return {
      label: row.state === 'FIAT_PENDING' ? 'Chase payer' : 'Chase receiver',
      tone: 'brand',
    };
  }
  return { label: 'Monitor', tone: 'idle' };
}

function QueueRow({ row }: { row: OperatorRow }) {
  const meta = DEAL_STATE[row.state];
  const hot = row.waitingMinutes >= AT_RISK_MINUTES;
  const action = nextAction(row);

  return (
    <tr
      tabIndex={0}
      data-queue-row
      data-href={`/app/ops/${row.dealId}`}
      className="cursor-pointer outline-none transition-colors hover:bg-[var(--color-sunken)] focus-visible:bg-[var(--color-sunken)]"
    >
      <Td>
        <span
          className={cn(
            'tnum font-semibold',
            row.disputed
              ? 'text-[var(--color-risk)]'
              : hot
                ? 'text-[var(--color-brand)]'
                : 'text-[var(--color-ink-2)]',
          )}
        >
          {row.waitingMinutes}m
        </span>
        {hot ? <span className="sr-only"> — over the {AT_RISK_MINUTES} minute mark</span> : null}
      </Td>
      <Td>
        {/* `whitespace-nowrap`: a deal code is a single token people read
            aloud and paste. Breaking it across two lines at the hyphen makes
            it look like two different references. */}
        <Link
          href={`/app/ops/${row.dealId}`}
          prefetch={false}
          className="whitespace-nowrap font-mono text-[length:var(--text-xs)] font-semibold text-[var(--color-ink)] underline-offset-4 hover:underline"
        >
          {row.dealCode}
        </Link>
      </Td>
      <Td>
        <span className="text-[length:var(--text-xs)] text-[var(--color-ink-2)]">
          {SCENARIO[row.direction].short}
        </span>
      </Td>
      <Td>
        <Status tone={meta.tone} size="sm">
          {meta.label}
        </Status>
      </Td>
      <Td>
        <span className="block truncate text-[var(--color-ink)]">
          {row.payerName}
          <span className="text-[var(--color-ink-4)]"> → </span>
          {row.payeeName}
        </span>
        {row.disputed && row.disputeReason ? (
          <span className="mt-0.5 block truncate text-[length:var(--text-2xs)] text-[var(--color-risk)]">
            {DISPUTE_REASON_COPY[row.disputeReason].label}
          </span>
        ) : null}
      </Td>
      <Td>
        <span className="flex items-center gap-2.5 text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
          <span className="inline-flex items-center gap-1">
            <Icon name="file" className="h-3.5 w-3.5" />
            <span className="tnum">{row.evidenceCount}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <Icon name="message" className="h-3.5 w-3.5" />
            <span className="tnum">{row.messageCount}</span>
          </span>
        </span>
      </Td>
      <Td className="text-right">
        <span className="tnum block font-semibold text-[var(--color-ink)]">
          ₹{formatMinor(row.inrMinor, 'INR')}
        </span>
        {row.usdtMinor ? (
          <span className="tnum block text-[length:var(--text-2xs)] text-[var(--color-ink-3)]">
            {formatMinor(row.usdtMinor, 'USDT')} USDT
          </span>
        ) : null}
      </Td>
      <Td>
        <Link
          href={`/app/ops/${row.dealId}`}
          prefetch={false}
          className={cn(
            'inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-[length:var(--text-xs)] font-semibold',
            action.tone === 'risk' && 'bg-[var(--color-risk-tint)] text-[var(--color-risk)]',
            action.tone === 'brand' && 'bg-[var(--color-brand-tint)] text-[var(--color-brand-ink)]',
            action.tone === 'idle' && 'text-[var(--color-ink-3)]',
          )}
        >
          {action.label}
          <Icon name="chevron-right" className="h-3.5 w-3.5" strokeWidth={2.2} />
        </Link>
      </Td>
    </tr>
  );
}

function CaseCard({ row }: { row: OperatorRow }) {
  const meta = DEAL_STATE[row.state];
  const action = nextAction(row);
  return (
    <Link
      href={`/app/ops/${row.dealId}`}
      prefetch={false}
      className={cn(
        'lift block rounded-[var(--radius-lg)] border bg-[var(--color-paper)] p-4 shadow-[var(--shadow-card)]',
        row.disputed ? 'border-[var(--color-risk-line)]' : 'border-[var(--color-line)]',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[length:var(--text-xs)] font-semibold text-[var(--color-ink)]">
          {row.dealCode}
        </span>
        <Status tone={meta.tone} size="sm">
          {meta.label}
        </Status>
      </div>
      <p className="tnum mt-2 text-[length:var(--text-xl)] font-semibold text-[var(--color-ink)]">
        ₹{formatMinor(row.inrMinor, 'INR')}
      </p>
      <p className="mt-1 truncate text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
        {row.payerName} → {row.payeeName}
      </p>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--color-line)] pt-2.5">
        <span className="tnum text-[length:var(--text-xs)] text-[var(--color-ink-4)]">
          {row.waitingMinutes}m waiting
        </span>
        <span
          className={cn(
            'text-[length:var(--text-xs)] font-semibold',
            action.tone === 'risk'
              ? 'text-[var(--color-risk)]'
              : action.tone === 'brand'
                ? 'text-[var(--color-brand)]'
                : 'text-[var(--color-ink-3)]',
          )}
        >
          {action.label}
        </span>
      </div>
    </Link>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`px-3 py-2.5 text-[length:var(--text-2xs)] font-semibold uppercase tracking-[0.07em] text-[var(--color-ink-4)] ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-3 align-middle ${className}`}>{children}</td>;
}
