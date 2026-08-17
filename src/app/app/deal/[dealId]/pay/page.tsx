import { redirect } from 'next/navigation';
import { FAILURE_COPY, SandboxFailure, getDeal } from '@/services';
import { getChrome } from '@/services';
import { formatMinor } from '@/lib/format';
import { settlementLegs } from '@/lib/dealPresenter';
import { AppHeader } from '@/components/kit/AppChrome';
import { CopyField } from '@/components/kit/Feedback';
import { Icon } from '@/components/kit/Icon';
import { QrCode, upiUri } from '@/components/kit/QrCode';
import { Deadline } from '@/components/kit/Time';
import { PayFlow } from '@/components/flows/PayFlow';
import {
  Avatar,
  Callout,
  Card,
  Fact,
  Facts,
  FocusLayout,
  Label,
  Notice,
  SandboxLine,
  Shell,
} from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

/**
 * Pay.
 *
 * Its own screen rather than a panel in the deal room, because paying is a
 * task a person leaves the app to do: they read the details here, switch to
 * their banking app, come back, and enter the reference. A screen they can
 * return to — with a real address they can reopen — serves that far better
 * than a modal that is lost the moment they switch apps.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHAT CHANGED, AND WHY.                                            │
 * │                                                                    │
 * │  This screen used to be one 27.5rem column nearly two thousand     │
 * │  pixels tall, with the destination, a QR, the amount, the          │
 * │  reference form, the proof upload and the only submit button       │
 * │  stacked in a line. The transfer figure appeared THREE times — in  │
 * │  the page title, as a hero, and again as a brand-coloured total —  │
 * │  and the sandbox warning appeared twice.                           │
 * │                                                                    │
 * │  The person's actual task, once they are back from their banking   │
 * │  app, is to type a reference. So the reference form is the column  │
 * │  they land in, and WHERE and HOW MUCH sit beside it as context     │
 * │  they can still see while typing. On a phone the order is          │
 * │  unchanged — context first, because they have not paid yet.        │
 * └────────────────────────────────────────────────────────────────────┘
 */
