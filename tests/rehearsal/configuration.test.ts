import { afterEach, describe, expect, it } from 'vitest';
import { MANDATORY_PRODUCTION_SECRETS, loadConfig, validateConfig } from '@/server/ops/config';

/**
 * Staging rehearsal, step 2 — the configuration gate.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE POINT OF THIS STEP IS THE REFUSAL.                            │
 * │                                                                    │
 * │  Confirming that a correctly configured staging deployment starts  │
 * │  proves very little — it is going to start. What has to be         │
 * │  rehearsed is that a deployment which forgot something DOES NOT,   │
 * │  and that what it says names the variable rather than its value.   │
 * │                                                                    │
 * │  A configuration report is read during an incident, often pasted   │
 * │  into a ticket. If it echoed a secret it would be a leak with a    │
 * │  delay attached, so the last assertion here is that no value       │
 * │  reaches the verdict.                                              │
 * └────────────────────────────────────────────────────────────────────┘
 */

const original = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in original)) delete process.env[key];
  }
  Object.assign(process.env, original);
});

describe('rehearsal step 2 · configuration', () => {
  it('the staging deployment this rehearsal runs validates', () => {
    process.env.INRP2P_MODE = 'staging';
    process.env.INRP2P_SANDBOX = 'true';
    const config = loadConfig();
    const verdict = validateConfig(config);
    expect(verdict.mode).toBe('staging');
    expect(verdict.problems, verdict.problems.join('; ')).toEqual([]);
    expect(verdict.ok).toBe(true);
    // And it is an ACKNOWLEDGED sandbox, not an accident.
    expect(config.sandboxAcknowledged).toBe(true);
  });

  it('production with nothing configured refuses, and names what is missing', () => {
    process.env.INRP2P_MODE = 'production';
    delete process.env.INRP2P_SANDBOX;
    process.env.TRUSTED_ORIGINS = '';
    for (const name of MANDATORY_PRODUCTION_SECRETS) delete process.env[name];

    const verdict = validateConfig(loadConfig());
    expect(verdict.ok, 'production must not validate without its secrets').toBe(false);
    expect(verdict.problems.length).toBeGreaterThan(0);
    // Every mandatory name is accounted for.
    for (const name of MANDATORY_PRODUCTION_SECRETS) {
      expect(verdict.problems.join(' '), `${name} should be named`).toContain(name);
    }
    expect(verdict.mode).toBe('production');
  });

  it('the verdict names variables and never echoes a value', () => {
    process.env.INRP2P_MODE = 'production';
    delete process.env.INRP2P_SANDBOX;
    const canary = 'canary-secret-value-that-must-not-appear';
    for (const name of MANDATORY_PRODUCTION_SECRETS) process.env[name] = canary;
    process.env.TRUSTED_ORIGINS = 'https://example.test';

    const config = loadConfig();
    const verdict = validateConfig(config);

    /*
     * THE VERDICT is what gets read aloud, pasted into a ticket and
     * rendered on a diagnostics screen, so the verdict is what must
     * carry no values.
     *
     * `config.databaseUrl` deliberately holds the real connection string
     * — the pool needs it — and it is asserted separately below that it
     * never travels: it is not in `presentSecrets`, which is the list a
     * report is built from.
     */
    expect(JSON.stringify(verdict), 'no secret value may reach a verdict').not.toContain(canary);
    expect(config.presentSecrets.join(' '), 'names only').not.toContain(canary);
    // The names, however, ARE reported — that is what makes it useful.
    expect(config.presentSecrets).toEqual([...MANDATORY_PRODUCTION_SECRETS]);
  });
});
