'use client';

import { useMemo, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { formatMinor } from '@/lib/format';
import { ExchangeRail, Label, buttonClass } from './primitives';

/**
 * Amount entry with a live preview of the consequence.
 *
 * The preview is explicitly labelled indicative. The binding figure comes
 * back from the server after submission — this component never claims the
 * number it renders is the one that will be locked.
 */

const RATE_NUM = 8880n;
const RATE_DEN = 100n;

function Submit({ disabled }: { disabled: boolean }) {
  // `useFormStatus` gives real pending state for a server action without
  // any client-side state machine of our own.
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className={buttonClass('primary', 'lg', true)}
    >
      {pending ? 'Asking the server for a firm rate…' : 'Get a firm rate and create the link'}
    </button>
  );
}

export function NewDealForm({
  action,
  defaultAmount,
}: {
  action: (formData: FormData) => void | Promise<void>;
  defaultAmount: string;
}) {
  const [raw, setRaw] = useState(defaultAmount);

  const { inrMinor, valid } = useMemo(() => {
    const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(raw.trim());
    if (!m) return { inrMinor: 0n, valid: false };
    const micro = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
    if (micro <= 0n) return { inrMinor: 0n, valid: false };
    return { inrMinor: (micro * RATE_NUM) / (RATE_DEN * 10_000n), valid: true };
  }, [raw]);

  return (
    <form
      action={action}
      className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--color-paper)]"
    >
      <div className="px-5 pt-5 sm:px-6 sm:pt-6">
        <label htmlFor="usdt" className="flex items-center justify-between">
          <Label>You supply</Label>
          <span className="text-[length:var(--text-2xs)] font-medium text-[var(--color-ink-4)]">
            Tether · TRC-20
          </span>
        </label>
        <div className="mt-2 flex items-baseline gap-2">
          <input
            id="usdt"
            name="usdt"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            inputMode="decimal"
            autoComplete="off"
            required
            aria-describedby="preview"
            aria-invalid={!valid || undefined}
            className="tnum w-full min-w-0 border-0 bg-transparent p-0 text-[length:var(--text-4xl)] font-semibold tracking-[-0.03em] text-[var(--color-ink)] outline-none"
          />
          <span className="shrink-0 text-[length:var(--text-lg)] font-medium text-[var(--color-ink-3)]">
            USDT
          </span>
        </div>
      </div>

      <div className="px-5 py-4 sm:px-6">
        <ExchangeRail caption="indicative" />
      </div>

      <div className="px-5 pb-5 sm:px-6 sm:pb-6">
        <Label>They send you</Label>
        <p
          id="preview"
          aria-live="polite"
          className="tnum mt-2 text-[length:var(--text-3xl)] font-semibold tracking-[-0.03em] text-[var(--color-ink)]"
        >
          <span aria-hidden>₹</span>
          {valid ? formatMinor(inrMinor.toString(), 'INR') : '0.00'}
          <span className="sr-only">
            {valid
              ? `${formatMinor(inrMinor.toString(), 'INR')} rupees, indicative`
              : 'Enter an amount'}
          </span>
        </p>
        <p className="mt-1.5 text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
          Indicative. The firm figure is fixed by the server on the next step.
        </p>
      </div>

      <div className="border-t border-[var(--color-line)] p-3 sm:p-4">
        <Submit disabled={!valid} />
      </div>
    </form>
  );
}
