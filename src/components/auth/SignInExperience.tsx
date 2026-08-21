'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { requestSignInCodeAction, verifySignInCodeAction } from '@/services/actions';
import { FAILURE_COPY, type SandboxError } from '@/lib/sandboxContract';
import { Icon } from '@/components/kit/Icon';
import { AccessRail, type AccessStage, type RailTravel } from './AccessRail';
import { CODE_LENGTH, CodeField } from './CodeField';

/**
 * Sign in: identity submitted → proof confirmed → access released.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE RAIL FOLLOWS THE SERVER. IT NEVER LEADS IT.                   │
 * │                                                                    │
 * │  Every advance in this component is downstream of a confirmed      │
 * │  response:                                                         │
 * │                                                                    │
 * │    step 01 → 02   only when `requestSignInCodeAction` returned ok, │
 * │                   which means a challenge row was written and the  │
 * │                   delivery adapter accepted the mail               │
 * │    step 02 → 03   only when `verifySignInCodeAction` returned ok,  │
 * │                   which means the challenge was consumed by the    │
 * │                   database and the session cookie is already set   │
 * │                                                                    │
 * │  Pressing a button advances nothing. A failure advances nothing    │
 * │  and leaves the last confirmed step where it was. Nothing          │
 * │  navigates before the session exists — the redirect below runs     │
 * │  after `ok`, and `ok` is returned after `setSessionCookie`.        │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ⚠ NOTHING ABOUT THE BACKEND CHANGES HERE. Both actions are the existing
 * ones, called with the existing arguments. The code is eight digits
 * because `mintNumericCode` mints eight; the fifteen-minute life and the
 * rate limits are the server's and are quoted, never re-implemented; the
 * refusals are the server's own sentences, which are deliberately
 * identical for a wrong, expired, spent or unknown code so that this
 * screen cannot become an account-enumeration oracle.
 */

/* ------------------------------------------------------------------ *
 * Motion, stated once
 * ------------------------------------------------------------------ */

/**
 * The rail's two beats, in milliseconds.
 *
 * The CSS owns the drawing; these exist so the JavaScript that clears a
 * one-shot animation and the CSS that runs it cannot drift apart. Change
 * them together with `--auth-*` in `globals.css`.
 */
const SIGNAL_TOTAL_MS = 900; // 100ms lead-in + 780ms travel, rounded up
const CONFIRM_HOLD_MS = 550; // "Access confirmed", before the destination
const REDUCED_HOLD_MS = 700; // the whole beat, when motion is not wanted

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

type Field = 'email' | 'code';

interface Refusal {
  readonly field: Field;
  readonly reason: string;
  readonly nextStep: string;
}

/**
 * Copy for the failures the server does not name.
 *
 * A raw server string is never printed: `fail()` in `services/actions.ts`
 * already collapses anything unrecognised to `UNKNOWN` with a fixed
 * sentence, and a fetch that never arrived has no server string at all.
 */
const LOCAL_COPY = {
  NETWORK: {
    reason: 'We could not reach INRP2P.',
    nextStep: 'Check your connection and try again — nothing was sent.',
  },
  REQUEST_FAILED: {
    reason: 'The code could not be sent.',
    nextStep: 'Try again in a moment. You are not signed in and nothing was changed.',
  },
  VERIFY_FAILED: {
    reason: 'We could not finish signing you in.',
    nextStep: 'Try the code again. No session was opened.',
  },
} as const;

function refusalFor(
  field: Field,
  result: { code?: string; message?: string } | undefined,
  fallback: { reason: string; nextStep: string },
): Refusal {
  const named =
    result?.code && result.code !== 'UNKNOWN'
      ? (FAILURE_COPY[result.code as SandboxError] ?? null)
      : null;
  return { field, ...(named ?? fallback) };
}

/* ------------------------------------------------------------------ *
 * The address, after it has been submitted
 * ------------------------------------------------------------------ */

/**
 * `priya@example.in` → `p•••••@example.in`.
 *
 * Enough for the person to recognise their own address and catch a typed
 * domain; not enough for a shoulder or a screenshot to carry the whole
 * thing. The mask is a FIXED five dots rather than one per hidden
 * character, because a mask whose length tracks the real length quietly
 * publishes the real length.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  return `${email.slice(0, 1)}•••••${email.slice(at)}`;
}

/** The server's own test, mirrored so the button can know before asking. */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* ------------------------------------------------------------------ *
 * The screen
 * ------------------------------------------------------------------ */

