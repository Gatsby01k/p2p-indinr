import 'server-only';
import { getPool } from '@/server/db/pool';
import { deploymentMode } from '@/server/adapters/mode';
import { valueProtectionAvailable } from '@/server/adapters/valueProtection';
import { inrRailAvailable } from '@/server/adapters/inrRail';
import { usdtRailAvailable } from '@/server/adapters/usdtRail';
import { evidenceAvailable } from '@/server/adapters/evidenceStorage';
import { screeningAvailable } from '@/server/risk/screening';
import { loadConfig, validateConfig, EXPECTED_SCHEMA_VERSION } from './config';

/**
 * Liveness, readiness, and the detailed operational view.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THREE DIFFERENT QUESTIONS, THREE DIFFERENT ANSWERS.               │
 * │                                                                    │
 * │  LIVENESS: is this process running? A restart fixes a `false`.     │
 * │  READINESS: may this process take traffic? A `false` means route   │
 * │             around it — restarting will not help.                  │
 * │  STATUS:    what exactly is wrong? Authenticated only.             │
 * │                                                                    │
 * │  Conflating liveness and readiness is how a deployment restarts a  │
 * │  healthy process in a loop because a database was briefly slow.    │
 * │                                                                    │
 * │  THE PUBLIC RESPONSES CARRY NO DETAIL. Not a database name, not a  │
 * │  missing variable, not a policy value, not a version. A readiness  │
 * │  endpoint is reachable by anybody who can find it, and a detailed  │
 * │  one is a free reconnaissance report.                              │
 * └────────────────────────────────────────────────────────────────────┘
 */

export type CheckStatus = 'PASS' | 'DEGRADED' | 'FAIL';

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  /** Safe for an AUTHENTICATED operator. Never in a public response. */
  readonly detail: string;
  /**
   * A DEGRADED optional integration does not stop traffic. A FAIL on a
   * mandatory one does — that is the whole distinction.
   */
  readonly mandatory: boolean;
}

export interface Readiness {
  readonly ready: boolean;
  readonly checks: readonly Check[];
}

const pass = (name: string, detail: string, mandatory = true): Check => ({
  name,
  status: 'PASS',
  detail,
  mandatory,
});
const fail = (name: string, detail: string, mandatory = true): Check => ({
  name,
  status: 'FAIL',
  detail,
  mandatory,
});
const degraded = (name: string, detail: string): Check => ({
  name,
  status: 'DEGRADED',
  detail,
  mandatory: false,
});

/**
 * Liveness: the process is up and can execute code.
 *
 * Deliberately does NOT touch the database. A liveness probe that fails
 * on a slow query gets a healthy process killed and restarted into the
 * same slow database, repeatedly.
 */
export function liveness(): { alive: true; version: string } {
  return { alive: true, version: loadConfig().appVersion };
}

