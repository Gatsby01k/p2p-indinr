'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-[var(--color-brand)] text-white hover:bg-[var(--color-brand-hover)] active:bg-[var(--color-brand-press)] disabled:bg-[var(--color-faint)]',
  secondary:
    'bg-[var(--color-surface-raised)] text-[var(--color-ink)] border border-[var(--color-line-strong)] hover:border-[var(--color-ink-soft)] disabled:text-[var(--color-faint)]',
  ghost:
    'bg-transparent text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-sunken)] disabled:text-[var(--color-faint)]',
  danger: 'bg-[var(--color-danger)] text-white hover:opacity-90 disabled:bg-[var(--color-faint)]',
};

const SIZE: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm rounded-[var(--radius-sm)]',
  md: 'h-11 px-4 text-[15px] rounded-[var(--radius-md)]',
  lg: 'h-14 px-6 text-base rounded-[var(--radius-md)]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <button
      {...rest}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 font-medium transition-colors duration-150',
        'disabled:cursor-not-allowed',
        VARIANT[variant],
        SIZE[size],
        fullWidth && 'w-full',
        className,
      )}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}
