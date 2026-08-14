import 'server-only';
import { getPool, type Tx } from '@/server/db/pool';

/**
 * Where the system stops and asks a human.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE SITUATION THIS EXISTS FOR:                                    │
 * │                                                                    │
 * │  A USDT deposit confirms. A dispute is ruled. The value is         │
 * │  released to the counterparty. THEN the chain reorganises and the  │
 * │  deposit is withdrawn.                                             │
 * │                                                                    │
 * │  The value is gone. There are three things the software could do   │
 * │  and two of them are unacceptable:                                 │
 * │                                                                    │
 * │    · post a compensating entry from nowhere — inventing value      │
 * │      that does not exist, which is a lie in the ledger;            │
 * │    · debit the counterparty who received it — taking money from    │
 * │      somebody who did nothing wrong, on the say-so of an           │
 * │      automated process;                                            │
 * │    · STOP, change nothing, and record exactly what happened for a  │
 * │      person to decide.                                             │
 * │                                                                    │
 * │  This module is the third option. It writes an incident and moves  │
 * │  no value. That is not a limitation to be fixed later — it is the  │
 * │  correct behaviour, and any future automation must justify itself  │
 * │  against it rather than replace it silently.                       │
 * └────────────────────────────────────────────────────────────────────┘
 */

export type IncidentKind =
  | 'REORG_AFTER_DISPOSAL'
  | 'LATE_EVENT_AFTER_RESOLUTION'
  | 'LOCK_STATE_DIVERGENCE';

export interface Incident {
  readonly incidentId: string;
  readonly dealId: string;
  readonly kind: IncidentKind;
  readonly state: string;
}

/**
 * Raise an incident, or join the one already open.
 *
 * `ON CONFLICT DO NOTHING` against the partial unique index means a
 * provider redelivering the same bad news joins the existing ticket
 * rather than opening fifty. The detail of the FIRST report is kept:
 * that is the one closest to the event.
 */
export async function raiseIncident(
  tx: Tx,
  input: {
    readonly dealId: string;
    readonly kind: IncidentKind;
    readonly detail: Record<string, unknown>;
  },
): Promise<Incident> {
  const { rows } = await tx.query(
    `INSERT INTO sandbox.deal_incident (deal_id, kind, detail)
     VALUES ($1,$2,$3)
     ON CONFLICT (deal_id, kind) WHERE state <> 'CLOSED' DO NOTHING
     RETURNING incident_id, deal_id, kind, state`,
    [input.dealId, input.kind, JSON.stringify(input.detail)],
  );

  if (rows[0]) {
    return {
      incidentId: rows[0].incident_id as string,
      dealId: input.dealId,
      kind: input.kind,
      state: rows[0].state as string,
    };
  }

  const { rows: existing } = await tx.query(
    `SELECT incident_id, deal_id, kind, state FROM sandbox.deal_incident
      WHERE deal_id = $1 AND kind = $2 AND state <> 'CLOSED'`,
    [input.dealId, input.kind],
  );
  return {
    incidentId: existing[0]!.incident_id as string,
    dealId: input.dealId,
    kind: input.kind,
    state: existing[0]!.state as string,
  };
}

export async function openIncidentsFor(dealId: string): Promise<readonly Incident[]> {
  const { rows } = await getPool().query(
    `SELECT incident_id, deal_id, kind, state FROM sandbox.deal_incident
      WHERE deal_id = $1 AND state <> 'CLOSED' ORDER BY opened_at`,
    [dealId],
  );
  return rows.map((r) => ({
    incidentId: r.incident_id as string,
    dealId: r.deal_id as string,
    kind: r.kind as IncidentKind,
    state: r.state as string,
  }));
}

/**
 * Is the value behind this deal still ours to dispose of?
 *
 * Returns false once the lock has been settled — released or refunded —
 * because at that point the value belongs to somebody's balance and an
 * automated reversal would be taking it back from them.
 */
export async function valueStillDisposable(tx: Tx, dealId: string): Promise<boolean> {
  const { rows } = await tx.query(`SELECT state FROM inrp2p.value_lock WHERE deal_id = $1`, [
    dealId,
  ]);
  return rows[0] !== undefined && rows[0].state === 'LOCKED';
}
