import 'server-only';
import { AdapterUnavailableError, deploymentMode } from './mode';

/**
 * The email-delivery adapter — the seam a real provider attaches to.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  NO FAKE PRODUCTION PROVIDER IS INVENTED HERE.                     │
 * │                                                                    │
 * │  Web sign-in is a one-time code sent to an address the person      │
 * │  controls. That is the ENTIRE proof of identity — so a deployment  │
 * │  that cannot actually deliver mail cannot authenticate anybody,    │
 * │  and pretending otherwise would be worse than the credential-free  │
 * │  sign-in DEL-03 exists to remove: it would look like real          │
 * │  authentication while proving nothing.                             │
 * │                                                                    │
 * │  The sandbox adapter therefore does NOT send mail either. It       │
 * │  records the code in the delivery log so the flow is testable and  │
 * │  demonstrable end to end, and it is named `SANDBOX` everywhere it  │
 * │  appears.                                                          │
 * │                                                                    │
 * │  Resend is the first REAL provider behind this seam. It is         │
 * │  selected by configuration alone — see `getEmailDeliveryAdapter`   │
 * │  — so a deployment with no key behaves exactly as it did before:   │
 * │  sandbox logs the code, production refuses to serve at all.        │
 * └────────────────────────────────────────────────────────────────────┘
 */

export interface DeliveryRequest {
  readonly to: string;
  readonly purpose: 'SIGN_IN' | 'RECOVERY';
  /** The one-time secret. Never persisted in clear; only delivered. */
  readonly secret: string;
  /**
   * The typable half of the secret, when there is one.
   *
   * `secret` is `<code>.<link-token>` and either half redeems the same
   * challenge (see `redeemEmailSignIn`). A provider needs the eight digits
   * on their own to put them in a mail, and splitting the secret inside an
   * adapter would silently produce nonsense the day that shape changes —
   * so the caller states the code explicitly instead.
   */
  readonly code?: string;
  readonly expiresInSeconds: number;
}

export interface EmailDeliveryAdapter {
  readonly kind: 'SANDBOX' | 'PRODUCTION';
  send(request: DeliveryRequest): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Sandbox: no mail leaves the process
 * ------------------------------------------------------------------ */

/**
 * What the sandbox "sent".
 *
 * An in-process ring buffer, so a test — and a developer running the app
 * locally — can complete a sign-in without a mail server. It is capped so
 * a long-running process cannot accumulate credentials in memory, and it
 * exists only while no real provider is configured.
 */
const DELIVERED: DeliveryRequest[] = [];
const MAX_RETAINED = 50;

class SandboxEmailDelivery implements EmailDeliveryAdapter {
  readonly kind = 'SANDBOX' as const;

