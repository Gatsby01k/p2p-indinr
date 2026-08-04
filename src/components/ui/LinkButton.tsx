import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary';
type Size = 'sm' | 'md' | 'lg';

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-[var(--color-brand)] text-white hover:bg-[var(--color-brand-hover)] active:bg-[var(--color-brand-press)]',
  secondary:
    'bg-[var(--color-surface-raised)] text-[var(--color-ink)] border border-[var(--color-line-strong)] hover:border-[var(--color-ink-soft)]',
};

const SIZE: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm rounded-[var(--radius-sm)]',
  md: 'h-11 px-4 text-[15px] rounded-[var(--radius-md)]',
  lg: 'h-14 px-6 text-base rounded-[var(--radius-md)]',
};

/** A link that looks like a button. Never nest a Link inside a <button>. */
export function LinkButton({
  href,
  children,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  className,
}: {
  href: string;
  children: ReactNode;
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex items-center justify-center gap-2 font-medium transition-colors duration-150',
        VARIANT[variant],
        SIZE[size],
        fullWidth && 'w-full',
        className,
      )}
    >
      {children}
    </Link>
  );
}
