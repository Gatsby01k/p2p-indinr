'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { claimTestFundsAction } from '@/services/actions';
import { formatMinor } from '@/lib/format';
import { Card, Fact, Facts, Label, SandboxLine, buttonClass } from '@/components/kit/primitives';

/**
 * What you hold, and what is spoken for.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  SELLING USDT NOW COSTS YOU USDT.                                  │
 * │                                                                    │
 * │  Escrow is wired into the deal lifecycle: joining a USDT deal      │
 * │  takes the seller's balance and completion hands it to the buyer.  │
 * │  Before that, "protected" was a label with nothing behind it and a │
 * │  balance was not worth showing. Now it decides whether a person    │
 * │  can trade at all, so it belongs on screen next to the reason.     │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * `locked` is shown beside `available` rather than folded into a total,
 * because they answer different questions — what can I commit next, and
 * what is already committed — and a single number answers neither.
 */
export function WalletCard({
  availableMinor,
  lockedMinor,
  claimable,
}: {
  readonly availableMinor: string;
  readonly lockedMinor: string;
  /** False outside a sandbox: there are no test funds to hand out. */
  readonly claimable: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);

  const claim = () =>
    startTransition(async () => {
      const result = await claimTestFundsAction();
      setNotice({ ok: result.ok, message: result.message ?? 'Done.' });
      if (result.ok) router.refresh();
    });

  const empty = availableMinor === '0' && lockedMinor === '0';

  return (
    <Card className="mt-4">
      <Label>USDT balance</Label>
      <Facts className="mt-3">
        <Fact term="Available" mono strong>
          {formatMinor(availableMinor, 'USDT')}
        </Fact>
        <Fact term="In escrow" mono>
          {formatMinor(lockedMinor, 'USDT')}
        </Fact>
      </Facts>

      <p className="mt-3 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
        {empty
          ? 'Selling USDT puts it into escrow until the buyer pays, so you need a balance before you can create that deal.'
          : 'Anything in escrow is committed to a live deal and is released when it completes.'}
      </p>

      {claimable ? (
        <>
          <button
            type="button"
            onClick={claim}
            disabled={pending}
            className={`${buttonClass('outline', 'md')} mt-4`}
            data-testid="claim-test-funds"
          >
            {pending ? 'Adding…' : 'Add 5,000 test USDT'}
          </button>
          {notice ? (
            <p
              role="status"
              className={`mt-2 text-[length:var(--text-sm)] ${
                notice.ok ? 'text-[var(--color-final)]' : 'text-[var(--color-ink-2)]'
              }`}
            >
              {notice.message}
            </p>
          ) : null}
          {/*
            Said plainly rather than in a footnote. This balance was never
            deposited by anybody — it is a real double-entry record of
            imaginary value, which is the whole point of a sandbox and
            exactly the thing that must never be mistaken for custody.
          */}
          <SandboxLine className="mt-3" full />
        </>
      ) : null}
    </Card>
  );
}
