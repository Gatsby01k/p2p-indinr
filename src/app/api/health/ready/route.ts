import { NextResponse } from 'next/server';
// One import, through the application-service boundary (UX-01 §9).
import { can, currentCaller, readiness } from '@/services';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Readiness.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  TWO AUDIENCES, TWO BODIES, ONE EVALUATION.                        │
 * │                                                                    │
 * │  A load balancer needs a boolean and must be able to read it       │
 * │  unauthenticated. An operator needs to know WHICH check failed.    │
 * │  Those are not the same response: a readiness endpoint is          │
 * │  reachable by anybody who can find it, and a detailed one hands    │
 * │  out the database role, the missing variable names, the schema     │
 * │  version and which adapters are absent — a free reconnaissance     │
 * │  report, refreshed on demand.                                      │
 * │                                                                    │
 * │  So the public body is `{ ready }` and NOTHING else. The itemised  │
 * │  view requires a signed-in caller holding `ops.queue.read`, the    │
 * │  same authority the Deal Desk needs, and it is the only place a    │
 * │  `detail` string is ever emitted.                                  │
 * │                                                                    │
 * │  The check itself runs once, identically, for both. A probe that   │
 * │  evaluated something cheaper for the anonymous caller would let    │
 * │  the load balancer and the operator disagree about the same        │
 * │  process.                                                          │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 503 when not ready, so an orchestrator routes around this instance
 * without needing to parse the body at all.
 */
export async function GET(): Promise<NextResponse> {
  const result = await readiness();
  const status = result.ready ? 200 : 503;
  const headers = { 'Cache-Control': 'no-store' };

  /*
   * Resolving the caller must never be able to change the verdict. A
   * database outage makes readiness false AND makes this lookup throw;
   * if that threw out of the handler the probe would return a 500 that
   * says nothing instead of a 503 that says "route around me".
   */
  const caller = await currentCaller().catch(() => null);
  const privileged = caller ? can(caller.principal, 'ops.queue.read') : false;

  if (!privileged) return NextResponse.json({ ready: result.ready }, { status, headers });

  return NextResponse.json(
    {
      ready: result.ready,
      checks: result.checks.map((c) => ({
        name: c.name,
        status: c.status,
        mandatory: c.mandatory,
        detail: c.detail,
      })),
    },
    { status, headers },
  );
}
