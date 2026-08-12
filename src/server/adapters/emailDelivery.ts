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
 * │  appears. Production has no adapter at all and says so loudly.     │
 * └────────────────────────────────────────────────────────────────────┘
 */

export interface DeliveryRequest {
  readonly to: string;
  readonly purpose: 'SIGN_IN' | 'RECOVERY';
  /** The one-time secret. Never persisted in clear; only delivered. */
  readonly secret: string;
  readonly expiresInSeconds: number;
}

export interface EmailDeliveryAdapter {
  readonly kind: 'SANDBOX' | 'PRODUCTION';
  send(request: DeliveryRequest): Promise<void>;
}

/**
 * What the sandbox "sent".
 *
 * An in-process ring buffer, so a test — and a developer running the app
 * locally — can complete a sign-in without a mail server. It is capped so
 * a long-running process cannot accumulate credentials in memory, and it
 * exists only while `deploymentMode()` is SANDBOX.
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

export function getEmailDeliveryAdapter(): EmailDeliveryAdapter {
  if (deploymentMode() === 'PRODUCTION') {
    throw new AdapterUnavailableError(
      'email-delivery',
      'DEL-03 (Identity and Access) — provider integration',
      'No production mail provider is configured, and the sandbox adapter does ' +
        'not send mail: it logs the code. Issuing a sign-in code nobody receives, ' +
        'or worse one anybody with log access receives, is not authentication.',
    );
  }
  return new SandboxEmailDelivery();
}

export function emailDeliveryAvailable(): boolean {
  return deploymentMode() !== 'PRODUCTION';
}
