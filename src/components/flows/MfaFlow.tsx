'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  beginMfaEnrolmentAction,
  confirmMfaEnrolmentAction,
  redeemRecoveryCodeAction,
  verifyMfaAction,
} from '@/services/actions';
import { Callout, Card, Label, buttonClass } from '@/components/kit/primitives';
import { Icon } from '@/components/kit/Icon';
import { QrCodeClient } from '@/components/kit/QrCodeClient';

/**
 * Authenticator enrolment and the per-session challenge.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE SCREEN DEL-03 SPECIFIED AND NOBODY BUILT.                     │
 * │                                                                    │
 * │  The server side has existed since DEL-03 — enrolment, TOTP        │
 * │  confirmation, single-use recovery codes and a per-session         │
 * │  challenge, all tested. No component ever called any of it, so     │
 * │  `/app/ops` refused every operator with "set up an authenticator   │
 * │  app in Security" and Security offered nothing. The product sent   │
 * │  people to a dead end.                                             │
 * │                                                                    │
 * │  WHERE THE SECRET IS ALLOWED TO EXIST.                             │
 * │                                                                    │
 * │  In this component's state, for the seconds between enrolling and  │
 * │  confirming, and nowhere else. It is never put in a URL, never     │
 * │  written to localStorage or sessionStorage, never logged, and the  │
 * │  server never places it in an audit detail or an outbox payload.   │
 * │  Once confirmation succeeds the state is cleared, because a secret │
 * │  still on screen is a secret still being shouldered by whoever is  │
 * │  standing behind you.                                              │
 * │                                                                    │
 * │  The QR is rendered from the encoder in the browser, so the        │
 * │  `otpauth://` URI never crosses the network to a QR service. The   │
 * │  encoder is imported lazily so it is not in the shared bundle for  │
 * │  the many people who never enrol.                                  │
 * └────────────────────────────────────────────────────────────────────┘
 */

type Stage = 'idle' | 'showing' | 'confirmed';

interface Enrolment {
  readonly secret: string;
  readonly uri: string;
  readonly recoveryCodes: readonly string[];
}

/** A same-origin path, or nothing. Never an absolute URL. */
function safeNext(raw: string | undefined): string | null {
  if (!raw) return null;
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : null;
}

