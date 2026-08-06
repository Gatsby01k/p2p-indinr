'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  SandboxFailure,
  attachEvidence,
  cancelDeal,
  closeDealLink,
  confirmReceipt,
  createDealLink,
  issueExchangeQuoteFromInr,
  issueFirmQuote,
  issueProtectedQuote,
  joinDealLink,
  postMessage,
  raiseDispute,
  signInSandbox,
  submitPaymentClaim,
  type DisputeReason,
  type SandboxError,
} from './service';
import {
  addPaymentMethod,
  attachReferrer,
  markAllRead,
  markVerified,
  removePaymentMethod,
  setDefaultPaymentMethod,
  updateProfile,
} from './identity';
import { ruleOnDispute, type Ruling } from './ops';
import { clearSessionCookie, requireUser, setSessionCookie } from './session';
import { parseInrToMinor, parseUsdtToMicro } from '@/lib/parse';
import type { Scenario } from '@/lib/scenario';
import type { FeeBearer } from '@/lib/fees';

/**
 * Server actions — the only mutation surface the browser can reach.
 *
 * Every one of them re-derives the caller from the signed session cookie and
 * re-checks authorization inside the service. Nothing here trusts a form
 * field, a query parameter or a hidden input to say who is acting.
 */

export interface ActionResult {
  readonly ok: boolean;
  readonly code?: SandboxError | 'UNKNOWN';
  readonly message?: string;
}

function fail(err: unknown): ActionResult {
  if (err instanceof SandboxFailure) return { ok: false, code: err.code, message: err.message };
  const code = (err as { code?: string }).code;
  if (code === 'UNAUTHENTICATED') {
    return { ok: false, code: 'UNAUTHENTICATED', message: 'Sign in to continue.' };
  }
  // Never leak an internal error string to the browser.
  console.error('[sandbox action]', err);
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
 * Creating a deal
 * ------------------------------------------------------------------ */

export interface CreateDealResult extends ActionResult {
  readonly publicId?: string;
}

/**
 * Create a protected deal from the wizard.
 *
 * The client sends an intention. Every binding figure — the fee, the total,
 * the expiry — is computed here and frozen into the quote, so the preview the
 * person saw can differ from the result without the result being wrong.
 */
export async function createDealAction(input: {
  scenario: Scenario;
  /** The INR leg, as typed. Exchanges may instead send `usdtAmount`. */
  inrAmount?: string;
  usdtAmount?: string;
  intent: 'PAY' | 'RECEIVE';
  feeBearer: FeeBearer;
  title?: string;
}): Promise<CreateDealResult> {
  try {
    const user = await requireUser();

    let quoteId: string;
    if (input.scenario === 'INR_TO_INR') {
      const inr = parseInrToMinor(input.inrAmount ?? '');
      if (inr === null)
        return { ok: false, code: 'AMOUNT_INVALID', message: 'Enter a valid amount.' };
      const quote = await issueProtectedQuote(user, inr, {
        feeBearer: input.feeBearer,
        title: input.title ?? null,
      });
      quoteId = quote.quoteId;
    } else if (input.usdtAmount) {
      const usdt = parseUsdtToMicro(input.usdtAmount);
      if (usdt === null)
        return { ok: false, code: 'AMOUNT_INVALID', message: 'Enter a valid amount.' };
      const quote = await issueFirmQuote(user, input.scenario, usdt, {
        feeBearer: input.feeBearer,
        title: input.title ?? null,
      });
      quoteId = quote.quoteId;
    } else {
      const inr = parseInrToMinor(input.inrAmount ?? '');
      if (inr === null)
        return { ok: false, code: 'AMOUNT_INVALID', message: 'Enter a valid amount.' };
      const quote = await issueExchangeQuoteFromInr(user, input.scenario, inr, {
        feeBearer: input.feeBearer,
        title: input.title ?? null,
      });
      quoteId = quote.quoteId;
    }

    const link = await createDealLink(user, quoteId, input.intent);
    revalidatePath('/app');
    return { ok: true, publicId: link.publicId };
  } catch (err) {
    return fail(err);
  }
}

/**
 * The legacy one-field create form, preserved.
 *
 * The original product surface took a USDT amount and produced a sell link.
 * It still does, and still lands the creator on the page they are about to
 * share, so what they send is what they have already seen.
 */
export async function createLinkAction(formData: FormData): Promise<void> {
  try {
    const user = await requireUser();
    const usdtMinor = parseUsdtToMicro(String(formData.get('usdt') ?? ''));
    if (usdtMinor === null) redirect('/app/new?error=amount');

    const quote = await issueFirmQuote(user, 'USDT_TO_INR', usdtMinor);
    const link = await createDealLink(user, quote.quoteId, 'RECEIVE');
    redirect(`/d/${link.publicId}`);
  } catch (err) {
    if (isRedirect(err)) throw err;
    redirect('/app/new?error=amount');
  }
}

export async function closeLinkAction(publicId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await closeDealLink(user, publicId);
    revalidatePath(`/d/${publicId}`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/* ------------------------------------------------------------------ *
 * The deal
 * ------------------------------------------------------------------ */

export async function joinAction(publicId: string): Promise<ActionResult & { dealId?: string }> {
  try {
    const user = await requireUser();
    const result = await joinDealLink(user, publicId);
    revalidatePath(`/d/${publicId}`);
    return { ok: true, dealId: result.dealId };
  } catch (err) {
    return fail(err);
  }
}

export async function claimAction(
  dealId: string,
  utr: string,
  note: string,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await submitPaymentClaim(user, dealId, utr, note);
    revalidatePath(`/app/deal/${dealId}`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function confirmAction(dealId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await confirmReceipt(user, dealId);
    revalidatePath(`/app/deal/${dealId}`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function cancelDealAction(dealId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await cancelDeal(user, dealId);
    revalidatePath(`/app/deal/${dealId}`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function messageAction(dealId: string, body: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await postMessage(user, dealId, body);
    revalidatePath(`/app/deal/${dealId}`);
    return { ok: true };
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

export async function disputeAction(
  dealId: string,
  reason: DisputeReason,
  detail: string,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await raiseDispute(user, dealId, reason, detail);
    revalidatePath(`/app/deal/${dealId}`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/* ------------------------------------------------------------------ *
 * Profile, methods, notifications
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
 * Operator
 * ------------------------------------------------------------------ */

export async function ruleAction(
  dealId: string,
  ruling: Ruling,
  reason: string,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await ruleOnDispute(user, dealId, ruling, reason);
    revalidatePath('/app/ops');
    revalidatePath(`/app/ops/${dealId}`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
