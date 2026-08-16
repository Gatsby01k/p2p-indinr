'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  SandboxFailure,
  attachEvidence,
  type DisputeReason,
  type SandboxError,
} from '@/server/sandbox/service';
import {
  addPaymentMethod,
  attachReferrer,
  markAllRead,
  removePaymentMethod,
  setDefaultPaymentMethod,
  updateProfile,
} from '@/server/sandbox/identity';
import {
  clearSessionCookie,
  currentCaller,
  requireCaller,
  requireUser,
  setSessionCookie,
} from '@/server/sandbox/session';
import {
  beginMfaEnrolment,
  confirmMfaEnrolment,
  redeemEmailSignIn,
  startEmailSignIn,
  redeemRecoveryCode,
  verifyMfaForSession,
} from '@/server/identity/auth';
import { listSessions, revokeAllSessions, revokeSession } from '@/server/identity/sessions';
import { decideVerification, submitVerification } from '@/server/identity/verification';
/*
 * EVERY DEL-02 MUTATION IS CONSTRUCTED IN `./commands`.
 *
 * This file resolves the session, redirects and revalidates. It decides
 * nothing else, so an action cannot drift away from the command a test
 * exercises. `tests/serviceBoundary.test.ts` fails the build if a domain
 * primitive is ever imported here again.
 */
import { afterCommit } from './present';
import {
  cancelCommand,
  claimCommand,
  closeLinkCommand,
  confirmCommand,
  createDealCommand,
  createLinkFromForm,
  disputeCommand,
  joinCommand,
  messageCommand,
  rulingCommand,
} from './commands';
import { AdapterUnavailableError } from '@/server/adapters/mode';
import type { Scenario } from '@/lib/scenario';
import type { ActionResult, CreateDealResult, JoinResult, Ruling } from './contract';

/**
 * The application-service MUTATION surface.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE ONLY MUTATION SURFACE THE BROWSER CAN REACH.                  │
 * │                                                                    │
 * │  Every action re-derives the caller from the signed session cookie │
 * │  and re-checks authorization inside the service. Nothing here      │
 * │  trusts a form field, a query parameter or a hidden input to say   │
 * │  who is acting, and a re-enabled button changes nothing except the │
 * │  error the person sees (UX-01 §2.2).                               │
 * │                                                                    │
 * │  DEL-02 mutations additionally carry a CALLER-SUPPLIED command id. │
 * │  A retry with the same id returns the original answer instead of   │
 * │  acting twice; the same id with different arguments is refused     │
 * │  outright. See `src/server/boundary/command.ts`.                   │
 * └────────────────────────────────────────────────────────────────────┘
 */

function fail(err: unknown): ActionResult {
  if (err instanceof SandboxFailure) return { ok: false, code: err.code, message: err.message };
  /*
   * A missing production adapter is a deployment fault, not the caller's
   * problem, so it is named rather than dressed up as "something went
   * wrong" — an operator reading a log needs to know which capability was
   * asked for and which stage owns it.
   */
  if (err instanceof AdapterUnavailableError) {
    console.error('[inrp2p adapter]', err.capability, err.owningStage);
    return { ok: false, code: 'ADAPTER_UNAVAILABLE', message: 'This action is unavailable here.' };
  }
  const code = (err as { code?: string }).code;
  if (code === 'UNAUTHENTICATED') {
    return { ok: false, code: 'UNAUTHENTICATED', message: 'Sign in to continue.' };
  }
  // Never leak an internal error string to the browser.
  console.error('[inrp2p action]', err);
  return { ok: false, code: 'UNKNOWN', message: 'Something went wrong on our side.' };
}

/**
 * `redirect()` works by throwing. Catching it as an error would turn a
 * successful navigation into a false failure, so it is re-thrown untouched.
 */
function isRedirect(err: unknown): boolean {
  return typeof (err as { digest?: unknown })?.digest === 'string'
    ? String((err as { digest: string }).digest).startsWith('NEXT_REDIRECT')
    : false;
}

/** Translate a boundary outcome into the shape the interface renders. */
function resultOf(outcome: { ok: boolean; code?: SandboxError; message?: string }): ActionResult {
  return outcome.ok ? { ok: true } : { ok: false, code: outcome.code, message: outcome.message };
}

