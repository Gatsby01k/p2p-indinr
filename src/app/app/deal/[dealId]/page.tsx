import type { Metadata } from 'next';
import { FAILURE_COPY, SandboxFailure, getDeal } from '@/server/sandbox/service';
import { getChrome } from '@/server/sandbox/chrome';
import { DEAL_STATE, dealTitle } from '@/lib/dealPresenter';
import { AppHeader } from '@/components/kit/AppChrome';
import { DealRoom } from '@/components/deal/DealRoom';
import { Notice, Shell, Status } from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ dealId: string }> };

/**
 * The deal room.
 *
 * Authorization happens in `getDeal`, before any content exists to render: a
 * non-participant receives a rejection, never a page with hidden contents.
 * The catch below turns that rejection into an explanation of why they
 * cannot open it — which is different from pretending it does not exist.
 */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { dealId } = await params;
  try {
    const { user } = await getChrome();
    const deal = await getDeal(user, dealId, { summaryOnly: true });
    return { title: `${dealTitle(deal)} · ${deal.dealCode}`, robots: { index: false } };
  } catch {
    return { title: 'Deal', robots: { index: false } };
  }
}

export default async function DealPage({ params }: Params) {
  const { dealId } = await params;
  const { user, unread } = await getChrome();

  try {
    const deal = await getDeal(user, dealId);
    const meta = DEAL_STATE[deal.state];

    return (
      <>
        <AppHeader
          title={dealTitle(deal)}
          subtitle={deal.dealCode}
          back={{ href: '/app/deals', label: 'Back to deals' }}
          unread={unread}
          actions={
            <span className="hidden sm:inline-flex">
              <Status tone={meta.tone}>{meta.label}</Status>
            </span>
          }
        />
        <Shell width="ops" className="py-4 sm:py-6">
          <DealRoom deal={deal} />
          {/* Reserve the height of the mobile section tabs so the last card
              is never trapped underneath them. */}
          <div aria-hidden className="h-20 lg:hidden" />
        </Shell>
      </>
    );
  } catch (err) {
    // A non-participant sees why they cannot open it, never its contents.
    const code = err instanceof SandboxFailure ? err.code : 'NOT_FOUND';
    const copy = FAILURE_COPY[code] ?? FAILURE_COPY.NOT_FOUND;
    return (
      <>
        <AppHeader
          title="Deal unavailable"
          back={{ href: '/app/deals', label: 'Back to deals' }}
          unread={unread}
        />
        <Shell width="prose" className="py-8">
          <Notice
            tone="idle"
            title="You cannot open this deal"
            body={copy.reason}
            reassurance="Nothing was changed, and no information about this deal was disclosed."
            nextStep={copy.nextStep}
            action={{ href: '/app/deals', label: 'Back to your deals' }}
          />
        </Shell>
      </>
    );
  }
}
