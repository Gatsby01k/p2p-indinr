import 'server-only';
import { AdapterUnavailableError, deploymentMode } from './mode';
import { SCENARIOS, type Scenario } from '@/lib/scenario';

/**
 * Deployment policy: which product scenarios and which identity paths a
 * given deployment may serve.
 *
 * This is where roadmap decisions B2 and the TS-00 P0 identity findings
 * become executable rather than documented.
 */

/* ------------------------------------------------------------------ *
 * Scenario availability — roadmap B2
 * ------------------------------------------------------------------ */

/**
 * `INR_TO_INR` is a core product scenario and stays in the product, the
 * UI and the sandbox exactly as approved.
 *
 * What it may not do yet is run in production, and the reason is precise.
 * Its production meaning is fixed as **USDT-collateral-backed INR
 * payment** — INRP2P never creates an INR ledger balance. Executing that
 * safely requires the normative `INR_TO_INR Collateral Addendum` (owner,
 * ratio, FX snapshot, volatility buffer, expiry, release, default,
 * dispute, fee, shortfall, reconciliation) and the DEL-04 ledger to lock
 * the collateral against. Neither exists.
 *
 * So the scenario is *available in sandbox and unavailable in production*
 * — which is the roadmap's stated requirement, and is not the same thing
 * as removing it.
 */
export function scenarioAvailable(scenario: Scenario): boolean {
  if (scenario !== 'INR_TO_INR') return true;
  return deploymentMode() !== 'PRODUCTION';
}

export function availableScenarios(): readonly Scenario[] {
  return SCENARIOS.filter(scenarioAvailable);
}

/** Why a scenario is unavailable, for an honest screen rather than a 404. */
export function scenarioUnavailableReason(scenario: Scenario): string | null {
  if (scenarioAvailable(scenario)) return null;
  return (
    'Protected INR payments are backed by locked USDT collateral, and the ' +
    'collateral contract for them is not yet approved. They are available in ' +
    'the sandbox and disabled here.'
  );
}

/**
 * The default fee bearer, decided by the server.
 *
 * UX-01 §3 and roadmap B4: retail users do not get a fee-bearing control.
 * The wizard used to offer one, so the browser chose who absorbed the fee
 * and the server honoured it — which made a client the authority over an
 * economic term. The policy lives here instead, and quote issuance reads
 * it rather than the request.
 *
 * The rule is the one already in the product: the payer sends the amount
 * plus the fees, and the payee receives the whole amount. Changing it, or
 * making it configurable in any form, is DEL-07's economics work.
 */
export const DEFAULT_FEE_BEARER = 'PAYER' as const;

/* ------------------------------------------------------------------ *
 * Operator rulings — sandbox only until DEL-06
 * ------------------------------------------------------------------ */

/**
 * Whether a single operator may resolve a dispute on this deployment.
 *
 * A ruling moves a deal to a terminal state. Doing that in production
 * needs maker-checker approval and a ledger disposition, both of which
 * are DEL-06/DEL-04 and neither of which exists. The sandbox keeps the
 * flow so the journey is complete end to end; production does not.
 */
export function operatorRulingAvailable(): boolean {
  return deploymentMode() !== 'PRODUCTION';
}

/* ------------------------------------------------------------------ *
 * Identity — TS-00 AUD-P0-001 / AUD-P0-002 containment
 * ------------------------------------------------------------------ */

/**
 * Whether the legacy sandbox identity path may run.
 *
 * ⚠ DEL-03 REPLACED IT. `signInSandbox` is no longer reachable from any
 * route: the web sign-in is a one-time code (`startEmailSignIn` /
 * `redeemEmailSignIn`) and operator authority comes from `role_grant`.
 *
 * The function survives for the integration suites that build fixture
 * accounts directly, and this gate keeps it unreachable in production —
 * so neither the `ops@` prefix (TS-00 `AUD-P0-001`) nor the
 * credential-free sign-in (`AUD-P0-002`) can return by configuration.
 */
export function sandboxIdentityEnabled(): boolean {
  return deploymentMode() !== 'PRODUCTION';
}

/**
 * Refuse the sandbox identity path in production.
 *
 * Throws rather than returning a rejection code, for the same reason
 * `getValueProtectionAdapter` does: this is a deployment fault, and a
 * caller must not be able to render it as an ordinary "try again".
 */
export function assertSandboxIdentityAllowed(): void {
  if (!sandboxIdentityEnabled()) {
    throw new AdapterUnavailableError(
      'authentication',
      'DEL-03 (Identity and Access)',
      'The sandbox sign-in verifies no credential and derives operator status ' +
        'from an email prefix. It is unreachable in production by construction.',
    );
  }
}

/**
 * Fixture roles for a sandbox email address.
 *
 * ⚠ `ops@` NO LONGER GRANTS OPERATOR AUTHORITY ANYWHERE.
 *
 * DEL-03 moved authority to `role_grant`, written only by the
 * out-of-band tool. What survives here is a TEST FIXTURE convenience:
 * `new@` marks an unverified account so the join guard can be exercised.
 * The operator half is gone entirely — a sandbox account named `ops@`
 * gets no permissions at all until somebody runs `grant-role.mjs`.
 *
 * The gate still applies, so even the fixture cannot run in production.
 */
export function sandboxRolesForEmail(email: string): {
  readonly isOperator: boolean;
  readonly isVerified: boolean;
} {
  assertSandboxIdentityAllowed();
  return {
    // Always false. Authority is a grant, never a spelling.
    isOperator: false,
    isVerified: !email.startsWith('new@'),
  };
}
