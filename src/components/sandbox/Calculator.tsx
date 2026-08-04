'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { formatMinor } from '@/lib/format';

/**
 * Pre-auth calculator.
 *
 * The figure shown here is INDICATIVE and is never carried forward as binding.
 * Only the amount travels to the next step; the server issues a fresh firm
 * quote, with its own expiry, at the moment a link is created. That is why
 * this component sends `amount` alone and no rate, quote id or expiry.
 */

// Sandbox reference price, matching the server's — display only.
const RATE_NUM = 8880n;
const RATE_DEN = 100n;

export function Calculator() {
  const router = useRouter();
  const [raw, setRaw] = useState('500');

  const { usdtMinor, inrMinor, valid } = useMemo(() => {
    const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(raw.trim());
    if (!m) return { usdtMinor: 0n, inrMinor: 0n, valid: false };
    const whole = BigInt(m[1]!);
    const frac = BigInt((m[2] ?? '').padEnd(6, '0'));
    const micro = whole * 1_000_000n + frac;
    if (micro <= 0n) return { usdtMinor: 0n, inrMinor: 0n, valid: false };
    // Same exact-integer arithmetic as the server. No floating point.
    return { usdtMinor: micro, inrMinor: (micro * RATE_NUM) / (RATE_DEN * 10_000n), valid: true };
  }, [raw]);

  return (
    <section
      aria-label="Rate calculator"
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
    >
      <label className="block">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">You send</span>
        <div className="mt-1.5 flex items-center gap-2">
          <input
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            inputMode="decimal"
            aria-label="USDT amount"
            className="h-14 w-full rounded-xl border border-slate-300 px-3.5 text-2xl font-medium tabular-nums text-slate-900"
          />
          <span className="shrink-0 rounded-xl bg-slate-100 px-3.5 py-4 text-sm font-semibold text-slate-700">
            USDT
          </span>
        </div>
      </label>

      <div className="my-4 flex items-center gap-3">
        <span className="h-px flex-1 bg-slate-200" />
        <span className="tabular-nums text-xs font-medium text-slate-500">
          {(Number(RATE_NUM) / Number(RATE_DEN)).toFixed(2)} INR / USDT
        </span>
        <span className="h-px flex-1 bg-slate-200" />
      </div>

      <div>
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          You receive
        </span>
        <p className="mt-1.5 flex h-14 items-center rounded-xl bg-slate-50 px-3.5 text-2xl font-semibold tabular-nums text-slate-900">
          {valid ? `₹${formatMinor(inrMinor.toString(), 'INR')}` : '₹0.00'}
        </p>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-slate-500">
        Indicative only — <strong className="font-medium text-slate-700">not guaranteed</strong>.
        Your rate is fixed only when the server issues a firm quote on the next step, and it may
        differ from what you see here.
      </p>

      <button
        type="button"
        disabled={!valid}
        onClick={() =>
          router.push(
            `/login?next=${encodeURIComponent(
              `/app/new?amount=${(Number(usdtMinor) / 1e6).toString()}`,
            )}`,
          )
        }
        className="mt-4 h-12 w-full rounded-xl bg-slate-900 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        Continue
      </button>

      <p className="mt-2.5 text-center text-xs text-slate-500">
        You can calculate without an account. You will be asked to sign in before a rate is locked.
      </p>
    </section>
  );
}
