'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { requestSignInCodeAction, verifySignInCodeAction } from '@/services/actions';
import { FAILURE_COPY, type SandboxError } from '@/lib/sandboxContract';
import { Icon } from '@/components/kit/Icon';
import { Callout, Label, Notice, buttonClass } from '@/components/kit/primitives';

/**
 * Email sign-in, in two steps.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE SAME SCREEN, ONE MORE STEP — AND A HONEST ONE.                │
 * │                                                                    │
 * │  The approved design is preserved: one card, one field, one        │
 * │  primary action. What changes is that pressing Continue no longer  │
 * │  signs anybody in. It sends a code, and the card asks for it.      │
 * │                                                                    │
 * │  The copy states exactly what the code proves — that you receive   │
 * │  that mailbox — rather than implying an identity check nobody      │
 * │  performed.                                                        │
 * │                                                                    │
 * │  The "code sent" state is shown whether or not the address is      │
 * │  known, because the server answers identically either way. A       │
 * │  screen that said "no such account" would be an enumeration        │
 * │  oracle sitting in front of the user table.                        │
 * └────────────────────────────────────────────────────────────────────┘
 */
export function SignInFlow({ next, invite }: { next: string; invite: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [step, setStep] = useState<'address' | 'code'>('address');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<{ reason: string; nextStep: string } | null>(null);

  const copyFor = (result: { code?: string; message?: string }) =>
    result.code && result.code !== 'UNKNOWN'
      ? (FAILURE_COPY[result.code as SandboxError] ?? null)
      : null;

  const request = () =>
    startTransition(async () => {
      setFailure(null);
      const form = new FormData();
      form.set('email', email);
      const result = await requestSignInCodeAction(form);
      if (result.ok) {
        setStep('code');
        return;
      }
      setFailure(
        copyFor(result) ?? {
          reason: result.message ?? 'That did not work.',
          nextStep: 'Check the address and try again.',
        },
      );
    });

  const verify = () =>
    startTransition(async () => {
      setFailure(null);
      const result = await verifySignInCodeAction({ email, code, next, invite });
      if (result.ok) {
        router.push(next);
        router.refresh();
        return;
      }
      setFailure(
        copyFor(result) ?? {
          reason: result.message ?? 'That code did not work.',
          nextStep: 'Request a fresh code.',
        },
      );
    });

  return (
    <>
      {failure ? (
        <Notice
          className="mt-4"
          tone="risk"
          title={failure.reason}
          reassurance="You are not signed in and nothing was changed."
          nextStep={failure.nextStep}
        />
      ) : null}

      {step === 'address' ? (
        <form
          className="mt-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            request();
          }}
        >
          <div>
            <label
              htmlFor="email"
              className="text-[length:var(--text-xs)] font-semibold text-[var(--color-ink-2)]"
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.in"
              className="field mt-1.5 text-[length:var(--text-base)]"
            />
          </div>
          <button
            type="submit"
            disabled={pending || email.trim().length === 0}
            className={buttonClass('primary', 'lg', true)}
          >
            <Icon name="arrow-right" className="h-4 w-4" />
            {pending ? 'Sending…' : 'Email me a code'}
          </button>
        </form>
      ) : (
        <form
          className="mt-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            verify();
          }}
        >
          <Callout tone="hold" icon="shield" className="mb-1">
            If <strong className="font-semibold">{email}</strong> is registered, a sign-in code is
            on its way. It works once and expires in fifteen minutes.
          </Callout>
          <div>
            <label
              htmlFor="code"
              className="text-[length:var(--text-xs)] font-semibold text-[var(--color-ink-2)]"
            >
              Sign-in code
            </label>
            <input
              id="code"
              name="code"
              inputMode="text"
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="12345678"
              className="field mt-1.5 font-mono text-[length:var(--text-base)]"
            />
          </div>
          <button
            type="submit"
            disabled={pending || code.trim().length === 0}
            className={buttonClass('primary', 'lg', true)}
          >
            <Icon name="arrow-right" className="h-4 w-4" />
            {pending ? 'Checking…' : 'Sign in'}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep('address');
              setCode('');
              setFailure(null);
            }}
            className={buttonClass('quiet', 'md', true)}
          >
            Use a different address
          </button>
        </form>
      )}

      <div className="mt-5 border-t border-[var(--color-line)] pt-4">
        <Label>How this works</Label>
        <p className="mt-2 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
          A one-time code is sent to your address. It proves you receive that mailbox — nothing
          more, and the interface never claims otherwise. There is no password to choose, forget or
          have stolen.
        </p>
      </div>
    </>
  );
}
