import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({
  children,
  className,
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article' | 'aside';
}) {
  return (
    <Tag
      className={cn(
        'rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-surface-raised)]',
        'shadow-[var(--shadow-card)]',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-tight text-[var(--color-ink)]">
          {title}
        </h2>
        {description ? (
          <p className="mt-1 text-sm text-[var(--color-muted)]">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-5 py-4', className)}>{children}</div>;
}
