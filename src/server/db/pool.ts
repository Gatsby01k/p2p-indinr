import 'server-only';
import { Pool, types } from 'pg';

/**
 * The PostgreSQL connection pool.
 *
 * Works in two environments without a code change:
 *
 *   LOCAL      an embedded PostgreSQL started by `npm run db:start`, over a
 *              plain TCP socket on 127.0.0.1.
 *   SERVERLESS a hosted PostgreSQL (Neon, Supabase, Vercel Postgres) over
 *              TLS, where each function instance owns a small short-lived
 *              pool rather than one long-lived pool per process.
 *
 * EXACTNESS: `pg` parses `int8` (OID 20) and `numeric` (OID 1700) into
 * JavaScript numbers by default, silently losing precision above 2^53. Both
 * are forced back to strings here and converted with `BigInt` at the edges.
 * No money-shaped value is ever a JS `number` in this codebase.
 */
types.setTypeParser(20, (v) => v); // int8    -> string
types.setTypeParser(1700, (v) => v); // numeric -> string

const globalForPool = globalThis as unknown as { __inrp2pPool?: Pool };

/** True for a local loopback database, false for anything hosted. */
function isLoopback(connectionString: string): boolean {
  try {
    const host = new URL(connectionString).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

export function getPool(): Pool {
  if (globalForPool.__inrp2pPool) return globalForPool.__inrp2pPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set.\n' +
        '  Local:      run `npm run db:start` (starts an embedded PostgreSQL).\n' +
        '  Deployment: set DATABASE_URL to a hosted PostgreSQL connection string,\n' +
        '              then run `npm run db:migrate` against it once.',
    );
  }

  const remote = !isLoopback(connectionString);

  const pool = new Pool({
    connectionString,
    /*
     * Serverless sizing. Every function instance builds its own pool, so a
     * large `max` multiplied by the instance count exhausts the database's
     * connection limit long before it helps throughput. Small pool, short
     * idle timeout, so instances release connections between invocations.
     *
     * `PGPOOL_MAX` overrides it — the concurrency tests raise it to model
     * genuine contention on one machine.
     */
    max: Number(process.env.PGPOOL_MAX ?? (remote ? 3 : 10)),
    idleTimeoutMillis: remote ? 10_000 : 30_000,
    connectionTimeoutMillis: 10_000,
    /*
     * Hosted providers terminate non-TLS connections. `rejectUnauthorized`
     * stays false because Neon and Supabase present certificates signed by
     * their own intermediates, which the Node bundle does not carry; the
     * channel is still encrypted. A provider-supplied CA can be pinned with
     * PGSSLROOTCERT when one is available.
     */
    ...(remote ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  // A pool error on an idle client is emitted on the pool, and an unhandled
  // 'error' event would take the process down. Log and let `pg` discard it.
  pool.on('error', (err) => {
    console.error('[inrp2p] idle client error', err.message);
  });

  globalForPool.__inrp2pPool = pool;
  return pool;
}

/** Decode a bigint column that `pg` has been told to return as a string. */
export function toBigInt(raw: unknown): bigint {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw !== 'string') {
    throw new TypeError(`expected string from int8 column, got ${typeof raw}`);
  }
  if (!/^-?(0|[1-9][0-9]*)$/.test(raw)) {
    throw new RangeError(`non-integer value from int8 column: ${raw}`);
  }
  return BigInt(raw);
}

export type Tx = {
  query: Pool['query'];
};

/**
 * Run `fn` inside a single database transaction on a single dedicated
 * connection.
 *
 * This is the only way a sandbox mutation may touch the database. Taking a
 * connection from the pool per statement would put concurrent statements on
 * different backends, defeating `FOR UPDATE` and making the single-winner
 * Join guarantee meaningless.
 */
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client as unknown as Tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the connection is already broken; the pool will discard it */
    }
    throw err;
  } finally {
    client.release();
  }
}
