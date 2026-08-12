import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdapterUnavailableError, deploymentMode } from '@/server/adapters/mode';
import {
  assertSandboxIdentityAllowed,
  availableScenarios,
  sandboxIdentityEnabled,
  sandboxRolesForEmail,
  scenarioAvailable,
} from '@/server/adapters/policy';
import {
  getValueProtectionAdapter,
  valueProtectionAvailable,
} from '@/server/adapters/valueProtection';
import { signInSandbox } from '@/server/sandbox/service';

/**
 * Production isolation.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THESE ARE THE TESTS THAT MAKE "FAILS CLOSED" A FACT.              │
 * │                                                                    │
 * │  TS-00 `AUD-P2-007` recorded that UX-01 §2.1's production gate was │
 * │  satisfied only by accident — the constants existed, nothing read  │
 * │  them, and the named verification harness did not exist.           │
 * │                                                                    │
 * │  Each case below flips the deployment to production and asserts    │
 * │  that the unsafe path is refused. `deploymentMode()` reads the     │
 * │  environment on every call precisely so this is executable.        │
 * └────────────────────────────────────────────────────────────────────┘
 */

const original = {
  nodeEnv: process.env.NODE_ENV,
  sandbox: process.env.INRP2P_SANDBOX,
};

function enterProduction(acknowledgeSandbox = false) {
  // `NODE_ENV` is readonly in the Node types but writable at runtime, and
  // writing it is the only way to exercise the gate it guards.
  (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
  if (acknowledgeSandbox) process.env.INRP2P_SANDBOX = 'true';
  else delete process.env.INRP2P_SANDBOX;
}

beforeEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = original.nodeEnv;
  if (original.sandbox === undefined) delete process.env.INRP2P_SANDBOX;
  else process.env.INRP2P_SANDBOX = original.sandbox;
});

afterEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = original.nodeEnv;
  if (original.sandbox === undefined) delete process.env.INRP2P_SANDBOX;
  else process.env.INRP2P_SANDBOX = original.sandbox;
});

describe('deployment mode', () => {
  it('is SANDBOX outside a production build', () => {
    expect(deploymentMode()).toBe('SANDBOX');
  });

  it('is PRODUCTION when a production build does not acknowledge the sandbox', () => {
    enterProduction();
    expect(deploymentMode()).toBe('PRODUCTION');
  });

  it('is SANDBOX when a production build explicitly opts in', () => {
    enterProduction(true);
    expect(deploymentMode()).toBe('SANDBOX');
  });
});

describe('value protection fails closed in production', () => {
  it('is available in the sandbox and returns a clearly simulated lock', async () => {
    expect(valueProtectionAvailable()).toBe(true);
    const lock = await getValueProtectionAdapter().lock({
      dealId: '11111111-2222-3333-4444-555555555555',
      scenario: 'INR_TO_INR',
      usdtMinor: null,
      inrMinor: 100_000n,
    });
    expect(lock.simulated).toBe(true);
    expect(lock.reference.startsWith('SBX-')).toBe(true);
  });

  it('refuses to hand out any adapter in production', () => {
    enterProduction();
    expect(valueProtectionAvailable()).toBe(false);
    expect(() => getValueProtectionAdapter()).toThrow(AdapterUnavailableError);
    try {
      getValueProtectionAdapter();
    } catch (err) {
      expect((err as AdapterUnavailableError).owningStage).toContain('DEL-04');
      // The message must name the capability, so an operator reading a log
      // knows what was asked for rather than only that something failed.
      expect(String(err)).toContain('value-protection');
    }
  });
});

describe('INR_TO_INR is preserved, and production-disabled (roadmap B2)', () => {
  it('is fully available in the sandbox', () => {
    expect(scenarioAvailable('INR_TO_INR')).toBe(true);
    expect(availableScenarios()).toContain('INR_TO_INR');
  });

  it('is unavailable in production until the collateral addendum exists', () => {
    enterProduction();
    expect(scenarioAvailable('INR_TO_INR')).toBe(false);
    expect(availableScenarios()).not.toContain('INR_TO_INR');
  });

  it('does not disable the two approved corridors', () => {
    enterProduction();
    expect(scenarioAvailable('INR_TO_USDT')).toBe(true);
    expect(scenarioAvailable('USDT_TO_INR')).toBe(true);
  });

  it('is still present in the product vocabulary — it is disabled, not removed', async () => {
    const { SCENARIOS, SCENARIO } = await import('@/lib/scenario');
    expect(SCENARIOS).toContain('INR_TO_INR');
    expect(SCENARIO.INR_TO_INR.title).toBe('Protected payment');
  });
});

describe('the sandbox identity path cannot be reached in production', () => {
  it('derives sandbox roles only in the sandbox', () => {
    expect(sandboxIdentityEnabled()).toBe(true);
    // DEL-03 removed the operator half entirely: authority is a role_grant
    // row, never a spelling. Only the unverified fixture survives.
    expect(sandboxRolesForEmail('ops@example.com').isOperator).toBe(false);
    expect(sandboxRolesForEmail('new@example.com').isVerified).toBe(false);
  });

  it('refuses role derivation in production', () => {
    enterProduction();
    expect(sandboxIdentityEnabled()).toBe(false);
    expect(() => sandboxRolesForEmail('ops@example.com')).toThrow(AdapterUnavailableError);
    expect(() => assertSandboxIdentityAllowed()).toThrow(/DEL-03/);
  });

  it('refuses sign-in in production BEFORE any database write', async () => {
    enterProduction();
    await expect(signInSandbox(`prod-attempt-${Date.now()}@example.com`)).rejects.toThrow(
      AdapterUnavailableError,
    );

    // Nothing was created: the guard runs ahead of the upsert.
    const { getPool } = await import('@/server/db/pool');
    const { rows } = await getPool().query(
      `SELECT 1 FROM sandbox.app_user WHERE email LIKE 'prod-attempt-%'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot mint an operator in production, however the address is spelled', async () => {
    enterProduction();
    for (const email of ['ops@x.com', 'OPS@x.com', 'ops@anything.example']) {
      await expect(signInSandbox(email)).rejects.toThrow(AdapterUnavailableError);
    }
  });

  it('and cannot mint one in the SANDBOX either — DEL-03 removed the prefix', async () => {
    const user = await signInSandbox(`ops-sandbox-${Date.now()}@example.com`);
    expect(user.isOperator).toBe(false);
  });
});
