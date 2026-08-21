import 'server-only';

/**
 * The one typed configuration boundary.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  PRODUCTION HAS NO DEFAULTS. NOT ONE.                              │
 * │                                                                    │
 * │  Every insecure default this file could offer is a way for a       │
 * │  misconfigured deployment to look healthy: a fallback signing key, │
 * │  a permissive origin, a sandbox adapter quietly serving real       │
 * │  customers. So production reads what is set and REFUSES when       │
 * │  something mandatory is missing, and the refusal names the         │
 * │  variable rather than its value.                                   │
 * │                                                                    │
 * │  Nothing here is exported to the client. `server-only` makes that  │
 * │  a build error rather than a review comment, and no value read     │
 * │  here is ever placed in a health response, a log line or an error  │
 * │  object.                                                           │
 * └────────────────────────────────────────────────────────────────────┘
 */

export type RuntimeMode = 'development' | 'test' | 'staging' | 'production';

export interface AppConfig {
  readonly mode: RuntimeMode;
  readonly sandboxAcknowledged: boolean;
  readonly databaseUrl: string | null;
  readonly databaseSslRequired: boolean;
  readonly poolMax: number;
  readonly statementTimeoutMs: number;
  readonly appVersion: string;
  readonly expectedSchemaVersion: number;
  /** Names only. A missing one is reported; a present one is never echoed. */
  readonly presentSecrets: readonly string[];
  readonly missingMandatory: readonly string[];
  readonly trustedOrigins: readonly string[];
  readonly trustProxyHops: number;
}

/**
 * Secrets production cannot start without.
 *
 * Deliberately a list of NAMES. This module never returns a secret's
 * value to a caller — the modules that need one read it themselves —
 * so a configuration report can be rendered to an operator without
 * becoming a way to exfiltrate the key.
 */
export const MANDATORY_PRODUCTION_SECRETS = [
  'DATABASE_URL',
  'SESSION_SIGNING_KEY',
  'EVIDENCE_STORAGE_URL',
  'SCREENING_PROVIDER_KEY',
  'RAIL_WEBHOOK_SECRET',
  'RATE_LIMIT_REDIS_URL',
] as const;

/**
 * The schema version this build was written against.
 *
 * Compared with `sandbox.schema_state` at readiness. A web process
 * running against a database it was not built for is how a "successful"
 * deploy silently writes the wrong shape.
 */
export const EXPECTED_SCHEMA_VERSION = 15;

function readMode(): RuntimeMode {
  const explicit = process.env.INRP2P_MODE;
  if (explicit === 'staging' || explicit === 'production') return explicit;
  if (explicit === 'development' || explicit === 'test') return explicit;
  if (process.env.NODE_ENV === 'test') return 'test';
  // The DEFAULT for a production build is `production`. A deployment
  // that forgot to set the mode must not inherit development behaviour.
  return process.env.NODE_ENV === 'production' ? 'production' : 'development';
}

function intFrom(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return fallback;
  const value = Number(raw);
  return value < min ? min : value > max ? max : value;
}

export function loadConfig(): AppConfig {
  const mode = readMode();
  const isProduction = mode === 'production';

  const present: string[] = [];
  const missing: string[] = [];
  for (const name of MANDATORY_PRODUCTION_SECRETS) {
    const value = process.env[name];
    if (value !== undefined && value.trim().length > 0) present.push(name);
    else if (isProduction) missing.push(name);
  }

  /*
   * TLS is REQUIRED in production and cannot be switched off by a
   * variable. An unencrypted connection carrying session tokens and
   * bank references across a provider's network is not a configuration
   * choice this system offers.
   */
  const databaseUrl = process.env.DATABASE_URL ?? null;
  const databaseSslRequired = isProduction;

  const trustedOrigins = (process.env.TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  if (isProduction && trustedOrigins.length === 0) missing.push('TRUSTED_ORIGINS');

  return {
    mode,
    sandboxAcknowledged: process.env.INRP2P_SANDBOX === 'true',
    databaseUrl,
    databaseSslRequired,
    // Bounded: an unbounded pool exhausts the database's connection slots
    // long before it helps throughput.
    poolMax: intFrom('DATABASE_POOL_MAX', 10, 1, 50),
    statementTimeoutMs: intFrom('DATABASE_STATEMENT_TIMEOUT_MS', 15_000, 1_000, 120_000),
    /*
     * An explicit APP_VERSION wins; on Vercel the platform-stamped commit
     * SHA identifies the deployment when nobody set one. Without the
     * fallback, production liveness reported "dev" and the one question a
     * deploy verification asks — is the running build the one we verified?
     * — could not be answered from the health endpoint.
     */
    appVersion:
      process.env.APP_VERSION ??
      process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ??
      'dev',
    expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
    presentSecrets: present,
    missingMandatory: missing,
    trustedOrigins,
    trustProxyHops: intFrom('TRUST_PROXY_HOPS', 0, 0, 5),
  };
}

export interface ConfigVerdict {
  readonly ok: boolean;
  readonly mode: RuntimeMode;
  /** Names and reasons. Never a value. */
  readonly problems: readonly string[];
}

/**
 * Validate configuration at startup.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE SANDBOX-IN-PRODUCTION CHECK IS THE MOST IMPORTANT ONE HERE.   │
 * │                                                                    │
 * │  `INRP2P_SANDBOX=true` in a production deployment means simulated  │
 * │  custody, simulated rails and a published webhook key serving real │
 * │  customers. It is refused outright rather than warned about.       │
 * └────────────────────────────────────────────────────────────────────┘
 */
export function validateConfig(config: AppConfig = loadConfig()): ConfigVerdict {
  const problems: string[] = [];

  if (config.mode === 'production') {
    if (config.sandboxAcknowledged) {
      problems.push(
        'INRP2P_SANDBOX is set in production: simulated custody and rails would serve real customers',
      );
    }
    for (const name of config.missingMandatory) {
      problems.push(`${name} is not set`);
    }
    if (config.databaseUrl !== null && !/^postgres(ql)?:\/\//.test(config.databaseUrl)) {
      problems.push('DATABASE_URL is not a PostgreSQL connection string');
    }
    /*
     * The web runtime must not hold the migration credential. Checked by
     * NAME, so a deployment that reuses one connection string for both
     * is caught before it runs a migration from a request handler.
     */
    if (process.env.MIGRATION_DATABASE_URL !== undefined) {
      problems.push(
        'MIGRATION_DATABASE_URL is visible to the web runtime: migration credentials belong to the deployment pipeline only',
      );
    }
  }

  return { ok: problems.length === 0, mode: config.mode, problems };
}

/**
 * Redact anything that might carry a secret before it reaches a log.
 *
 * Applied at the logging boundary rather than at each call site, because
 * the call site that forgets is the one that logs the token.
 */
const SENSITIVE_KEY =
  /(secret|token|password|passwd|key|authorization|cookie|signature|otp|seed|utr|iban|account_number|private)/i;

export function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string' && /^postgres(ql)?:\/\//.test(value)) {
    // A connection string carries a password in its userinfo.
    return '[redacted connection string]';
  }
  return value;
}

export function redactObject(input: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 4) return { '[truncated]': true };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const redacted = redactValue(key, value);
    if (redacted !== value) {
      out[key] = redacted;
      continue;
    }
    out[key] =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? redactObject(value as Record<string, unknown>, depth + 1)
        : value;
  }
  return out;
}
