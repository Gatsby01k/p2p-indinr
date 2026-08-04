'use client';

import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  suffix?: ReactNode;
}

export function Field({ label, hint, error, suffix, className, ...rest }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ');

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-[var(--color-ink-soft)]">
        {label}
      </label>
      <div className="relative">
        <input
          {...rest}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={cn(
            'h-11 w-full rounded-[var(--radius-md)] border bg-[var(--color-surface-raised)] px-3',
            'text-[15px] text-[var(--color-ink)] placeholder:text-[var(--color-faint)]',
            'transition-colors focus:outline-none focus-visible:border-[var(--color-brand)]',
            error ? 'border-[var(--color-danger)]' : 'border-[var(--color-line-strong)]',
            suffix ? 'pr-16' : '',
            className,
          )}
        />
        {suffix ? (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm font-medium text-[var(--color-muted)]">
            {suffix}
          </span>
        ) : null}
      </div>
      {hint && !error ? (
        <p id={hintId} className="text-xs text-[var(--color-muted)]">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errId} role="alert" className="text-xs font-medium text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