function CodeField({
  id,
  label,
  hint,
  value,
  onChange,
  maxLength,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  maxLength: number;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-[length:var(--text-sm)] font-medium">
        {label}
      </label>
      <input
        id={id}
        name={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={maxLength}
        // `one-time-code` lets a phone offer the code from its keyboard.
        autoComplete="one-time-code"
        inputMode={maxLength === 6 ? 'numeric' : 'text'}
        aria-describedby={`${id}-hint`}
        className="tnum mt-1.5 w-full rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-paper)] px-3 py-3 text-[length:var(--text-md)] tracking-[0.18em]"
      />
      <p id={`${id}-hint`} className="mt-1 text-[length:var(--text-xs)] text-[var(--color-ink-2)]">
        {hint}
      </p>
    </div>
  );
}

/* ================================================================== *
 * Enrolment
 * ================================================================== */

export function MfaEnrolment({ enrolled }: { enrolled: boolean }) {
  const [stage, setStage] = useState<Stage>(enrolled ? 'confirmed' : 'idle');
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const begin = () => {
    setError(null);
    startTransition(async () => {
      const result = await beginMfaEnrolmentAction();
      if (!result.ok || !result.secret || !result.uri) {
        setError(result.message ?? 'Enrolment could not be started.');
        return;
      }
      const value: Enrolment = {
        secret: result.secret,
        uri: result.uri,
        recoveryCodes: result.recoveryCodes ?? [],
      };
      setEnrolment(value);
      setStage('showing');
      /*
       * The code itself is drawn by `QrCodeClient`, in this browser, so
       * the `otpauth://` URI carrying the secret never crosses the
       * network to a QR service and never reaches an RSC payload.
       */
    });
  };

  const confirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await confirmMfaEnrolmentAction(code.trim());
      if (!result.ok) {
        setError(result.message ?? 'That code was not accepted.');
        return;
      }
      // The secret and the recovery codes leave memory the moment they
      // are no longer needed.
      setEnrolment(null);
      setCode('');
      setStage('confirmed');
      /*
       * ⚠ AND THEN RELOAD THE DOCUMENT — in that order, and a real
       * reload rather than `router.refresh()`.
       *
       * WHY ANYTHING AT ALL HAS TO HAPPEN HERE. The challenge card is
       * rendered by Security only when the ACCOUNT has a confirmed
       * factor and this SESSION has not answered it. A moment ago the
       * account had none, so the server sent no challenge, and
       * confirming on the client cannot conjure one. Without this the
       * person finishes enrolling and is left on a page with nothing to
       * answer — holding a factor they have no way to satisfy — which is
       * precisely where an operator got stuck one step short of the
       * desk.
       *
       * WHY NOT `router.refresh()`. It was tried, and measured: after a
       * successful confirmation the page still read "Not enrolled" and
       * no challenge appeared, while a plain reload of the same URL a
       * second later rendered both correctly. The refresh issued from
       * inside the action's transition did not produce a new tree.
       *
       * And the same rule that governs the challenge's return applies
       * here: enrolling CHANGES THE AUTHORITY OF THE ACCOUNT, so every
       * payload the client router is holding was rendered for an account
       * without a second factor. Throwing that tree away is not a
       * workaround, it is the correct treatment of a stale one — and it
       * is deterministic, which on the screen that gates operator access
       * is worth more than saving a navigation nobody makes twice.
       *
       * It is safe only BECAUSE the definitive result is already in
       * client state above, and because nothing secret is left on this
       * screen: the secret and the recovery codes were cleared three
       * lines up. `confirmMfaEnrolmentAction` deliberately does not
       * revalidate this route for the same reason — a failed
       * presentation render must never be able to swallow a confirmed
       * enrolment, or the one-time secret goes with it.
       */
      window.location.reload();
    });
  };

  if (stage === 'confirmed') {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <Icon name="shield" className="mt-0.5 text-[var(--color-good)]" />
          <div>
            <p className="font-semibold" data-testid="mfa-enrolled">
              An authenticator app is enrolled.
            </p>
            <p className="mt-1 text-[length:var(--text-sm)] text-[var(--color-ink-2)]">
              Operator actions ask for a code from it once per session. Enrolling again replaces the
              current app and retires the old one in the same step, so you are never left with two
              live factors or none.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            setStage('idle');
            setEnrolment(null);
          }}
          className={`${buttonClass('quiet')} mt-4`}
          data-testid="mfa-reenrol"
        >
          Replace the authenticator app
        </button>
      </Card>
    );
  }

  if (stage === 'showing' && enrolment) {
    return (
      <Card>
        <Label>Step 1 — scan this</Label>
        <div className="mt-3">
          <QrCodeClient
            value={enrolment.uri}
            label="Scan this with your authenticator app to add INRP2P"
            fallback={
              <p className="text-[length:var(--text-sm)] text-[var(--color-ink-2)]">
                The code could not be drawn. Use the manual key below.
              </p>
            }
          />
        </div>

        <Label className="mt-5 block">Or enter this key by hand</Label>
        <p
          className="tnum mt-1.5 rounded-[var(--radius-md)] bg-[var(--color-wash)] px-3 py-2 text-[length:var(--text-sm)] break-all"
          data-testid="mfa-secret"
        >
          {enrolment.secret}
        </p>
        <p className="mt-1 text-[length:var(--text-xs)] text-[var(--color-ink-2)]">
          Shown once, on this screen only. It is never sent in a link, stored in your browser or
          written to any log.
        </p>

        {enrolment.recoveryCodes.length > 0 ? (
          <>
            <Label className="mt-5 block">Step 2 — save these recovery codes</Label>
            <ul
              className="tnum mt-1.5 grid grid-cols-2 gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-wash)] p-3 text-[length:var(--text-sm)]"
              data-testid="mfa-recovery-codes"
            >
              {enrolment.recoveryCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <p className="mt-1 text-[length:var(--text-xs)] text-[var(--color-ink-2)]">
              Each works once, and only if you lose the app. They are shown now and never again.
            </p>
          </>
        ) : null}

        <div className="mt-5">
          <Label className="mb-1.5 block">Step 3 — confirm</Label>
          <CodeField
            id="mfa-enrol-code"
            label="Code from the app"
            hint="Six digits. The code changes every thirty seconds."
            value={code}
            onChange={setCode}
            maxLength={6}
          />
        </div>

        {error ? (
          <Callout tone="risk" icon="alert" className="mt-3">
            <span role="alert">{error}</span>
          </Callout>
        ) : null}

        <button
          type="button"
          onClick={confirm}
          disabled={pending || code.trim().length !== 6}
          className={`${buttonClass('primary')} mt-4 w-full`}
          data-testid="mfa-confirm"
        >
          {pending ? 'Checking…' : 'Confirm and enrol'}
        </button>
      </Card>
    );
  }

  return (
    <Card>
      <p className="font-semibold">No authenticator app is enrolled.</p>
      <p className="mt-1 text-[length:var(--text-sm)] text-[var(--color-ink-2)]">
        Operator tools need one. Enrolling shows a key once, here — it is never emailed, linked or
        stored in your browser.
      </p>
      {error ? (
        <Callout tone="risk" icon="alert" className="mt-3">
          <span role="alert">{error}</span>
        </Callout>
      ) : null}
      <button
        type="button"
        onClick={begin}
        disabled={pending}
        className={`${buttonClass('primary')} mt-4`}
        data-testid="mfa-begin"
      >
        {pending ? 'Preparing…' : 'Set up an authenticator app'}
      </button>
    </Card>
  );
}

