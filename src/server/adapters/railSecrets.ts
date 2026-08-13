import 'server-only';
import { AdapterUnavailableError, deploymentMode } from './mode';

/**
 * Webhook signing secrets.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THERE IS NO PRODUCTION SECRET IN THIS REPOSITORY, AND THERE IS    │
 * │  NO PRODUCTION SECRET MANAGER EITHER.                              │
 * │                                                                    │
 * │  So production asks for a signing key and is told no. It is not    │
 * │  given a placeholder, not given the sandbox key, and not allowed   │
 * │  to skip verification "just this once" — a rail that accepts       │
 * │  unsigned webhooks is a rail where anyone who knows the URL can    │
 * │  confirm their own payment.                                        │
 * │                                                                    │
 * │  The sandbox key is a constant, and it is written here in plain    │
 * │  sight ON PURPOSE. A secret that is checked into a public          │
 * │  repository is not a secret, so this one is labelled as worthless  │
 * │  rather than hidden in a way that might make somebody trust it.    │
 * └────────────────────────────────────────────────────────────────────┘
 */

/** Not a secret. Signs nothing of value. Public by design. */
const SANDBOX_WEBHOOK_SECRET = 'sandbox-webhook-key-not-a-secret-do-not-use-in-production';

/**
 * How stale a signed event may be before it is refused.
 *
 * Signature verification alone does not stop replay: a captured, validly
 * signed event stays validly signed forever. The freshness window bounds
 * how long a captured event remains useful, and `rail_event`'s uniqueness
 * stops it being used even once within that window.
 */
export const WEBHOOK_FRESHNESS_SECONDS = 300;

export function webhookSecretFor(providerKey: string): string {
  if (deploymentMode() === 'PRODUCTION') {
    throw new AdapterUnavailableError(
      `webhook-secret:${providerKey}`,
      'DEL-09 (Operations, Secrets and Dispatch)',
      'No secret manager is configured and no production signing key exists. ' +
        'Refusing to verify provider webhooks with a published sandbox key.',
    );
  }
  return `${SANDBOX_WEBHOOK_SECRET}:${providerKey}`;
}
