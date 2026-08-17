'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatMinor, plainMinor } from '@/lib/format';
import { amountProblem, parseInrToMinor, parseUsdtToMicro } from '@/lib/parse';
import { inrFromUsdt, settlementFor, usdtFromInr } from '@/lib/fees';
import { REFERENCE_RATE, rateDisplay } from '@/lib/rate';
import type { Scenario } from '@/lib/scenario';
import { cn } from '@/lib/cn';
import { AssetMark, Icon } from './Icon';
import { Label, buttonClass } from './primitives';

/**
 * The calculator — the product itself, not a marketing widget.
 *
 * It states the whole mental model in one control:
 *   FROM → AMOUNT → TO → FINAL RESULT → MOVE
 *
 * The figure shown is INDICATIVE and never travels forward as binding. Only
 * the amount and the chosen scenario are carried across authentication; the
 * server issues a fresh firm quote, with its own expiry, when the deal is
 * created. That is why `Continue` sends the amount alone — no rate, no quote
 * id, no expiry.
 */

type Mode = Scenario;

const MODES: readonly { key: Mode; label: string; from: 'INR' | 'USDT'; to: 'INR' | 'USDT' }[] = [
  { key: 'INR_TO_INR', label: 'Pay safely', from: 'INR', to: 'INR' },
  { key: 'INR_TO_USDT', label: 'Buy USDT', from: 'INR', to: 'USDT' },
  { key: 'USDT_TO_INR', label: 'Sell USDT', from: 'USDT', to: 'INR' },
];

/**
 * `25000` → `25,000`, in the Indian grouping the rest of the product uses.
 *
 * Deliberately conservative: anything that is not a plain number is
 * returned untouched, so a half-typed or invalid entry still shows
 * exactly what the person typed and `amountProblem` still explains it.
 * `formatMinor` is the authority on grouping everywhere else; this
 * borrows it rather than reimplementing the rule.
 */