/* ------------------------------------------------------------------ *
 * Session
 * ------------------------------------------------------------------ */

/**
 * Ask for a sign-in code.
 *
 * ⚠ THE CREDENTIAL-FREE SIGN-IN IS GONE.
 *
 * This used to take an address and issue a session — no password, no
 * code, no proof of anything (TS-00 `AUD-P0-002`). It now starts a
 * one-time-code flow: the code goes to the address out of band, and no
 * session exists until it comes back.
 *
 * The answer is identical for a known and an unknown address, because
 * distinguishing them would be an account-enumeration oracle.
 */
export async function requestSignInCodeAction(formData: FormData): Promise<ActionResult> {
  try {
    const email = String(formData.get('email') ?? '');
    const outcome = await startEmailSignIn(email);
    return resultOf(outcome);
  } catch (err) {
    return fail(err);
  }
}

/** Redeem a code or magic link and open a session. */
export async function verifySignInCodeAction(input: {
  email: string;
  code: string;
  next?: string;
  invite?: string;
}): Promise<ActionResult> {
  try {
    const outcome = await redeemEmailSignIn({
      email: input.email,
      secret: input.code,
      deviceLabel: 'Browser',
    });
    if (!outcome.ok) return resultOf(outcome);

    const { userId, sessionToken, expiresAt } = outcome.value;
    if (input.invite?.trim()) await attachReferrer(userId, input.invite.trim());
    await setSessionCookie(sessionToken, { embedded: false, expiresAt });
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** Sign out this device. The session row is revoked, not just forgotten. */
export async function signOutAction(): Promise<void> {
  try {
    const caller = await currentCaller();
    if (caller) await revokeSession(caller.session.sessionId, caller.user.userId, 'SIGN_OUT');
  } catch (err) {
    console.error('[inrp2p] sign-out revocation failed', err);
  }
  await clearSessionCookie();
  redirect('/');
}

/**
 * Sign out everywhere.
 *
 * Revokes every other session AND bumps the user's session version, so a
 * credential already in flight cannot become a session after the fact.
 * The device the person is using is kept — that is what the control says.
 */
export async function signOutEverywhereAction(): Promise<ActionResult> {
  try {
    const caller = await requireCaller();
    const revoked = await revokeAllSessions(
      caller.user.userId,
      'SIGN_OUT_EVERYWHERE',
      caller.session.sessionId,
    );
    /*
     * This one KEEPS its revalidation: the session list on the page is
     * exactly what changed, and Security no longer renders through a
     * throwing resolver — an unresolvable session now redirects to
     * sign-in instead of producing an error payload. The MFA actions
     * above drop theirs because their result is a one-time secret that
     * a failed render must never be able to swallow.
     */
    afterCommit(() => revalidatePath('/app/settings/security'));
    return { ok: true, message: `${revoked} other session(s) ended.` };
  } catch (err) {
    return fail(err);
  }
}

/** End one named session from the device list. */
export async function revokeSessionAction(sessionId: string): Promise<ActionResult> {
  try {
    const caller = await requireCaller();
    // Ownership: the listing only ever shows the caller's own sessions,
    // and this re-checks rather than trusting the id that came back.
    const owned = await listSessions(caller.user.userId, caller.session.sessionId);
    if (!owned.some((s) => s.sessionId === sessionId)) {
      return { ok: false, code: 'PERMISSION_DENIED', message: 'That session is not yours.' };
    }
    await revokeSession(sessionId, caller.user.userId, 'REVOKED_BY_USER');
    afterCommit(() => revalidatePath('/app/settings/security'));
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/* ------------------------------------------------------------------ *
 * Second factor
 * ------------------------------------------------------------------ */

export async function beginMfaEnrolmentAction(): Promise<
  ActionResult & { secret?: string; uri?: string; recoveryCodes?: readonly string[] }
> {
  try {
    const caller = await requireCaller();
    const outcome = await beginMfaEnrolment(caller.user.userId);
    if (!outcome.ok) return resultOf(outcome);
    const { enrolmentUri } = await import('@/server/identity/totp');
    return {
      ok: true,
      secret: outcome.value.secret,
      uri: enrolmentUri(outcome.value.secret, caller.user.email ?? caller.user.displayName),
      recoveryCodes: outcome.value.recoveryCodes,
    };
  } catch (err) {
    return fail(err);
  }
}

export async function confirmMfaEnrolmentAction(code: string): Promise<ActionResult> {
  try {
    const caller = await requireCaller();
    const outcome = await confirmMfaEnrolment(caller.user.userId, code, {
      // This device just proved possession of the new factor; every
      // OTHER session still dies with the version bump.
      keepSessionId: caller.session.sessionId,
    });
    /*
     * ⚠ NO `revalidatePath('/app/settings/security')` HERE.
     *
     * Revalidating this route re-renders Security on the way back, and a
     * failure in that PRESENTATION render used to swallow a mutation
     * that had already COMMITTED — turning a confirmed enrolment into an
     * apparent failure and, worse, losing a one-time secret with it.
     *
     * The definitive result is the return value below. `MfaFlow` updates
     * its own state from it and refreshes afterwards if it needs to, so
     * a render problem can never contradict what the database did.
     */
    return resultOf(outcome);
  } catch (err) {
    return fail(err);
  }
}

/** Satisfy the second factor for this session. */
export async function verifyMfaAction(code: string): Promise<ActionResult> {
  try {
    const caller = await requireCaller();
    const outcome = await verifyMfaForSession({
      userId: caller.user.userId,
      sessionId: caller.session.sessionId,
      presented: code,
    });
    /*
     * Nor here. The client navigates to the route it was sent to answer
     * the factor for, once it has the definitive success in hand.
     */
    return resultOf(outcome);
  } catch (err) {
    return fail(err);
  }
}

export async function redeemRecoveryCodeAction(code: string): Promise<ActionResult> {
  try {
    const caller = await requireCaller();
    const outcome = await redeemRecoveryCode({
      userId: caller.user.userId,
      sessionId: caller.session.sessionId,
      code,
    });
    /*
     * Same reason as `confirmMfaEnrolmentAction`: a recovery code is
     * SINGLE USE, so a presentation render that hid its success would
     * spend the code and tell the person it failed.
     */
    return resultOf(outcome);
  } catch (err) {
    return fail(err);
  }
}

/* ------------------------------------------------------------------ *
 * DEL-02 mutations — session, delegate, redirect, revalidate
 * ------------------------------------------------------------------ */

/**
 * Create a protected deal from the wizard.
 *
 * `feeBearer` is NOT a parameter. It was, and the browser chose it, which
 * made a client the authority over an economic term (UX-01 §3, roadmap
 * B4). It is now server policy, and a forged request has no field to
 * carry: the value is applied in `createDealCommand` and hashed into the
 * command payload there.
 */
export async function createDealAction(input: {
  commandId: string;
  scenario: Scenario;
  /** The INR leg, as typed. Exchanges may instead send `usdtAmount`. */
  inrAmount?: string;
  usdtAmount?: string;
  intent: 'PAY' | 'RECEIVE';
  title?: string;
}): Promise<CreateDealResult> {
  try {
    const user = await requireUser();
    const outcome = await createDealCommand(user, {
      commandId: input.commandId,
      scenario: input.scenario,
      inrAmount: input.inrAmount,
      usdtAmount: input.usdtAmount,
      intent: input.intent,
      title: input.title ?? null,
    });
    if (!outcome.ok) return resultOf(outcome);
    // Committed. Revalidation cannot take that away.
    afterCommit(() => revalidatePath('/app'));
    return { ok: true, publicId: outcome.value.publicId };
  } catch (err) {
    return fail(err);
  }
}

/**
 * The no-JavaScript create-link form.
 *
 * The command id travels in a hidden field rendered by `/app/new`, so a
 * repeated post replays rather than duplicating. Parsing and the boundary
 * call both live in `createLinkFromForm`, which the integration suite
 * drives with real `FormData` — this wrapper only navigates.
 */
export async function createLinkAction(formData: FormData): Promise<void> {
  try {
    const user = await requireUser();
    const outcome = await createLinkFromForm(user, formData);
    if (!outcome.ok) redirect(`/app/new?error=${encodeURIComponent(outcome.code.toLowerCase())}`);
    redirect(`/d/${outcome.value.publicId}`);
  } catch (err) {
    if (isRedirect(err)) throw err;
    console.error('[inrp2p action] createLink', err);
    redirect('/app/new?error=adapter_unavailable');
  }
}

export async function closeLinkAction(commandId: string, publicId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const outcome = await closeLinkCommand(user, commandId, publicId);
    if (outcome.ok) afterCommit(() => revalidatePath(`/d/${publicId}`));
    return resultOf(outcome);
  } catch (err) {
    return fail(err);
  }
}

export async function joinAction(commandId: string, publicId: string): Promise<JoinResult> {
  try {
    const user = await requireUser();
    const outcome = await joinCommand(user, commandId, publicId);
    if (!outcome.ok) return resultOf(outcome);
    afterCommit(() => revalidatePath(`/d/${publicId}`));
    return { ok: true, dealId: outcome.value.dealId };
  } catch (err) {
    return fail(err);
  }
}

export async function claimAction(
  commandId: string,
  dealId: string,
  utr: string,
  note: string,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const outcome = await claimCommand(user, commandId, dealId, utr, note);
    if (outcome.ok) afterCommit(() => revalidatePath(`/app/deal/${dealId}`));
    return resultOf(outcome);
  } catch (err) {
    return fail(err);
  }
}

export async function confirmAction(commandId: string, dealId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const outcome = await confirmCommand(user, commandId, dealId);
    if (outcome.ok) afterCommit(() => revalidatePath(`/app/deal/${dealId}`));
    return resultOf(outcome);
  } catch (err) {
    return fail(err);
  }
}

export async function cancelDealAction(commandId: string, dealId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const outcome = await cancelCommand(user, commandId, dealId);
    if (outcome.ok) afterCommit(() => revalidatePath(`/app/deal/${dealId}`));
    return resultOf(outcome);
  } catch (err) {
    return fail(err);
  }
}

