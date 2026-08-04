import { Shell, Skeleton } from '@/components/kit/primitives';

/**
 * Loading state for the authenticated section.
 *
 * Scoped to `/app` deliberately. At the root it would wrap the ENTIRE
 * application in one Suspense boundary — including the static landing page
 * and login, which have nothing to wait for — and blank them behind a
 * skeleton on every navigation. A loading boundary belongs at the segment
 * that actually does the fetching.
 *
 * The skeleton mirrors the real composition — a header line, a figure
 * pair and a panel — so the layout does not shift when content arrives.
 * It sweeps rather than pulses, which reads as "loading" without implying
 * progress that is not being made.
 */
export default function Loading() {
  return (
    <main id="main" className="py-8">
      <Shell width="content">
        <Skeleton className="h-5 w-40" />
        <div className="mt-6 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-paper)]">
          <div className="flex items-center justify-between gap-4 p-5">
            <Skeleton className="h-9 w-36" />
            <Skeleton className="h-6 w-24 rounded-[var(--radius-full)]" />
          </div>
          <div className="h-px bg-[var(--color-line)]" />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        </div>
        <span className="sr-only" role="status">
          Loading
        </span>
      </Shell>
    </main>
  );
}
