import { getChrome, newCommandId } from '@/services';
import { createLinkAction } from '@/services/actions';
import { SCENARIOS, type Scenario } from '@/lib/scenario';
import { AppHeader } from '@/components/kit/AppChrome';
import { CreateDealWizard } from '@/components/flows/CreateDealWizard';
import { Notice, Shell, buttonClass } from '@/components/kit/primitives';

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

  /*
   * One command id per render of this page, embedded in the no-JavaScript
   * form below.
   *
   * Minted HERE rather than inside the action, and that is the whole
   * point: a browser repeats a form post on refresh and on
   * back-navigation, and an id generated server-side per request would be
   * different every time — guaranteeing the duplicate deal it is meant to
   * prevent. Re-submitting THIS rendered page sends THIS id, so the second
   * arrival replays the first answer instead of creating a second deal.
   */
  const formCommandId = newCommandId();

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
        ) : params.error ? (
          <Notice
            className="mb-5"
            tone="risk"
            title="That deal was not created"
            body="The server refused the request."
            reassurance="No quote was issued and no link exists. Nothing was charged."
            nextStep="Reload this page and submit the form again."
          />
        ) : null}

        <CreateDealWizard
          initialScenario={scenario}
          initialIntent={intent}
          initialAmount={amount}
        />

        {/*
          The no-JavaScript path.

          Invisible to everyone whose browser runs the wizard above, so the
          approved interface is untouched — but a real, working form for
          anyone whose scripts failed to load, which is a normal condition
          on a bad Indian mobile connection rather than an exotic one.

          It carries the same server-authoritative guarantees as the wizard:
          the amount is priced on the server, the quote and link are written
          in one transaction, and `commandId` makes a repeated submission
          replay rather than duplicate.
        */}
        <noscript>
          <form action={createLinkAction} className="mt-6 space-y-3">
            <input type="hidden" name="commandId" value={formCommandId} />
            <label
              htmlFor="usdt-nojs"
              className="block text-[length:var(--text-sm)] font-medium text-[var(--color-ink)]"
            >
              Sell USDT — amount
            </label>
            <input
              id="usdt-nojs"
              name="usdt"
              inputMode="decimal"
              defaultValue={amount}
              placeholder="100"
              className="w-full rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[length:var(--text-lg)] text-[var(--color-ink)]"
            />
            <button type="submit" className={buttonClass('primary', 'lg', true)}>
              Create a sell link
            </button>
          </form>
        </noscript>
      </Shell>
    </>
  );
}