export function SignInExperience({ next, invite }: { next: string; invite: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [stage, setStage] = useState<AccessStage>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [status, setStatus] = useState('');
  const [travel, setTravel] = useState<RailTravel | null>(null);

  const emailRef = useRef<HTMLInputElement | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);
  const travelSeq = useRef(0);
  /** Guards the one-shot hand-off timers against a unmount mid-flight. */
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );

  const after = useCallback((ms: number, run: () => void) => {
    timers.current.push(setTimeout(run, ms));
  }, []);

  /** One confirmed hand-off: draw the line, send the signal, once. */
  const handOff = useCallback(
    (from: AccessStage, to: AccessStage) => {
      setStage(to);
      if (reduced) return;
      travelSeq.current += 1;
      const id = travelSeq.current;
      setTravel({ id, from, to });
      // Cleared so the element leaves the DOM and cannot replay.
      after(SIGNAL_TOTAL_MS, () => setTravel((live) => (live?.id === id ? null : live)));
    },
    [after, reduced],
  );

  const emailValid = EMAIL_SHAPE.test(email.trim());

  /* ---- 01 → 02 --------------------------------------------------- */

  const request = (mode: 'first' | 'resend') =>
    startTransition(async () => {
      setRefusal(null);
      setStatus(mode === 'first' ? 'Sending your sign-in code…' : 'Sending a new code…');

      let result: { ok: boolean; code?: string; message?: string } | undefined;
      try {
        const form = new FormData();
        form.set('email', email.trim());
        result = await requestSignInCodeAction(form);
      } catch {
        setStatus('');
        setRefusal({ field: 'email', ...LOCAL_COPY.NETWORK });
        return;
      }

      /*
       * `!result?.ok` rather than `!result.ok`. A server action that
       * resolves to nothing — a deploy skew, a stripped response, a
       * boundary that swallowed the payload — used to throw here, and a
       * throw inside a transition unmounts nothing and shows nothing:
       * the person was left holding a button that had already stopped
       * spinning. An unrecognisable answer is a refusal, and refusals
       * are things this screen knows how to say.
       */
      if (!result?.ok) {
        setStatus('');
        setRefusal(
          refusalFor(mode === 'first' ? 'email' : 'code', result, LOCAL_COPY.REQUEST_FAILED),
        );
        return;
      }

      if (mode === 'resend') {
        setCode('');
        setStatus('A new code is on its way. The previous one no longer works.');
        setFocusWanted('code');
        return;
      }

      setStatus(`Code sent. Enter the eight digits sent to ${maskEmail(email.trim())}.`);
      setFocusWanted('code');
      handOff('email', 'code');
    });

  /* ---- 02 → 03 --------------------------------------------------- */

  const verify = (presented: string) =>
    startTransition(async () => {
      setRefusal(null);
      setStatus('Checking your code…');

      let result: { ok: boolean; code?: string; message?: string } | undefined;
      try {
        result = await verifySignInCodeAction({
          email: email.trim(),
          code: presented,
          next,
          invite,
        });
      } catch {
        setStatus('');
        setRefusal({ field: 'code', ...LOCAL_COPY.NETWORK });
        return;
      }

      // See the note on the request path: an unrecognisable answer is a
      // refusal, never an exception. Nothing advances on one.
      if (!result?.ok) {
        setStatus('');
        setRefusal(refusalFor('code', result, LOCAL_COPY.VERIFY_FAILED));
        /*
         * Back to the field, not to the message. The refusal is
         * `role="alert"` and is announced either way; what the person
         * has to do next is retype eight digits, and making them find
         * the field again first is the cost of a tidier focus rule.
         */
        setFocusWanted('code');
        return;
      }

      /*
       * The session cookie is already set — `verifySignInCodeAction`
       * awaits `setSessionCookie` before it returns `ok`. So this is a
       * confirmation of something that has happened, not an optimistic
       * guess, and the navigation below cannot arrive unauthenticated.
       */
      setStatus('Access confirmed. Taking you to INRP2P.');
      handOff('code', 'granted');
      after(reduced ? REDUCED_HOLD_MS : SIGNAL_TOTAL_MS + CONFIRM_HOLD_MS, () => {
        router.push(next);
        router.refresh();
      });
    });

  /* ---- Focus, where the eye already went -------------------------- */

  /*
   * FOCUS IS ASKED FOR, THEN GRANTED WHEN THE FIELD CAN TAKE IT.
   *
   * ⚠ The obvious version — focus the code field the moment the stage
   * becomes `code` — silently does nothing, and this is the trap: the
   * stage changes inside `startTransition`, so `pending` is still true
   * on that commit, so the field is still `disabled`, and `.focus()` on
   * a disabled element is a no-op that throws nothing and logs nothing.
   * The person was left on `<body>` with a code field they had to click.
   *
   * So a move is REQUESTED by whatever caused it and performed once the
   * request has actually finished. Nothing is requested on mount: on a
   * small screen that would raise the keyboard over half the page before
   * anybody had decided to type, and it would move the focus ring with
   * no user action behind it.
   */
  const [focusWanted, setFocusWanted] = useState<'email' | 'code' | null>(null);
  useEffect(() => {
    if (pending || focusWanted === null) return;
    (focusWanted === 'code' ? codeRef : emailRef).current?.focus();
    setFocusWanted(null);
  }, [focusWanted, pending]);

  const granted = stage === 'granted';
  const emailError = refusal?.field === 'email' ? refusal : null;
  const codeError = refusal?.field === 'code' ? refusal : null;

  return (
    /*
      THE SPLIT IS INSIDE THE CLIENT BOUNDARY, AND ONLY FOR THE RAIL.

      The editorial panel is static text that server-renders identically
      either way — but the rail standing in it has to read the same stage
      the form on the right is driving, and two copies of that state is
      how a progress indicator ends up disagreeing with the form beside
      it. One state, one owner, one rail.
    */
    <div className="auth-split" data-stage={stage}>
      {/* ---- The argument, on the dark side ------------------------ */}
      <section className="auth-editorial">
        <div className="auth-editorial-inner">
          <p className="auth-editorial-eyebrow">DealSafe India</p>
          <h2 className="auth-editorial-title">
            <span className="block">Your deals.</span>
            <span className="block">Your proof.</span>
            <span className="block">Your history.</span>
          </h2>
          <p className="auth-editorial-sub">One email. One-time code. Back where you left off.</p>

          <AccessRail stage={stage} travel={travel} className="auth-editorial-rail" />

          <p className="auth-editorial-foot">
            <Icon name="lock" className="auth-editorial-foot-icon" strokeWidth={1.8} />
            Passwordless access. Private by default.
          </p>
        </div>
      </section>

      {/* ---- The work, on the paper side --------------------------- */}
      <section className="auth-work">
        <div className="auth-work-inner">
          {/*
            One polite channel for what the server just did. It carries no
            credential — the code is never interpolated into it — and it is
            separate from the assertive refusals below, which interrupt.
          */}
          <p role="status" aria-live="polite" className="sr-only">
            {status}
          </p>

          {granted ? (
            <Granted key="granted" />
          ) : stage === 'code' ? (
            <CodeStage
              key="code"
              email={email}
              code={code}
              setCode={setCode}
              pending={pending}
              error={codeError}
              codeRef={codeRef}
              onVerify={verify}
              onResend={() => request('resend')}
              onRestart={() => {
                setCode('');
                setRefusal(null);
                setStatus('');
                setTravel(null);
                setStage('email');
                setFocusWanted('email');
              }}
            />
          ) : (
            <EmailStage
              key="email"
              email={email}
              setEmail={setEmail}
              valid={emailValid}
              pending={pending}
              error={emailError}
              emailRef={emailRef}
              onSubmit={() => request('first')}
            />
          )}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * State 1 — the address
 * ------------------------------------------------------------------ */

function EmailStage({
  email,
  setEmail,
  valid,
  pending,
  error,
  emailRef,
  onSubmit,
}: {
  email: string;
  setEmail: (next: string) => void;
  valid: boolean;
  pending: boolean;
  error: Refusal | null;
  emailRef: React.RefObject<HTMLInputElement | null>;
  onSubmit: () => void;
}) {
  return (
    <form
      className="auth-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !pending) onSubmit();
      }}
    >
      <p className="auth-eyebrow">Secure access</p>
      <h1 className="auth-title">Sign in to INRP2P</h1>
      <p className="auth-sub">Enter your email. We&rsquo;ll send a one-time code to continue.</p>

      <div className="mt-8">
        <label htmlFor="auth-email" className="auth-label">
          Email address
        </label>
        <input
          ref={emailRef}
          id="auth-email"
          name="email"
          type="email"
          autoComplete="email"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="email"
          disabled={pending}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'auth-email-error' : undefined}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.in"
          className="auth-input"
        />
        <FieldError id="auth-email-error" error={error} />
      </div>

      <SubmitButton pending={pending} disabled={!valid} busyLabel="Sending your code">
        Continue
      </SubmitButton>

      <p className="auth-helper">
        <Icon name="message" className="auth-helper-icon" strokeWidth={1.7} />
        The code can be used once. No password is created or stored.
      </p>

      <SecurityNotice />
      <NewHere />
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * State 2 — the proof
 * ------------------------------------------------------------------ */

