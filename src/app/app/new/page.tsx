import { getChrome } from '@/server/sandbox/chrome';
import { SCENARIOS, type Scenario } from '@/lib/scenario';
import { AppHeader } from '@/components/kit/AppChrome';
import { CreateDealWizard } from '@/components/flows/CreateDealWizard';
import { Notice, Shell } from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * Create a protected deal.
 *
 * The intention arrives in the URL — from the home screen's three cards, or
 * from the landing calculator across sign-in — so the wizard opens already
 * set to what the person said they wanted. Everything is still editable:
 * a pre-selection is a shortcut, never a commitment.
 *
 * NO RATE IS CARRIED HERE. Whatever figure a visitor saw earlier was
 * indicative; the server issues a fresh firm quote, with its own
 * server-controlled expiry, at the moment the link is created.
 */
export default async function NewDealPage({
  searchParams,
}: {
  searchParams: Promise<{
    scenario?: string;
    intent?: string;
    amount?: string;
    error?: string;
  }>;
}) {
  const { unread } = await getChrome();
  const params = await searchParams;

  const scenario: Scenario = SCENARIOS.includes(params.scenario as Scenario)
    ? (params.scenario as Scenario)
    : 'INR_TO_INR';
  const intent = params.intent === 'receive' ? 'RECEIVE' : 'PAY';
  // Only a well-formed decimal travels in from a link; anything else is
  // dropped rather than rendered back into the field.
  const amount = /^\d{1,12}(\.\d{1,6})?$/.test(params.amount ?? '') ? params.amount! : '';

  return (
    <>
      <AppHeader
        title="Create a protected deal"
        subtitle="Fix the terms, then share one link"
        back={{ href: '/app', label: 'Back to home' }}
        unread={unread}
      />

      <Shell width="content" className="py-5 sm:py-7">
        {params.error === 'amount' ? (
          <Notice
            className="mb-5"
            tone="risk"
            title="That amount is not valid"
            body="An amount must be a plain number — rupees to two decimal places, USDT to six."
            reassurance="Nothing was created and no rate was requested."
            nextStep="Enter something like 25000 or 12.5, then create the deal again."
          />
        ) : null}

        <CreateDealWizard
          initialScenario={scenario}
          initialIntent={intent}
          initialAmount={amount}
        />
      </Shell>
    </>
  );
}
