'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { cancelDealAction, confirmAction } from '@/server/sandbox/actions';
import { FAILURE_COPY, type DealView } from '@/lib/sandboxContract';
import { formatMinor } from '@/lib/format';
import {
  DEAL_STATE,
  dealTitle,
  flowFor,
  rateLabel,
  roleLabel,
  settlementLegs,
  whoseMove,
  leg,
} from '@/lib/dealPresenter';
import { SCENARIO } from '@/lib/scenario';
import { cn } from '@/lib/cn';
import { Celebration, Seal } from '@/components/kit/Brand';
import { AssetMark, Icon } from '@/components/kit/Icon';
import { Sheet } from '@/components/kit/Sheet';
import { CopyButton, useToast } from '@/components/kit/Feedback';
import { Ago, Deadline } from '@/components/kit/Time';
import {
  ActionLink,
  Avatar,
  Callout,
  Card,
  Fact,
  Facts,
  Label,
  Notice,
  RailSteps,
  SandboxLine,
  Status,
  Stepper,
  TotalRow,
  VerifiedTick,
  buttonClass,
} from '@/components/kit/primitives';
import { ChatPanel } from './ChatPanel';
import { EvidencePanel } from './EvidencePanel';

/**
 * The deal room — the product's signature screen.
 *
 * Composed to answer, in order and without hunting:
 *   what am I exchanging · what is protected · what is my role ·
 *   where is this now · whose move · what do I do · by when ·
 *   what proves it is done
 *
 * AUTHORITY: every action here comes from `deal.permitted`, computed by the
 * server from the viewer's seat and the deal's state. This component derives
 * no permission, performs no transition and infers no fund movement.
 * Submitting anyway is safe — the server re-checks and rejects.
 *
 * LAYOUT: one component, two postures. On a phone the three panels are tabs,
 * because a 390px column cannot hold them side by side without making all
 * three useless. On a desktop they are three columns, because the whole
 * point of the room is seeing the deal, its progress and the conversation at
 * once. Both use the same panels — there is no second implementation to keep
 * in step.
 *
 * A completed deal stops being a workspace and becomes a receipt.
 */

type Tab = 'overview' | 'chat' | 'proof';

