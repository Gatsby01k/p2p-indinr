import { LineSkeleton, Shell, Skeleton } from '@/components/kit/primitives';

/**
 * The deal room's loading state.
 *
 * Matched to the room's three-column desktop composition and its single
 * column on a phone, so the layout does not reflow when the deal arrives.
 * The amount block keeps its height in particular: a figure that appears and
 * pushes the action button down is how people tap the wrong thing.
 */
export default function DealLoading() {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">
        Loading this deal
      </span>

      <div className="border-b border-[var(--color-line)] px-4 py-4 sm:px-6 lg:px-8">
        <Skeleton className="h-5 w-52" />
        <Skeleton className="mt-2 h-3 w-24" />
      </div>

      <Shell width="ops" className="py-4 sm:py-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_minmax(0,22rem)] lg:items-start">
          <Panel>
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-6 w-24 rounded-full" />
            </div>
            <Skeleton className="mx-auto mt-6 h-9 w-44" />
            <Skeleton className="mt-6 h-14 w-full rounded-[var(--radius-md)]" />
            <Skeleton className="mt-5 h-5 w-full" />
          </Panel>

          <Panel>
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-6 w-56" />
            <div className="mt-3">
              <LineSkeleton rows={2} />
            </div>
            <Skeleton className="mt-5 h-[3.25rem] w-full rounded-[var(--radius-md)]" />
          </Panel>

          <Panel className="hidden lg:block">
            <Skeleton className="h-4 w-40" />
            <div className="mt-4 space-y-3">
              <Skeleton className="h-10 w-3/4 rounded-[var(--radius-lg)]" />
              <Skeleton className="ml-auto h-10 w-2/3 rounded-[var(--radius-lg)]" />
              <Skeleton className="h-10 w-1/2 rounded-[var(--radius-lg)]" />
            </div>
          </Panel>
        </div>
      </Shell>
    </div>
  );
}

function Panel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-paper)] p-4 shadow-[var(--shadow-card)] sm:p-5 ${className}`}
    >
      {children}
    </div>
  );
}
