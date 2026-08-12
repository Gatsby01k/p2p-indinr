import 'server-only';

/**
 * Deployment mode — the single gate every fail-closed decision reads.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE DEFAULT IS CLOSED, AND PRODUCTION MUST OPT IN TO BE OPEN.     │
 * │                                                                    │
 * │  A deployment is SANDBOX only when it says so. `NODE_ENV=production`│
 * │  with no explicit acknowledgement resolves to PRODUCTION, where    │
 * │  every sandbox stand-in is unreachable rather than merely          │
 * │  discouraged. That ordering matters: the failure mode this guards  │
 * │  against is a real deployment silently inheriting simulations,     │
 * │  never a local machine being over-restricted.                      │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * TS-00 recorded that `src/lib/env.ts` exported two capability constants
 * that nothing consumed (`AUD-P2-007`), so UX-01 §2.1's "executable
 * production gate" was satisfied only by the accident of no scenario
 * mechanism existing. This module is that gate, and the tests in
 * `tests/integration/productionIsolation.test.ts` execute it in a real
 * process rather than asserting it in prose.
 */

export type DeploymentMode = 'SANDBOX' | 'PRODUCTION';

/**
 * Read fresh on every call rather than captured at module load.
 *
 * A module-level constant cannot be exercised by a test that needs to see
 * both modes, and an untestable safety gate is not a safety gate. The read
 * is two environment lookups; nothing here is on a hot path.
 */
export function deploymentMode(): DeploymentMode {
  const isProductionBuild = process.env.NODE_ENV === 'production';
  const acknowledgedSandbox = process.env.INRP2P_SANDBOX === 'true';
  if (!isProductionBuild) return 'SANDBOX';
  return acknowledgedSandbox ? 'SANDBOX' : 'PRODUCTION';
}

export function isSandboxDeployment(): boolean {
  return deploymentMode() === 'SANDBOX';
}

export function isProductionDeployment(): boolean {
  return deploymentMode() === 'PRODUCTION';
}

/**
 * Raised when production asks for a capability no production adapter
 * implements.
 *
 * It is deliberately an exception and not a rejection code: a missing
 * adapter is a deployment fault, not a decision about the caller's
 * request, and it must be loud rather than rendered as a tidy message on
 * a screen that then looks like it worked.
 */
export class AdapterUnavailableError extends Error {
  readonly capability: string;
  readonly owningStage: string;

  constructor(capability: string, owningStage: string, detail: string) {
    super(
      `No production adapter for "${capability}". ${detail}\n` +
        `This capability is delivered by ${owningStage}. Refusing to serve it with a ` +
        `sandbox stand-in: a simulation in front of real users is the failure this ` +
        `guard exists to prevent. Set INRP2P_SANDBOX=true to run an explicitly ` +
        `labelled sandbox deployment.`,
    );
    this.name = 'AdapterUnavailableError';
    this.capability = capability;
    this.owningStage = owningStage;
  }
}
