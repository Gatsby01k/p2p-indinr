import { NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { outboxHandlers, recoverStaleLeases, runOnce } from '@/services';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * One outbox pass, invoked by the scheduler.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE WORKER WAS ONE-SHOT BY DESIGN AND UNREACHABLE IN PRACTICE.    │
 * │                                                                    │
 * │  `runOnce` is deliberately not a loop: a `while (true)` inside a   │
 * │  request process is how a function is killed mid-handler holding   │
 * │  a lease. The runbook says so, and says the scheduler is an        │
 * │  EXTERNAL readiness dependency — but no scheduler could call it,   │
 * │  because nothing exposed it. A deployment's outbox would never     │
 * │  drain, and the only symptom would be a backlog readiness reports  │
 * │  as DEGRADED.                                                      │
 * │                                                                    │
 * │  WHY A SHARED SECRET AND NOT A SESSION.                            │
 * │                                                                    │
 * │  There is no person here. A cron job holds no cookie and has no    │
 * │  second factor, so a session check would make this uncallable by   │
 * │  the only thing meant to call it. The credential is therefore a    │
 * │  bearer secret held by the scheduler, compared in constant time —  │
 * │  and it FAILS CLOSED: with `WORKER_TICK_SECRET` unset the endpoint │
 * │  is 503 and runs nothing, so a deployment that forgot to set it    │
 * │  does not quietly expose a lever to the internet.                  │
 * │                                                                    │
 * │  WHAT AN ATTACKER WOULD GET even holding it: the worker drains     │
 * │  events that already exist. It creates nothing, moves no value,    │
 * │  reads nothing back to the caller beyond four counts, and every    │
 * │  handler it calls is idempotent — so the worst an extra call does  │
 * │  is work that was going to happen a minute later.                  │
 * └────────────────────────────────────────────────────────────────────┘
 */

/** Constant-time compare of two secrets of any length. */
function secretMatches(presented: string, expected: string): boolean {
  // Hash first so the comparison is over equal-length buffers; comparing
  // raw strings leaks the length through the early return.
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<NextResponse> {
  const expected = process.env.WORKER_TICK_SECRET ?? '';
  if (expected.trim().length < 16) {
    return NextResponse.json(
      { ok: false, message: 'The worker scheduler credential is not configured.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented || !secretMatches(presented, expected)) {
    // No detail. A scheduler knows whether it holds the secret; anybody
    // else learns nothing from the difference between wrong and absent.
    return NextResponse.json(
      { ok: false },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  /*
   * Lease recovery FIRST, and every pass.
   *
   * A worker killed between claiming and finishing leaves rows leased to
   * a process that no longer exists. Recovering before claiming is what
   * makes a crash survivable without anybody being paged: the lapsed
   * lease is released and this pass picks the event up. Handlers are
   * idempotent, so re-running one that had already succeeded is
   * harmless.
   */
  const recovered = await recoverStaleLeases();
  const result = await runOnce(outboxHandlers());

  return NextResponse.json(
    { ok: true, recovered, ...result },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
