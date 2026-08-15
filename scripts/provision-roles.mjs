#!/usr/bin/env node
/**
 * Grant LOGIN to the least-privilege roles, out of band.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  PASSWORDS COME FROM THE ENVIRONMENT AND GO NOWHERE ELSE.        │
 * │                                                                  │
 * │  Migration 0013 creates the roles NOLOGIN precisely so that a    │
 * │  credential never appears in a file under version control. This  │
 * │  script reads one from the environment, sets it, and prints      │
 * │  nothing but the role name.                                      │
 * │                                                                  │
 * │  It is deliberately NOT part of `db:migrate`: a migration runs   │
 * │  on every deploy, and rotating a database password on every      │
 * │  deploy is not a thing anybody wants.                            │
 * └──────────────────────────────────────────────────────────────────┘
 *
 *   INRP2P_WEB_PASSWORD=… INRP2P_WORKER_PASSWORD=… \
 *     node scripts/provision-roles.mjs
 */

import pg from 'pg';

// `pg` is CommonJS. A named import resolves at run time rather than
// at parse time, so it fails only when the script is actually used —
// which is the worst moment to discover an import error.
const { Client } = pg;

const ROLES = [
  ['inrp2p_web', 'INRP2P_WEB_PASSWORD'],
  ['inrp2p_worker', 'INRP2P_WORKER_PASSWORD'],
  ['inrp2p_readonly', 'INRP2P_READONLY_PASSWORD'],
  ['inrp2p_migrator', 'INRP2P_MIGRATOR_PASSWORD'],
];

const DATABASE_URL =
  process.env.ADMIN_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://inrp2p_sandbox:sandbox-local-only@127.0.0.1:55433/inrp2p_sandbox';

/**
 * A password long enough to be worth having.
 *
 * Refused rather than warned about: a 6-character database password on
 * an internet-reachable instance is a breach with a delay attached.
 */
function validate(role, password) {
  if (password === undefined || password.length === 0) return `${role}: no password provided`;
  if (password.length < 24) return `${role}: password must be at least 24 characters`;
  return null;
}

async function main() {
  const requested = ROLES.filter(([, envName]) => process.env[envName] !== undefined);

  if (requested.length === 0) {
    console.error('No role passwords in the environment. Nothing to do.');
    console.error('Expected one or more of:', ROLES.map(([, e]) => e).join(', '));
    process.exit(2);
  }

  const problems = requested
    .map(([role, envName]) => validate(role, process.env[envName]))
    .filter((p) => p !== null);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    for (const [role, envName] of requested) {
      /*
       * TWO STEPS, because a `DO` block cannot take bind parameters.
       *
       * PostgreSQL builds the statement from BOUND values — `%I` quotes
       * the identifier, `%L` quotes and escapes the literal — and we
       * then execute the text it returned. The password is escaped by
       * the database rather than by string concatenation here, which is
       * the part that matters.
       */
      const { rows } = await client.query(
        `SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS stmt`,
        [role, process.env[envName]],
      );
      await client.query(rows[0].stmt);
      // The NAME only. Never the value, and never a fragment of it.
      console.log(`granted LOGIN: ${role} (from ${envName})`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  // The message may quote SQL; the password is never in the SQL text
  // because it travelled as a bound parameter.
  console.error('provisioning failed:', error.message);
  process.exit(1);
});
