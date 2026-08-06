import 'server-only';
import { cache } from 'react';
import { getPool } from '@/server/db/pool';
import { countUnread } from './identity';
import { requireUser } from './session';
import type { SessionUser } from '@/lib/sandboxContract';

/**
 * The chrome bundle — everything the navigation needs, fetched once.
 *
 * Wrapped in React's `cache`, so the layout and every page in a single
 * render share one round trip instead of each asking again. Without this a
 * page with a header, a rail and a tab bar would count unread notifications
 * three times per navigation.
 */

export interface Chrome {
  readonly user: SessionUser;
  readonly unread: number;
  /** Open disputes across the platform. Operators only; 0 for everyone else. */
  readonly disputeCount: number;
}

export const getChrome = cache(async (): Promise<Chrome> => {
  const user = await requireUser();
  const [unread, disputeCount] = await Promise.all([
    countUnread(user),
    user.isOperator ? openDisputeCount() : Promise.resolve(0),
  ]);
  return { user, unread, disputeCount };
});

async function openDisputeCount(): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM sandbox.dispute WHERE state <> 'RESOLVED'`,
  );
  return Number(rows[0]?.n ?? 0);
}