function CodeStage({
  email,
  code,
  setCode,
  pending,
  error,
  codeRef,
  onVerify,
  onResend,
  onRestart,
}: {
  email: string;
  code: string;
  setCode: (next: string) => void;
  pending: boolean;
  error: Refusal | null;
  codeRef: React.RefObject<HTMLInputElement | null>;
  onVerify: (code: string) => void;
  onResend: () => void;
  onRestart: () => void;
}) {
  const ready = code.length === CODE_LENGTH;

  return (
    <form
      className="auth-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !pending) onVerify(code);
      }}
    >
      <p className="auth-eyebrow">Secure access</p>
      <h1 className="auth-title">Check your email</h1>
      <p className="auth-sub">
        Enter the one-time code sent to{' '}
        <span className="auth-sub-strong">{maskEmail(email.trim())}</span>
      </p>

      <div className="mt-8">
        <CodeField
          value={code}
          onChange={setCode}
          /*
           * A pasted code submits itself. Asking somebody to press a
           * button after the field is unambiguously complete is a step
           * that exists only because the form has one.
           */
          onComplete={(full) => {
            if (!pending) onVerify(full);
          }}
          disabled={pending}
          invalid={Boolean(error)}
          describedBy={error ? 'auth-code-error auth-code-hint' : 'auth-code-hint'}
          inputRef={codeRef}
        />
        <FieldError id="auth-code-error" error={error} />
        <p id="auth-code-hint" className="auth-hint">
          Eight digits. It works once and expires fifteen minutes after it was sent.
        </p>
      </div>

      <SubmitButton pending={pending} disabled={!ready} busyLabel="Checking your code">
        Verify code
      </SubmitButton>

      <div className="auth-secondary">
        <button type="button" onClick={onRestart} disabled={pending} className="auth-quiet">
          Use a different email
        </button>
        <span aria-hidden className="auth-secondary-rule" />
        <button type="button" onClick={onResend} disabled={pending} className="auth-quiet">
          Send a new code
        </button>
      </div>

      <SecurityNotice />
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * State 3 — released
 * ------------------------------------------------------------------ */

