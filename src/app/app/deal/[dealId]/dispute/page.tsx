import { redirect } from 'next/navigation';
import { FAILURE_COPY, SandboxFailure, getDeal } from '@/services';
import { getChrome } from '@/services';
import { settlementLegs } from '@/lib/dealPresenter';
import { AppHeader } from '@/components/kit/AppChrome';
import { DisputeForm } from '@/components/flows/DisputeForm';
import { Card, FocusLayout, Notice, Shell } from '@/components/kit/primitives';
import { Icon } from '@/components/kit/Icon';

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

      <Shell width="wide" className="py-5 sm:py-7">
        {/*
          Reporting a problem is the most anxious thing a person does in
          this product. The form is the task; what happens next — that
          release pauses, that nothing resolves on a timer, that a person
          reads it — sits beside it rather than being discovered
          afterwards.
        */}
        <FocusLayout
          aside={
            <Card>
              <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                What reporting does
              </h2>
              <ul className="mt-3 space-y-3">
                {[
                  {
                    title: 'Release pauses immediately',
                    body: 'Neither side can complete or cancel the deal while a case is open.',
                  },
                  {
                    title: 'A person reads it',
                    body: 'An operator reviews what both sides wrote and attached. Nothing is decided by a rule or a timer.',
                  },
                  {
                    title: 'The reason is on the record',
                    body: 'Whatever is decided comes with a written reason, and both sides see it.',
                  },
                  {
                    title: 'Nothing is lost by reporting',
                    body: 'If it turns out to be a misunderstanding, the deal continues from where it was.',
                  },
                ].map((point) => (
                  <li key={point.title} className="flex gap-2.5">
                    <Icon
                      name="shield-check"
                      className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-ink-4)]"
                    />
                    <div className="min-w-0">
                      <p className="text-[length:var(--text-sm)] font-semibold text-[var(--color-ink)]">
                        {point.title}
                      </p>
                      <p className="mt-0.5 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                        {point.body}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          }
        >
          <DisputeForm
            dealId={deal.dealId}
            dealCode={deal.dealCode}
            amountLabel={settle.amount.display}
            counterpartyName={deal.counterpartyName}
            evidence={deal.evidence}
            canUpload={deal.permitted.canUpload}
          />
        </FocusLayout>
      </Shell>
    </>
  );
}
