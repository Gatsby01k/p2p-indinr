import { getChrome } from '@/services';
import { listPaymentMethods } from '@/services';
import { removeMethodAction, setDefaultMethodAction } from '@/services/actions';
import { AppHeader } from '@/components/kit/AppChrome';
import { Icon, type IconName } from '@/components/kit/Icon';
import { ToastProvider } from '@/components/kit/Feedback';
import { ActionButton } from '@/components/flows/ActionButton';
import { AddMethodForm } from '@/components/flows/AddMethodForm';
import { Callout, Card, Chip, EmptyState, FocusLayout, Shell } from '@/components/kit/primitives';

export const dynamic = 'force-dynamic';

const KIND_ICON: Readonly<Record<'UPI' | 'BANK' | 'WALLET', IconName>> = {
  UPI: 'rupee',
  BANK: 'bank',
  WALLET: 'link',
};

/**
 * Payment methods.
 *
 * ⚠ HOLDS NO CREDENTIAL. Every row here is an ADDRESS — where a transfer
 * should be sent — not an authorisation to make one. The schema has no
 * column for a PIN, password, CVV, full card number or bank login, and none
 * may be added. Bank accounts are stored masked to their last four digits.
 *
 * Exactly one method is the default, enforced by a partial unique index in
 * the database rather than by remembering to clear the old one. The default
 * is what a counterparty is shown on the pay screen.
 */
export default async function PaymentMethodsPage() {
  const { user, unread } = await getChrome();
  const methods = await listPaymentMethods(user);

  return (
    <ToastProvider>
      <AppHeader
        title="Payment methods"
        subtitle={methods.length === 0 ? 'None yet' : `${methods.length} on file`}
        back={{ href: '/app/profile', label: 'Back to profile' }}
        unread={unread}
      />

      <Shell width="wide" className="py-5 sm:py-7">
        <FocusLayout
          aside={
            <Card>
              <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                What a payment method is here
              </h2>
              <p className="mt-2 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                An ADDRESS a counterparty sends money to, and nothing more. It holds no credential:
                there is no PIN, CVV or password field anywhere in this product, and the database
                has no column that could store one.
              </p>
              <p className="mt-2 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                Your default UPI or bank account is the one shown on a counterparty&rsquo;s payment
                screen. A bank account is stored masked to its last four digits before it is
                written.
              </p>
              {/*
                Said here rather than left to be inferred. A wallet sitting
                in the same list as a UPI reads as another way to be paid,
                and it is not: USDT moves inside INRP2P between balances,
                and this address is where it would leave to. Until a
                withdrawal exists it does nothing at all, and implying
                otherwise is the kind of quiet promise that costs trust
                exactly when somebody is waiting for money.
              */}
              <p className="mt-2 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                A USDT wallet is <strong>not</strong> a way to be paid for a deal. Crypto settles
                against your INRP2P balance, and this address is only where a withdrawal would send
                it &mdash; which this sandbox build cannot do yet.
              </p>
            </Card>
          }
        >
          {methods.length === 0 ? (
            <EmptyState
              icon="wallet"
              title="Nobody can pay you yet"
              body="Add a UPI ID or a bank account — every deal is settled in rupees between two people, so one of those is what a counterparty needs. Whichever you mark as default is what they see."
            />
          ) : (
            <ul className="space-y-3">
              {methods.map((m) => (
                <li key={m.methodId}>
                  <Card>
                    <div className="flex items-start gap-3">
                      <span
                        className={
                          m.isDefault
                            ? 'grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--color-brand-tint)] text-[var(--color-brand)]'
                            : 'grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--color-sunken)] text-[var(--color-ink-3)]'
                        }
                      >
                        <Icon name={KIND_ICON[m.kind]} className="h-[18px] w-[18px]" />
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="truncate text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                            {m.label}
                          </h2>
                          {m.isDefault ? (
                            <Chip tone="brand" icon="check">
                              Default
                            </Chip>
                          ) : null}
                          {m.verified ? <Chip icon="shield-check">Verified</Chip> : null}
                        </div>
                        <p className="mt-1 truncate font-mono text-[length:var(--text-sm)] text-[var(--color-ink-2)]">
                          {m.handle}
                        </p>
                        {m.bankName || m.ifsc ? (
                          <p className="mt-0.5 truncate text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
                            {[m.bankName, m.ifsc].filter(Boolean).join(' · ')}
                          </p>
                        ) : null}
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--color-line)] pt-3">
                      {!m.isDefault ? (
                        <ActionButton
                          action={setDefaultMethodAction.bind(null, m.methodId)}
                          success={`${m.label} is now your default`}
                          icon="check"
                        >
                          Make default
                        </ActionButton>
                      ) : null}
                      <ActionButton
                        action={removeMethodAction.bind(null, m.methodId)}
                        success={`${m.label} removed`}
                        icon="trash"
                        variant="danger"
                        confirm={`Remove ${m.label}? Anyone paying you will need a different method.`}
                      >
                        Remove
                      </ActionButton>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4">
            <AddMethodForm />
          </div>

          <Callout tone="info" icon="lock" className="mt-4">
            <strong className="font-semibold text-[var(--color-ink)]">
              INRP2P will never ask for a PIN, a password or a card number.
            </strong>{' '}
            Nothing on this screen can accept one, and no such field exists anywhere in the product.
            A message asking for one is not from us.
          </Callout>
        </FocusLayout>
      </Shell>
    </ToastProvider>
  );
}
