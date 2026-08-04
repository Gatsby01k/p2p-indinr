import 'server-only';
import { Pool, types } from 'pg';

/**
 * The single PostgreSQL connection pool for the sandbox vertical.
 *
 * EXACTNESS: `pg` parses `int8` (OID 20) and `numeric` (OID 1700) into
 * JavaScript numbers by default, which silently loses precision above 2^53.
 * Both are forced back to strings here and converted with `BigInt` at the
 * edges. No money-shaped value is ever a JS `number` in this codebase.
 */
types.setTypeParser(20, (v) => v); // int8    -> string
types.setTypeParser(1700, (v) => v); // numeric -> string

const globalForPool = globalThis as unknown as { __inrp2pPool?: Pool };

export function getPool(): Pool {
  if (globalForPool.__inrp2pPool) return globalForPool.__inrp2pPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Start the sandbox database with `npm run db:start`.');
  }

  const pool = new Pool({
    connectionString,
    max: Number(process.env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });

  // Next.js dev reloads the module graph; without this the pool leaks.
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
 * different backends, which would defeat `FOR UPDATE` and make the
 * single-winner Join guarantee meaningless.
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
