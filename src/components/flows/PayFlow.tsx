'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { claimAction } from '@/services/actions';
import { useCommandId } from '@/lib/commandId';
import { FAILURE_COPY, type DealEvidence } from '@/lib/sandboxContract';
import { UTR_LENGTH, isValidUtr, normaliseUtr } from '@/lib/parse';
import { cn } from '@/lib/cn';
import { Icon } from '@/components/kit/Icon';
import { Sheet } from '@/components/kit/Sheet';
import { AttachButton, EvidencePanel } from '@/components/deal/EvidencePanel';
import { TelegramClosingGuard, TelegramMainButton } from '@/components/telegram/TelegramButtons';
import { haptic } from '@/lib/telegramSdk';
import {
  Callout,
  Card,
  Label,
  Notice,
  SandboxLine,
  buttonClass,
} from '@/components/kit/primitives';

/**
 * Marking a payment sent.
 *
 * This is the most consequential thing a person does in the product that is
 * not the final release, and the copy treats it that way: they are making an
 * ASSERTION that a transfer happened outside this system. The screen never
 * says "pay now" as though the button moved money.
 *
 * The UTR is checked here for shape only, as a courtesy so nobody submits
 * eleven characters and waits. The server normalises and re-validates it,
 * and `UNIQUE(utr)` platform-wide is what actually stops a reference being
 * reused across deals.
 */
export function PayFlow({
  dealId,
  amountLabel,
  counterpartyName,
  evidence,
}: {
  dealId: string;
  amountLabel: string;
  counterpartyName: string;
  evidence: readonly DealEvidence[];
}) {
  const router = useRouter();
  const command = useCommandId();
  const [pending, startTransition] = useTransition();
  const [utr, setUtr] = useState('');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<{ reason: string; nextStep: string } | null>(null);

  const clean = normaliseUtr(utr);
  const valid = isValidUtr(clean);
  const remaining = UTR_LENGTH - clean.length;

  const submit = () =>
    startTransition(async () => {
      setFailure(null);
      const result = await claimAction(command.next(), dealId, clean, note);
      command.settleIfDefinitive(result);
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
          nextStep: 'Check the reference and try again.',
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
          reassurance="Nothing was marked and the deal was not changed."
          nextStep={failure.nextStep}
        />
      ) : null}

      {/* ---- The reference --------------------------------------- */}
      <Card>
        <h2 className="text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
          Enter the bank reference
        </h2>
        <p className="mt-1 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-3)]">
          The 12-character UTR from your transfer confirmation. It is checked against every other
          deal, so one transfer can only ever be claimed once.
        </p>

        <div className="mt-4">
          <label
            htmlFor="utr"
            className="text-[length:var(--text-xs)] font-semibold text-[var(--color-ink-2)]"
          >
            UTR / reference number
          </label>
          <input
            id="utr"
            value={utr}
            onChange={(e) => setUtr(e.target.value.toUpperCase())}
            onBlur={() => setTouched(true)}
            maxLength={20}
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="428123456789"
            aria-describedby="utr-help"
            aria-invalid={touched && clean.length > 0 && !valid ? true : undefined}
            className="field tnum mt-1.5 font-mono text-[length:var(--text-lg)] tracking-[0.14em] placeholder:tracking-[0.08em]"
          />
          <p
            id="utr-help"
            aria-live="polite"
            className={cn(
              'mt-1.5 flex items-center gap-1.5 text-[length:var(--text-xs)]',
              valid ? 'text-[var(--color-final)]' : 'text-[var(--color-ink-3)]',
            )}
          >
            {valid ? (
              <>
                <Icon name="check-circle" className="h-3.5 w-3.5" strokeWidth={2} />
                That looks like a valid reference.
              </>
            ) : clean.length === 0 ? (
              '12 letters and digits, exactly as your bank shows it.'
            ) : remaining > 0 ? (
              `${remaining} more character${remaining === 1 ? '' : 's'} needed.`
            ) : (
              'A UTR is 12 letters and digits — no spaces or dashes.'
            )}
          </p>
        </div>

        <div className="mt-4">
          <label
            htmlFor="pay-note"
            className="text-[length:var(--text-xs)] font-semibold text-[var(--color-ink-2)]"
          >
            Note <span className="font-normal text-[var(--color-ink-4)]">(optional)</span>
          </label>
          <input
            id="pay-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="Anything the other side should know"
            className="field mt-1.5"
          />
        </div>
      </Card>

      {/* ---- The proof ------------------------------------------- */}
      <Card className="mt-4">
        <h2 className="text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
          Add payment proof
        </h2>
        <p className="mt-1 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-3)]">
          A screenshot or PDF of the transfer. Optional, but it is what resolves a dispute quickly
          if one is ever raised.
        </p>

        {evidence.length > 0 ? (
          <div className="mt-3">
            <EvidencePanel dealId={dealId} evidence={evidence} canUpload={false} compact />
          </div>
        ) : null}

        <div className="mt-3">
          <AttachButton dealId={dealId} />
        </div>
      </Card>

      {/* ---- The assertion --------------------------------------- */}
      <div className="mt-4">
        {/*
          Inside Telegram this action is mirrored into the client's own
          MainButton, which sits above the keyboard where a Telegram user
          already reaches. The in-page button stays in the DOM — it is what
          screen readers and the no-JavaScript path use — and only stops
          taking up space, so the two can never disagree about being
          disabled.
        */}
        <TelegramMainButton
          text={`I have paid ${amountLabel}`}
          disabled={!valid}
          loading={pending}
          onClick={() => {
            haptic('medium');
            setConfirming(true);
          }}
        />
        {/* A half-typed bank reference is real work; losing it to a stray
            swipe is the kind of thing people do not come back from. */}
        <TelegramClosingGuard active={utr.trim().length > 0} />

        <button
          type="button"
          disabled={!valid || pending}
          data-testid="claim-open"
          data-mirrored-cta
          onClick={() => setConfirming(true)}
          className={buttonClass('primary', 'lg', true)}
        >
          <Icon name="check" className="h-4 w-4" strokeWidth={2.4} />I have paid {amountLabel}
        </button>
        <p className="mt-2.5 text-center text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
          This tells {counterpartyName} to check their account. It does not move any money by
          itself.
        </p>
      </div>

      <Sheet
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Mark ${amountLabel} as sent?`}
        description={`${counterpartyName} will be asked to check their account and confirm.`}
        footer={
          <div className="space-y-2">
            <button
              type="button"
              disabled={pending}
              data-testid="claim-submit"
              onClick={submit}
              className={buttonClass('primary', 'lg', true)}
            >
              {pending ? (
                <>
                  <Icon name="refresh" className="h-4 w-4 animate-spin" />
                  Submitting…
                </>
              ) : (
                'Yes, I have sent it'
              )}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className={buttonClass('quiet', 'md', true)}
            >
              Not yet
            </button>
          </div>
        }
      >
        <div className="rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-sunken)] p-3.5">
          <Label>You are declaring you sent</Label>
          <p className="tnum mt-1 text-[length:var(--text-2xl)] font-semibold text-[var(--color-ink)]">
            {amountLabel}
          </p>
          <p className="mt-2 text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
            Reference <strong className="font-mono text-[var(--color-ink)]">{clean}</strong>
            {note.trim() ? <> · “{note.trim()}”</> : null}
          </p>
        </div>

        <Callout tone="hold" icon="alert" className="mt-3">
          Only do this once the transfer has actually left your account. Marking a payment that was
          not sent is what disputes are made of.
        </Callout>
        <SandboxLine className="mt-2.5" full />
      </Sheet>
    </>
  );
}
