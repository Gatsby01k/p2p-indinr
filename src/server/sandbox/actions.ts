'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  SandboxFailure,
  confirmReceipt,
  createDealLink,
  issueFirmQuote,
  joinDealLink,
  signInSandbox,
  submitPaymentClaim,
  type SandboxError,
} from './service';
import { clearSessionCookie, requireUser, setSessionCookie } from './session';

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

export async function signInAction(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '');
  const next = String(formData.get('next') ?? '/app');
  const user = await signInSandbox(email);
  await setSessionCookie(user.userId);
  // Only same-origin relative paths, so a crafted `next` cannot bounce anyone.
  const dest = next.startsWith('/') && !next.startsWith('//') ? next : '/app';
  redirect(dest);
}

export async function signOutAction(): Promise<void> {
  await clearSessionCookie();
  redirect('/');
}

export async function createLinkAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const usdt = String(formData.get('usdt') ?? '').trim();

  // Parse to exact minor units. No floating point.
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(usdt);
  if (!match) redirect('/app/new?error=amount');
  const whole = BigInt(match![1]!);
  const frac = BigInt((match![2] ?? '').padEnd(6, '0'));
  const usdtMinor = whole * 1_000_000n + frac;

  const quote = await issueFirmQuote(user, 'USDT_TO_INR', usdtMinor);
  const link = await createDealLink(user, quote.quoteId);
  // Land the creator on the very page they are about to share, so what they
  // send is what they have already seen.
  redirect(`/d/${link.publicId}`);
}

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
