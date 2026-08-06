'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ruleAction } from '@/server/sandbox/actions';
import type { Ruling } from '@/server/sandbox/ops';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/kit/Icon';
import { Sheet } from '@/components/kit/Sheet';
import { useToast } from '@/components/kit/Feedback';
import { Callout, Card, Notice, buttonClass } from '@/components/kit/primitives';

/**
 * The ruling.
 *
 * The ONLY way out of DISPUTED, and deliberately the heaviest control in the
 * product: three named outcomes, a mandatory written reason, and a
 * confirmation that restates what the chosen outcome does. An unexplained
 * ruling on someone's money is not an acceptable artefact, so the server
 * refuses one shorter than a sentence and this screen says so before the
 * operator has typed anything.
 *
 * The reason is shown to BOTH sides afterwards. Operators are told that here
 * rather than discovering it later.
 */

const OUTCOMES: readonly {
  key: Ruling;
  label: string;
  effect: string;
  icon: IconName;
  tone: 'final' | 'hold' | 'idle';
}[] = [
  {
    key: 'RELEASED',
    label: 'Release to the receiver',
    effect:
      'The deal completes. Use this when the evidence shows the money arrived as agreed.',
    icon: 'check-circle',
    tone: 'final',
  },
  {
    key: 'REFUNDED',
    label: 'Refund to the payer',
    effect:
      'The protected value returns to its origin. Use this when the payment failed or was never delivered.',
    icon: 'refresh',
    tone: 'hold',
  },
  {
    key: 'CANCELLED',
    label: 'Cancel the deal',
    effect:
      'The deal closes with no settlement either way. Use this when neither side performed.',
    icon: 'close',
    tone: 'idle',
  },
];

const MIN_REASON = 10;

export function RulingPanel({ dealId, dealCode }: { dealId: string; dealCode: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [ruling, setRuling] = useState<Ruling | null>(null);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const chosen = OUTCOMES.find((o) => o.key === ruling) ?? null;
  const reasonOk = reason.trim().length >= MIN_REASON;

  const submit = () =>
    startTransition(async () => {
      if (!ruling) return;
      setFailure(null);
      const result = await ruleAction(dealId, ruling, reason);
      if (result.ok) {
        setConfirming(false);
        toast.push(`${dealCode} resolved`, 'ok', 'check-circle');
        router.push('/app/ops');
        router.refresh();
        return;
      }
      setConfirming(false);
      setFailure(result.message ?? 'That ruling could not be recorded.');
    });

  return (
    <Card>
      <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
        Rule on this case
      </h2>
      <p className="mt-1 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
        Both sides are notified with your reason attached. No timer resolves this — a ruling is the
        only way the deal moves.
      </p>

      {failure ? (
        <Notice
          className="mt-3"
          tone="risk"
          title={failure}
          reassurance="The deal was not changed."
          nextStep="Check the outcome and the reason, then try again."
        />
      ) : null}

      <div role="radiogroup" aria-label="Outcome" className="mt-4 space-y-2.5">
        {OUTCOMES.map((o) => (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={ruling === o.key}
            onClick={() => setRuling(o.key)}
            data-selected={ruling === o.key}
            className="pick items-start"
          >
            <span className="pick-dot mt-0.5" aria-hidden />
            <span
              aria-hidden
              className={cn(
                'grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)]',
                o.tone === 'final' && 'bg-[var(--color-final-tint)] text-[var(--color-final)]',
                o.tone === 'hold' && 'bg-[var(--color-hold-tint)] text-[var(--color-hold)]',
                o.tone === 'idle' && 'bg-[var(--color-sunken)] text-[var(--color-ink-3)]',
              )}
            >
              <Icon name={o.icon} className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[length:var(--text-sm)] font-semibold text-[var(--color-ink)]">
                {o.label}
              </span>
              <span className="mt-0.5 block text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                {o.effect}
              </span>
            </span>
          </button>
        ))}
      </div>

      <div className="mt-4">
        <label
          htmlFor="ruling-reason"
          className="text-[length:var(--text-xs)] font-semibold text-[var(--color-ink-2)]"
        >
          Reason <span className="font-normal text-[var(--color-ink-4)]">(shown to both sides)</span>
        </label>
        <textarea
          id="ruling-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="The bank statement confirms ₹25,000 credited at 17:41 against reference 428123456789."
          className="field mt-1.5 resize-y text-[length:var(--text-sm)]"
        />
        <p
          className={cn(
            'mt-1 text-[length:var(--text-2xs)]',
            reasonOk ? 'text-[var(--color-final)]' : 'text-[var(--color-ink-4)]',
          )}
        >
          {reasonOk
            ? 'Long enough to be a record.'
            : `At least ${MIN_REASON} characters — this is the permanent explanation.`}
        </p>
      </div>

      <button
        type="button"
        disabled={!ruling || !reasonOk || pending}
        onClick={() => setConfirming(true)}
        className={cn(buttonClass('solid', 'md', true), 'mt-4')}
      >
        <Icon name="flag" className="h-4 w-4" />
        Take action
      </button>

      <Sheet
        open={confirming}
        onClose={() => setConfirming(false)}
        title={chosen?.label ?? 'Rule on this case'}
        description={`${dealCode} · this cannot be undone`}
        footer={
          <div className="space-y-2">
            <button
              type="button"
              disabled={pending}
              onClick={submit}
              className={buttonClass('solid', 'lg', true)}
            >
              {pending ? (
                <>
                  <Icon name="refresh" className="h-4 w-4 animate-spin" />
                  Recording the ruling…
                </>
              ) : (
                'Confirm the ruling'
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
        <p className="text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink-2)]">
          {chosen?.effect}
        </p>
        <div className="mt-3 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-sunken)] p-3">
          <p className="text-[length:var(--text-2xs)] font-semibold uppercase tracking-[0.07em] text-[var(--color-ink-4)]">
            Your reason
          </p>
          <p className="mt-1 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
            {reason.trim()}
          </p>
        </div>
        <Callout tone="hold" icon="alert" className="mt-3">
          Recorded against your operator account in the audit trail, together with the outcome and
          the deal's previous state.
        </Callout>
      </Sheet>
    </Card>
  );
}
