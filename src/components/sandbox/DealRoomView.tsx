'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { claimAction, confirmAction } from '@/server/sandbox/actions';
import { FAILURE_COPY, type DealView } from '@/lib/sandboxContract';
import { formatMinor } from '@/lib/format';
import { SandboxNote } from './SandboxChrome';

/**
 * The deal room.
 *
 * Preserves the UX-01 six-question contract: what is happening, what must I
 * do, what must they do, where are the funds, what happens next, and what if
 * it goes wrong. Each is answered explicitly below — none is left implied.
 *
 * AUTHORITY: every action rendered here comes from `deal.permitted`, which the
 * server computed from the viewer's seat and the deal's state. This component
 * derives no permission of its own, performs no transition, and infers no fund
 * movement. Submitting anyway is safe: the server re-checks and rejects.
 */

const STATE_META: Readonly<
  Record<DealView['state'], { label: string; tone: string; headline: string }>
> = {
  FIAT_PENDING: {
    label: 'Awaiting payment',
    tone: 'bg-blue-50 text-blue-800 ring-blue-600/20',
    headline: 'The deal is live and the INR transfer is outstanding.',
  },
  FIAT_CLAIMED: {
    label: 'Awaiting confirmation',
    tone: 'bg-amber-50 text-amber-900 ring-amber-600/20',
    headline: 'A payment has been marked. The receiver is checking their account.',
  },
  COMPLETED: {
    label: 'Completed',
    tone: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20',
    headline: 'Settled. Both sides are done.',
  },
  CANCELLED: {
    label: 'Cancelled',
    tone: 'bg-slate-100 text-slate-700 ring-slate-500/20',
    headline: 'This deal ended without settlement.',
  },
};

