import Link from 'next/link';
import { FAILURE_COPY, SandboxFailure, getDeal } from '@/server/sandbox/service';
import { requireUser } from '@/server/sandbox/session';
import { BottomNav } from '@/components/kit/AppChrome';
import { DealRoom } from '@/components/kit/DealRoom';
import { Notice, Shell } from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

export default async function DealPage({ params }: { params: Promise<{ dealId: string }> }) {
  const { dealId } = await params;
  const user = await requireUser();

  try {
    const deal = await getDeal(user, dealId);
    return (
      <>
        <Shell width="content" className="py-5 sm:py-8">
          <div className="mx-auto max-w-[44rem]">
            <Link
              href="/app"
              prefetch={false}
              className="mb-4 inline-flex items-center gap-1.5 text-[length:var(--text-xs)] font-medium text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            >
              <span aria-hidden>←</span> All deals
            </Link>
            <DealRoom deal={deal} />
          </div>
        </Shell>
        <BottomNav active="deals" isOperator={user.isOperator} />
      </>
    );
  } catch (err) {
    // A non-participant sees why they cannot open it, never its contents.
    const code = err instanceof SandboxFailure ? err.code : 'NOT_FOUND';
    const copy = FAILURE_COPY[code] ?? FAILURE_COPY.NOT_FOUND;
    return (
      <>
        <Shell width="prose" className="py-10">
          <Notice
            tone="idle"
            title="You cannot open this deal"
            body={copy.reason}
            reassurance="Nothing was changed, and no information about this deal was disclosed."
            nextStep={copy.nextStep}
            action={{ href: '/app', label: 'Back to your deals' }}
          />
        </Shell>
        <BottomNav active="deals" isOperator={user.isOperator} />
      </>
    );
  }
}