export async function messageAction(
  commandId: string,
  dealId: string,
  body: string,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const outcome = await messageCommand(user, commandId, dealId, body);
    if (outcome.ok) afterCommit(() => revalidatePath(`/app/deal/${dealId}`));
    return resultOf(outcome);
  } catch (err) {
    return fail(err);
  }
}

export async function disputeAction(
  commandId: string,
  dealId: string,
  reason: DisputeReason,
  detail: string,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const outcome = await disputeCommand(user, commandId, dealId, reason, detail);
    if (outcome.ok) afterCommit(() => revalidatePath(`/app/deal/${dealId}`));
    return resultOf(outcome);
  } catch (err) {
    return fail(err);
  }
}

/**
 * Attach evidence.
 *
 * FormData is the transport because a `File` cannot cross a server-action
 * boundary any other way. Size and type are re-checked on the server: the
 * `accept` attribute and any client guard are conveniences, not controls.
 *
 * Evidence hardening — magic bytes, scanning, quotas, retention — is
 * DEL-06's scope and is deliberately not attempted here, which is also
 * why this mutation is not yet command-bound.
 */
export async function uploadEvidenceAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const dealId = String(formData.get('dealId') ?? '');
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, code: 'EVIDENCE_TYPE_REJECTED', message: 'Choose a file first.' };
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    await attachEvidence(user, dealId, { name: file.name, type: file.type, bytes });
    revalidatePath(`/app/deal/${dealId}`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/* ------------------------------------------------------------------ *
 * Profile, methods, notifications — DEL-03/DEL-07 own these properly
 * ------------------------------------------------------------------ */

export async function updateProfileAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await updateProfile(user, {
      about: formData.has('about') ? String(formData.get('about')) : undefined,
      city: formData.has('city') ? String(formData.get('city')) : undefined,
      notifyEmail: formData.has('notify') ? formData.get('notifyEmail') === 'on' : undefined,
      notifyPush: formData.has('notify') ? formData.get('notifyPush') === 'on' : undefined,
    });
    revalidatePath('/app/profile');
    revalidatePath('/app/settings');
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/**
 * The old boolean 2FA toggle, deliberately removed.
 *
 * It set `two_factor_enabled` and nothing else — no secret, no enrolment,
 * no challenge (TS-00 `AUD-P1-008`). A screen that offered it was
 * offering a checkbox labelled "be secure". Enrolment now goes through
 * `beginMfaEnrolmentAction` / `confirmMfaEnrolmentAction`, and this
 * action exists only to tell an out-of-date client so.
 */
export async function setTwoFactorAction(): Promise<ActionResult> {
  return {
    ok: false,
    code: 'MFA_NOT_ENROLLED',
    message: 'Two-factor authentication is set up with an authenticator app.',
  };
}

/**
 * Submit a verification for review.
 *
 * ⚠ THIS NO LONGER VERIFIES ANYTHING BY ITSELF.
 *
 * It used to set a boolean and mint loyalty points on every press (TS-00
 * `AUD-P1-008`, `AUD-P1-001`). It now opens a CASE. Approval requires a
 * reviewer who is not the subject — enforced by a database constraint,
 * not by this function — and the badge follows the decision.
 */
export async function verifyStepAction(step: 'identity' | 'upi' | 'wallet'): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const kind = step.toUpperCase() as 'IDENTITY' | 'UPI' | 'WALLET';
    const outcome = await submitVerification({ userId: user.userId, kind });
    if (outcome.ok) {
      afterCommit(() => {
        revalidatePath('/app/profile');
        revalidatePath('/app/profile/verification');
      });
    }
    return resultOf(outcome);
  } catch (err) {
    return fail(err);
  }
}