  async send(request: DeliveryRequest): Promise<void> {
    DELIVERED.push(request);
    if (DELIVERED.length > MAX_RETAINED) DELIVERED.shift();
    // Printed, because a local developer needs to be able to sign in.
    console.info(
      `[inrp2p sandbox mail] ${request.purpose} code for ${request.to}: ${request.secret} ` +
        `(valid ${request.expiresInSeconds}s — SANDBOX ONLY, no mail was sent)`,
    );
  }
}

/** The most recent code sent to an address. Sandbox only; tests use it. */
export function lastDeliveredTo(email: string): DeliveryRequest | null {
  const normalized = email.trim().toLowerCase();
  for (let i = DELIVERED.length - 1; i >= 0; i -= 1) {
    if (DELIVERED[i]!.to === normalized) return DELIVERED[i]!;
  }
  return null;
}

/** Drop everything retained. Called between tests. */
export function clearDeliveries(): void {
  DELIVERED.length = 0;
}

/* ------------------------------------------------------------------ *
 * Resend: a real provider
 * ------------------------------------------------------------------ */

/**
 * The provider's endpoint, as a fixed literal.
 *
 * Deliberately NOT read from the environment. `tests/webSecurity.test.ts`
 * (T16, SSRF) requires every outbound target in an adapter to be a named
 * URL constant rather than an assembled string; a hard-coded literal is the
 * strictest form that rule admits, because there is no input — not even an
 * operator's — that can redirect where the sign-in code is sent.
 */
const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * How long we wait for the provider before giving up.
 *
 * A person is staring at a spinner on the sign-in screen, so this cannot be
 * generous. Ten seconds is long enough to absorb a slow hop and short enough
 * that a wedged provider surfaces as a refusal rather than a hang.
 */
const SEND_TIMEOUT_MS = 10_000;

/**
 * The default sender.
 *
 * ⚠ `onboarding@resend.dev` IS NOT A LAUNCH CONFIGURATION. Resend accepts it
 * without a verified domain, but it delivers ONLY to the address that owns
 * the Resend account — which is exactly right for proving the integration
 * works today, and useless for real users tomorrow. Verify `inrp2p.com` in
 * Resend and set `RESEND_FROM` to something like
 * `INRP2P <noreply@inrp2p.com>`; every other recipient is refused by the
 * provider until you do, and that refusal fails the sign-in loudly rather
 * than quietly dropping the mail.
 */
const DEFAULT_FROM = 'INRP2P <onboarding@resend.dev>';

interface ResendConfig {
  readonly apiKey: string;
  readonly from: string;
}

function resendConfig(): ResendConfig | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  /*
   * A real Resend key is `re_` followed by a long random tail. Anything
   * else is a placeholder someone pasted, and treating it as configuration
   * would mean claiming an adapter exists and then failing every sign-in
   * with a 401 — the same reasoning as `botToken()` in the Telegram verifier.
   */
  if (!apiKey || !apiKey.startsWith('re_') || apiKey.length < 20) return null;
  const from = process.env.RESEND_FROM?.trim();
  return { apiKey, from: from && from.length > 0 ? from : DEFAULT_FROM };
}

/**
 * Deliver through Resend's HTTP API.
 *
 * ⚠ NO SDK. This is one POST with a JSON body, and the `resend` package
 * would add a dependency — and its transitive tree — to the most security-
 * sensitive path in the product for no capability we lack. `fetch` is
 * global on the Node runtime these routes already pin.
 */
class ResendEmailDelivery implements EmailDeliveryAdapter {
  readonly kind = 'PRODUCTION' as const;

  constructor(private readonly config: ResendConfig) {}

