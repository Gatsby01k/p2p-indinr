import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './Button';

/** Neutral shimmer used for every loading surface. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-[var(--radius-sm)] bg-[var(--color-line)]', className)}
    />
  );
}

export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3 px-5 py-6">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-9 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      {icon ? <div className="text-[var(--color-faint)]">{icon}</div> : null}
      <h3 className="text-base font-semibold text-[var(--color-ink)]">{title}</h3>
      <p className="max-w-sm text-sm leading-relaxed text-[var(--color-muted)]">{description}</p>
      {action ? <div className="pt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = 'That did not load',
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <h3 className="text-base font-semibold text-[var(--color-ink)]">{title}</h3>
      <p className="max-w-sm text-sm leading-relaxed text-[var(--color-muted)]">{message}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry} className="mt-2">
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function OfflineState({ onRetry }: { onRetry?: () => void }) {
  return (
    <ErrorState
      title="You are offline"
      message="We could not reach INRP2P. Your deals are unaffected — nothing is cancelled while you are disconnected."
      {...(onRetry ? { onRetry } : {})}
    />
  );
}

export function PermissionDeniedState() {
  return (
    <ErrorState
      title="Not available to your account"
      message="This area is restricted. If you believe you should have access, contact support from your profile."
    />
  );
}

export function NotFoundState({ what = 'page' }: { what?: string }) {
  return (
    <EmptyState
      title={`This ${what} does not exist`}
      description="The link may be mistyped, or it may have been removed by whoever created it."
    />
  );
}
