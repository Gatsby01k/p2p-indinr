import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';

const TONE: Record<Tone, string> = {
  neutral:
    'bg-[var(--color-surface-sunken)] text-[var(--color-muted)] border-[var(--color-line-strong)]',
  brand:
    'bg-[var(--color-brand-tint)] text-[var(--color-brand-hover)] border-[var(--color-brand-line)]',
  success:
    'bg-[var(--color-success-tint)] text-[var(--color-success)] border-[var(--color-success)]/25',
  warning:
    'bg-[var(--color-warning-tint)] text-[var(--color-warning)] border-[var(--color-warning)]/25',
  danger:
    'bg-[var(--color-danger-tint)] text-[var(--color-danger)] border-[var(--color-danger)]/25',
  info: 'bg-[var(--color-info-tint)] text-[var(--color-info)] border-[var(--color-info)]/25',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
