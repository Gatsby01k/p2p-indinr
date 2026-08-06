'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from './Icon';

/**
 * Transient feedback: toasts and the copy affordance.
 *
 * The rule these enforce: a consequential action must confirm itself
 * IMMEDIATELY and IN PLACE. A person who taps "Copy link" and sees nothing
 * taps it again; a person who submits a dispute and is silently navigated
 * away does not know whether it worked.
 *
 * Toasts here are for CONFIRMATION only. A failure that a person must act on
 * gets a `Notice` in the layout, where it cannot scroll away or auto-dismiss
 * before it has been read.
 */

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: 'ok' | 'info' | 'warn';
  readonly icon?: IconName;
}

interface ToastApi {
  push: (message: string, tone?: Toast['tone'], icon?: IconName) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TOAST_MS = 3200;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback<ToastApi['push']>((message, tone = 'ok', icon) => {
    seq.current += 1;
    const id = seq.current;
    setToasts((current) => [...current, { id, message, tone, icon }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== id));
    }, TOAST_MS);
  }, []);

  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/*
        `aria-live="polite"` rather than assertive: a confirmation should be
        announced when the screen reader reaches a natural pause, not cut
        across whatever the person is currently reading.
      */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[70] flex flex-col items-center gap-2 px-4 pb-[calc(var(--h-tabbar)+1rem)] lg:pb-6"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              'animate-toast pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-2.5 rounded-[var(--radius-full)] px-4 py-2.5 shadow-[var(--shadow-lift)]',
              'text-[length:var(--text-sm)] font-medium',
              t.tone === 'ok' && 'bg-[var(--color-ink)] text-[var(--color-paper)]',
              t.tone === 'info' && 'bg-[var(--color-ink)] text-[var(--color-paper)]',
              t.tone === 'warn' && 'bg-[var(--color-risk)] text-white',
            )}
          >
            <Icon
              name={t.icon ?? (t.tone === 'warn' ? 'alert' : 'check-circle')}
              className="h-4 w-4 shrink-0"
              strokeWidth={2}
            />
            <span className="truncate">{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Toasts are optional context.
 *
 * A component that can appear outside the provider (the public deal link,
 * for instance) still needs its copy button to work, so the fallback is a
 * no-op rather than a thrown error. The local, in-button confirmation is
 * what actually carries the feedback; the toast is a second channel.
 */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? { push: () => {} };
}

/* ------------------------------------------------------------------ *
 * Copy
 * ------------------------------------------------------------------ */

/**
 * Copy to clipboard, with the confirmation on the button itself.
 *
 * `navigator.clipboard` requires a secure context and can be refused by
 * permission policy, so the failure path is real and is handled: the value
 * is selected instead, and the label says to copy it manually. Silently
 * doing nothing would be the worst outcome — the person believes they have
 * the link and pastes an empty message.
 */
export function useCopy(): {
  copied: boolean;
  copy: (value: string, announce?: string) => Promise<boolean>;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  const toast = useToast();

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  const copy = useCallback(
    async (value: string, announce = 'Copied') => {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        toast.push(announce, 'ok', 'copy');
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 2000);
        return true;
      } catch {
        toast.push('Could not copy — select the text and copy it manually.', 'warn');
        return false;
      }
    },
    [toast],
  );

  return { copied, copy };
}

export function CopyButton({
  value,
  label = 'Copy',
  announce,
  variant = 'icon',
  className,
}: {
  value: string;
  label?: string;
  announce?: string;
  variant?: 'icon' | 'button';
  className?: string;
}) {
  const { copied, copy } = useCopy();

  if (variant === 'icon') {
    return (
      <button
        type="button"
        onClick={() => void copy(value, announce)}
        aria-label={copied ? 'Copied' : label}
        className={cn(
          'press grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-sm)] text-[var(--color-ink-3)] hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]',
          copied && 'text-[var(--color-final)]',
          className,
        )}
      >
        <Icon
          key={copied ? 'done' : 'idle'}
          name={copied ? 'check' : 'copy'}
          className={cn('h-4 w-4', copied && 'animate-pop')}
          strokeWidth={copied ? 2.6 : 1.7}
        />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void copy(value, announce)}
      className={cn(
        'press tap inline-flex items-center justify-center gap-2 rounded-[var(--radius-md)] border px-4 text-[length:var(--text-base)] font-semibold transition-colors',
        copied
          ? 'border-[var(--color-final-line)] bg-[var(--color-final-tint)] text-[var(--color-final)]'
          : 'border-[var(--color-rule)] bg-[var(--color-paper)] text-[var(--color-ink)] hover:bg-[var(--color-sunken)]',
        className,
      )}
    >
      <Icon
        key={copied ? 'done' : 'idle'}
        name={copied ? 'check' : 'copy'}
        className={cn('h-4 w-4', copied && 'animate-pop')}
        strokeWidth={copied ? 2.6 : 1.7}
      />
      {copied ? 'Copied' : label}
    </button>
  );
}

/**
 * A read-only value with a copy control — deal codes, links, UPI handles,
 * referral codes. Monospace, because these are transcribed.
 */
export function CopyField({
  value,
  label,
  announce,
  className,
  mono = true,
}: {
  value: string;
  label?: string;
  announce?: string;
  className?: string;
  mono?: boolean;
}) {
  return (
    <div className={className}>
      {label ? (
        <span className="text-[length:var(--text-2xs)] font-semibold uppercase tracking-[0.07em] text-[var(--color-ink-4)]">
          {label}
        </span>
      ) : null}
      <div
        className={cn(
          'flex items-center gap-1 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-sunken)] py-1 pl-3 pr-1',
          label && 'mt-1.5',
        )}
      >
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[length:var(--text-sm)] text-[var(--color-ink-2)]',
            mono && 'font-mono',
          )}
        >
          {value}
        </span>
        <CopyButton value={value} announce={announce} />
      </div>
    </div>
  );
}
