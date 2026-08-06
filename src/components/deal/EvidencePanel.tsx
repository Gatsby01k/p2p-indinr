'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { uploadEvidenceAction } from '@/server/sandbox/actions';
import { FAILURE_COPY, type DealEvidence } from '@/lib/sandboxContract';
import { cn } from '@/lib/cn';
import { Icon } from '@/components/kit/Icon';
import { Ago } from '@/components/kit/Time';
import { useToast } from '@/components/kit/Feedback';
import { Callout, EmptyState, buttonClass } from '@/components/kit/primitives';

/**
 * Evidence — the proof trail for a deal.
 *
 * A receipt, a screenshot, a signed document. Held as bytes on the server so
 * the trail is genuinely downloadable by the two participants rather than a
 * filename with nothing behind it, and hashed so a file can later be shown
 * to be the same file — which is what makes an evidence trail worth having
 * when a deal is disputed.
 *
 * ⚠ The client checks size and type as a COURTESY, so a person is not made
 * to wait for a 40 MB upload that will be refused. The server re-checks
 * both, and the database has its own constraints. Neither the `accept`
 * attribute nor anything in this file is a control.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPTED = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;
const ACCEPT_ATTR = '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function EvidencePanel({
  dealId,
  evidence,
  canUpload,
  className,
  compact = false,
}: {
  dealId: string;
  evidence: readonly DealEvidence[];
  canUpload: boolean;
  className?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const upload = (file: File) => {
    setProblem(null);

    if (file.size > MAX_BYTES) {
      setProblem(`${FAILURE_COPY.EVIDENCE_TOO_LARGE.reason} ${FAILURE_COPY.EVIDENCE_TOO_LARGE.nextStep}`);
      return;
    }
    if (!ACCEPTED.includes(file.type as (typeof ACCEPTED)[number])) {
      setProblem(
        `${FAILURE_COPY.EVIDENCE_TYPE_REJECTED.reason} ${FAILURE_COPY.EVIDENCE_TYPE_REJECTED.nextStep}`,
      );
      return;
    }

    const form = new FormData();
    form.set('dealId', dealId);
    form.set('file', file);

    startTransition(async () => {
      const result = await uploadEvidenceAction(form);
      if (result.ok) {
        toast.push(`${file.name} attached`, 'ok', 'file');
        if (input.current) input.current.value = '';
        router.refresh();
        return;
      }
      const copy = result.code && result.code !== 'UNKNOWN' ? FAILURE_COPY[result.code] : null;
      setProblem(copy ? `${copy.reason} ${copy.nextStep}` : (result.message ?? 'Upload failed.'));
    });
  };

  return (
    <div className={cn('space-y-3', className)}>
      {evidence.length === 0 && !compact ? (
        <EmptyState
          icon="file"
          title="No evidence attached"
          body="Attach the payment receipt, a screenshot or anything else that shows what happened. Both sides can see it, and it forms part of the record if a problem is reported."
        />
      ) : null}

      {evidence.length > 0 ? (
        <ul className="space-y-2">
          {evidence.map((file) => (
            <li key={file.evidenceId}>
              <a
                href={`/api/evidence/${file.evidenceId}`}
                className="press flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-paper)] p-3 hover:bg-[var(--color-sunken)]"
              >
                <span
                  aria-hidden
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[var(--color-sunken)] text-[var(--color-ink-3)]"
                >
                  <Icon name="file" className="h-[18px] w-[18px]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[length:var(--text-sm)] font-medium text-[var(--color-ink)]">
                    {file.filename}
                  </span>
                  <span className="mt-0.5 block truncate text-[length:var(--text-2xs)] text-[var(--color-ink-3)]">
                    {humanSize(file.byteSize)} ·{' '}
                    <span className="capitalize">
                      {file.uploadedByViewer ? 'You' : file.uploadedByName}
                    </span>{' '}
                    · <Ago iso={file.uploadedAt} />
                  </span>
                </span>
                <Icon
                  name="download"
                  className="h-4 w-4 shrink-0 text-[var(--color-ink-4)]"
                />
              </a>
              {/* The hash is what makes this a trail rather than a folder.
                  Truncated for the eye, complete in the title attribute. */}
              <p
                title={file.sha256}
                className="mt-1 truncate px-3 font-mono text-[10px] text-[var(--color-ink-5)]"
              >
                SHA-256 {file.sha256.slice(0, 16)}…
              </p>
            </li>
          ))}
        </ul>
      ) : null}

      {problem ? (
        <Callout tone="risk" icon="alert" role="alert">
          {problem}
        </Callout>
      ) : null}

      {canUpload ? (
        <div>
          <input
            ref={input}
            type="file"
            accept={ACCEPT_ATTR}
            className="sr-only"
            id={`evidence-${dealId}`}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload(file);
            }}
          />

          {/* A drop target on pointer devices; a plain button on touch,
              where dragging a file is not a thing anyone does. */}
          <label
            htmlFor={`evidence-${dealId}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) upload(file);
            }}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[var(--radius-lg)] border border-dashed px-4 py-5 text-center transition-colors',
              dragging
                ? 'border-[var(--color-brand)] bg-[var(--color-brand-tint)]'
                : 'border-[var(--color-rule)] bg-[var(--color-paper)] hover:bg-[var(--color-sunken)]',
              pending && 'pointer-events-none opacity-60',
            )}
          >
            <Icon
              name={pending ? 'refresh' : 'upload'}
              className={cn('h-5 w-5 text-[var(--color-ink-3)]', pending && 'animate-spin')}
            />
            <span className="text-[length:var(--text-sm)] font-semibold text-[var(--color-ink)]">
              {pending ? 'Uploading…' : 'Attach evidence'}
            </span>
            <span className="text-[length:var(--text-2xs)] text-[var(--color-ink-3)]">
              PDF, PNG, JPG or WebP · up to 5 MB
            </span>
          </label>

          {pending ? (
            <div className="mt-2 track" aria-label="Uploading">
              <span />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The compact attach control, for use inside the pay screen. */
export function AttachButton({ dealId, label = 'Upload payment proof' }: { dealId: string; label?: string }) {
  const router = useRouter();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPT_ATTR}
        className="sr-only"
        id={`attach-${dealId}`}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          if (file.size > MAX_BYTES) {
            toast.push(FAILURE_COPY.EVIDENCE_TOO_LARGE.reason, 'warn');
            return;
          }
          const form = new FormData();
          form.set('dealId', dealId);
          form.set('file', file);
          startTransition(async () => {
            const result = await uploadEvidenceAction(form);
            if (result.ok) {
              toast.push(`${file.name} attached`, 'ok', 'file');
              router.refresh();
            } else {
              toast.push(result.message ?? 'Upload failed.', 'warn');
            }
            if (input.current) input.current.value = '';
          });
        }}
      />
      <label
        htmlFor={`attach-${dealId}`}
        className={cn(buttonClass('outline', 'md', true), 'cursor-pointer', pending && 'opacity-60')}
      >
        <Icon
          name={pending ? 'refresh' : 'upload'}
          className={cn('h-4 w-4', pending && 'animate-spin')}
        />
        {pending ? 'Uploading…' : label}
      </label>
    </>
  );
}
