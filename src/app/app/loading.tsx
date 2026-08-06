import { DealCardSkeleton, Shell, Skeleton } from '@/components/kit/primitives';

/**
 * The authenticated shell's loading state.
 *
 * Shaped like the screen it replaces — a header, a row of intents, a grid of
 * cards — so nothing jumps when the data lands. A skeleton whose geometry is
 * wrong is worse than a spinner: it promises a layout and then breaks it.
 *
 * `aria-busy` with a single live message is what a screen reader needs; the
 * shapes themselves are `aria-hidden`, because "rectangle rectangle
 * rectangle" is not information.
 */
export default function AppLoading() {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>

      <div className="border-b border-[var(--color-line)] px-4 py-4 sm:px-6 lg:px-8">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-2 h-3 w-32" />
      </div>

      <Shell width="wide" className="py-5 sm:py-7">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="mt-2 h-4 w-80 max-w-full" />

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-paper)] p-4 shadow-[var(--shadow-card)] sm:p-5"
            >
              <Skeleton className="h-11 w-11 rounded-full" />
              <Skeleton className="mt-3 h-4 w-28" />
              <Skeleton className="mt-2 h-3 w-full" />
              <Skeleton className="mt-1.5 h-3 w-3/4" />
            </div>
          ))}
        </div>

        <Skeleton className="mt-8 h-4 w-36" />
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <DealCardSkeleton key={i} />
          ))}
        </div>
      </Shell>
    </div>
  );
}