export function DealRoom({ deal }: { deal: DealView }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [tab, setTab] = useState<Tab>('overview');
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [failure, setFailure] = useState<{ reason: string; nextStep: string } | null>(null);

  const meta = DEAL_STATE[deal.state];
  const scenario = SCENARIO[deal.direction];
  const settle = settlementLegs(deal);
  const usdt = leg(deal.usdtMinor, 'USDT');
  const move = whoseMove(deal);
  const steps = flowFor(deal);
  const isFiat = deal.viewerRole === 'FIAT_SIDE';
  const terminal = deal.state === 'COMPLETED' || meta.halted;

  const run = (fn: () => Promise<{ ok: boolean; code?: string; message?: string }>) =>
    startTransition(async () => {
      setFailure(null);
      const result = await fn();
      if (result.ok) {
        setConfirming(false);
        setCancelling(false);
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

  /* ---- The completed receipt replaces the workspace entirely ---- */
  if (deal.state === 'COMPLETED') {
    return <Receipt deal={deal} />;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_minmax(0,22rem)] lg:items-start">
      {/* ================= COLUMN 1 · the deal ==================== */}
      <div className={cn('space-y-4', tab === 'overview' ? 'block' : 'hidden', 'lg:block')}>
        <Card flush className="animate-rise">
          <header className="flex items-start justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3.5 sm:px-5">
            <div className="min-w-0">
              <Label>{scenario.title}</Label>
              <h2 className="mt-0.5 truncate text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                {dealTitle(deal)}
              </h2>
            </div>
            <Status tone={meta.tone}>{meta.label}</Status>
          </header>

          <div className="px-4 py-5 text-center sm:px-5">
            <p className="tnum text-[length:var(--text-3xl)] font-semibold tracking-[-0.03em] text-[var(--color-ink)]">
              {settle.amount.display}
              <span className="sr-only"> {settle.amount.srLabel}</span>
            </p>

            {deal.direction !== 'INR_TO_INR' ? (
              <div className="mt-3 flex items-center justify-center gap-2.5">
                <span className="flex items-center gap-1.5">
                  <AssetMark asset={scenario.from} size="sm" />
                  <span className="tnum text-[length:var(--text-sm)] font-medium text-[var(--color-ink-2)]">
                    {scenario.from === 'INR' ? settle.amount.display : usdt.display}
                  </span>
                </span>
                <Icon name="arrow-right" className="h-3.5 w-3.5 text-[var(--color-ink-4)]" />
                <span className="flex items-center gap-1.5">
                  <AssetMark asset={scenario.to} size="sm" />
                  <span className="tnum text-[length:var(--text-sm)] font-medium text-[var(--color-ink-2)]">
                    {scenario.to === 'INR' ? settle.amount.display : usdt.display}
                  </span>
                </span>
              </div>
            ) : null}

            {/* Who is doing what, in one row. */}
            <div className="mt-5 flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-sunken)] p-2.5">
              <Party
                name="You"
                role={roleLabel(deal.direction, deal.viewerRole)}
                verified
                align="left"
              />
              <Icon
                name="arrow-right"
                className="h-4 w-4 shrink-0 text-[var(--color-ink-4)]"
                strokeWidth={2}
              />
              <Party
                name={deal.counterpartyName}
                role={roleLabel(
                  deal.direction,
                  deal.viewerRole === 'FIAT_SIDE' ? 'CRYPTO_SIDE' : 'FIAT_SIDE',
                )}
                verified={deal.counterpartyVerified}
                align="right"
              />
            </div>
          </div>

          <div className="border-t border-[var(--color-line)] px-4 py-4 sm:px-5">
            <Stepper steps={steps} />
          </div>
        </Card>

        {/* ---- The record ------------------------------------------ */}
        <Card>
          <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
            Deal details
          </h2>
          <Facts className="mt-1">
            <Fact term="Deal code">
              <span className="inline-flex items-center gap-1">
                <span className="font-mono font-semibold tracking-[0.06em]">{deal.dealCode}</span>
                <CopyButton value={deal.dealCode} announce="Deal code copied" />
              </span>
            </Fact>
            <Fact term="Your role" strong>
              {roleLabel(deal.direction, deal.viewerRole)}
            </Fact>
            <Fact term={isFiat ? 'You send' : 'You receive'} strong>
              <span className="tnum">
                {isFiat ? settle.payerSends.display : settle.payeeReceives.display}
              </span>
            </Fact>
            {scenario.hasRate ? (
              <Fact term="Locked rate">
                <span className="tnum">{rateLabel(deal)}</span>
              </Fact>
            ) : null}
            <Fact term="Protection fee">
              <span className="tnum">₹{formatMinor(deal.protectionFeeMinor, 'INR')}</span>
            </Fact>
            {BigInt(deal.networkFeeMinor) > 0n ? (
              <Fact term="Network fee">
                <span className="tnum">₹{formatMinor(deal.networkFeeMinor, 'INR')}</span>
              </Fact>
            ) : null}
            <Fact term="Started">
              <Ago iso={deal.createdAt} />
            </Fact>
            {deal.claim ? (
              <Fact term="Reference" mono>
                {deal.claim.utr}
              </Fact>
            ) : null}
          </Facts>
        </Card>
      </div>

      {/* ================= COLUMN 2 · what happens now ============= */}
      <div className={cn('space-y-4', tab === 'overview' ? 'block' : 'hidden', 'lg:block')}>
        {failure ? (
          <Notice
            tone="risk"
            title={failure.reason}
            reassurance="The deal was not changed."
            nextStep={failure.nextStep}
          />
        ) : null}

        {/* ---- Whose move ------------------------------------------ */}
        <Card
          tone={move.who === 'you' ? 'brand' : 'paper'}
          className={move.who === 'operator' ? 'border-[var(--color-risk-line)]' : undefined}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Label>
                {move.who === 'you'
                  ? 'Your move'
                  : move.who === 'operator'
                    ? 'Under review'
                    : move.who === 'them'
                      ? 'Their move'
                      : 'Closed'}
              </Label>
              <h2
                className={cn(
                  'mt-1 text-[length:var(--text-lg)] font-semibold tracking-[-0.02em]',
                  move.who === 'you'
                    ? 'text-[var(--color-brand-ink)]'
                    : 'text-[var(--color-ink)]',
                )}
              >
                {move.title}
              </h2>
            </div>
            {deal.actionDeadline && !terminal ? (
              <div className="shrink-0 text-right">
                <Label>Deadline</Label>
                <p className="mt-1 text-[length:var(--text-sm)] font-semibold text-[var(--color-ink)]">
                  <Deadline iso={deal.actionDeadline} />
                </p>
              </div>
            ) : null}
          </div>

          <p className="mt-2 text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink-2)]">
            {move.detail}
          </p>

          {/* The one permitted action. */}
          {deal.permitted.canClaim ? (
            <ActionLink
              href={`/app/deal/${deal.dealId}/pay`}
              variant="primary"
              size="lg"
              full
              className="mt-4"
              icon="arrow-right"
            >
              Pay {settle.payerSends.display}
            </ActionLink>
          ) : null}

          {deal.permitted.canConfirm ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              data-testid="confirm-open"
              className={cn(buttonClass('final', 'lg', true), 'mt-4')}
            >
              <Icon name="check-circle" className="h-4 w-4" />
              Confirm {settle.amount.display} received
            </button>
          ) : null}

          {!deal.permitted.canClaim && !deal.permitted.canConfirm && !terminal ? (
            <button
              type="button"
              disabled
              className={cn(buttonClass('outline', 'lg', true), 'mt-4')}
            >
              <Icon name="clock" className="h-4 w-4" />
              {isFiat ? 'Waiting for confirmation' : 'Waiting for payment'}
            </button>
          ) : null}

          {deal.actionDeadline && !terminal ? (
            <p className="mt-2.5 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
              Nothing is released, refunded or completed by that deadline on its own. If it passes,
              an operator can look at the deal.
            </p>
          ) : null}
        </Card>

        {/* ---- A live dispute ------------------------------------- */}
        {deal.dispute ? (
          <Card className="border-[var(--color-risk-line)]">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--color-risk-tint)] text-[var(--color-risk)]">
                <Icon name="flag" className="h-[18px] w-[18px]" />
              </span>
              <div className="min-w-0">
                <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                  Problem reported
                </h2>
                <p className="mt-0.5 text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
                  by <span className="capitalize">{deal.dispute.raisedByViewer ? 'you' : deal.dispute.raisedByName}</span>{' '}
                  · <Ago iso={deal.dispute.raisedAt} />
                </p>
              </div>
            </div>
            {deal.dispute.detail ? (
              <p className="mt-3 rounded-[var(--radius-md)] bg-[var(--color-sunken)] p-3 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
                {deal.dispute.detail}
              </p>
            ) : null}
            <Callout tone="risk" icon="lock" className="mt-3">
              Release is paused. Only an operator ruling moves this deal onward — no timer resolves
              it, and neither side can complete or cancel it while the case is open.
            </Callout>
          </Card>
        ) : null}

        {/* ---- The vertical rail, desktop only --------------------- */}
        <Card className="hidden lg:block">
          <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
            Deal rail
          </h2>
          <div className="mt-3">
            <RailSteps steps={steps} />
          </div>
        </Card>

        {/* ---- Escape hatches ------------------------------------- */}
        {!terminal ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            {deal.permitted.canDispute ? (
              <ActionLink
                href={`/app/deal/${deal.dealId}/dispute`}
                variant="danger"
                size="md"
                full
                icon="flag"
              >
                Report a problem
              </ActionLink>
            ) : null}
            {deal.permitted.canCancel ? (
              <button
                type="button"
                onClick={() => setCancelling(true)}
                className={buttonClass('outline', 'md', true)}
              >
                <Icon name="close" className="h-4 w-4" />
                Cancel deal
              </button>
            ) : null}
          </div>
        ) : null}

        <SandboxLine full />
      </div>

      {/* ================= COLUMN 3 · chat and proof =============== */}
      <div className="space-y-4">
        <Card
          flush
          className={cn(
            'flex flex-col overflow-hidden lg:h-[32rem]',
            tab === 'chat' ? 'flex' : 'hidden',
            'lg:flex',
          )}
        >
          <h2 className="border-b border-[var(--color-line)] px-4 py-3 text-[length:var(--text-base)] font-semibold text-[var(--color-ink)] sm:px-5">
            Protected deal chat
          </h2>
          <ChatPanel
            dealId={deal.dealId}
            messages={deal.messages}
            canMessage={deal.permitted.canMessage}
            counterpartyName={deal.counterpartyName}
            className="min-h-0 flex-1"
          />
        </Card>

        <div className={cn(tab === 'proof' ? 'block' : 'hidden', 'lg:block')}>
          <Card>
            <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
              Evidence
            </h2>
            <p className="mt-1 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
              Files here are visible to both sides and to an operator reviewing a reported problem.
            </p>
            <div className="mt-3">
              <EvidencePanel
                dealId={deal.dealId}
                evidence={deal.evidence}
                canUpload={deal.permitted.canUpload}
              />
            </div>
          </Card>
        </div>
      </div>

      {/* ================= Mobile tab bar ========================== */}
      <TabStrip
        tab={tab}
        setTab={setTab}
        chatCount={deal.messages.filter((m) => m.kind === 'CHAT').length}
        proofCount={deal.evidence.length}
      />

      {/* ================= Confirmation ============================ */}
      <Sheet
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Confirm the money arrived"
        description="Confirm only once the exact amount is actually credited to your account."
        footer={
          <div className="space-y-2">
            <button
              type="button"
              disabled={pending}
              data-testid="confirm-submit"
              onClick={() => run(() => confirmAction(deal.dealId))}
              className={buttonClass('final', 'lg', true)}
            >
              {pending ? (
                <>
                  <Icon name="refresh" className="h-4 w-4 animate-spin" />
                  Releasing…
                </>
              ) : (
                <>
                  <Icon name="check" className="h-4 w-4" strokeWidth={2.4} />
                  Confirm and release
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className={buttonClass('quiet', 'md', true)}
            >
              Not yet
            </button>
          </div>
        }
      >
        <div className="rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-sunken)] p-3.5">
          <Label>Check your account for</Label>
          <p className="tnum mt-1 text-[length:var(--text-2xl)] font-semibold text-[var(--color-ink)]">
            {settle.amount.display}
          </p>
          {deal.claim ? (
            <p className="mt-2 text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
              Against reference{' '}
              <strong className="font-mono text-[var(--color-ink)]">{deal.claim.utr}</strong>
              {deal.claim.note ? <> · “{deal.claim.note}”</> : null}
            </p>
          ) : null}
        </div>

        {deal.evidence.length > 0 ? (
          <div className="mt-3">
            <Label>Proof they attached</Label>
            <div className="mt-2">
              <EvidencePanel
                dealId={deal.dealId}
                evidence={deal.evidence}
                canUpload={false}
                compact
              />
            </div>
          </div>
        ) : null}

        <Callout tone="hold" icon="alert" className="mt-3">
          <strong className="font-semibold">This action is final.</strong> In a live deal it
          releases the protected value and cannot be undone. If the money has not arrived, report a
          problem instead.
        </Callout>
        <SandboxLine className="mt-2.5" full />
      </Sheet>

      {/* ================= Cancellation ============================ */}
      <Sheet
        open={cancelling}
        onClose={() => setCancelling(false)}
        title="Cancel this deal?"
        description="Only possible because nobody has paid yet."
        footer={
          <div className="space-y-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => cancelDealAction(deal.dealId))}
              className={buttonClass('danger', 'lg', true)}
            >
              {pending ? 'Cancelling…' : 'Cancel the deal'}
            </button>
            <button
              type="button"
              onClick={() => setCancelling(false)}
              className={buttonClass('quiet', 'md', true)}
            >
              Keep it open
            </button>
          </div>
        }
      >
        <p className="text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink-2)]">
          <span className="capitalize">{deal.counterpartyName}</span> is told immediately, and the
          deal closes for good. Nothing was transferred, so nothing is returned.
        </p>
        <Callout tone="info" icon="info" className="mt-3">
          Once a payment has been marked sent, cancelling is no longer possible — that would strand
          a real transfer. Report a problem instead, and an operator decides.
        </Callout>
      </Sheet>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

function Party({
  name,
  role,
  verified,
  align,
}: {
  name: string;
  role: string;
  verified: boolean;
  align: 'left' | 'right';
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2',
        align === 'right' && 'flex-row-reverse text-right',
      )}
    >
      <Avatar name={name} size="sm" verified={verified} />
      <div className="min-w-0">
        <p className="truncate text-[length:var(--text-sm)] font-semibold capitalize text-[var(--color-ink)]">
          {name}
        </p>
        <p className="truncate text-[length:var(--text-2xs)] text-[var(--color-ink-3)]">{role}</p>
      </div>
    </div>
  );
}

