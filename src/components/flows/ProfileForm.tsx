'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult } from '@/server/sandbox/actions';
import { Icon } from '@/components/kit/Icon';
import { useToast } from '@/components/kit/Feedback';
import { buttonClass } from '@/components/kit/primitives';

/**
 * The editable part of a profile.
 *
 * A plain form posting to a server action, so it works with JavaScript
 * disabled and gains only its pending state and its toast from the client.
 * The `notify` hidden field is what tells the action that the two checkboxes
 * were submitted at all — an unchecked box sends nothing, so without it the
 * server cannot distinguish "turned off" from "not part of this form".
 */
export function ProfileForm({
  action,
  about,
  city,
  notifyEmail,
  notifyPush,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  about: string;
  city: string;
  notifyEmail: boolean;
  notifyPush: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [dirty, setDirty] = useState(false);

  return (
    <form
      onChange={() => setDirty(true)}
      action={(formData) =>
        startTransition(async () => {
          const result = await action(formData);
          toast.push(
            result.ok ? 'Settings saved' : (result.message ?? 'That did not save.'),
            result.ok ? 'ok' : 'warn',
          );
          if (result.ok) setDirty(false);
          router.refresh();
        })
      }
      className="space-y-4"
    >
      <input type="hidden" name="notify" value="1" />

      <div>
        <label
          htmlFor="city"
          className="text-[length:var(--text-xs)] font-semibold text-[var(--color-ink-2)]"
        >
          City
        </label>
        <input
          id="city"
          name="city"
          defaultValue={city}
          maxLength={80}
          placeholder="Mumbai, India"
          className="field mt-1.5"
        />
      </div>

      <div>
        <label
          htmlFor="about"
          className="text-[length:var(--text-xs)] font-semibold text-[var(--color-ink-2)]"
        >
          About{' '}
          <span className="font-normal text-[var(--color-ink-4)]">
            (shown on your trust profile)
          </span>
        </label>
        <textarea
          id="about"
          name="about"
          defaultValue={about}
          rows={3}
          maxLength={400}
          placeholder="Freelance UI/UX designer. Mostly INR → INR milestones."
          className="field mt-1.5 resize-y"
        />
      </div>

      <fieldset className="space-y-2.5">
        <legend className="text-[length:var(--text-xs)] font-semibold text-[var(--color-ink-2)]">
          Tell me when
        </legend>
        <Check
          name="notifyEmail"
          defaultChecked={notifyEmail}
          label="Email"
          hint="A deal needs you, or something changes on one of yours."
        />
        <Check
          name="notifyPush"
          defaultChecked={notifyPush}
          label="In-app"
          hint="The bell in the header, and the notifications screen."
        />
      </fieldset>

      <button type="submit" disabled={pending || !dirty} className={buttonClass('primary', 'md')}>
        {pending ? (
          <>
            <Icon name="refresh" className="h-4 w-4 animate-spin" />
            Saving…
          </>
        ) : (
          'Save changes'
        )}
      </button>
    </form>
  );
}

function Check({
  name,
  defaultChecked,
  label,
  hint,
}: {
  name: string;
  defaultChecked: boolean;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-line)] p-3">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-brand)]"
      />
      <span className="min-w-0">
        <span className="block text-[length:var(--text-sm)] font-medium text-[var(--color-ink)]">
          {label}
        </span>
        <span className="mt-0.5 block text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
          {hint}
        </span>
      </span>
    </label>
  );
}
