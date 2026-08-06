'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createDealAction } from '@/server/sandbox/actions';
import { FAILURE_COPY, type SandboxError } from '@/lib/sandboxContract';
import { formatMinor } from '@/lib/format';
import { amountProblem, parseInrToMinor, parseUsdtToMicro } from '@/lib/parse';
import { inrFromUsdt, settlementFor, usdtFromInr, type FeeBearer } from '@/lib/fees';
import { PAYMENT_WINDOW_MINUTES, REFERENCE_RATE, rateDisplay } from '@/lib/rate';
import { SCENARIO, type Scenario } from '@/lib/scenario';
import { cn } from '@/lib/cn';
import { AssetMark, Icon } from '@/components/kit/Icon';
import {
  Callout,
  Card,
  Fact,
  Facts,
  Label,
  Notice,
  SandboxLine,
  TotalRow,
  buttonClass,
} from '@/components/kit/primitives';

/**
 * Create a protected deal.
 *
 * Two in-page steps — SET TERMS, then REVIEW AND SECURE — followed by the
 * share screen and the deal room, which is the four-step model the product
 * shows in its own header.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  EVERY FIGURE ON THIS SCREEN IS INDICATIVE.                      │
 * │                                                                  │
 * │  The preview is computed with the same exact-integer functions   │
 * │  the server uses, from the same shared constants, so it will     │
 * │  normally agree to the paisa. But it carries no expiry and no    │
 * │  authority: the binding amounts are the ones the server freezes  │
 * │  into the quote when "Secure" is pressed. The copy says so       │
 * │  rather than implying a client-side number is a commitment.      │
 * └──────────────────────────────────────────────────────────────────┘
 */

type Step = 'terms' | 'review';
type Intent = 'PAY' | 'RECEIVE';

interface Draft {
  scenario: Scenario;
  intent: Intent;
  /** What the person typed, verbatim. Parsed, never mutated in place. */
  amount: string;
  /** Which leg the amount refers to. Exchanges may be quoted either way. */
  amountAsset: 'INR' | 'USDT';
  title: string;
  feeBearer: FeeBearer;
}