export async function readiness(): Promise<Readiness> {
  const config = loadConfig();
  const checks: Check[] = [];

  /* ---- Configuration ---- */
  const verdict = validateConfig(config);
  checks.push(
    verdict.ok
      ? pass('config', `mode=${config.mode}`)
      : fail('config', verdict.problems.join('; ')),
  );

  /* ---- Sandbox must not be serving production ---- */
  checks.push(
    config.mode === 'production' && deploymentMode() !== 'PRODUCTION'
      ? fail('deployment-mode', 'sandbox adapters are active in a production deployment')
      : pass('deployment-mode', deploymentMode()),
  );

  /* ---- Database, under the role the app actually uses ---- */
  let schemaVersion: number | null = null;
  try {
    const { rows } = await getPool().query(
      `SELECT current_user AS role,
              (SELECT version FROM sandbox.schema_state LIMIT 1) AS version,
              now() AS db_now`,
    );
    const role = rows[0]!.role as string;
    schemaVersion = rows[0]!.version === null ? null : Number(rows[0]!.version);

    checks.push(pass('database', `connected as ${role}`));

    /*
     * THE ROLE CHECK.
     *
     * A production runtime connecting as the owner is the finding every
     * stage since DEL-04 has carried. It is now a readiness FAILURE, so
     * a deployment that regresses cannot take traffic.
     */
    if (config.mode === 'production' && (role === 'postgres' || role.endsWith('_sandbox'))) {
      checks.push(fail('database-role', `production is connected as a privileged role (${role})`));
    } else {
      checks.push(pass('database-role', role));
    }

    /* ---- Clock sanity ---- */
    const skewMs = Math.abs(Date.now() - (rows[0]!.db_now as Date).getTime());
    checks.push(
      skewMs > 30_000
        ? fail('clock', `application and database clocks differ by ${Math.round(skewMs / 1000)}s`)
        : pass('clock', `skew ${Math.round(skewMs / 1000)}s`),
    );
  } catch (error) {
    // The message is kept for the AUTHENTICATED view only.
    checks.push(fail('database', error instanceof Error ? error.message : 'unreachable'));
  }

  /* ---- Schema version ---- */
  checks.push(
    schemaVersion === EXPECTED_SCHEMA_VERSION
      ? pass('schema-version', `v${schemaVersion}`)
      : fail(
          'schema-version',
          `expected v${EXPECTED_SCHEMA_VERSION}, database reports ${schemaVersion ?? 'none'}`,
        ),
  );

  /* ---- Mandatory production adapters ---- */
  if (config.mode === 'production') {
    for (const [name, probe] of adapterProbes()) {
      checks.push(
        probe() ? pass(`adapter:${name}`, 'available') : fail(`adapter:${name}`, 'unavailable'),
      );
    }
  }

  /* ---- Active policies ---- */
  try {
    const { rows } = await getPool().query(
      `SELECT
         (SELECT count(*) FROM sandbox.fee_policy WHERE state='ACTIVE')  AS fee,
         (SELECT count(*) FROM sandbox.risk_policy WHERE state='ACTIVE') AS risk`,
    );
    const fee = Number(rows[0]!.fee);
    const risk = Number(rows[0]!.risk);
    checks.push(
      fee > 0 && risk > 0
        ? pass('policies', `fee=${fee} risk=${risk}`)
        : fail('policies', `fee=${fee} risk=${risk}`),
    );
  } catch {
    checks.push(fail('policies', 'unreadable'));
  }

  /* ---- Outbox health. DEGRADED, not FAIL: a backlog is a problem for
   * an operator to see, and refusing traffic would stop the very work
   * that drains it. */
  try {
    const { rows } = await getPool().query(
      `SELECT count(*) FILTER (WHERE state='PENDING' AND next_attempt_at < now() - interval '5 minutes') AS lagging,
              count(*) FILTER (WHERE state='DEAD_LETTER') AS dead
         FROM sandbox.outbox_event`,
    );
    const lagging = Number(rows[0]!.lagging);
    const dead = Number(rows[0]!.dead);
    checks.push(
      lagging > 0 || dead > 0
        ? degraded('outbox', `lagging=${lagging} deadLetter=${dead}`)
        : pass('outbox', 'drained', false),
    );
  } catch {
    checks.push(degraded('outbox', 'unreadable'));
  }

  /* ---- Emergency pause. Reported, never a failure: a pause is a
   * DELIBERATE state and a paused platform is still healthy. */
  try {
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.control_switch WHERE paused`,
    );
    const paused = Number(rows[0]!.n);
    checks.push(
      paused > 0
        ? degraded('controls', `${paused} scope(s) paused`)
        : pass('controls', 'running', false),
    );
  } catch {
    checks.push(degraded('controls', 'unreadable'));
  }

  const ready = checks.every((c) => c.status !== 'FAIL' || !c.mandatory);
  return { ready, checks };
}

/**
 * Mandatory production adapters, probed without throwing.
 *
 * Imported statically rather than lazily. A dynamic `require` here would
 * hide a broken import until a readiness check ran — which is the one
 * moment the check must be reliable — and the probes are cheap, pure
 * mode reads with no side effects.
 *
 * Every one of these returns `false` in production, because none of
 * these providers is implemented in this repository. A production
 * readiness failure here is the correct and intended answer.
 */
function adapterProbes(): readonly (readonly [string, () => boolean])[] {
  return [
    ['value-protection', () => safeProbe(valueProtectionAvailable)],
    ['inr-rail', () => safeProbe(inrRailAvailable)],
    ['usdt-rail', () => safeProbe(usdtRailAvailable)],
    ['evidence-storage', () => safeProbe(evidenceAvailable)],
    ['screening', () => safeProbe(screeningAvailable)],
  ] as const;
}

function safeProbe(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

/**
 * The PUBLIC readiness response.
 *
 * A boolean and nothing else. No check names, no versions, no reasons —
 * an unauthenticated caller learns whether to route traffic here and
 * not one thing more.
 */
export async function publicReadiness(): Promise<{ ready: boolean }> {
  const result = await readiness();
  return { ready: result.ready };
}
