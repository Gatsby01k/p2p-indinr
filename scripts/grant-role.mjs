#!/usr/bin/env node
/**
 * The out-of-band administrative boundary.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THIS IS THE ONLY WAY ANYBODY BECOMES AN OPERATOR.                 │
 * │                                                                    │
 * │  It runs on an administrator's own machine, against the database,  │
 * │  with credentials the web application never has. It is not         │
 * │  reachable over HTTP, it is not imported by any route, and it      │
 * │  cannot be triggered by a request.                                 │
 * │                                                                    │
 * │  Three independent protections, so this being careless is not      │
 * │  sufficient to cause harm:                                         │
 * │    · `granted_via` accepts only CLI or MIGRATION — a CHECK         │
 * │      constraint makes a web-issued grant unrepresentable;          │
 * │    · `role_grant_not_self` refuses a self-grant;                   │
 * │    · a written reason of at least eight characters is required,    │
 * │      because a grant nobody explained is a grant nobody can audit. │
 * └────────────────────────────────────────────────────────────────────┘
 *
 *   node scripts/grant-role.mjs grant <email> OPERATOR "why this person"
 *   node scripts/grant-role.mjs revoke <email> OPERATOR
 *   node scripts/grant-role.mjs list
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Same minimal `.env.local` reader the database script uses. */
function loadEnvLocal() {
  const file = path.join(ROOT, '.env.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadEnvLocal();

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgres://inrp2p_sandbox:sandbox-local-only@127.0.0.1:55433/inrp2p_sandbox';

function isRemote(url) {
  try {
    const h = new URL(url).hostname;
    return !(h === 'localhost' || h === '127.0.0.1' || h === '::1');
  } catch {
    return false;
  }
}

const ROLES = new Set(['OPERATOR', 'REVIEWER', 'ADMIN']);

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const client = new pg.Client(
    isRemote(DATABASE_URL)
      ? { connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }
      : { connectionString: DATABASE_URL },
  );
  await client.connect();

  try {
    if (command === 'list') {
      const { rows } = await client.query(
        `SELECT u.email, u.telegram_username, g.role, g.granted_at, g.granted_via, g.reason
           FROM sandbox.role_grant g
           JOIN sandbox.app_user u ON u.user_id = g.user_id
          WHERE g.revoked_at IS NULL
          ORDER BY g.granted_at DESC`,
      );
      if (rows.length === 0) {
        console.log('No live role grants.');
        return;
      }
      for (const r of rows) {
        console.log(
          `${(r.email ?? r.telegram_username ?? '(telegram)').padEnd(34)} ${r.role.padEnd(9)} ` +
            `via ${r.granted_via.padEnd(9)} ${new Date(r.granted_at).toISOString()}  ${r.reason}`,
        );
      }
      return;
    }

    if (command !== 'grant' && command !== 'revoke') {
      console.error(
        'usage:\n' +
          '  node scripts/grant-role.mjs grant  <email> <OPERATOR|REVIEWER|ADMIN> "<reason>"\n' +
          '  node scripts/grant-role.mjs revoke <email> <OPERATOR|REVIEWER|ADMIN>\n' +
          '  node scripts/grant-role.mjs list',
      );
      process.exit(2);
    }

    const [email, role, reason] = rest;
    if (!email || !ROLES.has(role)) {
      console.error(`Unknown role "${role}". One of: ${[...ROLES].join(', ')}`);
      process.exit(2);
    }

    const { rows: users } = await client.query(
      `SELECT user_id FROM sandbox.app_user WHERE lower(email) = lower($1)`,
      [email],
    );
    if (!users[0]) {
      console.error(`No account with the address ${email}.`);
      process.exit(1);
    }
    const userId = users[0].user_id;

    if (command === 'grant') {
      if (!reason || reason.trim().length < 8) {
        console.error('A grant needs a written reason of at least eight characters.');
        process.exit(2);
      }
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO sandbox.role_grant (user_id, role, granted_by, granted_via, reason)
         VALUES ($1,$2,NULL,'CLI',$3)
         ON CONFLICT DO NOTHING`,
        [userId, role, reason.trim()],
      );
      await syncAndAudit(client, userId, role, 'ROLE_GRANT', reason.trim());
      await client.query('COMMIT');
      console.log(`Granted ${role} to ${email}. Their live sessions must sign in again.`);
      return;
    }

    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE sandbox.role_grant SET revoked_at = now(), revoked_by = NULL
        WHERE user_id = $1 AND role = $2 AND revoked_at IS NULL`,
      [userId, role],
    );
    if (rowCount !== 1) {
      await client.query('ROLLBACK');
      console.error(`${email} has no live ${role} grant.`);
      process.exit(1);
    }
    await syncAndAudit(client, userId, role, 'ROLE_REVOKE', 'Revoked via CLI');
    await client.query('COMMIT');
    console.log(`Revoked ${role} from ${email}. Their sessions are invalidated immediately.`);
  } finally {
    await client.end();
  }
}

/**
 * Keep the cached flag honest, bump the session version, and audit.
 *
 * The version bump is what makes a REVOKE take effect now rather than
 * whenever a session happens to expire.
 */
async function syncAndAudit(client, userId, role, action, reason) {
  await client.query(
    `UPDATE sandbox.app_user u
        SET is_operator = EXISTS (
          SELECT 1 FROM sandbox.role_grant g
           WHERE g.user_id = u.user_id AND g.role = 'OPERATOR' AND g.revoked_at IS NULL),
            session_version = u.session_version + 1
      WHERE u.user_id = $1`,
    [userId],
  );
  await client.query(
    `INSERT INTO sandbox.audit_event
       (actor_id, action, subject_kind, subject_id, to_state, outcome, detail)
     VALUES (NULL, $2, 'user', $1, $3, 'OK', $4)`,
    [userId, action, role, JSON.stringify({ role, via: 'CLI', reason })],
  );
}

await main();