export function CreateDealWizard({
  initialScenario = 'INR_TO_INR',
  initialIntent = 'PAY',
  initialAmount = '',
}: {
  initialScenario?: Scenario;
  initialIntent?: Intent;
  initialAmount?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [step, setStep] = useState<Step>('terms');
  const [failure, setFailure] = useState<{ reason: string; nextStep: string } | null>(null);
  const [draft, setDraft] = useState<Draft>({
    scenario: initialScenario,
    intent: initialIntent,
    amount: initialAmount,
    amountAsset: initialScenario === 'USDT_TO_INR' ? 'USDT' : 'INR',
    title: '',
    feeBearer: 'PAYER',
  });

  const patch = (next: Partial<Draft>) => setDraft((d) => ({ ...d, ...next }));

  const quote = useQuotePreview(draft);
  const meta = SCENARIO[draft.scenario];
  const problem = amountProblem(draft.amount, draft.amountAsset);
  const ready = quote !== null && problem === null;

  const submit = () =>
    startTransition(async () => {
      setFailure(null);
      const result = await createDealAction({
        scenario: draft.scenario,
        intent: draft.scenario === 'INR_TO_INR' ? draft.intent : 'PAY',
        feeBearer: draft.feeBearer,
        title: draft.title.trim() || undefined,
        ...(draft.amountAsset === 'USDT'
          ? { usdtAmount: draft.amount }
          : { inrAmount: draft.amount }),
      });

      if (result.ok && result.publicId) {
        router.push(`/d/${result.publicId}`);
        return;
      }
      const copy =
        result.code && result.code !== 'UNKNOWN' ? FAILURE_COPY[result.code as SandboxError] : null;
      setFailure(
        copy ?? {
          reason: result.message ?? 'That did not work.',
          nextStep: 'Check the amount and try again. Nothing was created.',
        },
      );
    });

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start lg:gap-8">
      <div className="min-w-0 space-y-4">
        <StepRail step={step} />

        {failure ? (
          <Notice
            tone="risk"
            title={failure.reason}
            reassurance="No deal was created and no rate was locked."
            nextStep={failure.nextStep}
          />
        ) : null}

        {step === 'terms' ? (
          <TermsStep draft={draft} patch={patch} problem={problem} quote={quote} />
        ) : (
          <ReviewStep draft={draft} quote={quote} onBack={() => setStep('terms')} />
        )}
      </div>

      {/* The summary rail. On desktop it sits beside the form and updates as
          the person types; on mobile it becomes the footer of the review
          step, where a summary is what the screen is FOR. */}
      <aside className="hidden lg:block lg:sticky lg:top-24">
        <SummaryRail draft={draft} quote={quote} />
      </aside>

      {/* The action. Fixed above the tab bar on mobile so it is always in
          thumb reach; inline on desktop where the page is not scrolled. */}
      <div className="pb-safe fixed inset-x-0 bottom-[var(--h-tabbar)] z-30 border-t border-[var(--color-line)] bg-[var(--color-canvas)]/95 px-4 py-3 backdrop-blur-[10px] lg:static lg:col-start-1 lg:row-start-2 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
        {step === 'terms' ? (
          <button
            type="button"
            disabled={!ready}
            onClick={() => setStep('review')}
            className={buttonClass('primary', 'lg', true)}
          >
            Review deal
            <Icon name="arrow-right" className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            disabled={!ready || pending}
            onClick={submit}
            data-testid="secure-submit"
            className={buttonClass('primary', 'lg', true)}
          >
            {pending ? (
              <>
                <Icon name="refresh" className="h-4 w-4 animate-spin" />
                Asking the server for a firm quote…
              </>
            ) : (
              <>
                <Icon name="shield" className="h-4 w-4" />
                Protect {quote ? quote.payerSends : ''}
              </>
            )}
          </button>
        )}
        <p className="mt-2 text-center text-[length:var(--text-2xs)] leading-relaxed text-[var(--color-ink-3)]">
          {step === 'terms'
            ? `${meta.title} · you can still change everything on the next screen`
            : 'The server issues the firm figures and their expiry when you press this.'}
        </p>
      </div>

      {/* Reserve the exact height of the fixed action bar. */}
      <div aria-hidden className="h-24 lg:hidden" />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The preview calculation
 * ------------------------------------------------------------------ */

interface QuotePreview {
  readonly inrMinor: bigint;
  readonly usdtMicro: bigint | null;
  readonly payerSends: string;
  readonly payeeReceives: string;
  readonly protectionMinor: bigint;
  readonly networkMinor: bigint;
  readonly protectionLabel: string;
  readonly protectionBasis: string;
  readonly totalFeeMinor: bigint;
}

/**
 * The indicative figures, derived with the SAME functions the server uses.
 *
 * Sharing the implementation is what stops the preview and the issued quote
 * disagreeing about arithmetic. What they may legitimately differ on is the
 * RATE, because the server reads it at issuance — and the UI says so rather
 * than presenting this figure as a commitment.
 */
function useQuotePreview(draft: Draft): QuotePreview | null {
  return useMemo(() => {
    const { scenario, amount, amountAsset, feeBearer } = draft;

    let inrMinor: bigint | null;
    let usdtMicro: bigint | null = null;

    if (amountAsset === 'USDT') {
      usdtMicro = parseUsdtToMicro(amount);
      inrMinor =
        usdtMicro === null ? null : inrFromUsdt(usdtMicro, REFERENCE_RATE.num, REFERENCE_RATE.den);
    } else {
      inrMinor = parseInrToMinor(amount);
      if (inrMinor !== null && scenario !== 'INR_TO_INR') {
        usdtMicro = usdtFromInr(inrMinor, REFERENCE_RATE.num, REFERENCE_RATE.den);
      }
    }

    if (inrMinor === null || inrMinor <= 0n) return null;

    const settlement = settlementFor(scenario, inrMinor, feeBearer);
    return {
      inrMinor,
      usdtMicro,
      payerSends: `₹${formatMinor(settlement.payerSendsMinor.toString(), 'INR')}`,
      payeeReceives: `₹${formatMinor(settlement.payeeReceivesMinor.toString(), 'INR')}`,
      protectionMinor: settlement.fees.protectionMinor,
      networkMinor: settlement.fees.networkMinor,
      protectionLabel: settlement.fees.protectionLabel,
      protectionBasis: settlement.fees.protectionBasis,
      totalFeeMinor: settlement.fees.totalMinor,
    };
  }, [draft]);
}

/* ------------------------------------------------------------------ *
 * Step rail
 * ------------------------------------------------------------------ */

const STEP_LABELS = ['Set terms', 'Secure', 'Share', 'Complete'] as const;

function StepRail({ step }: { step: Step }) {
  const index = step === 'terms' ? 0 : 1;
  return (
    <ol className="no-bar flex items-center gap-2 overflow-x-auto" aria-label="Progress">
      {STEP_LABELS.map((label, i) => {
        const state = i < index ? 'done' : i === index ? 'now' : 'todo';
        return (
          <li key={label} className="flex shrink-0 items-center gap-2">
            <span
              className={cn(
                'grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold',
                state === 'done' && 'bg-[var(--color-final)] text-white',
                state === 'now' && 'bg-[var(--color-brand)] text-white',
                state === 'todo' && 'bg-[var(--color-sunken)] text-[var(--color-ink-4)]',
              )}
            >
              {state === 'done' ? (
                <Icon name="check" className="h-2.5 w-2.5" strokeWidth={3.5} />
              ) : (
                i + 1
              )}
            </span>
            <span
              className={cn(
                'text-[length:var(--text-xs)] font-medium',
                state === 'now'
                  ? 'text-[var(--color-ink)]'
                  : state === 'done'
                    ? 'text-[var(--color-ink-2)]'
                    : 'text-[var(--color-ink-4)]',
              )}
            >
              {label}
            </span>
            {i < STEP_LABELS.length - 1 ? (
              <span aria-hidden className="h-px w-4 bg-[var(--color-line)] sm:w-8" />
            ) : null}
            <span className="sr-only">{state === 'now' ? ' — current step' : ''}</span>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ *
 * Step 1 — terms
 * ------------------------------------------------------------------ */

const USE_CASES: readonly { label: string; icon: 'briefcase' | 'settings' | 'package' }[] = [
  { label: 'Freelance work', icon: 'briefcase' },
  { label: 'Services', icon: 'settings' },
  { label: 'Goods', icon: 'package' },
];

function TermsStep({
  draft,
  patch,
  problem,
  quote,
}: {
  draft: Draft;
  patch: (next: Partial<Draft>) => void;
  problem: string | null;
  quote: QuotePreview | null;
}) {
  const isExchange = draft.scenario !== 'INR_TO_INR';

  return (
    <>
      {/* ---- Which deal is this? --------------------------------- */}
      <Card>
        <h2 className="text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
          What are you doing?
        </h2>
        <p className="mt-1 text-[length:var(--text-sm)] text-[var(--color-ink-3)]">
          Choose the deal type that fits. It decides who does what.
        </p>

        <div role="radiogroup" aria-label="Deal type" className="mt-4 space-y-2.5">
          <ScenarioOption
            selected={draft.scenario === 'INR_TO_INR' && draft.intent === 'PAY'}
            onSelect={() => patch({ scenario: 'INR_TO_INR', intent: 'PAY', amountAsset: 'INR' })}
            from="INR"
            to="INR"
            title="Pay safely"
            body="You pay. The money is protected until you confirm the work."
          />
          <ScenarioOption
            selected={draft.scenario === 'INR_TO_INR' && draft.intent === 'RECEIVE'}
            onSelect={() =>
              patch({ scenario: 'INR_TO_INR', intent: 'RECEIVE', amountAsset: 'INR' })
            }
            from="INR"
            to="INR"
            title="Get paid"
            body="They pay you. The money is protected before you start."
          />
          <ScenarioOption
            selected={draft.scenario === 'INR_TO_USDT'}
            onSelect={() => patch({ scenario: 'INR_TO_USDT', amountAsset: 'INR' })}
            from="INR"
            to="USDT"
            title="Buy USDT"
            body="You send rupees. Your counterparty supplies the USDT."
          />
          <ScenarioOption
            selected={draft.scenario === 'USDT_TO_INR'}
            onSelect={() => patch({ scenario: 'USDT_TO_INR', amountAsset: 'USDT' })}
            from="USDT"
            to="INR"
            title="Sell USDT"
            body="You supply the USDT. Your counterparty sends the rupees."
          />
        </div>
      </Card>

      {/* ---- How much? -------------------------------------------- */}
      <Card>
        <h2 className="text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
          {isExchange ? 'How much are you exchanging?' : 'How much is the deal?'}
        </h2>

        <div className="mt-4">
          <label htmlFor="amount" className="flex items-center justify-between">
            <Label>{draft.amountAsset === 'USDT' ? 'You send' : 'Deal amount'}</Label>
            {isExchange ? (
              <button
                type="button"
                onClick={() =>
                  patch({
                    amountAsset: draft.amountAsset === 'INR' ? 'USDT' : 'INR',
                    amount: '',
                  })
                }
                className="inline-flex items-center gap-1 text-[length:var(--text-xs)] font-semibold text-[var(--color-brand)]"
              >
                <Icon name="swap" className="h-3.5 w-3.5" />
                Enter in {draft.amountAsset === 'INR' ? 'USDT' : 'INR'}
              </button>
            ) : null}
          </label>

          <div className="mt-2 flex items-center gap-2 border-b border-[var(--color-line)] pb-3">
            {draft.amountAsset === 'INR' ? (
              <span
                aria-hidden
                className="text-[length:var(--text-3xl)] font-semibold text-[var(--color-ink-4)]"
              >
                ₹
              </span>
            ) : null}
            <input
              id="amount"
              value={draft.amount}
              onChange={(e) => patch({ amount: e.target.value })}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? 'amount-problem' : 'amount-preview'}
              className="amount-input text-[length:var(--text-3xl)] sm:text-[length:var(--text-4xl)]"
            />
            <span className="shrink-0 text-[length:var(--text-lg)] font-medium text-[var(--color-ink-3)]">
              {draft.amountAsset === 'USDT' ? 'USDT' : 'INR'}
            </span>
            <AssetMark asset={draft.amountAsset} size="md" />
          </div>

          {problem ? (
            <p
              id="amount-problem"
              role="alert"
              className="mt-2 flex items-center gap-1.5 text-[length:var(--text-xs)] font-medium text-[var(--color-risk)]"
            >
              <Icon name="alert" className="h-3.5 w-3.5" />
              {problem}
            </p>
          ) : (
            <p
              id="amount-preview"
              aria-live="polite"
              className="mt-2 text-[length:var(--text-xs)] text-[var(--color-ink-3)]"
            >
              {quote
                ? isExchange && quote.usdtMicro !== null
                  ? `≈ ${
                      draft.amountAsset === 'INR'
                        ? `${formatMinor(quote.usdtMicro.toString(), 'USDT')} USDT`
                        : `₹${formatMinor(quote.inrMinor.toString(), 'INR')}`
                    } at ${rateDisplay()} INR / USDT · indicative`
                  : 'Protected from the moment the link is created.'
                : 'Protected deals start at ₹100.'}
            </p>
          )}
        </div>

        {isExchange ? (
          <Callout tone="info" icon="info" className="mt-4">
            The rate here is indicative. The server issues a firm rate with its own short expiry on
            the next screen, and that is the one the deal locks.
          </Callout>
        ) : null}
      </Card>

      {/* ---- What is it for? --------------------------------------- */}
      <Card>
        <h2 className="text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
          What is it for?
        </h2>
        <p className="mt-1 text-[length:var(--text-sm)] text-[var(--color-ink-3)]">
          Both sides see this. It is not in the shared link preview.
        </p>

        <input
          id="title"
          value={draft.title}
          onChange={(e) => patch({ title: e.target.value })}
          maxLength={120}
          placeholder={isExchange ? 'Exchange with Ananya' : 'Freelance design milestone'}
          aria-label="Deal purpose"
          className="field mt-3 text-[length:var(--text-base)]"
        />

        {!isExchange ? (
          <div className="no-bar mt-3 flex gap-2 overflow-x-auto">
            {USE_CASES.map((u) => (
              <button
                key={u.label}
                type="button"
                onClick={() => patch({ title: u.label })}
                className="press inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-full)] border border-[var(--color-line)] bg-[var(--color-paper)] px-3 py-1.5 text-[length:var(--text-xs)] font-medium text-[var(--color-ink-2)] hover:border-[var(--color-rule)]"
              >
                <Icon name={u.icon} className="h-3.5 w-3.5 text-[var(--color-ink-3)]" />
                {u.label}
              </button>
            ))}
          </div>
        ) : null}
      </Card>

      {/* ---- Who pays the fee? ------------------------------------- */}
      <Card>
        <h2 className="text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
          Who covers the fee?
        </h2>
        <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
          <FeeOption
            selected={draft.feeBearer === 'PAYER'}
            onSelect={() => patch({ feeBearer: 'PAYER' })}
            title="The payer"
            body="They send the amount plus the fee. The receiver keeps the full amount."
          />
          <FeeOption
            selected={draft.feeBearer === 'PAYEE'}
            onSelect={() => patch({ feeBearer: 'PAYEE' })}
            title="The receiver"
            body="The payer sends exactly the amount. The fee comes out of the receipt."
          />
        </div>
      </Card>

      {/* Mobile only: the same summary the desktop rail shows. */}
      <div className="lg:hidden">
        <SummaryRail draft={draft} quote={quote} />
      </div>
    </>
  );
}

function ScenarioOption({
  selected,
  onSelect,
  from,
  to,
  title,
  body,
}: {
  selected: boolean;
  onSelect: () => void;
  from: 'INR' | 'USDT';
  to: 'INR' | 'USDT';
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      data-selected={selected}
      className="pick"
    >
      <span className="pick-dot" aria-hidden />
      <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
        <AssetMark asset={from} size="sm" />
        <Icon name="arrow-right" className="h-3 w-3 text-[var(--color-ink-4)]" strokeWidth={2.2} />
        <AssetMark asset={to} size="sm" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
          {title}
        </span>
        <span className="mt-0.5 block text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
          {body}
        </span>
      </span>
    </button>
  );
}

function FeeOption({
  selected,
  onSelect,
  title,
  body,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      data-selected={selected}
      className="pick items-start"
    >
      <span className="pick-dot mt-0.5" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
          {title}
        </span>
        <span className="mt-0.5 block text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
          {body}
        </span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Step 2 — review
 * ------------------------------------------------------------------ */

function ReviewStep({
  draft,
  quote,
  onBack,
}: {
  draft: Draft;
  quote: QuotePreview | null;
  onBack: () => void;
}) {
  const meta = SCENARIO[draft.scenario];
  if (!quote) {
    return (
      <Notice
        tone="hold"
        title="There is nothing to review yet"
        body="No valid amount was entered, so no figures could be prepared."
        nextStep="Go back and enter the amount for this deal."
        action={{ href: '/app/new', label: 'Back to the terms' }}
      />
    );
  }

  return (
    <>
      <Card>
        <button
          type="button"
          onClick={onBack}
          className="press -ml-1 mb-3 inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1 py-0.5 text-[length:var(--text-xs)] font-semibold text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
        >
          <Icon name="chevron-left" className="h-3.5 w-3.5" strokeWidth={2.2} />
          Change the terms
        </button>

        <h2 className="text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
          Review and protect
        </h2>
        <p className="mt-1 text-[length:var(--text-sm)] text-[var(--color-ink-3)]">
          Confirm the amounts. Nothing is created until you press the button.
        </p>

        {/* The one sentence the whole product is about. */}
        <div className="mt-5 flex items-center gap-3 rounded-[var(--radius-lg)] bg-[var(--color-sunken)] p-4">
          <div className="min-w-0 flex-1">
            <Label>{draft.intent === 'RECEIVE' ? 'They pay' : 'You pay'}</Label>
            <p className="tnum mt-1 truncate text-[length:var(--text-2xl)] font-semibold tracking-[-0.028em] text-[var(--color-ink)]">
              {quote.payerSends}
            </p>
          </div>
          <Icon
            name="arrow-right"
            className="h-5 w-5 shrink-0 text-[var(--color-ink-4)]"
            strokeWidth={2}
          />
          <div className="min-w-0 flex-1 text-right">
            <Label>{draft.intent === 'RECEIVE' ? 'You receive' : 'They receive'}</Label>
            <p className="tnum mt-1 truncate text-[length:var(--text-2xl)] font-semibold tracking-[-0.028em] text-[var(--color-ink)]">
              {draft.scenario === 'INR_TO_INR'
                ? quote.payeeReceives
                : quote.usdtMicro !== null
                  ? `${formatMinor(quote.usdtMicro.toString(), 'USDT')} USDT`
                  : quote.payeeReceives}
            </p>
          </div>
        </div>

        <Facts className="mt-4">
          <Fact term="Deal type">{meta.title}</Fact>
          {draft.title.trim() ? <Fact term="Purpose">{draft.title.trim()}</Fact> : null}
          <Fact term="Amount">
            <span className="tnum">₹{formatMinor(quote.inrMinor.toString(), 'INR')}</span>
          </Fact>
          {meta.hasRate ? (
            <Fact term="Rate" hint="Indicative here. The server fixes the firm rate next.">
              <span className="tnum">{rateDisplay()} INR / USDT</span>
            </Fact>
          ) : null}
          <Fact term={quote.protectionLabel} hint={quote.protectionBasis}>
            <span className="tnum">₹{formatMinor(quote.protectionMinor.toString(), 'INR')}</span>
          </Fact>
          {quote.networkMinor > 0n ? (
            <Fact term="Network fee" hint="Flat cost of moving the crypto leg.">
              <span className="tnum">₹{formatMinor(quote.networkMinor.toString(), 'INR')}</span>
            </Fact>
          ) : null}
          <Fact term="Fee paid by">
            {draft.feeBearer === 'PAYER' ? 'The payer' : 'The receiver'}
          </Fact>
        </Facts>

        <div className="mt-3">
          <TotalRow term="Total the payer sends" tone="brand">
            {quote.payerSends}
          </TotalRow>
        </div>
      </Card>

      {/* ---- What protection actually means here ------------------- */}
      <Card>
        <h3 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
          What happens after you protect it
        </h3>
        <ul className="mt-3 space-y-2.5">
          {[
            'You get a link with its own expiry. Send it wherever you like.',
            'Exactly one eligible person can take the other side. Everyone else is told it was taken.',
            `Once they join, the payer has ${PAYMENT_WINDOW_MINUTES} minutes to send the money.`,
            'Nothing releases until the receiving side confirms it arrived — or an operator rules on a dispute.',
          ].map((line, i) => (
            <li key={i} className="flex gap-2.5">
              <span
                aria-hidden
                className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[var(--color-final-tint)] text-[var(--color-final)]"
              >
                <Icon name="check" className="h-2.5 w-2.5" strokeWidth={3.5} />
              </span>
              <span className="text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
                {line}
              </span>
            </li>
          ))}
        </ul>
        <SandboxLine className="mt-4" full />
      </Card>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The summary rail
 * ------------------------------------------------------------------ */

function SummaryRail({ draft, quote }: { draft: Draft; quote: QuotePreview | null }) {
  const meta = SCENARIO[draft.scenario];

  return (
    <Card>
      <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
        Deal summary
      </h2>

      <Facts className="mt-2">
        <Fact term="Scenario">{meta.short}</Fact>
        <Fact term="You are the">
          {draft.scenario === 'INR_TO_INR'
            ? draft.intent === 'PAY'
              ? 'Payer'
              : 'Payee'
            : meta.roleLabel[draft.scenario === 'USDT_TO_INR' ? 'CRYPTO_SIDE' : 'FIAT_SIDE']}
        </Fact>
        {quote ? (
          <>
            <Fact term="Amount">
              <span className="tnum">₹{formatMinor(quote.inrMinor.toString(), 'INR')}</span>
            </Fact>
            <Fact term={quote.protectionLabel}>
              <span className="tnum">₹{formatMinor(quote.protectionMinor.toString(), 'INR')}</span>
            </Fact>
            {quote.networkMinor > 0n ? (
              <Fact term="Network fee">
                <span className="tnum">₹{formatMinor(quote.networkMinor.toString(), 'INR')}</span>
              </Fact>
            ) : null}
            <Fact term="Payee receives">
              <span className="tnum">{quote.payeeReceives}</span>
            </Fact>
          </>
        ) : (
          <Fact term="Amount">
            <span className="text-[var(--color-ink-4)]">Not set</span>
          </Fact>
        )}
      </Facts>

      {quote ? (
        <div className="mt-3">
          <TotalRow term="Payer sends" tone="brand">
            {quote.payerSends}
          </TotalRow>
        </div>
      ) : null}

      <div className="mt-4 flex items-start gap-2.5 rounded-[var(--radius-md)] bg-[var(--color-sunken)] p-3">
        <Icon name="shield-check" className="mt-px h-4 w-4 shrink-0 text-[var(--color-final)]" />
        <p className="text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-2)]">
          <strong className="font-semibold text-[var(--color-ink)]">Protected by INRP2P.</strong>{' '}
          Terms are frozen on the server when the link is created and copied into the deal
          unchanged. No later step re-derives a figure from the rate.
        </p>
      </div>
    </Card>
  );
}
