import { TopBar } from '@/components/kit/AppChrome';
import { SandboxChip, Shell, Skeleton } from '@/components/kit/primitives';

/**
 * The shared link's loading state.
 *
 * This is the first screen many people ever see of the product, arriving
 * from a WhatsApp message on a slow connection — so it keeps the real
 * chrome and only skeletons the parts that need the database. What it must
 * never do is show a Join button before the server has said whether the link
 * can be joined.
 */
export default function LinkLoading() {
  return (
    <div className="flex min-h-dvh flex-col" aria-busy="true">
      <TopBar suffix="DealSafe India" right={<SandboxChip />} />
      <main className="flex-1 py-5 sm:py-8">
        <Shell width="form">
          <span className="sr-only" role="status">
            Loading this deal link
          </span>

          <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-paper)] shadow-[var(--shadow-card)]">
            <div className="flex items-start justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3.5 sm:px-5">
              <div>
                <Skeleton className="h-3 w-24" />
                <Skeleton className="mt-2 h-4 w-40" />
              </div>
              <Skeleton className="h-6 w-28 rounded-full" />
            </div>

            <div className="px-4 py-6 sm:px-5">
              <Skeleton className="mx-auto h-10 w-52" />
              <Skeleton className="mx-auto mt-5 h-12 w-full rounded-[var(--radius-md)]" />
            </div>

            <div className="space-y-3 border-t border-[var(--color-line)] px-4 py-4 sm:px-5">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex justify-between gap-4">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-28" />
                </div>
              ))}
            </div>

            <div className="border-t border-[var(--color-line)] bg-[var(--color-sunken)] px-4 py-4 sm:px-5">
              <Skeleton className="h-[3.25rem] w-full rounded-[var(--radius-md)]" />
            </div>
          </div>
        </Shell>
      </main>
    </div>
  );
}