function groupDigits(value: string): string {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return value;
  const [whole, fraction] = trimmed.split('.');
  const grouped = Number(whole).toLocaleString('en-IN');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

export function Calculator({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('INR_TO_INR');
  const [raw, setRaw] = useState('25000');

  const meta = MODES.find((m) => m.key === mode)!;
  const problem = amountProblem(raw, meta.from);

  const result = useMemo(() => {
    if (meta.from === 'USDT') {
      const micro = parseUsdtToMicro(raw);
      if (micro === null) return null;
      const inrMinor = inrFromUsdt(micro, REFERENCE_RATE.num, REFERENCE_RATE.den);
      const settlement = settlementFor(mode, inrMinor, 'PAYER');
      return {
        sendLabel: `${formatMinor(micro.toString(), 'USDT')} USDT`,
        receiveLabel: `₹${formatMinor(settlement.payeeReceivesMinor.toString(), 'INR')}`,
        feeLabel: `₹${formatMinor(settlement.fees.totalMinor.toString(), 'INR')}`,
        amount: plainMinor(micro.toString(), 'USDT'),
      };
    }

    const inrMinor = parseInrToMinor(raw);
    if (inrMinor === null) return null;
    const settlement = settlementFor(mode, inrMinor, 'PAYER');

    if (mode === 'INR_TO_INR') {
      return {
        sendLabel: `₹${formatMinor(settlement.payerSendsMinor.toString(), 'INR')}`,
        receiveLabel: `₹${formatMinor(settlement.payeeReceivesMinor.toString(), 'INR')}`,
        feeLabel: `₹${formatMinor(settlement.fees.totalMinor.toString(), 'INR')}`,
        amount: plainMinor(inrMinor.toString(), 'INR'),
      };
    }

    const micro = usdtFromInr(inrMinor, REFERENCE_RATE.num, REFERENCE_RATE.den);
    return {
      sendLabel: `₹${formatMinor(settlement.payerSendsMinor.toString(), 'INR')}`,
      receiveLabel: `${formatMinor(micro.toString(), 'USDT')} USDT`,
      feeLabel: `₹${formatMinor(settlement.fees.totalMinor.toString(), 'INR')}`,
      amount: plainMinor(inrMinor.toString(), 'INR'),
    };
  }, [raw, mode, meta.from]);

  const go = () => {
    if (!result) return;
    const next = `/app/new?scenario=${mode}&amount=${result.amount}`;
    router.push(`/login?next=${encodeURIComponent(next)}`);
  };

  return (
    <section
      aria-label="Work out a protected deal"
      className="overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-line)] bg-[var(--color-paper)] shadow-[var(--shadow-lift)]"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        {/* ---- FROM: which deal --------------------------------- */}
        <div
          role="radiogroup"
          aria-label="Deal type"
          className="no-bar flex gap-1.5 overflow-x-auto border-b border-[var(--color-line)] p-3"
        >
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              role="radio"
              aria-checked={mode === m.key}
              onClick={() => {
                setMode(m.key);
                setRaw(m.from === 'USDT' ? '500' : '25000');
              }}
              className={cn(
                'press flex shrink-0 items-center gap-1.5 rounded-[var(--radius-full)] px-3.5 py-2 text-[length:var(--text-sm)] font-semibold transition-colors',
                mode === m.key
                  ? 'bg-[var(--color-ink)] text-[var(--color-paper)]'
                  : 'text-[var(--color-ink-3)] hover:bg-[var(--color-sunken)]',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* ---- AMOUNT ------------------------------------------- */}
        <div className="px-5 pt-5 sm:px-6">
          <label htmlFor="calc-amount" className="flex items-center justify-between">
            <Label>You {mode === 'INR_TO_INR' ? 'pay' : 'send'}</Label>
            <span className="text-[length:var(--text-2xs)] font-medium text-[var(--color-ink-4)]">
              {meta.from === 'USDT' ? 'Tether · TRC-20' : 'UPI or bank transfer'}
            </span>
          </label>
          <div className="mt-2 flex items-baseline gap-2">
            {meta.from === 'INR' ? (
              <span
                aria-hidden
                className="text-[length:var(--text-3xl)] font-semibold text-[var(--color-ink-4)] sm:text-[length:var(--text-4xl)]"
              >
                ₹
              </span>
            ) : null}
            <input
              id="calc-amount"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              /*
                ⚠ GROUPED ON BLUR, NOT WHILE TYPING.

                The typed figure sat raw — `25000` — directly above a
                formatted result reading `₹25,000.00`, so the single most
                important element on the landing page rendered the same
                quantity two different ways. Grouping it as the person
                types means fighting the caret on every keystroke and
                breaks editing in the middle of a number, which is worse.
                Grouping when they finish costs nothing and makes the two
                figures read as one system.
              */
              onBlur={() => setRaw((current) => groupDigits(current))}
              inputMode="decimal"
              autoComplete="off"
              autoFocus={autoFocus}
              aria-describedby={problem ? 'calc-problem' : 'calc-result calc-basis'}
              aria-invalid={problem ? true : undefined}
              className="amount-input text-[length:var(--text-3xl)] sm:text-[length:var(--text-4xl)]"
              placeholder="0"
            />
            <span className="shrink-0 text-[length:var(--text-lg)] font-medium text-[var(--color-ink-3)]">
              {meta.from}
            </span>
            <AssetMark asset={meta.from} size="md" />
          </div>
        </div>

        {problem ? (
          <p
            id="calc-problem"
            role="alert"
            className="flex items-center gap-1.5 px-5 pt-2 text-[length:var(--text-xs)] font-medium text-[var(--color-risk)] sm:px-6"
          >
            <Icon name="alert" className="h-3.5 w-3.5" />
            {problem}
          </p>
        ) : null}

        {/* ---- The seam ------------------------------------------ */}
        <div className="relative px-5 py-5 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-[var(--color-line)]" />
            <span className="tnum shrink-0 text-[length:var(--text-xs)] font-medium text-[var(--color-ink-3)]">
              {mode === 'INR_TO_INR'
                ? `${result?.feeLabel ?? '—'} protection fee`
                : `1 USDT = ₹${rateDisplay()}`}
            </span>
            <div className="h-px flex-1 bg-[var(--color-line)]" />
          </div>
        </div>

        {/* ---- TO + FINAL RESULT --------------------------------- */}
        <div className="px-5 pb-5 sm:px-6">
          <div className="flex items-center justify-between">
            <Label>{mode === 'INR_TO_INR' ? 'They receive' : 'You receive'}</Label>
            <span className="text-[length:var(--text-2xs)] font-medium text-[var(--color-ink-4)]">
              {meta.to === 'USDT' ? 'Tether · TRC-20' : 'Bank transfer'}
            </span>
          </div>
          <p
            id="calc-result"
            aria-live="polite"
            key={result?.receiveLabel ?? 'none'}
            className="tnum animate-value mt-2 flex items-baseline gap-2 text-[length:var(--text-3xl)] font-semibold tracking-[-0.03em] text-[var(--color-ink)] sm:text-[length:var(--text-4xl)]"
          >
            {result ? result.receiveLabel : meta.to === 'INR' ? '₹0.00' : '0 USDT'}
          </p>

          {mode !== 'INR_TO_INR' && result ? (
            <p className="mt-1.5 text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
              Includes {result.feeLabel} in fees. You send {result.sendLabel}.
            </p>
          ) : null}
        </div>

        {/* ---- MOVE ---------------------------------------------- */}
        <div className="border-t border-[var(--color-line)] bg-[var(--color-sunken)] p-3 sm:p-4">
          <button type="submit" disabled={!result} className={buttonClass('primary', 'lg', true)}>
            <Icon name="shield" className="h-4 w-4" />
            {mode === 'INR_TO_INR' ? 'Create a protected deal' : 'Get a protected quote'}
          </button>
          <p
            id="calc-basis"
            className="mt-2.5 text-center text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]"
          >
            Indicative figures, <strong className="font-semibold">not a quote</strong>. The server
            fixes the firm amounts, with their own expiry, when you create the deal.
          </p>
        </div>
      </form>
    </section>
  );
}
