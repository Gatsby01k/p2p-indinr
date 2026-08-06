'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { formatMinor } from '@/lib/format';
import { ExchangeRail, Label, buttonClass } from './primitives';

/**
 * The calculator — the product itself, not a marketing widget.
 *
 * It states the whole mental model in one control:
 *   FROM → AMOUNT → TO → FINAL RESULT → MOVE
 *
 * The figure shown is INDICATIVE and never travels forward as binding.
 * Only the amount is carried across authentication; the server issues a
 * fresh firm quote with its own expiry when the link is created. That is
 * why `Continue` sends `amount` alone — no rate, no quote id, no expiry.
 */

const RATE_NUM = 8880n;
const RATE_DEN = 100n;

export function Calculator({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter();
  const [raw, setRaw] = useState('500');

  const { usdt, inrMinor, valid, problem } = useMemo(() => {
    const text = raw.trim();
    const none = { usdt: 0n, inrMinor: 0n, valid: false };
    if (text === '') return { ...none, problem: null };
    if (!/^[\d.]+$/.test(text)) {
      return { ...none, problem: 'Digits only — no symbols, spaces or commas.' };
    }
    if ((text.match(/\./g) ?? []).length > 1) {
      return { ...none, problem: 'That has more than one decimal point.' };
    }
    const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(text);
    if (!m) {
      return {
        ...none,
        problem: text.includes('.')
          ? 'USDT goes to six decimal places at most.'
          : 'That amount is too large.',
      };
    }
    const micro = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
    if (micro <= 0n) return { ...none, problem: 'Enter an amount greater than zero.' };
    // Identical exact-integer arithmetic to the server. No floating point.
    return {
      usdt: micro,
      inrMinor: (micro * RATE_NUM) / (RATE_DEN * 10_000n),
      valid: true,
      problem: null,
    };
  }, [raw]);

  const go = () => {
    if (!valid) return;
    const amount = formatMinor(usdt.toString(), 'USDT', true);
    router.push(`/login?next=${encodeURIComponent(`/app/new?amount=${amount}`)}`);
  };

  return (
    <section
      aria-label="Convert USDT to Indian rupees"
      className="rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--color-paper)]"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        {/* FROM + AMOUNT */}
        <div className="px-5 pt-5 sm:px-6 sm:pt-6">
          <label htmlFor="calc-amount" className="flex items-center justify-between">
            <Label>You send</Label>
            <span className="text-[length:var(--text-2xs)] font-medium text-[var(--color-ink-4)]">
              Tether · TRC-20
            </span>
          </label>
          <div className="mt-2 flex items-baseline gap-2">
            <input
              id="calc-amount"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              inputMode="decimal"
              autoComplete="off"
              autoFocus={autoFocus}
              aria-describedby={problem ? 'calc-problem' : 'calc-result calc-basis'}
              aria-invalid={!valid || undefined}
              className="tnum w-full min-w-0 border-0 bg-transparent p-0 text-[length:var(--text-4xl)] font-semibold tracking-[-0.03em] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)]"
              placeholder="0"
            />
            <span className="shrink-0 text-[length:var(--text-lg)] font-medium text-[var(--color-ink-3)]">
              USDT
            </span>
          </div>
        </div>

        {problem ? (
          <p
            id="calc-problem"
            role="alert"
            className="px-5 pt-2 text-[length:var(--text-xs)] font-medium text-[var(--color-risk)] sm:px-6"
          >
            {problem}
          </p>
        ) : null}

        {/* The rail: direction made geometric. */}
        <div className="px-5 py-4 sm:px-6">
          <ExchangeRail
            caption={`${(Number(RATE_NUM) / Number(RATE_DEN)).toFixed(2)} INR / USDT`}
            live
          />
        </div>

        {/* TO + FINAL RESULT */}
        <div className="px-5 pb-5 sm:px-6 sm:pb-6">
          <div className="flex items-center justify-between">
            <Label>You receive</Label>
            <span className="text-[length:var(--text-2xs)] font-medium text-[var(--color-ink-4)]">
              Bank transfer
            </span>
          </div>
          <p
            id="calc-result"
            aria-live="polite"
            className="tnum mt-2 flex items-baseline gap-2 text-[length:var(--text-4xl)] font-semibold tracking-[-0.03em] text-[var(--color-ink)]"
          >
            <span aria-hidden>₹</span>
            {valid ? formatMinor(inrMinor.toString(), 'INR') : '0.00'}
            <span className="sr-only">
              {valid ? `${formatMinor(inrMinor.toString(), 'INR')} rupees` : 'Enter an amount'}
            </span>
          </p>
        </div>

        {/* MOVE */}
        <div className="border-t border-[var(--color-line)] p-3 sm:p-4">
          <button type="submit" disabled={!valid} className={buttonClass('primary', 'lg', true)}>
            Create a deal link
          </button>
          <p
            id="calc-basis"
            className="mt-2.5 text-center text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]"
          >
            Indicative rate, <strong className="font-semibold">not guaranteed</strong>. The server
            issues a firm quote when you create the link.
          </p>
        </div>
      </form>
    </section>
  );
}
