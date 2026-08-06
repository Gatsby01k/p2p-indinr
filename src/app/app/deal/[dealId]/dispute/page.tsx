import { redirect } from 'next/navigation';
import { FAILURE_COPY, SandboxFailure, getDeal } from '@/server/sandbox/service';
import { getChrome } from '@/server/sandbox/chrome';
import { settlementLegs } from '@/lib/dealPresenter';
import { AppHeader } from '@/components/kit/AppChrome';
import { DisputeForm } from '@/components/flows/DisputeForm';
import { Notice, Shell } from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * Report a problem.
 *
 * Reachable in one tap from the deal room, and its own address so a person
 * can be sent straight to it by support. If the deal is already disputed or
 * already finished, there is nothing to raise — the deal room holds the
 * current truth, so they go there instead of filling in a form that would
 * be refused on submit.
 */
export default async function DisputePage({ params }: { params: Promise<{ dealId: string }> }) {
  const { dealId } = await params;
  const { user, unread } = await getChrome();

  let deal;
  try {
    deal = await getDeal(user, dealId);
  } catch (err) {
    const code = err instanceof SandboxFailure ? err.code : 'NOT_FOUND';
    const copy = FAILURE_COPY[code] ?? FAILURE_COPY.NOT_FOUND;
    return (
      <>
        <AppHeader title="Unavailable" back={{ href: '/app/deals', label: 'Back' }} />
        <Shell width="prose" className="py-8">
          <Notice
            tone="idle"
            title="You cannot report a problem on this deal"
            body={copy.reason}
            reassurance="Nothing was changed and no case was opened."
            nextStep={copy.nextStep}
            action={{ href: '/app/deals', label: 'Back to your deals' }}
          />
        </Shell>
      </>
    );
  }

  if (!deal.permitted.canDispute) redirect(`/app/deal/${dealId}`);

  const settle = settlementLegs(deal);

  return (
    <>
      <AppHeader
        title="Report a problem"
        subtitle={`${deal.dealCode} · release is paused while it is reviewed`}
        back={{ href: `/app/deal/${dealId}`, label: 'Back to the deal' }}
        unread={unread}
      />

      <Shell width="form" className="py-5 sm:py-7">
        <DisputeForm
          dealId={deal.dealId}
          dealCode={deal.dealCode}
          amountLabel={settle.amount.display}
          counterpartyName={deal.counterpartyName}
          evidence={deal.evidence}
          canUpload={deal.permitted.canUpload}
        />
      </Shell>
    </>
  );
}
