import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { getPool } from '@/server/db/pool';
import { newCommandId } from '@/server/boundary/command';
import {
  approveOpsActionCommand,
  pauseControlCommand,
  proposeApprovalCommand,
  resumeControlCommand,
} from '@/services/commands';
import { grantRole, permissionsFor, type Principal } from '@/server/identity/rbac';
import { clearDeliveries, lastDeliveredTo } from '@/server/adapters/emailDelivery';
import {
  beginMfaEnrolment,
  confirmMfaEnrolment,
  redeemEmailSignIn,
  startEmailSignIn,
  verifyMfaForSession,
} from '@/server/identity/auth';
import { codeFor, stepFor } from '@/server/identity/totp';
import { recoverStaleLeases, runOnce } from '@/server/ops/outboxWorker';
import { outboxHandlers } from '@/server/ops/outboxHandlers';

/**
 * Staging rehearsal, steps 7 and 10 — the two that need a real operator
 * and a real worker rather than an HTTP call.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A REHEARSAL IS ONLY WORTH RUNNING IF IT CAN FAIL.                 │
 * │                                                                    │
 * │  Both steps here assert the REFUSAL as well as the success:        │
 * │                                                                    │
 * │    · pause is one person and resume is two, so the rehearsal       │
 * │      first tries a one-person resume and requires it to be         │
 * │      refused. A drill that only ever does the allowed thing        │
 * │      cannot tell a working control from an absent one.             │
 * │                                                                    │
 * │    · crash recovery is proved by ORPHANING a lease — writing the   │
 * │      state a killed worker leaves behind — showing the event is    │
 * │      stuck, then showing the next pass frees and delivers it.      │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Run by `scripts/staging-rehearsal.mjs` against the rehearsal cluster,
 * never against a developer's database.
 */

const unique = () => Math.random().toString(36).slice(2, 10);

async function operatorWith(roles: readonly ('OPERATOR' | 'REVIEWER')[], prefix: string) {
  clearDeliveries();
  const email = `${prefix}-${unique()}@example.com`;
  await startEmailSignIn(email);
  const signedIn = await redeemEmailSignIn({ email, secret: lastDeliveredTo(email)!.secret });
  if (!signedIn.ok) throw new Error('rehearsal fixture: sign-in');

  for (const role of roles) {
    await grantRole({
      userId: signedIn.value.userId,
      role,
      grantedBy: null,
      via: 'CLI',
      reason: `Staging rehearsal ${prefix} operator.`,
    });
  }

  const enrolment = await beginMfaEnrolment(signedIn.value.userId);
  if (!enrolment.ok) throw new Error('rehearsal fixture: enrolment');
  await confirmMfaEnrolment(signedIn.value.userId, codeFor(enrolment.value.secret, stepFor()), {
    keepSessionId: signedIn.value.sessionId,
  });
  await verifyMfaForSession({
    userId: signedIn.value.userId,
    sessionId: signedIn.value.sessionId,
    presented: codeFor(enrolment.value.secret, stepFor() + 1),
  });

  const principal: Principal = {
    userId: signedIn.value.userId,
    roles: [...roles],
    permissions: permissionsFor([...roles]),
    mfaSatisfied: true,
    mfaEnrolled: true,
  };
  return principal;
}

/* ================================================================== *
 * Step 7 · emergency pause, two-person resume
 * ================================================================== */

