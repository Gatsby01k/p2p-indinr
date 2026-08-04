'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { claimAction, confirmAction } from '@/server/sandbox/actions';
import { FAILURE_COPY, type DealView } from '@/lib/sandboxContract';
import { formatMinor } from '@/lib/format';
import { Seal } from './Brand';
import {
  ExchangeRail,
  Label,
  Money,
  Notice,
  SandboxLine,
  Status,
  buttonClass,
  type Tone,
} from './primitives';

/**
 * The deal room — the product's signature screen.
 *
 * Composed to answer, in order and without hunting:
 *   what am I exchanging · what is locked · what is my role ·
 *   where is this now · whose move · what do I do · by when ·
 *   what proves it is done
 *
 * AUTHORITY: every action here comes from `deal.permitted`, computed by
 * the server from the viewer's seat and the deal's state. This component
 * derives no permission, performs no transition and infers no fund
 * movement. Submitting anyway is safe — the server re-checks and rejects.
 *
 * A completed deal stops being a workspace and becomes a receipt.
 */

const STEPS = ['Joined', 'INR sent', 'Confirmed'] as const;

const STATE_META: Record<
  DealView['state'],
  { tone: Tone; label: string; step: number; headline: string }
> = {
  FIAT_PENDING: {
    tone: 'idle',
    label: 'Awaiting payment',
    step: 1,
    headline: 'The deal is live. The INR transfer is outstanding.',
  },
  FIAT_CLAIMED: {
    tone: 'hold',
    label: 'Awaiting confirmation',
    step: 2,
    headline: 'A payment has been marked. The receiver is checking their account.',
  },
  COMPLETED: {
    tone: 'final',
    label: 'Completed',
    step: 3,
    headline: 'Settled. Both sides are done.',
  },
  CANCELLED: {
    tone: 'idle',
    label: 'Cancelled',
    step: 3,
    headline: 'This deal ended without settlement.',
  },
};

