import Link from 'next/link';
import { listDealsForUser, type DealView } from '@/server/sandbox/service';
import { requireUser } from '@/server/sandbox/session';
import { formatMinor } from '@/lib/format';
import { BottomNav, DeskNav } from '@/components/kit/AppChrome';
import {
  ActionLink,
  Label,
  Money,
  Panel,
  Rail,
  Shell,
  Status,
  type Tone,
} from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * Transaction home.
 *
 * Organised by WHOSE MOVE IT IS, not by arbitrary KPI tiles. A person
 * opening this wants one question answered — is anything waiting on me —
 * so that section comes first and is the only one with the action colour.
 */
export default async function DealsPage() {
  const user = await requireUser();
  const deals = await listDealsForUser(user);

  const needsYou = deals.filter((d) => d.permitted.canClaim || d.permitted.canConfirm);
  const inFlight = deals.filter(
    (d) => !needsYou.includes(d) && d.state !== 'COMPLETED' && d.state !== 'CANCELLED',
  );
  const settled = deals.filter((d) => d.state === 'COMPLETED' || d.state === 'CANCELLED');

  return (
    <>
      <Shell width="content" className="py-6 sm:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[length:var(--text-2xl)] font-semibold tracking-[-0.025em] text-[var(--color-ink)]">
              Your deals
            </h1>
            <p className="mt-1 text-[length:var(--text-sm)] text-[var(--color-ink-3)]">
              Held on the server. These survive a reload and a restart.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <DeskNav active="deals" isOperator={user.isOperator} />
            <ActionLink
              href="/app/new"
              variant="primary"
              size="sm"
              className="hidden md:inline-flex"
            >
              Create a deal link
            </ActionLink>
          </div>
        </div>

        {deals.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="mt-7 space-y-8">
            {needsYou.length > 0 ? (
              <Group title="Waiting on you" count={needsYou.length} accent deals={needsYou} />
            ) : null}
            {inFlight.length > 0 ? (
              <Group title="In progress" count={inFlight.length} deals={inFlight} />
            ) : null}
            {settled.length > 0 ? (
              <Group title="Settled" count={settled.length} deals={settled} muted />
            ) : null}
          </div>
        )}
      </Shell>
      <BottomNav active="deals" isOperator={user.isOperator} />
    </>
  );
}

function Group({
  title,
  count,
  deals,
  accent = false,
  muted = false,
}: {
  title: string;
  count: number;
  deals: readonly DealView[];
  accent?: boolean;
  muted?: boolean;
}) {
  return (
    <section>
      <div className="flex items-center gap-3">
        <h2
          className={`text-[length:var(--text-sm)] font-semibold ${
            accent ? 'text-[var(--color-action)]' : 'text-[var(--color-ink)]'
          }`}
        >
          {title}
        </h2>
        <span className="tnum text-[length:var(--text-xs)] text-[var(--color-ink-4)]">{count}</span>
        <Rail live={accent} className="flex-1" />
      </div>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {deals.map((d) => (
          <li key={d.dealId}>
            <DealCard deal={d} muted={muted} />
          </li>
        ))}
      </ul>
    </section>
  );
}

const STATE_TONE: Record<DealView['state'], Tone> = {
  FIAT_PENDING: 'idle',
  FIAT_CLAIMED: 'hold',
  COMPLETED: 'final',
  CANCELLED: 'idle',
};

const STATE_LABEL: Record<DealView['state'], string> = {
  FIAT_PENDING: 'Awaiting payment',
  FIAT_CLAIMED: 'Awaiting confirmation',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

function DealCard({ deal, muted }: { deal: DealView; muted?: boolean }) {
  const yours = deal.permitted.canClaim || deal.permitted.canConfirm;
  return (
    <Link
      href={`/app/deal/${deal.dealId}`}
      className={`press block rounded-[var(--radius-lg)] border bg-[var(--color-paper)] p-4 transition-colors ${
        yours
          ? 'border-[var(--color-action-line)] hover:border-[var(--color-action)]'
          : 'border-[var(--color-line)] hover:border-[var(--color-edge)]'
      } ${muted ? 'opacity-90' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">
          {deal.publicId}
        </span>
        <Status tone={STATE_TONE[deal.state]}>{STATE_LABEL[deal.state]}</Status>
      </div>

      <div className="mt-3">
        <Money value={formatMinor(deal.usdtMinor, 'USDT')} unit="USDT" size="md" />
      </div>
      <div className="my-2">
        <Rail live={yours} />
      </div>
      <p className="tnum text-[length:var(--text-base)] font-medium text-[var(--color-ink-2)]">
        ₹{formatMinor(deal.inrMinor, 'INR')}
      </p>

      <p className="mt-3 border-t border-[var(--color-line)] pt-2.5 text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
        {yours ? (
          <span className="font-medium text-[var(--color-action)]">
            {deal.permitted.canClaim ? 'Mark your INR payment' : 'Confirm the INR arrived'}
          </span>
        ) : (
          <>You are the {deal.viewerRole === 'FIAT_SIDE' ? 'INR sender' : 'USDT supplier'}</>
        )}
      </p>
    </Link>
  );
}

function EmptyState() {
  return (
    <Panel className="mt-7 p-8 text-center sm:p-12">
      <Label>Nothing here yet</Label>
      <h2 className="mt-2 text-[length:var(--text-xl)] font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
        Your first deal starts with a link
      </h2>
      <p className="mx-auto mt-2 max-w-[46ch] text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
        Fix an amount, get a firm rate from the server, and send the link to the person you want to
        trade with. Exactly one of them can take it.
      </p>
      <ActionLink href="/app/new" variant="primary" size="md" className="mt-6">
        Create a deal link
      </ActionLink>
    </Panel>
  );
}