export function DealRoomView({ deal }: { deal: DealView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [utr, setUtr] = useState('');
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<{ reason: string; nextStep: string } | null>(null);

  const meta = STATE_META[deal.state];
  const isFiat = deal.viewerRole === 'FIAT_SIDE';
  const terminal = deal.state === 'COMPLETED' || deal.state === 'CANCELLED';

  // The six questions, answered from authoritative state only.
  const funds = terminal
    ? deal.state === 'COMPLETED'
      ? 'Simulated release complete. No real USDT existed and none moved.'
      : 'Nothing is outstanding. No real USDT existed and none moved.'
    : 'A simulated hold is recorded against this deal. No real USDT is held — this is a sandbox.';

  const yourMove = terminal
    ? null
    : deal.permitted.canClaim
      ? 'Send the INR from your bank, then enter the 12-character UTR to mark it paid.'
      : deal.permitted.canConfirm
        ? 'Check your account for the exact amount, then confirm it arrived.'
        : null;

  const theirMove = terminal
    ? null
    : isFiat
      ? deal.state === 'FIAT_CLAIMED'
        ? 'They are checking their account for your payment.'
        : 'They are waiting for your payment.'
      : deal.state === 'FIAT_PENDING'
        ? 'They must send the INR and mark it paid.'
        : null;

  const ifNothing = terminal
    ? 'Nothing further is required.'
    : 'Nothing is released, refunded or moved on a timer. A person has to act.';

  const run = (fn: () => Promise<{ ok: boolean; code?: string; message?: string }>) =>
    startTransition(async () => {
      setFailure(null);
      const result = await fn();
      if (result.ok) {
        setUtr('');
        setNote('');
        router.refresh();
        return;
      }
      const copy =
        result.code && result.code !== 'UNKNOWN'
          ? FAILURE_COPY[result.code as keyof typeof FAILURE_COPY]
          : null;
      setFailure(
        copy ?? {
          reason: result.message ?? 'That did not work.',
          nextStep: 'Refresh the page to see the current state of the deal.',
        },
      );
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 sm:px-6">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight text-slate-900">Sell USDT</h1>
              <span
                data-testid="deal-status"
                className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${meta.tone}`}
              >
                {meta.label}
              </span>
            </div>
            <p className="mt-1.5 text-sm text-slate-600">{meta.headline}</p>
          </div>
          <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
            You are the {isFiat ? 'INR sender' : 'USDT supplier'}
          </span>
        </div>

        <div className="grid gap-5 px-5 py-5 sm:grid-cols-2 sm:px-6">
          <Figure label="Amount" value={`${formatMinor(deal.usdtMinor, 'USDT')} USDT`} />
          <Figure label="Value" value={`₹${formatMinor(deal.inrMinor, 'INR')}`} emphasis />
          <Meta
            term="Rate"
            detail={`${(Number(deal.rateNum) / Number(deal.rateDen)).toFixed(2)} INR / USDT`}
          />
          <Meta term="Counterparty" detail={deal.counterpartyName} />
          <Meta term="Reference" detail={deal.publicId} />
          <Meta
            term="Started"
            detail={new Date(deal.createdAt).toLocaleString('en-IN', {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          />
        </div>
      </section>

      {/* The six-question contract. */}
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <h2 className="border-b border-slate-200 px-5 py-3 text-sm font-semibold text-slate-900 sm:px-6">
          Where things stand
        </h2>
        <dl className="divide-y divide-slate-100 text-sm">
          <QA term="Funds" detail={funds} />
          {yourMove ? <QA term="You" detail={yourMove} /> : null}
          {theirMove ? <QA term="They" detail={theirMove} /> : null}
          {deal.claim ? (
            <QA
              term="Payment marked"
              detail={`UTR ${deal.claim.utr} · ${new Date(deal.claim.submittedAt).toLocaleString(
                'en-IN',
                { dateStyle: 'medium', timeStyle: 'short' },
              )}${deal.claim.note ? ` · “${deal.claim.note}”` : ''}`}
            />
          ) : null}
          <QA term="If nobody acts" detail={ifNothing} />
        </dl>
      </section>

      {failure ? (
        <div
          role="alert"
          className="rounded-xl border border-amber-500/30 bg-amber-50 px-4 py-3"
          data-testid="deal-failure"
        >
          <p className="text-sm font-semibold text-amber-900">{failure.reason}</p>
          <p className="mt-1 text-sm leading-relaxed text-amber-900">{failure.nextStep}</p>
        </div>
      ) : null}

      {/* Only the server-permitted action is offered. */}
      {deal.permitted.canClaim ? (
        <section
          className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
          data-testid="claim-panel"
        >
          <h2 className="text-sm font-semibold text-slate-900">Mark the INR sent</h2>
          <p className="mt-1 text-sm leading-relaxed text-slate-600">
            Enter the 12-character reference from your bank confirmation. It is checked against
            every other deal, so each transfer can only be claimed once.
          </p>
          <SandboxNote className="mt-3" />
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="text-xs font-medium text-slate-700">UTR</span>
              <input
                value={utr}
                onChange={(e) => setUtr(e.target.value.toUpperCase())}
                maxLength={12}
                placeholder="e.g. AXIS12345678"
                aria-label="UTR"
                className="mt-1 h-11 w-full rounded-lg border border-slate-300 px-3 font-mono text-sm tracking-wider uppercase"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-700">Note (optional)</span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                aria-label="Note"
                className="mt-1 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm"
              />
            </label>
            <button
              type="button"
              disabled={pending || utr.trim().length !== 12}
              data-testid="claim-submit"
              onClick={() => run(() => claimAction(deal.dealId, utr, note))}
              className="h-11 w-full rounded-lg bg-slate-900 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {pending ? 'Submitting…' : 'I have sent the INR'}
            </button>
          </div>
        </section>
      ) : null}

      {deal.permitted.canConfirm ? (
        <section
          className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
          data-testid="confirm-panel"
        >
          <h2 className="text-sm font-semibold text-slate-900">Confirm the INR arrived</h2>
          <p className="mt-1 text-sm leading-relaxed text-slate-600">
            Confirm only once the exact amount is actually credited to your account. In a live deal
            this releases the USDT and cannot be undone.
          </p>
          <SandboxNote className="mt-3" />
          <button
            type="button"
            disabled={pending}
            data-testid="confirm-submit"
            onClick={() => run(() => confirmAction(deal.dealId))}
            className="mt-4 h-11 w-full rounded-lg bg-emerald-700 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            {pending
              ? 'Confirming…'
              : 'Confirm ₹' + formatMinor(deal.inrMinor, 'INR') + ' received'}
          </button>
        </section>
      ) : null}

      {terminal ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600 shadow-sm sm:p-6">
          This deal is finished and can no longer change. Nothing further is required.
        </section>
      ) : null}
    </div>
  );
}

function Figure({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p
        className={
          emphasis
            ? 'mt-0.5 text-2xl font-semibold tabular-nums tracking-tight text-slate-900'
            : 'mt-0.5 text-xl font-medium tabular-nums text-slate-900'
        }
      >
        {value}
      </p>
    </div>
  );
}

function Meta({ term, detail }: { term: string; detail: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{term}</p>
      <p className="mt-0.5 text-sm font-medium text-slate-900">{detail}</p>
    </div>
  );
}

function QA({ term, detail }: { term: string; detail: string }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 px-5 py-3 sm:px-6">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{term}</dt>
      <dd className="text-sm leading-relaxed text-slate-800">{detail}</dd>
    </div>
  );
}
