'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { disputeAction } from '@/server/sandbox/actions';
import {
  DISPUTE_REASON_COPY,
  FAILURE_COPY,
  type DealEvidence,
  type DisputeReason,
} from '@/lib/sandboxContract';
import { Icon } from '@/components/kit/Icon';
import { Sheet } from '@/components/kit/Sheet';
import { EvidencePanel } from '@/components/deal/EvidencePanel';
import { Callout, Card, Notice, buttonClass } from '@/components/kit/primitives';

/**
 * Report a problem.
 *
 * The screen's job is to make the consequence unmistakable BEFORE the
 * person commits: raising this pauses release, and only an operator can
 * move the deal afterwards. That is a real cost to both sides, so the
 * button is not the first thing they can press — a reason has to be chosen
 * and the effect has to be read.
 *
 * It is still deliberately easy to reach from the deal room. A protection
 * product whose complaint path is buried is not a protection product.
 */

const REASONS: readonly DisputeReason[] = [
  'PAYMENT_NOT_RECEIVED',
  'WRONG_AMOUNT',
  'PROOF_MISMATCH',
  'NOT_AS_AGREED',
  'OTHER',
];

const REASON_ICON: Readonly<
  Record<DisputeReason, 'wallet' | 'rupee' | 'file' | 'package' | 'more'>
> = {
  PAYMENT_NOT_RECEIVED: 'wallet',
  WRONG_AMOUNT: 'rupee',
  PROOF_MISMATCH: 'file',
  NOT_AS_AGREED: 'package',
  OTHER: 'more',
};

export function DisputeForm({
  dealId,
  dealCode,
  amountLabel,
  counterpartyName,
  evidence,
  canUpload,
}: {
  dealId: string;
  dealCode: string;
  amountLabel: string;
  counterpartyName: string;
  evidence: readonly DealEvidence[];
  canUpload: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState<DisputeReason | null>(null);
  const [detail, setDetail] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<{ reason: string; nextStep: string } | null>(null);

  const submit = () =>
    startTransition(async () => {
      if (!reason) return;
      setFailure(null);
      const result = await disputeAction(dealId, reason, detail);
      if (result.ok) {
        setConfirming(false);
        router.push(`/app/deal/${dealId}`);
        router.refresh();
        return;
      }
      setConfirming(false);
      const copy =
        result.code && result.code !== 'UNKNOWN'
          ? FAILURE_COPY[result.code as keyof typeof FAILURE_COPY]
          : null;
      setFailure(
        copy ?? {
          reason: result.message ?? 'That did not work.',
          nextStep: 'Refresh the deal and try again.',
        },
      );
    });

  return (
    <>
      {failure ? (
        <Notice
          className="mb-4"
          tone="risk"
          title={failure.reason}
          reassurance="No case was opened and the deal was not changed."
          nextStep={failure.nextStep}
        />
      ) : null}

      <Callout tone="info" icon="shield" className="mb-4">
        <strong className="font-semibold text-[var(--color-ink)]">This deal is protected.</strong>{' '}
        Reporting a problem pauses release while it is reviewed. Nothing is reversed, refunded or
        completed automatically.
      </Callout>

      {/* ---- Why ------------------------------------------------- */}
      <Card>
        <h2 className="text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
          Choose the reason
        </h2>
        <p className="mt-1 text-[length:var(--text-sm)] text-[var(--color-ink-3)]">
          Pick the closest one. An operator reads the detail and the evidence too.
        </p>

        <div role="radiogroup" aria-label="Reason" className="mt-4 space-y-2.5">
          {REASONS.map((key) => {
            const copy = DISPUTE_REASON_COPY[key];
            const selected = reason === key;
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setReason(key)}
                data-selected={selected}
                className="pick items-start"
              >
                <span className="pick-dot mt-0.5" aria-hidden />
                <span
                  aria-hidden
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[var(--color-sunken)] text-[var(--color-ink-3)]"
                >
                  <Icon name={REASON_ICON[key]} className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                    {copy.label}
                  </span>
                  <span className="mt-0.5 block text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                    {copy.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      {/* ---- What happened --------------------------------------- */}
      <Card className="mt-4">
        <label
          htmlFor="detail"
          className="text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]"
        >
          What happened?
        </label>
        <p className="mt-1 text-[length:var(--text-sm)] text-[var(--color-ink-3)]">
          Both {counterpartyName} and the reviewing operator can read this. Facts and figures help
          more than adjectives.
        </p>
        <textarea
          id="detail"
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          rows={4}
          maxLength={2000}
          placeholder="I sent ₹25,000 at 5:37 PM with reference 428123456789 but nothing has arrived."
          className="field mt-3 resize-y"
        />
        <p className="tnum mt-1.5 text-right text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">
          {detail.length} / 2000
        </p>
      </Card>

      {/* ---- Evidence -------------------------------------------- */}
      <Card className="mt-4">
        <h2 className="text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
          Evidence
        </h2>
        <p className="mt-1 text-[length:var(--text-sm)] text-[var(--color-ink-3)]">
          Anything already attached to this deal is part of the case automatically.
        </p>
        <div className="mt-3">
          <EvidencePanel dealId={dealId} evidence={evidence} canUpload={canUpload} compact />
        </div>
      </Card>

      <div className="mt-4 space-y-2">
        <button
          type="button"
          disabled={!reason || pending}
          onClick={() => setConfirming(true)}
          data-testid="dispute-open"
          className={buttonClass('danger', 'lg', true)}
        >
          <Icon name="flag" className="h-4 w-4" />
          Submit dispute
        </button>
        <a href={`/app/deal/${dealId}`} className={buttonClass('quiet', 'md', true)}>
          Back to the deal
        </a>
      </div>

      <Sheet
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Open a case on this deal?"
        description={`${dealCode} · ${amountLabel}`}
        footer={
          <div className="space-y-2">
            <button
              type="button"
              disabled={pending}
              onClick={submit}
              data-testid="dispute-submit"
              className={buttonClass('danger', 'lg', true)}
            >
              {pending ? (
                <>
                  <Icon name="refresh" className="h-4 w-4 animate-spin" />
                  Opening the case…
                </>
              ) : (
                'Open the case'
              )}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className={buttonClass('quiet', 'md', true)}
            >
              Go back
            </button>
          </div>
        }
      >
        <ul className="space-y-2.5">
          {[
            'Release is paused straight away. Neither side can complete or cancel the deal.',
            `${counterpartyName} is told immediately and can add their own evidence.`,
            'An operator reviews the messages, the payment reference and every attached file.',
            'The case ends with a person’s decision — released, refunded or cancelled — never a timer.',
          ].map((line) => (
            <li key={line} className="flex gap-2.5">
              <Icon
                name="chevron-right"
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-risk)]"
                strokeWidth={2.4}
              />
              <span className="text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
                {line}
              </span>
            </li>
          ))}
        </ul>
        <Callout tone="hold" icon="alert" className="mt-3">
          If this is a misunderstanding, a message in the deal chat is usually faster and costs
          neither side anything.
        </Callout>
      </Sheet>
    </>
  );
}
