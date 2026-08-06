'use client';

import { useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult } from '@/server/sandbox/actions';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/kit/Icon';
import { useToast } from '@/components/kit/Feedback';
import { buttonClass, type ButtonSize, type ButtonVariant } from '@/components/kit/primitives';

/**
 * A button that runs one server action.
 *
 * Exists so the dozens of small mutations in this product — verify a step,
 * make a method default, toggle two-factor, mark notifications read — all
 * behave identically: disabled while in flight, a spinner in place of the
 * icon, a toast on success, a toast carrying the SERVER'S message on
 * failure, and a refresh either way so the screen shows what actually
 * happened rather than what was hoped for.
 *
 * The failure toast never invents copy. If the server said why, that is what
 * the person reads.
 */
export function ActionButton({
  action,
  children,
  success,
  icon,
  variant = 'outline',
  size = 'sm',
  full = false,
  className,
  confirm,
}: {
  action: () => Promise<ActionResult>;
  children: ReactNode;
  success: string;
  icon?: IconName;
  variant?: ButtonVariant;
  size?: ButtonSize;
  full?: boolean;
  className?: string;
  /** When set, the browser asks first. For anything that removes data. */
  confirm?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (confirm && !window.confirm(confirm)) return;
        startTransition(async () => {
          const result = await action();
          if (result.ok) {
            toast.push(success, 'ok');
          } else {
            toast.push(result.message ?? 'That did not work.', 'warn');
          }
          router.refresh();
        });
      }}
      className={cn(buttonClass(variant, size, full), className)}
    >
      {pending ? (
        <Icon name="refresh" className="h-4 w-4 animate-spin" />
      ) : icon ? (
        <Icon name={icon} className="h-4 w-4" />
      ) : null}
      {children}
    </button>
  );
}

/**
 * A settings switch backed by a server action.
 *
 * Optimism is deliberately absent: the switch moves when the server says it
 * moved. A preference that appears to save and silently did not is worse
 * than one that takes 200ms.
 */
export function ActionSwitch({
  checked,
  action,
  label,
  description,
  success,
}: {
  checked: boolean;
  action: (next: boolean) => Promise<ActionResult>;
  label: string;
  description?: string;
  success: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
      <div className="min-w-0 flex-1">
        <p className="text-[length:var(--text-base)] font-medium text-[var(--color-ink)]">
          {label}
        </p>
        {description ? (
          <p className="mt-0.5 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
            {description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await action(!checked);
            toast.push(
              result.ok ? success : (result.message ?? 'That did not work.'),
              result.ok ? 'ok' : 'warn',
            );
            router.refresh();
          })
        }
        className={cn('switch shrink-0', pending && 'opacity-60')}
      />
    </div>
  );
}