  async send(request: DeliveryRequest): Promise<void> {
    const code = request.code ?? request.secret;
    const minutes = Math.max(1, Math.round(request.expiresInSeconds / 60));
    const signIn = request.purpose === 'SIGN_IN';
    /*
     * The code is NOT in the subject, though putting it there is common.
     * Subject lines are what a provider surfaces in its dashboard and keeps
     * in its delivery history, and the reasoning below about request logs
     * would be worthless if the code travelled in the one field certain to
     * be indexed. It costs a glance at the body; it buys the code living in
     * the mailbox alone.
     */
    const subject = signIn ? 'Your INRP2P sign-in code' : 'Your INRP2P recovery code';

    let response: Response;
    try {
      response = await fetch(RESEND_API_URL, {
        method: 'POST',
        /*
         * ⚠ NO IDEMPOTENCY KEY, DELIBERATELY.
         *
         * The obvious key would be derived from the code — and that is a
         * disclosure, not a de-duplication: eight digits is 10^8 candidates,
         * so any digest of the code can be brute-forced back to the code by
         * whoever reads the provider's request logs. The entire point of
         * this file is that the code reaches one mailbox and nowhere else.
         *
         * De-duplication is also not wanted here: every "send me a code"
         * mints a NEW code, and every one of them must actually arrive.
         */
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [request.to],
          subject,
          text: plainText(code, minutes, signIn),
          html: html(code, minutes, signIn),
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (cause) {
      /*
       * A timeout or a DNS failure. The message deliberately carries no
       * code and no key — this string reaches logs that more people can
       * read than can read the mailbox.
       */
      throw new Error(
        `Email delivery failed: could not reach the mail provider. ` +
          `${cause instanceof Error ? cause.name : 'unknown error'}`,
        { cause },
      );
    }

    if (!response.ok) {
      /*
       * FAIL THE SIGN-IN. A swallowed error here is the exact failure this
       * whole file exists to prevent: the screen would say "check your
       * mail" for a mail that was never accepted, and the person would
       * wait for a code that is not coming.
       *
       * The provider's own message is included because the two failures
       * that actually happen — an unverified sending domain (403) and a
       * bad key (401) — are indistinguishable without it, and both are
       * OUR misconfiguration rather than anything the person did.
       */
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Email delivery failed: provider returned ${response.status}. ` + `${detail.slice(0, 300)}`,
      );
    }
  }
}

function plainText(code: string, minutes: number, signIn: boolean): string {
  return [
    signIn ? 'Your INRP2P sign-in code:' : 'Your INRP2P recovery code:',
    '',
    `    ${code}`,
    '',
    `It expires in ${minutes} minute${minutes === 1 ? '' : 's'} and can be used once.`,
    '',
    'If you did not ask for this code, nothing has happened to your account and',
    'you can ignore this message. Nobody can use the code without this mailbox.',
    '',
    'INRP2P — DealSafe India',
  ].join('\n');
}

function html(code: string, minutes: number, signIn: boolean): string {
  /*
   * Inline styles and a table-free layout, because mail clients discard
   * stylesheets. The code is our own eight digits, so there is nothing
   * caller-supplied interpolated here to escape.
   */
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#faf7f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917">
  <div style="max-width:480px;margin:0 auto;background:#fffdfa;border:1px solid #e7e0d6;border-radius:14px;padding:28px">
    <p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8a7f70">INRP2P</p>
    <h1 style="margin:0 0 18px;font-size:19px;font-weight:600">${
      signIn ? 'Your sign-in code' : 'Your recovery code'
    }</h1>
    <p style="margin:0 0 8px;font-size:15px;line-height:1.5;color:#57534e">Enter this code to continue:</p>
    <p style="margin:0 0 18px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:32px;font-weight:600;letter-spacing:.16em;color:#1c1917">${code}</p>
    <p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#57534e">It expires in ${minutes} minute${
      minutes === 1 ? '' : 's'
    } and can be used once.</p>
    <p style="margin:0;font-size:13px;line-height:1.6;color:#8a7f70">If you did not ask for this code, nothing has happened to your account and you can ignore this message. Nobody can use the code without access to this mailbox.</p>
  </div>
</body></html>`;
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

export function getEmailDeliveryAdapter(): EmailDeliveryAdapter {
  /*
   * Configuration decides, not deployment mode.
   *
   * A sandbox deployment with a real key SHOULD send real mail — that is
   * how a demo becomes usable by people who are not holding the server
   * logs. And `INRP2P_SANDBOX` stays true meanwhile, because the payment
   * rails behind it are still stand-ins; the two facts are independent and
   * conflating them is what would put a simulated rail in front of a real
   * user.
   */
  const resend = resendConfig();
  if (resend) return new ResendEmailDelivery(resend);

  if (deploymentMode() === 'PRODUCTION') {
    throw new AdapterUnavailableError(
      'email-delivery',
      'DEL-03 (Identity and Access) — provider integration',
      'No production mail provider is configured, and the sandbox adapter does ' +
        'not send mail: it logs the code. Issuing a sign-in code nobody receives, ' +
        'or worse one anybody with log access receives, is not authentication. ' +
        'Set RESEND_API_KEY to deliver through Resend.',
    );
  }
  return new SandboxEmailDelivery();
}

export function emailDeliveryAvailable(): boolean {
  return resendConfig() !== null || deploymentMode() !== 'PRODUCTION';
}

/**
 * Which adapter is in force, for the diagnostics screen.
 *
 * Reports the SHAPE of the configuration and never the key: an operator
 * needs to know whether mail actually leaves the building, and whether the
 * sender is still the provider's shared testing address.
 */
export function emailDeliveryStatus(): {
  readonly kind: 'SANDBOX' | 'RESEND' | 'NONE';
  readonly from: string | null;
  readonly domainVerified: boolean;
} {
  const resend = resendConfig();
  if (resend) {
    return {
      kind: 'RESEND',
      from: resend.from,
      domainVerified: resend.from !== DEFAULT_FROM,
    };
  }
  return {
    kind: deploymentMode() === 'PRODUCTION' ? 'NONE' : 'SANDBOX',
    from: null,
    domainVerified: false,
  };
}