describe('rehearsal step 7 · pause and two-person resume', () => {
  it('one operator pauses, one operator cannot resume, two can', async () => {
    const operator = await operatorWith(['OPERATOR'], 'reh-op');
    const reviewer = await operatorWith(['REVIEWER'], 'reh-rev');

    /* ---- Pause needs ONE authorised person ---- */
    const paused = await pauseControlCommand(operator, newCommandId(), {
      scope: 'REWARDS',
      reason: 'Staging rehearsal: exercising the emergency pause.',
    });
    expect(paused.ok, 'an operator may pause alone').toBe(true);
    if (!paused.ok) return;
    const switchId = paused.value.switchId;

    const { rows: live } = await getPool().query(
      `SELECT paused FROM sandbox.control_switch WHERE switch_id = $1`,
      [switchId],
    );
    expect(live[0]!.paused).toBe(true);

    /* ---- Resume alone is REFUSED ---- */
    const alone = await resumeControlCommand(operator, newCommandId(), {
      switchId,
      approvalId: crypto.randomUUID(),
      reason: 'Staging rehearsal: attempting a one-person resume.',
    });
    expect(alone.ok, 'a one-person resume must be refused').toBe(false);
    if (!alone.ok) expect(alone.code).toBe('APPROVAL_REQUIRED');

    /* ---- Two people: propose, approve, resume ---- */
    const proposed = await proposeApprovalCommand(operator, newCommandId(), {
      actionKind: 'CORRIDOR_RESUME',
      targetRef: switchId,
      rationale: 'Staging rehearsal: the simulated incident is over.',
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    const approved = await approveOpsActionCommand(reviewer, newCommandId(), {
      approvalId: proposed.value.approvalId,
    });
    expect(approved.ok, 'a second person approves').toBe(true);

    const resumed = await resumeControlCommand(operator, newCommandId(), {
      switchId,
      approvalId: proposed.value.approvalId,
      reason: 'Staging rehearsal: resuming after approval.',
    });
    expect(resumed.ok, 'the approved resume succeeds').toBe(true);

    const { rows: after } = await getPool().query(
      `SELECT paused FROM sandbox.control_switch WHERE switch_id = $1`,
      [switchId],
    );
    expect(after[0]!.paused).toBe(false);
  });
});

/* ================================================================== *
 * Step 10 · worker crash recovery
 * ================================================================== */

describe('rehearsal step 10 · a worker that dies holding a lease', () => {
  it('leaves the event stuck, and the next pass recovers and delivers it', async () => {
    /*
     * A real event, enqueued the way the product enqueues one: an
     * intentional no-op type, so delivering it changes nothing but the
     * row's own state. The subject is a fresh uuid so this cannot
     * collide with anything else in the cluster.
     */
    const subject = crypto.randomUUID();
    const { rows: created } = await getPool().query(
      `INSERT INTO sandbox.outbox_event (event_key, event_type, subject_kind, subject_id, payload)
       VALUES ($2,'deal.joined','deal',$1,'{}'::jsonb)
       RETURNING outbox_id`,
      // `event_key` is the deduplication identity: exactly-once emission
      // is a unique index, not a convention, so the fixture supplies one.
      [subject, `rehearsal-crash-${subject}`],
    );
    const outboxId = created[0]!.outbox_id as string;

    /*
     * THE CRASH, written down rather than simulated with a kill: this is
     * exactly the row state a worker leaves when it is killed between
     * claiming and finishing — leased to a process that no longer
     * exists, with a lease that has already lapsed.
     */
    await getPool().query(
      `UPDATE sandbox.outbox_event
          SET lease_owner = 'worker-that-died',
              lease_expires_at = now() - interval '5 minutes',
              attempts = 1
        WHERE outbox_id = $1`,
      [outboxId],
    );

    const { rows: orphaned } = await getPool().query(
      `SELECT state, lease_owner FROM sandbox.outbox_event WHERE outbox_id = $1`,
      [outboxId],
    );
    expect(orphaned[0]!.state).toBe('PENDING');
    expect(orphaned[0]!.lease_owner).toBe('worker-that-died');

    /* ---- Recovery releases the lapsed lease ---- */
    const recovered = await recoverStaleLeases();
    expect(recovered, 'at least our orphan is recovered').toBeGreaterThanOrEqual(1);

    const { rows: freed } = await getPool().query(
      `SELECT lease_owner FROM sandbox.outbox_event WHERE outbox_id = $1`,
      [outboxId],
    );
    expect(freed[0]!.lease_owner).toBeNull();

    /* ---- And the next pass delivers it ---- */
    await runOnce(outboxHandlers(), { workerId: 'rehearsal-worker', limit: 200 });
    const { rows: done } = await getPool().query(
      `SELECT state FROM sandbox.outbox_event WHERE outbox_id = $1`,
      [outboxId],
    );
    expect(done[0]!.state, 'the event a dead worker was holding is delivered').toBe('DELIVERED');
  });
});