/* ================================================================== *
 * Per-session challenge
 * ================================================================== */

export function MfaChallenge({ next }: { next?: string }) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  const destination = safeNext(next);

  /*
   * THE RETURN IS A FULL DOCUMENT LOAD, DELIBERATELY.
   *
   * ⚠ It used to be `router.replace(destination)`, and that is wrong
   * here for a reason that has nothing to do with taste.
   *
   * Answering the second factor CHANGES THE AUTHORITY OF THE SESSION.
   * Every RSC payload the client router is holding was rendered for the
   * session as it was BEFORE that — including, in the ordinary flow, the
   * 403 for the very route being returned to, because being refused
   * there is how the person arrived here. A client-side navigation is
   * entitled to answer from that cache, so the router could put the old
   * refusal back on screen, or settle the new tree under the old URL:
   * either way the address bar and the rendered route disagree, which is
   * exactly the kind of ambiguity an authorization boundary must not
   * have.
   *
   * A document load throws the whole client tree away. There is no stale
   * Security subtree left mounted, no cached `/app/ops` payload to
   * prefer, and the URL is the one the server actually rendered. It
   * costs one navigation, once per session, on a screen nobody visits
   * twice.
   *
   * `replace`, not `assign`, so the answered challenge is not left in
   * the back history — and `safeNext` has already rejected anything that
   * is not a same-origin path, so this can never leave the origin.
   */
  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = useRecovery
        ? await redeemRecoveryCodeAction(recovery.trim())
        : await verifyMfaAction(code.trim());
      if (!result.ok) {
        setError(result.message ?? 'That code was not accepted.');
        return;
      }
      /*
       * The DEFINITIVE result has arrived and settles into client state
       * FIRST. Only then does anything navigate — a render that fails
       * afterwards can no longer contradict a mutation that already
       * committed.
       */
      setDone(true);
      setCode('');
      setRecovery('');
      if (destination) window.location.replace(destination);
      else router.refresh();
    });
  };

  if (done && !destination) {
    return (
      <Callout tone="final" icon="shield" className="mt-3">
        <span data-testid="mfa-satisfied">Your second factor is answered for this session.</span>
      </Callout>
    );
  }

  return (
    <Card>
      <p className="font-semibold">Answer your second factor</p>
      <p className="mt-1 text-[length:var(--text-sm)] text-[var(--color-ink-2)]">
        Asked once per session, on this device.
        {destination ? ' You will be taken back to where you were.' : ''}
      </p>

      <div className="mt-4">
        {useRecovery ? (
          <CodeField
            id="mfa-recovery"
            label="Recovery code"
            hint="One of the codes saved when you enrolled. Each works once."
            value={recovery}
            onChange={setRecovery}
            maxLength={32}
          />
        ) : (
          <CodeField
            id="mfa-code"
            label="Code from the app"
            hint="Six digits from your authenticator app."
            value={code}
            onChange={setCode}
            maxLength={6}
          />
        )}
      </div>

      {error ? (
        <Callout tone="risk" icon="alert" className="mt-3">
          <span role="alert" data-testid="mfa-error">
            {error}
          </span>
        </Callout>
      ) : null}

      <button
        type="button"
        onClick={submit}
        disabled={pending || (useRecovery ? recovery.trim().length < 8 : code.trim().length !== 6)}
        className={`${buttonClass('primary')} mt-4 w-full`}
        data-testid="mfa-verify"
      >
        {pending ? 'Checking…' : 'Confirm'}
      </button>

      <button
        type="button"
        onClick={() => {
          setUseRecovery(!useRecovery);
          setError(null);
        }}
        className={`${buttonClass('quiet')} mt-2 w-full`}
        data-testid="mfa-use-recovery"
      >
        {useRecovery ? 'Use the app instead' : 'Use a recovery code'}
      </button>
    </Card>
  );
}