export function DealRoom({ deal }: { deal: DealView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [utr, setUtr] = useState('');
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<{ reason: string; nextStep: string } | null>(null);

  const meta = STATE_META[deal.state];
  const isFiat = deal.viewerRole === 'FIAT_SIDE';
  const terminal = deal.state === 'COMPLETED' || deal.state === 'CANCELLED';
  const utrOk = /^[0-9A-Z]{12}$/.test(utr.trim().toUpperCase());

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
          nextStep: 'Refresh to see the current state of this deal.',
        },
      );
      router.refresh();
    });

  /* ---------------- Whose move, in one sentence ---------------- */
  const whoseMove = terminal
    ? null
    : deal.permitted.canClaim
      ? { who: 'you' as const, text: 'Send the INR, then mark it with the bank reference.' }
      : deal.permitted.canConfirm
        ? { who: 'you' as const, text: 'Check your account, then confirm the money arrived.' }
        : {
            who: 'them' as const,
            text: isFiat
              ? 'They are checking their account for your payment.'
              : 'They must send the INR and mark it paid.',
          };

  return (
    <div className="space-y-4">
      {/* ============ 1. WHAT + WHERE, in one block ============ */}
      <section
        className={`animate-rise overflow-hidden rounded-[var(--radius-lg)] border bg-[var(--color-paper)] ${
          terminal ? 'border-[var(--color-final-line)]' : 'border-[var(--color-rule)]'
        }`}
      >
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[var(--color-line)] px-5 py-3.5 sm:px-6">
          <div className="flex items-center gap-2.5">
            <h1 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
              {isFiat ? 'Buy USDT' : 'Sell USDT'}
            </h1>
            <Status tone={meta.tone}>{meta.label}</Status>
          </div>
          <span className="rounded-[var(--radius-full)] bg-[var(--color-sunken)] px-2.5 py-1 text-[length:var(--text-2xs)] font-medium text-[var(--color-ink-2)]">
            You are the {isFiat ? 'INR sender' : 'USDT supplier'}
          </span>
        </header>

        {/* Terminal: a calm receipt. Live: the working figures. */}
        {terminal && deal.state === 'COMPLETED' ? (
          <div className="px-5 py-6 text-center sm:px-6 sm:py-8">
            <div className="mx-auto w-fit text-[var(--color-final)]">
              <Seal />
            </div>
            <p className="mt-3 text-[length:var(--text-sm)] font-medium text-[var(--color-final)]">
              Settled {deal.completedAt ? formatWhen(deal.completedAt) : ''}
            </p>
            <div className="mt-4 flex items-center justify-center gap-3 sm:gap-4">
              {isFiat ? (
                <>
                  <span className="tnum text-[length:var(--text-xl)] font-semibold text-[var(--color-ink)]">
                    ₹{formatMinor(deal.inrMinor, 'INR')}
                  </span>
                  <span aria-hidden className="text-[var(--color-ink-4)]">
                    →
                  </span>
                  <Money value={formatMinor(deal.usdtMinor, 'USDT')} unit="USDT" size="md" />
                </>
              ) : (
                <>
                  <Money value={formatMinor(deal.usdtMinor, 'USDT')} unit="USDT" size="md" />
                  <span aria-hidden className="text-[var(--color-ink-4)]">
                    →
                  </span>
                  <span className="tnum text-[length:var(--text-xl)] font-semibold text-[var(--color-ink)]">
                    ₹{formatMinor(deal.inrMinor, 'INR')}
                  </span>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="px-5 py-5 sm:px-6">
            {/*
              The figures are stated FROM THE VIEWER'S SEAT, in the order
              they experience them: what leaves, then what arrives. The
              FIAT_SIDE sends INR and receives USDT; the CRYPTO_SIDE does
              the reverse. Labelling both sides identically would tell one
              of them the opposite of what they are actually doing.
            */}
            <Label>You send</Label>
            <div className="mt-1">
              {isFiat ? (
                <p className="tnum text-[length:var(--text-3xl)] font-semibold tracking-[-0.03em] text-[var(--color-ink)]">
                  <span aria-hidden>₹</span>
                  {formatMinor(deal.inrMinor, 'INR')}
                  <span className="sr-only">{formatMinor(deal.inrMinor, 'INR')} rupees</span>
                </p>
              ) : (
                <Money value={formatMinor(deal.usdtMinor, 'USDT')} unit="USDT" size="lg" />
              )}
            </div>

            <div className="my-4">
              <ExchangeRail
                caption={`${(Number(deal.rateNum) / Number(deal.rateDen)).toFixed(2)} INR / USDT · locked`}
              />
            </div>

            <Label>You receive</Label>
            <div className="mt-1">
              {isFiat ? (
                <Money value={formatMinor(deal.usdtMinor, 'USDT')} unit="USDT" size="lg" />
              ) : (
                <p className="tnum text-[length:var(--text-3xl)] font-semibold tracking-[-0.03em] text-[var(--color-ink)]">
                  <span aria-hidden>₹</span>
                  {formatMinor(deal.inrMinor, 'INR')}
                  <span className="sr-only">{formatMinor(deal.inrMinor, 'INR')} rupees</span>
                </p>
              )}
            </div>
          </div>
        )}

        {/* Progress: server state, never a timer. */}
        <div className="border-t border-[var(--color-line)] px-5 py-4 sm:px-6">
          <ol className="flex items-center gap-2" aria-label="Progress">
            {STEPS.map((s, i) => {
              const done = i < meta.step;
              const now = i === meta.step - 1 && !terminal;
              return (
                <li key={s} className="flex flex-1 items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div
                      className="rail-progress"
                      data-tone={deal.state === 'COMPLETED' ? 'final' : undefined}
                    >
                      <span style={{ width: done ? '100%' : '0%' }} />
                    </div>
                    <p
                      className={`mt-1.5 truncate text-[length:var(--text-2xs)] ${
                        done
                          ? 'font-medium text-[var(--color-ink)]'
                          : now
                            ? 'font-medium text-[var(--color-action)]'
                            : 'text-[var(--color-ink-4)]'
                      }`}
                    >
                      {s}
                      {done ? <span className="sr-only"> — done</span> : null}
                      {now ? <span className="sr-only"> — current step</span> : null}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="mt-3 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
            {meta.headline}
          </p>
        </div>
      </section>

      {/* ============ 2. WHOSE MOVE ============ */}
      {whoseMove ? (
        <section
          className={`rounded-[var(--radius-lg)] border px-5 py-4 sm:px-6 ${
            whoseMove.who === 'you'
              ? 'border-[var(--color-action-line)] bg-[var(--color-action-tint)]'
              : 'border-[var(--color-line)] bg-[var(--color-paper)]'
          }`}
        >
          <Label>{whoseMove.who === 'you' ? 'Your move' : 'Their move'}</Label>
          <p
            className={`mt-1 text-[length:var(--text-base)] leading-relaxed ${
              whoseMove.who === 'you'
                ? 'font-medium text-[var(--color-action-press)]'
                : 'text-[var(--color-ink-2)]'
            }`}
          >
            {whoseMove.text}
          </p>
          {deal.actionDeadline ? (
            <p className="mt-2 text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
              Operator review opens after {formatWhen(deal.actionDeadline)}. Nothing is released,
              refunded or completed by that deadline on its own.
            </p>
          ) : null}
        </section>
      ) : null}

      {failure ? (
        <Notice
          tone="risk"
          title={failure.reason}
          reassurance="The deal was not changed."
          nextStep={failure.nextStep}
        />
      ) : null}

      {/* ============ 3. THE ONE PERMITTED ACTION ============ */}
      {deal.permitted.canClaim ? (
        <section
          data-testid="claim-panel"
          className="rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--color-paper)] p-5 sm:p-6"
        >
          <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
            Mark the INR sent
          </h2>
          <p className="mt-1 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
            Enter the 12-character reference from your bank confirmation. It is checked against
            every other deal, so one transfer can only ever be claimed once.
          </p>
          <SandboxLine className="mt-3" full />

          <div className="mt-4 space-y-3">
            <div>
              <label
                htmlFor="utr"
                className="text-[length:var(--text-xs)] font-medium text-[var(--color-ink-2)]"
              >
                Bank reference (UTR)
              </label>
              <input
                id="utr"
                value={utr}
                onChange={(e) => setUtr(e.target.value.toUpperCase())}
                maxLength={12}
                placeholder="AXIS12345678"
                aria-label="UTR"
                aria-describedby="utr-help"
                aria-invalid={utr.length > 0 && !utrOk ? true : undefined}
                className="tap tnum mt-1.5 w-full rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-paper)] px-3 font-mono uppercase tracking-[0.08em] text-[var(--color-ink)] placeholder:tracking-normal placeholder:text-[var(--color-ink-4)]"
              />
              <p
                id="utr-help"
                className="mt-1 text-[length:var(--text-2xs)] text-[var(--color-ink-3)]"
              >
                {utr.length === 0
                  ? '12 letters and digits.'
                  : utrOk
                    ? 'Looks right.'
                    : `${12 - utr.trim().length} more character${12 - utr.trim().length === 1 ? '' : 's'} needed.`}
              </p>
            </div>
            <div>
              <label
                htmlFor="note"
                className="text-[length:var(--text-xs)] font-medium text-[var(--color-ink-2)]"
              >
                Note <span className="font-normal text-[var(--color-ink-4)]">(optional)</span>
              </label>
              <input
                id="note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                aria-label="Note"
                className="tap mt-1.5 w-full rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-paper)] px-3 text-[var(--color-ink)]"
              />
            </div>

            {/* Concise summary before the consequential action. */}
            <div className="rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2.5">
              <p className="text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-2)]">
                You are declaring that you sent{' '}
                <strong className="tnum font-semibold text-[var(--color-ink)]">
                  ₹{formatMinor(deal.inrMinor, 'INR')}
                </strong>{' '}
                to {deal.counterpartyName}. They then confirm it arrived.
              </p>
            </div>

            <button
              type="button"
              disabled={pending || !utrOk}
              data-testid="claim-submit"
              onClick={() => run(() => claimAction(deal.dealId, utr, note))}
              className={buttonClass('primary', 'lg', true)}
            >
              {pending ? 'Submitting…' : 'I have sent the INR'}
            </button>
          </div>
        </section>
      ) : null}

      {deal.permitted.canConfirm ? (
        <section
          data-testid="confirm-panel"
          className="rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--color-paper)] p-5 sm:p-6"
        >
          <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
            Confirm the INR arrived
          </h2>
          <p className="mt-1 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
            Confirm only once the exact amount is actually credited to your account. In a live deal
            this releases the USDT and cannot be undone.
          </p>
          <SandboxLine className="mt-3" full />

          <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2.5">
            <p className="text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-2)]">
              Check for{' '}
              <strong className="tnum font-semibold text-[var(--color-ink)]">
                ₹{formatMinor(deal.inrMinor, 'INR')}
              </strong>
              {deal.claim ? (
                <>
                  {' '}
                  against reference{' '}
                  <strong className="font-mono text-[var(--color-ink)]">{deal.claim.utr}</strong>
                </>
              ) : null}
              .
            </p>
          </div>

          <button
            type="button"
            disabled={pending}
            data-testid="confirm-submit"
            onClick={() => run(() => confirmAction(deal.dealId))}
            className={`${buttonClass('final', 'lg', true)} mt-3`}
          >
            {pending ? 'Confirming…' : `Confirm ₹${formatMinor(deal.inrMinor, 'INR')} received`}
          </button>
        </section>
      ) : null}

      {/* ============ 4. THE RECORD ============ */}
      <section className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-paper)]">
        <h2 className="border-b border-[var(--color-line)] px-5 py-3 text-[length:var(--text-sm)] font-semibold text-[var(--color-ink)] sm:px-6">
          {terminal ? 'Receipt' : 'The record'}
        </h2>
        <dl className="divide-y divide-[var(--color-line)]">
          <Row term="Reference" mono>
            {deal.publicId}
          </Row>
          <Row term="Counterparty">{deal.counterpartyName}</Row>
          <Row term="Rate">
            <span className="tnum">
              {(Number(deal.rateNum) / Number(deal.rateDen)).toFixed(2)} INR / USDT
            </span>
          </Row>
          <Row term="Started">{formatWhen(deal.createdAt)}</Row>
          {deal.claim ? (
            <Row term="INR marked sent">
              <span className="tnum font-mono text-[length:var(--text-xs)]">{deal.claim.utr}</span>
              <span className="text-[var(--color-ink-3)]">
                {' '}
                · {formatWhen(deal.claim.submittedAt)}
              </span>
              {deal.claim.note ? (
                <span className="block text-[var(--color-ink-3)]">“{deal.claim.note}”</span>
              ) : null}
            </Row>
          ) : null}
          {deal.completedAt ? (
            <Row term="Confirmed">
              <span className="font-medium text-[var(--color-final)]">
                {formatWhen(deal.completedAt)}
              </span>
            </Row>
          ) : null}
          <Row term="Funds">
            <span className="text-[var(--color-ink-3)]">
              {terminal
                ? 'Simulated release complete. No real USDT existed and none moved.'
                : 'A simulated hold is recorded. No real USDT is held — this is a sandbox.'}
            </span>
          </Row>
        </dl>
      </section>

      {terminal ? (
        <p className="px-1 text-center text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
          This deal is finished and can no longer change. Nothing further is required.
        </p>
      ) : null}
    </div>
  );
}

function Row({
  term,
  children,
  mono,
}: {
  term: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-baseline gap-3 px-5 py-2.5 sm:grid-cols-[9rem_1fr] sm:px-6">
      <dt className="text-[length:var(--text-xs)] text-[var(--color-ink-3)]">{term}</dt>
      <dd
        className={`text-[length:var(--text-sm)] text-[var(--color-ink)] ${
          mono ? 'font-mono text-[length:var(--text-xs)]' : ''
        }`}
      >
        {children}
      </dd>
    </div>
  );
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}
