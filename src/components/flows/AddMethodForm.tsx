'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addPaymentMethodAction } from '@/services/actions';
import { cn } from '@/lib/cn';
import { Icon } from '@/components/kit/Icon';
import { Sheet } from '@/components/kit/Sheet';
import { useToast } from '@/components/kit/Feedback';
import { Callout, buttonClass } from '@/components/kit/primitives';

/**
 * Add a way to be paid.
 *
 * ⚠ NO CREDENTIAL IS COLLECTED. There is no PIN field, no password field,
 * no CVV and no card number — this form records how to ADDRESS a transfer a
 * person makes in their own banking app, and the schema has no column that
 * could hold anything else. A bank account is stored masked to its last four
 * digits, server-side, before it is written.
 *
 * Validation is duplicated between here and the server on purpose: this one
 * exists so a person is told about a malformed IFSC while they are still
 * looking at the field, and the server's is the one that decides.
 */

type Kind = 'UPI' | 'BANK' | 'WALLET';

const KINDS: readonly { key: Kind; label: string; hint: string }[] = [
  { key: 'UPI', label: 'UPI', hint: 'name@bank — the fastest way to be paid in India' },
  { key: 'BANK', label: 'Bank account', hint: 'Account number and IFSC, for IMPS or NEFT' },
  { key: 'WALLET', label: 'Wallet', hint: 'A TRC-20 address, for the crypto leg' },
];

export function AddMethodForm() {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState<Kind>('UPI');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (form: FormData) => {
    form.set('kind', kind);
    startTransition(async () => {
      setProblem(null);
      const result = await addPaymentMethodAction(form);
      if (result.ok) {
        setOpen(false);
        toast.push('Payment method added', 'ok', 'wallet');
        router.refresh();
        return;
      }
      setProblem(result.message ?? 'That could not be saved.');
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClass('primary', 'md', true)}
      >
        <Icon name="plus" className="h-4 w-4" strokeWidth={2.2} />
        Add a payment method
      </button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Add a payment method"
        description="This is how a counterparty sends you rupees. It holds no credential."
      >
        <form action={submit} className="space-y-4">
          <div role="radiogroup" aria-label="Method type" className="space-y-2">
            {KINDS.map((k) => (
              <button
                key={k.key}
                type="button"
                role="radio"
                aria-checked={kind === k.key}
                onClick={() => setKind(k.key)}
                data-selected={kind === k.key}
                className="pick items-start"
              >
                <span className="pick-dot mt-0.5" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                    {k.label}
                  </span>
                  <span className="mt-0.5 block text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
                    {k.hint}
                  </span>
                </span>
              </button>
            ))}
          </div>

          <div>
            <label
              htmlFor="label"
              className="text-[length:var(--text-xs)] font-semibold text-[var(--color-ink-2)]"
            >
              Label
            </label>
            <input
              id="label"
              name="label"
              required
              maxLength={60}
              defaultValue={
                kind === 'UPI'
                  ? 'Primary UPI'
                  : kind === 'BANK'
                    ? 'Salary account'
                    : 'TRC-20 wallet'
              }
              className="field mt-1.5"
            />
          </div>

          <div>
            <label
              htmlFor="handle"
              className="text-[length:var(--text-xs)] font-semibold text-[var(--color-ink-2)]"
            >
              {kind === 'UPI' ? 'UPI ID' : kind === 'BANK' ? 'Account number' : 'Wallet address'}
            </label>
            <input
              id="handle"
              name="handle"
              required
              autoComplete="off"
              spellCheck={false}
              inputMode={kind === 'BANK' ? 'numeric' : 'text'}
              placeholder={
                kind === 'UPI' ? 'you@okhdfcbank' : kind === 'BANK' ? '50201234567890' : 'TXk5…'
              }
              className={cn('field mt-1.5', kind !== 'UPI' && 'font-mono')}
            />
            {kind === 'BANK' ? (
              <p className="mt-1.5 text-[length:var(--text-2xs)] text-[var(--color-ink-3)]">
                Only the last four digits are stored. The full number never reaches the database.
              </p>
            ) : null}
          </div>

          {kind === 'BANK' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="bankName"
                  className="text-[length:var(--text-xs)] font-semibold text-[var(--color-ink-2)]"
                >
                  Bank
                </label>
                <input
                  id="bankName"
                  name="bankName"
                  maxLength={80}
                  placeholder="HDFC Bank"
                  className="field mt-1.5"
                />
              </div>
              <div>
                <label
                  htmlFor="ifsc"
                  className="text-[length:var(--text-xs)] font-semibold text-[var(--color-ink-2)]"
                >
                  IFSC
                </label>
                <input
                  id="ifsc"
                  name="ifsc"
                  maxLength={11}
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="HDFC0001234"
                  className="field mt-1.5 font-mono uppercase"
                />
              </div>
            </div>
          ) : null}

          {problem ? (
            <Callout tone="risk" icon="alert" role="alert">
              {problem}
            </Callout>
          ) : null}

          <Callout tone="info" icon="lock">
            Never enter a UPI PIN, a card number, a CVV or a banking password. This form has no
            field for one, and INRP2P will never ask.
          </Callout>

          <button
            type="submit"
            disabled={pending}
            className={cn(buttonClass('primary', 'lg', true))}
          >
            {pending ? (
              <>
                <Icon name="refresh" className="h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              'Save payment method'
            )}
          </button>
        </form>
      </Sheet>
    </>
  );
}