function TabStrip({
  tab,
  setTab,
  chatCount,
  proofCount,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  chatCount: number;
  proofCount: number;
}) {
  const items: readonly { key: Tab; label: string; count?: number }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'chat', label: 'Chat', count: chatCount },
    { key: 'proof', label: 'Proof', count: proofCount },
  ];
  return (
    <div
      role="tablist"
      aria-label="Deal sections"
      className="pb-safe fixed inset-x-0 bottom-[var(--h-tabbar)] z-30 flex gap-1 border-t border-[var(--color-line)] bg-[var(--color-paper)]/96 px-3 py-2 backdrop-blur-[10px] lg:hidden"
    >
      {items.map((item) => (
        <button
          key={item.key}
          role="tab"
          type="button"
          aria-selected={tab === item.key}
          onClick={() => setTab(item.key)}
          className={cn(
            'press flex flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-md)] py-2.5 text-[length:var(--text-sm)] font-semibold transition-colors',
            tab === item.key
              ? 'bg-[var(--color-ink)] text-[var(--color-paper)]'
              : 'text-[var(--color-ink-3)] hover:bg-[var(--color-sunken)]',
          )}
        >
          {item.label}
          {item.count ? (
            <span
              className={cn(
                'tnum rounded-full px-1.5 text-[length:var(--text-2xs)]',
                tab === item.key
                  ? 'bg-[var(--color-paper)]/20'
                  : 'bg-[var(--color-sunken)] text-[var(--color-ink-4)]',
              )}
            >
              {item.count}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The receipt
 * ------------------------------------------------------------------ */

/**
 * A completed deal.
 *
 * The workspace is gone: there is nothing left to do, so showing controls
 * that do nothing would be noise. What remains is a receipt — the figures,
 * the references, and the two things a person actually wants afterwards,
 * which are a copy of it and a way back to the rest of their deals.
 */
function Receipt({ deal }: { deal: DealView }) {
  const settle = settlementLegs(deal);
  const usdt = leg(deal.usdtMinor, 'USDT');
  const scenario = SCENARIO[deal.direction];
  const isFiat = deal.viewerRole === 'FIAT_SIDE';

  return (
    <div className="mx-auto max-w-[34rem] space-y-4">
      <Card className="relative overflow-hidden text-center">
        <div className="relative mx-auto w-fit">
          <Celebration />
          <span className="relative block text-[var(--color-final)]">
            <Seal size={72} />
          </span>
        </div>

        <h2 className="mt-4 text-[length:var(--text-xl)] font-semibold tracking-[-0.025em] text-[var(--color-ink)]">
          Deal completed
        </h2>
        <p className="mt-1 text-[length:var(--text-base)] text-[var(--color-ink-3)]">
          Released to <span className="capitalize">{isFiat ? deal.counterpartyName : 'you'}</span>
        </p>

        <p className="tnum mt-4 text-[length:var(--text-4xl)] font-semibold tracking-[-0.03em] text-[var(--color-ink)]">
          {settle.amount.display}
          <span className="sr-only"> {settle.amount.srLabel}</span>
        </p>

        {deal.direction !== 'INR_TO_INR' ? (
          <p className="tnum mt-1 text-[length:var(--text-base)] text-[var(--color-ink-3)]">
            {scenario.from === 'INR' ? settle.amount.display : usdt.display} →{' '}
            {scenario.to === 'INR' ? settle.amount.display : usdt.display}
          </p>
        ) : null}

        <div className="mt-5">
          <Stepper steps={flowFor(deal)} />
        </div>
      </Card>

      <Card>
        <h3 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
          Receipt
        </h3>
        <Facts className="mt-1">
          <Fact term="Deal code">
            <span className="inline-flex items-center gap-1">
              <span className="font-mono font-semibold tracking-[0.06em]">{deal.dealCode}</span>
              <CopyButton value={deal.dealCode} announce="Deal code copied" />
            </span>
          </Fact>
          <Fact term="Completed">
            {deal.completedAt ? <Ago iso={deal.completedAt} /> : '—'}
          </Fact>
          <Fact term="Counterparty">
            <span className="inline-flex items-center gap-1.5 capitalize">
              {deal.counterpartyName}
              {deal.counterpartyVerified ? <VerifiedTick /> : null}
            </span>
          </Fact>
          <Fact term="Amount">
            <span className="tnum">{settle.amount.display}</span>
          </Fact>
          {scenario.hasRate ? (
            <Fact term="Locked rate">
              <span className="tnum">{rateLabel(deal)}</span>
            </Fact>
          ) : null}
          <Fact term="Protection fee">
            <span className="tnum">₹{formatMinor(deal.protectionFeeMinor, 'INR')}</span>
          </Fact>
          {BigInt(deal.networkFeeMinor) > 0n ? (
            <Fact term="Network fee">
              <span className="tnum">₹{formatMinor(deal.networkFeeMinor, 'INR')}</span>
            </Fact>
          ) : null}
          {deal.claim ? (
            <Fact term="Bank reference" mono>
              {deal.claim.utr}
            </Fact>
          ) : null}
          <Fact term="Status" strong>
            <span className="text-[var(--color-final)]">Completed</span>
          </Fact>
        </Facts>
        <div className="mt-3">
          <TotalRow term={isFiat ? 'You sent' : 'You received'}>
            {isFiat ? settle.payerSends.display : settle.payeeReceives.display}
          </TotalRow>
        </div>
      </Card>

      {/* SafePoints: stated as what they are, never as money. */}
      <Card tone="brand" className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--color-paper)] text-[var(--color-brand)]">
          <Icon name="sparkle" className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
            +250 SafePoints
          </p>
          <p className="mt-0.5 text-[length:var(--text-xs)] text-[var(--color-ink-2)]">
            Unlocks a fee discount on this platform. Not money, and never withdrawable.
          </p>
        </div>
        <Link
          href="/app/rewards"
          prefetch={false}
          aria-label="Open rewards"
          className="shrink-0 text-[var(--color-brand-ink)]"
        >
          <Icon name="chevron-right" className="h-4 w-4" />
        </Link>
      </Card>

      {deal.evidence.length > 0 ? (
        <Card>
          <h3 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
            Attached evidence
          </h3>
          <div className="mt-3">
            <EvidencePanel dealId={deal.dealId} evidence={deal.evidence} canUpload={false} compact />
          </div>
        </Card>
      ) : null}

      <Card flush className="overflow-hidden">
        <h3 className="border-b border-[var(--color-line)] px-4 py-3 text-[length:var(--text-base)] font-semibold text-[var(--color-ink)] sm:px-5">
          The conversation
        </h3>
        <ChatPanel
          dealId={deal.dealId}
          messages={deal.messages}
          canMessage={false}
          counterpartyName={deal.counterpartyName}
        />
      </Card>

      <div className="no-print flex flex-col gap-2 sm:flex-row">
        <ActionLink href="/app/deals" variant="outline" size="md" full>
          All deals
        </ActionLink>
        <ActionLink href="/app/new" variant="primary" size="md" full icon="plus">
          New protected deal
        </ActionLink>
      </div>

      <p className="no-print text-center text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
        This deal is finished and can no longer change. Nothing further is required.
      </p>
      <SandboxLine full />
    </div>
  );
}