function Granted() {
  return (
    <div className="auth-form">
      <p className="auth-eyebrow">Secure access</p>
      <h1 className="auth-title">Access confirmed</h1>
      <p className="auth-sub">Your session is open. Taking you where you were going.</p>

      <div className="auth-granted">
        <span aria-hidden className="auth-granted-mark">
          <Icon name="check" className="h-5 w-5" strokeWidth={2.6} />
        </span>
        <span>
          <span className="auth-granted-title">Signed in</span>
          <span className="auth-granted-line">
            This code has been spent and cannot be used again.
          </span>
        </span>
      </div>

      <SecurityNotice />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

/**
 * The primary action, and the only place a request is visible.
 *
 * The label never changes and the box never resizes: a button that
 * becomes "Sending…" is a button that moves the text under a finger
 * already on its way down, and one that shrinks to a spinner has thrown
 * away what it was about to do. The work shows as a line inside the
 * button's own edge, and `aria-busy` says the same thing out loud.
 */
function SubmitButton({
  children,
  pending,
  disabled,
  busyLabel,
}: {
  children: React.ReactNode;
  pending: boolean;
  disabled: boolean;
  busyLabel: string;
}) {
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className="auth-submit"
    >
      <span className="auth-submit-label">{children}</span>
      {pending ? (
        <>
          <span aria-hidden className="auth-submit-work" />
          <span className="sr-only">{busyLabel}</span>
        </>
      ) : null}
    </button>
  );
}

/**
 * A refusal, beside the field it belongs to.
 *
 * `role="alert"` because it is the answer to something the person just
 * did and they may have looked away; the polite status region above
 * carries everything that is merely progress.
 */
function FieldError({ id, error }: { id: string; error: Refusal | null }) {
  if (!error) return null;
  return (
    <p id={id} role="alert" className="auth-error">
      <Icon name="alert" className="auth-error-icon" strokeWidth={2} />
      <span>
        <span className="auth-error-reason">{error.reason}</span> {error.nextStep}
      </span>
    </p>
  );
}

function SecurityNotice() {
  return (
    <div className="auth-notice">
      <p className="auth-notice-title">Never share your sign-in code.</p>
      <p className="auth-notice-line">INRP2P support will never ask you for it.</p>
    </div>
  );
}

/**
 * The way in for somebody with no account.
 *
 * It goes to the REAL create-deal route through the sign-in this page
 * already is — `/app/new` behind `next`. No account is created by
 * following it; the same code proves the same mailbox, and the account
 * comes into existence when that code is redeemed.
 */
function NewHere() {
  return (
    <p className="auth-newhere">
      <span className="auth-newhere-label">New to INRP2P?</span>
      <a href="/login?next=%2Fapp%2Fnew" className="auth-newhere-link">
        Create a protected deal
      </a>
    </p>
  );
}
