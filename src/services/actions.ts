'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  SandboxFailure,
  attachEvidence,
  signInSandbox,
  type DisputeReason,
  type SandboxError,
} from '@/server/sandbox/service';
import {
  addPaymentMethod,
  attachReferrer,
  markAllRead,
  markVerified,
  removePaymentMethod,
  setDefaultPaymentMethod,
  updateProfile,
} from '@/server/sandbox/identity';
import { clearSessionCookie, requireUser, setSessionCookie } from '@/server/sandbox/session';
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

export async function signInAction(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '');
  const next = String(formData.get('next') ?? '/app');
  const invite = String(formData.get('invite') ?? '').trim();

  const user = await signInSandbox(email);
  if (invite) await attachReferrer(user.userId, invite);
  await setSessionCookie(user.userId);
  // Only same-origin relative paths, so a crafted `next` cannot bounce anyone.
  const dest = next.startsWith('/') && !next.startsWith('//') ? next : '/app';
  redirect(dest);
}

export async function signOutAction(): Promise<void> {
  await clearSessionCookie();
  redirect('/');
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

export async function setTwoFactorAction(enabled: boolean): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await updateProfile(user, { twoFactorEnabled: enabled });
    revalidatePath('/app/settings/security');
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function verifyStepAction(step: 'identity' | 'upi' | 'wallet'): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await markVerified(user, step);
    revalidatePath('/app/profile');
    revalidatePath('/app/profile/verification');
    return { ok: true };
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
    const user = await requireUser();
    const outcome = await rulingCommand(user, commandId, dealId, ruling, reason);
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
