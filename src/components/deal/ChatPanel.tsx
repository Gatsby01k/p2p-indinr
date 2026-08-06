'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { messageAction } from '@/server/sandbox/actions';
import type { DealMessage } from '@/lib/sandboxContract';
import { cn } from '@/lib/cn';
import { Avatar } from '@/components/kit/primitives';
import { Icon } from '@/components/kit/Icon';
import { ClockTime } from '@/components/kit/Time';
import { useToast } from '@/components/kit/Feedback';

/**
 * The protected deal chat.
 *
 * Private to the two seats and to an operator reviewing a raised dispute.
 * There is no group, no third party and no public thread — authorization is
 * a join against `participant`, enforced on the server.
 *
 * SYSTEM lines and CHAT lines are visually distinct and structurally
 * distinct: a system line has no author in the database, so it cannot be
 * forged by typing one. That matters because these lines are evidence in a
 * dispute — "₹25,000 secured", "payment marked sent" — and a message that
 * merely LOOKS official would corrupt the record.
 */
export function ChatPanel({
  dealId,
  messages,
  canMessage,
  counterpartyName,
  className,
}: {
  dealId: string;
  messages: readonly DealMessage[];
  canMessage: boolean;
  counterpartyName: string;
  className?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(messages.length);

  // Scroll to the newest message when one ARRIVES, not on every render —
  // otherwise reading back through the thread yanks the person to the
  // bottom every time the page revalidates.
  useEffect(() => {
    if (messages.length !== lastCount.current) {
      lastCount.current = messages.length;
      endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [messages.length]);

  const send = () => {
    const body = draft.trim();
    if (!body || pending) return;
    startTransition(async () => {
      const result = await messageAction(dealId, body);
      if (result.ok) {
        setDraft('');
        router.refresh();
        return;
      }
      toast.push(result.message ?? 'That message could not be sent.', 'warn');
    });
  };

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div
        className="min-h-[14rem] flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-5"
        role="log"
        aria-label="Deal messages"
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <p className="py-8 text-center text-[length:var(--text-sm)] text-[var(--color-ink-4)]">
            No messages yet. Anything you write here stays between the two of you and is part of the
            record if a problem is reported.
          </p>
        ) : null}

        {messages.map((m) =>
          m.kind === 'SYSTEM' ? (
            <p
              key={m.messageId}
              className="mx-auto w-fit max-w-full rounded-[var(--radius-full)] bg-[var(--color-sunken)] px-3 py-1 text-center text-[length:var(--text-2xs)] text-[var(--color-ink-3)]"
            >
              {m.body} · <ClockTime iso={m.sentAt} />
            </p>
          ) : (
            <div
              key={m.messageId}
              className={cn(
                'flex items-end gap-2',
                m.authorIsViewer ? 'flex-row-reverse' : 'flex-row',
              )}
            >
              <Avatar name={m.authorName ?? '?'} size="xs" />
              <div className={cn('min-w-0', m.authorIsViewer ? 'text-right' : 'text-left')}>
                <div className="bubble inline-block text-left" data-mine={m.authorIsViewer}>
                  {m.body}
                </div>
                <p className="mt-0.5 px-1 text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">
                  {m.authorIsViewer ? 'You' : (m.authorName ?? counterpartyName)}
                  {' · '}
                  <ClockTime iso={m.sentAt} />
                </p>
              </div>
            </div>
          ),
        )}
        <div ref={endRef} />
      </div>

      {canMessage ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="flex items-end gap-2 border-t border-[var(--color-line)] bg-[var(--color-paper)] px-3 py-2.5"
        >
          <label htmlFor="chat-input" className="sr-only">
            Message about this deal
          </label>
          <textarea
            id="chat-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter makes a new line. The convention
              // every messaging app uses, so nobody has to learn it.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            maxLength={2000}
            placeholder="Message about this deal"
            className="field max-h-32 min-h-[2.75rem] flex-1 resize-none py-2.5 text-[length:var(--text-base)]"
          />
          <button
            type="submit"
            disabled={pending || draft.trim().length === 0}
            aria-label="Send message"
            className="press grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--color-brand)] text-white shadow-[var(--shadow-brand)] disabled:pointer-events-none disabled:opacity-40"
          >
            <Icon
              name={pending ? 'refresh' : 'arrow-right'}
              className={cn('h-[18px] w-[18px]', pending && 'animate-spin')}
              strokeWidth={2}
            />
          </button>
        </form>
      ) : (
        <p className="border-t border-[var(--color-line)] px-4 py-3 text-center text-[length:var(--text-xs)] text-[var(--color-ink-4)]">
          This deal is finished, so the thread is closed. It stays readable as part of the record.
        </p>
      )}
    </div>
  );
}