/**
 * Decide a verification case.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE ACTION THAT WAS MISSING.                                      │
 * │                                                                    │
 * │  `decideVerification` has been implemented and tested since        │
 * │  DEL-03 and nothing could reach it, so no submitted case was ever  │
 * │  decided and no account could ever become verified — which made    │
 * │  joining a protected deal impossible for everyone. This exposes    │
 * │  the existing boundary; it adds no authority that did not already  │
 * │  exist and it weakens nothing.                                     │
 * │                                                                    │
 * │  Three things are still decided by the layers below, not here:     │
 * │  `verification.review` with a satisfied second factor, a written   │
 * │  reason of at least eight characters, and reviewer separation —    │
 * │  the last enforced by a CHECK constraint, so a bug in this file    │
 * │  cannot produce a self-approval.                                   │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function decideVerificationAction(
  caseId: string,
  decision: 'APPROVED' | 'REJECTED',
  note: string,
): Promise<ActionResult> {
  try {
    const caller = await requireCaller();
    const outcome = await decideVerification({
      reviewer: caller.principal,
      caseId,
      decision,
      note,
    });
    if (outcome.ok) {
      afterCommit(() => {
        revalidatePath('/app/ops/verification');
        // The subject's own screens read the cached flags this writes.
        revalidatePath('/app/profile');
        revalidatePath('/app/profile/verification');
      });
    }
    return resultOf(outcome);
  } catch (err) {
    return fail(err);
  }
}

export async function addPaymentMethodAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const kind = String(formData.get('kind') ?? 'UPI') as 'UPI' | 'BANK' | 'WALLET';
    await addPaymentMethod(user, {
      kind,
      label: String(formData.get('label') ?? ''),
      handle: String(formData.get('handle') ?? ''),
      bankName: String(formData.get('bankName') ?? '') || null,
      ifsc: String(formData.get('ifsc') ?? '') || null,
    });
    revalidatePath('/app/profile/payment-methods');
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function setDefaultMethodAction(methodId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await setDefaultPaymentMethod(user, methodId);
    revalidatePath('/app/profile/payment-methods');
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function removeMethodAction(methodId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await removePaymentMethod(user, methodId);
    revalidatePath('/app/profile/payment-methods');
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function markNotificationsReadAction(): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await markAllRead(user);
    revalidatePath('/app/notifications');
    revalidatePath('/app');
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/* ------------------------------------------------------------------ *
 * Operator — DEL-06 adds maker-checker and ledger-backed execution
 * ------------------------------------------------------------------ */

export async function ruleAction(
  commandId: string,
  dealId: string,
  ruling: Ruling,
  reason: string,
): Promise<ActionResult> {
  try {
    // The PRINCIPAL, not the user: live roles plus this session's MFA
    // state. A cached `isOperator` is not authority.
    const caller = await requireCaller();
    const outcome = await rulingCommand(caller.principal, commandId, dealId, ruling, reason);
    if (outcome.ok) {
      afterCommit(() => {
        revalidatePath('/app/ops');
        revalidatePath(`/app/ops/${dealId}`);
      });
    }
    return resultOf(outcome);
  } catch (err) {
    return fail(err);
  }
}
