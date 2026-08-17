'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { decideVerificationAction } from '@/services/actions';
import { Icon } from '@/components/kit/Icon';
import { useToast } from '@/components/kit/Feedback';
import { Callout, buttonClass } from '@/components/kit/primitives';

/**
 * Approve or reject ONE verification case.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A DECISION ABOUT SOMEBODY ELSE ALWAYS CARRIES A REASON.           │
 * │                                                                    │
 * │  Approving a case is what lets an account join deals and receive   │
 * │  money, and rejecting one shuts them out. Both are consequential   │
 * │  enough that an unexplained one is not an acceptable record, so    │
 * │  the reason is mandatory here and — more importantly — mandatory   │
 * │  in the server boundary, which refuses anything under eight        │
 * │  characters whatever this screen does.                             │
 * │                                                                    │
 * │  A reviewer's OWN case is shown but has no controls: separation is │
 * │  enforced by a database CHECK constraint, and offering a button    │
 * │  the database will refuse is a lie about what is possible.         │
 * └────────────────────────────────────────────────────────────────────┘
 */
const MIN_REASON = 8;

export function VerificationReview({
  caseId,
  subjectName,
  kind,
  isOwnCase,
}: {
  caseId: string;
  subjectName: string;
  kind: string;
  isOwnCase: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /*
   * The page states the rule once, above the queue. Here the card only
   * needs to be marked as one of the affected ones — repeating the whole
   * sentence per card is what made a queue of three read like a scolding.
   */
  if (isOwnCase) {
    return (
      <p className="mt-3 flex items-center gap-1.5 text-[length:var(--text-xs)] font-medium text-[var(--color-hold)]">
        <Icon name="alert" className="h-3.5 w-3.5 shrink-0" />
        Your own case — another reviewer decides this one
      </p>
    );
  }

  const decide = (decision: 'APPROVED' | 'REJECTED') => {
    setError(null);
    startTransition(async () => {
      const result = await decideVerificationAction(caseId, decision, note.trim());
      if (!result.ok) {
        setError(result.message ?? 'That decision was not recorded.');
        return;
      }
      /*
       * The definitive result settles into the toast first; the refresh
       * that removes the row from the queue comes afterwards, so a
       * failed re-render can never hide a decision that committed.
       */
      toast.push(
        `${kind} ${decision === 'APPROVED' ? 'approved' : 'rejected'} for ${subjectName}`,
        decision === 'APPROVED' ? 'ok' : 'warn',
      );
      setNote('');
      router.refresh();
    });
  };

  const ready = note.trim().length >= MIN_REASON;

  return (
    <div className="mt-3">
      <label
        htmlFor={`note-${caseId}`}
        className="text-[length:var(--text-xs)] font-semibold text-[var(--color-ink-2)]"
      >
        Reason for the decision
      </label>
      <textarea
        id={`note-${caseId}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="What you checked, and what it showed."
        aria-describedby={`note-${caseId}-hint`}
        className="field mt-1.5 w-full text-[length:var(--text-sm)]"
      />
      <p
        id={`note-${caseId}-hint`}
        className="mt-1 text-[length:var(--text-xs)] text-[var(--color-ink-3)]"
      >
        Recorded against the case for good, and readable by the person it is about. At least{' '}
        {MIN_REASON} characters.
      </p>

      {error ? (
        <Callout tone="risk" icon="alert" className="mt-3">
          <span role="alert">{error}</span>
        </Callout>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending || !ready}
          onClick={() => decide('APPROVED')}
          data-testid="verification-approve"
          className={buttonClass('primary', 'md')}
        >
          <Icon name="check-circle" className="h-4 w-4" />
          {pending ? 'Recording…' : 'Approve'}
        </button>
        <button
          type="button"
          disabled={pending || !ready}
          onClick={() => decide('REJECTED')}
          data-testid="verification-reject"
          className={buttonClass('outline', 'md')}
        >
          <Icon name="close" className="h-4 w-4" />
          Reject
        </button>
      </div>
    </div>
  );
}