export default async function PayPage({ params }: { params: Promise<{ dealId: string }> }) {
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
        <AppHeader title="Payment unavailable" back={{ href: '/app/deals', label: 'Back' }} />
        <Shell width="prose" className="py-8">
          <Notice
            tone="idle"
            title="You cannot open this payment"
            body={copy.reason}
            reassurance="Nothing was changed and no payment was recorded."
            nextStep={copy.nextStep}
            action={{ href: '/app/deals', label: 'Back to your deals' }}
          />
        </Shell>
      </>
    );
  }

  // The server has already decided whether this person may pay. If they may
  // not — wrong seat, already claimed, disputed, finished — the deal room
  // is where the current truth is, so send them there rather than rendering
  // a form whose submission would be refused.
  if (!deal.permitted.canClaim) redirect(`/app/deal/${dealId}`);

  const settle = settlementLegs(deal);
  const amount = settle.payerSends;
  const payTo = deal.payTo;
  const rupees = formatMinor(settle.payerSendsMinor, 'INR');

  /* ---- Context column: where the money goes, and exactly how much --- */
  const destination = (
    <Card>
      <div className="flex items-center gap-3">
        <Avatar name={deal.counterpartyName} size="md" verified={deal.counterpartyVerified} />
        <div className="min-w-0 flex-1">
          <Label>Pay to</Label>
          <p className="truncate text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
            {deal.counterpartyName}
          </p>
        </div>
      </div>

      {payTo ? (
        <>
          <div className="mt-4 space-y-2.5">
            <CopyField
              label={payTo.kind === 'UPI' ? 'UPI ID' : 'Account'}
              value={payTo.handle}
              announce={`${payTo.kind === 'UPI' ? 'UPI ID' : 'Account'} copied`}
            />
            {payTo.bankName ? <CopyField label="Bank" value={payTo.bankName} mono={false} /> : null}
            {payTo.ifsc ? <CopyField label="IFSC" value={payTo.ifsc} /> : null}
          </div>

          {/* Scan-to-pay. In this sandbox the handle is a @sandboxupi
              address, which resolves at no bank — so the code is real
              and scannable but structurally cannot move real money. */}
          {payTo.kind === 'UPI' ? (
            <div className="mt-5 flex flex-col items-center border-t border-[var(--color-line)] pt-5">
              <QrCode
                value={upiUri({
                  vpa: payTo.handle,
                  name: deal.counterpartyName,
                  amountRupees: rupees.replace(/,/g, ''),
                  note: deal.dealCode,
                })}
                label={`Scan to open this payment in a UPI app · ${amount.display} to ${deal.counterpartyName}`}
                size={148}
              />
              {/*
                ⚠ THIS LINE IS NOT THE GENERAL SANDBOX NOTICE, AND IT IS
                NOT REDUNDANT WITH IT.

                Consolidating the two sandbox warnings on this screen, I
                deleted this one too — and the browser gate failed on
                `sandbox handle disclosed honestly`, correctly. The
                footer says no funds are held or moved anywhere in the
                product; THIS says the specific thing somebody is about
                to point their bank's camera at cannot reach a bank. A
                scannable code with no such caption is the one element
                here that could be mistaken for a live payment.
              */}
              <p className="mt-2 max-w-[18rem] text-center text-[length:var(--text-2xs)] leading-relaxed text-[var(--color-hold)]">
                Sandbox handle. It resolves at no bank, so this code cannot move real money.
              </p>
            </div>
          ) : null}
        </>
      ) : deal.valueLocked ? (
        <Callout tone="risk" icon="alert" className="mt-4">
          This person has not added a way to be paid yet. Message them in the deal room and ask them
          to add one before you transfer anything.
        </Callout>
      ) : (
        /*
         * The two reasons instructions can be missing are not the same
         * reason, and telling someone to "ask them to add one" when the
         * truth is "nothing is protecting this deal yet" would send them
         * to transfer money against nothing (UX-01 §3, TS-01.4 I7).
         */
        <Callout tone="risk" icon="alert" className="mt-4">
          Payment details are not available yet, because nothing is locked against this deal. Do not
          transfer anything until this page shows where to send it.
        </Callout>
      )}
    </Card>
  );

  const breakdown = (
    <Card>
      {/*
        ONE rendering of the transfer figure on this card. The page title
        already carries it, and a third brand-coloured repetition of the
        same number at the bottom of a table taught nobody anything.
      */}
      <Label>Send exactly</Label>
      <p className="tnum mt-1.5 text-[length:var(--text-3xl)] font-semibold tracking-[-0.03em] text-[var(--color-ink)]">
        {amount.display}
        <span className="sr-only"> {amount.srLabel}</span>
      </p>

      <Facts className="mt-3">
        <Fact term="Deal amount">
          <span className="tnum">{settle.amount.display}</span>
        </Fact>
        <Fact
          term={deal.direction === 'INR_TO_INR' ? 'Protection fee' : 'Service fee'}
          hint="Fixed on the server when the deal was created. It does not change."
        >
          <span className="tnum">₹{formatMinor(deal.protectionFeeMinor, 'INR')}</span>
        </Fact>
        {BigInt(deal.networkFeeMinor) > 0n ? (
          <Fact term="Network fee">
            <span className="tnum">₹{formatMinor(deal.networkFeeMinor, 'INR')}</span>
          </Fact>
        ) : null}
        <Fact term="Payment method">
          {payTo?.kind === 'UPI' ? 'UPI' : payTo?.kind === 'BANK' ? 'Bank transfer' : '—'}
        </Fact>
        {deal.actionDeadline ? (
          <Fact term="Pay by">
            <Deadline iso={deal.actionDeadline} />
          </Fact>
        ) : null}
      </Facts>

      <p className="mt-3 flex items-start gap-2 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
        <Icon name="info" className="mt-px h-3.5 w-3.5 shrink-0" />A different amount cannot be
        matched automatically and has to be resolved by hand.
      </p>
    </Card>
  );

  return (
    <>
      <AppHeader
        title={`Pay ${amount.display}`}
        subtitle={deal.dealCode}
        back={{ href: `/app/deal/${dealId}`, label: 'Back to the deal' }}
        unread={unread}
      />

      <Shell width="wide" className="py-5 sm:py-7">
        <FocusLayout
          asideFirst
          aside={
            <>
              {destination}
              {breakdown}
            </>
          }
        >
          {/* ---- The one warning that matters --------------------- */}
          <Callout tone="hold" icon="shield">
            <strong className="font-semibold">Pay only from your own verified account.</strong> A
            transfer from a third party cannot be matched to this deal and will delay or fail
            verification.
          </Callout>

          <div className="mt-4">
            <PayFlow
              dealId={deal.dealId}
              amountLabel={amount.display}
              counterpartyName={deal.counterpartyName}
              evidence={deal.evidence}
            />
          </div>

          {/*
            ONE sandbox line on this screen. There were two — one under
            the QR and one as a separate callout — and a warning printed
            twice on a page is a warning nobody finishes reading.
          */}
          <div className="mt-4">
            <SandboxLine full />
          </div>
        </FocusLayout>
      </Shell>
    </>
  );
}
