import { redirect } from 'next/navigation';
import { FAILURE_COPY, SandboxFailure, getDeal } from '@/server/sandbox/service';
import { getChrome } from '@/server/sandbox/chrome';
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
  Label,
  Notice,
  SandboxLine,
  Shell,
  TotalRow,
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
 * The order matches what a person does with their thumb: WHERE the money
 * goes, HOW MUCH exactly, then the reference and the proof.
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

  return (
    <>
      <AppHeader
        title={`Pay ${amount.display}`}
        subtitle={deal.dealCode}
        back={{ href: `/app/deal/${dealId}`, label: 'Back to the deal' }}
        unread={unread}
      />

      <Shell width="form" className="py-5 sm:py-7">
        {/* ---- The one warning that matters --------------------- */}
        <Callout tone="hold" icon="shield" className="mb-4">
          <strong className="font-semibold">Pay only from your own verified account.</strong> A
          transfer from a third party cannot be matched to this deal and will delay or fail
          verification.
        </Callout>

        {/* ---- Where the money goes ----------------------------- */}
        <Card>
          <div className="flex items-center gap-3">
            <Avatar
              name={deal.counterpartyName}
              size="md"
              verified={deal.counterpartyVerified}
            />
            <div className="min-w-0 flex-1">
              <Label>Pay to</Label>
              <p className="truncate text-[length:var(--text-lg)] font-semibold capitalize text-[var(--color-ink)]">
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
                {payTo.bankName ? (
                  <CopyField label="Bank" value={payTo.bankName} mono={false} />
                ) : null}
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
                    size={168}
                  />
                  <p className="mt-1 max-w-[22rem] text-center text-[length:var(--text-2xs)] leading-relaxed text-[var(--color-hold)]">
                    Sandbox handle. It resolves at no bank, so this code cannot move real money.
                  </p>
                </div>
              ) : null}
            </>
          ) : (
            <Callout tone="risk" icon="alert" className="mt-4">
              This person has not added a way to be paid yet. Message them in the deal room and ask
              them to add one before you transfer anything.
            </Callout>
          )}
        </Card>

        {/* ---- Exactly how much ---------------------------------- */}
        <Card className="mt-4">
          <h2 className="text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
            Send exactly this amount
          </h2>
          <p className="tnum mt-2 text-[length:var(--text-4xl)] font-semibold tracking-[-0.03em] text-[var(--color-ink)]">
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

          <div className="mt-3">
            <TotalRow term="Transfer" tone="brand">
              {amount.display}
            </TotalRow>
          </div>

          <p className="mt-3 flex items-start gap-2 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
            <Icon name="info" className="mt-px h-3.5 w-3.5 shrink-0" />A different amount cannot be
            matched automatically and has to be resolved by hand.
          </p>
        </Card>

        <div className="mt-4">
          <SandboxLine full />
        </div>

        <div className="mt-4">
          <PayFlow
            dealId={deal.dealId}
            amountLabel={amount.display}
            counterpartyName={deal.counterpartyName}
            evidence={deal.evidence}
          />
        </div>
      </Shell>
    </>
  );
}
