'use client';

import { useId, type RefObject } from 'react';
import { cn } from '@/lib/cn';

/**
 * The one-time code, in the shape the server actually issues.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  EIGHT DIGITS, BECAUSE THE BACKEND MINTS EIGHT DIGITS.             │
 * │                                                                    │
 * │  `mintNumericCode()` is `randomInt(0, 100_000_000)` padded to      │
 * │  eight — see `src/server/identity/tokens.ts`, which explains why:  │
 * │  two extra decimal digits cost the person nothing and multiply an  │
 * │  attacker's work by a hundred. A six-cell field would be a UI      │
 * │  that cannot accept the credential the product sends.              │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  ONE REAL INPUT UNDER EIGHT DRAWN CELLS.                           │
 * │                                                                    │
 * │  The cells are `<span>`s painted from state; the thing the browser │
 * │  and the person are actually talking to is a single `<input>`      │
 * │  stretched across all of them with transparent text and caret.     │
 * │                                                                    │
 * │  That is the whole reason for the arrangement. Eight separate      │
 * │  inputs is the common implementation and it re-implements — badly  │
 * │  — everything the platform already does: paste spreading across    │
 * │  cells, backspace crossing a boundary, arrow keys, iOS and Android │
 * │  SMS/mail autofill, password managers, IME composition, and a      │
 * │  screen reader announcing one field instead of eight. Here every   │
 * │  one of those is native behaviour that no code of ours can get     │
 * │  wrong.                                                            │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ⚠ The value is held by the caller, in React state, and is passed to the
 * verify action and nowhere else. It is never written to `localStorage`,
 * `sessionStorage`, a cookie, the URL or a log line — a one-time code that
 * outlives its one use, or that appears in a history entry or an analytics
 * payload, is a credential in the clear.
 */
export const CODE_LENGTH = 8;

/** Digits only, capped. Paste of `1234 5678` or `1234-5678` still works. */
export function normalizeCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
}

export function CodeField({
  value,
  onChange,
  onComplete,
  disabled,
  invalid,
  describedBy,
  inputRef,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Fired once the eighth digit lands, so paste can submit without a click. */
  onComplete?: (code: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const id = useId();
  const cells = Array.from({ length: CODE_LENGTH }, (_, i) => value[i] ?? '');
  // Where the caret sits, so exactly one cell can show as the live one.
  const cursor = Math.min(value.length, CODE_LENGTH - 1);

  return (
    <div>
      <label htmlFor={id} className="auth-label">
        Sign-in code
      </label>

      <div
        className={cn('auth-code', invalid && 'auth-code-invalid', disabled && 'auth-code-off')}
        data-filled={value.length}
      >
        <input
          ref={inputRef}
          id={id}
          name="code"
          type="text"
          /*
           * `numeric` rather than `tel`: it raises the digits-only keypad
           * on both platforms without the phone keypad's `+ * #` row,
           * which has nothing to do with an eight-digit code.
           */
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          /*
           * ⚠ NO `maxLength`, DELIBERATELY — it silently ate a digit.
           *
           * The browser truncates a paste to `maxLength` BEFORE the
           * change event fires, so pasting a code a mail client had
           * formatted as `4821 3907` arrived as `4821 390`, and
           * stripping the space then left seven digits and a field
           * that looked one keystroke short for no visible reason.
           * The cap belongs after the formatting is removed, which is
           * exactly what `normalizeCode` does.
           */
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          value={value}
          onChange={(event) => {
            const next = normalizeCode(event.target.value);
            onChange(next);
            if (next.length === CODE_LENGTH) onComplete?.(next);
          }}
          className="auth-code-input"
        />

        {/*
          Painted from the value above. `aria-hidden` because the input is
          the field: a screen reader that met these as well would be told
          the code twice, once as eight loose characters.
        */}
        <span aria-hidden className="auth-code-cells">
          {cells.map((digit, i) => (
            <span
              key={i}
              className="auth-code-cell"
              data-live={!disabled && i === cursor ? '' : undefined}
              data-set={digit ? '' : undefined}
            >
              {digit}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
