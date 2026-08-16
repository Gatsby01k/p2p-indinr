import { NextResponse } from 'next/server';
import { liveness } from '@/services';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Liveness.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  DOES NOT TOUCH THE DATABASE, ON PURPOSE.                          │
 * │                                                                    │
 * │  A liveness probe answers one question: should this process be     │
 * │  restarted? A slow or unreachable database is not a reason to      │
 * │  restart a healthy process — doing so restarts it into the same    │
 * │  slow database, in a loop, and takes down the capacity that would  │
 * │  have served the traffic once the database recovered.              │
 * │                                                                    │
 * │  So this returns from memory and nothing else. Readiness is the    │
 * │  probe that is allowed to say "route around me".                   │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * `docs/ops/RUNBOOKS.md` §1 has referred to this pair since DEL-09 and
 * neither existed: the runbook's first instruction could not be carried
 * out. The server module was already written and tested; only the two
 * HTTP surfaces were missing.
 */
export function GET(): NextResponse {
  const { alive, version } = liveness();
  return NextResponse.json(
    { alive, version },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
