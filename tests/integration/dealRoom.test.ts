import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getPool, withTransaction } from '@/server/db/pool';
import { newCommandId, readCommand } from '@/server/boundary/command';
import { revokeRole } from '@/server/identity/rbac';
import { dealRoom } from '@/server/room/dealRoom';
import { caseNotes, caseQueue } from '@/server/room/disputes';
import { fetchEvidence } from '@/server/room/evidence';
import { messagesForDeal } from '@/server/room/chat';
import {
  addCaseNoteCommand,
  approveRulingCommand,
  beginEvidenceUploadCommand,
  cancelCommand,
  completeEvidenceUploadCommand,
  openDisputeCaseCommand,
  postDealMessageCommand,
  proposeRulingCommand,
  refundValueCommand,
  rejectRulingCommand,
  releaseValueCommand,
  requestEvidenceDownload,
} from '@/services/commands';
import type { SessionUser } from '@/server/sandbox/service';
import type { Principal } from '@/server/identity/rbac';
import { lockedDeal } from './support/rails';
import {
  balanceOf,
  bare,
  caseRow,
  dealRow,
  eicarBytes,
  lockRow,
  mismatchedBytes,
  newUser,
  operatorPrincipal,
  pngBytes,
  proposalRow,
  unique,
  withoutMfa,
} from './support/room';

/**
 * DEL-06 deal room, chat, evidence and disputes.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE PROPERTY UNDER TEST: NOBODY DECIDES ALONE.                    │
 * │                                                                    │
 * │  A participant can complain but cannot choose the outcome, and     │
 * │  complaining FREEZES the paths that would settle around them. An   │
 * │  operator can recommend but cannot execute. A second, separately   │
 * │  authorised person executes — and the money moves through the      │
 * │  DEL-04 boundary that already proved it moves exactly once.        │
 * │                                                                    │
 * │  The interesting tests are therefore the ones where somebody tries │
 * │  to shortcut that: approving their own proposal, settling a        │
 * │  disputed deal, reading a colleague's private notes, downloading   │
 * │  another deal's receipts, or handing a capability to a friend.     │
 * └────────────────────────────────────────────────────────────────────┘
 */

const original = { nodeEnv: process.env.NODE_ENV, sandbox: process.env.INRP2P_SANDBOX };
function enterProduction() {
  (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
  delete process.env.INRP2P_SANDBOX;
}
function restore() {
  (process.env as Record<string, string | undefined>).NODE_ENV = original.nodeEnv;
  if (original.sandbox === undefined) delete process.env.INRP2P_SANDBOX;
  else process.env.INRP2P_SANDBOX = original.sandbox;
}
afterEach(restore);

let alice: SessionUser;
let bob: SessionUser;
let maker: Principal;
let checker: Principal;

beforeAll(async () => {
  alice = await newUser('room-alice');
  bob = await newUser('room-bob');
  maker = await operatorPrincipal('OPERATOR', 'room-maker');
  checker = await operatorPrincipal('REVIEWER', 'room-checker');
});

const STATEMENT = 'The rupees never reached my account and the sender says the transfer succeeded.';

async function disputedDeal(amountMinor = 100_000n) {
  const dealId = await lockedDeal(alice, bob, amountMinor);
  const opened = await openDisputeCaseCommand(alice, newCommandId(), {
    dealId,
    category: 'PAYMENT_NOT_RECEIVED',
    statement: STATEMENT,
  });
  if (!opened.ok) throw new Error(`case fixture: ${opened.code}`);
  return { dealId, caseId: opened.value.caseId, version: opened.value.version, amountMinor };
}

/** A case with an outstanding proposal from `maker`. */
async function proposedDeal(disposition: 'RELEASE' | 'REFUND' = 'RELEASE') {
  const base = await disputedDeal();
  const proposed = await proposeRulingCommand(maker, newCommandId(), {
    caseId: base.caseId,
    disposition,
    rationale: 'The provider record shows no matching credit for this deal at all.',
    caseVersion: base.version,
  });
  if (!proposed.ok) throw new Error(`proposal fixture: ${proposed.code}`);
  return { ...base, proposalId: proposed.value.proposalId };
}

/* ================================================================== *
 * The room projection
 * ================================================================== */

describe('the deal room is derived server-side', () => {
  it('shows a participant their role, lock and allowed actions', async () => {
    const dealId = await lockedDeal(alice, bob);
    const room = await dealRoom(bare(alice), dealId);
    expect(room.ok).toBe(true);
    if (!room.ok) return;

    expect(room.value.viewerRole).toBe('FIAT_SIDE');
    expect(room.value.counterpartyId).toBe(bob.userId);
    expect(room.value.valueLock).toMatchObject({ present: true, state: 'LOCKED' });
    expect(room.value.allowedActions).toContain('OPEN_PAYMENT_INTENT');
    expect(room.value.allowedActions).toContain('OPEN_DISPUTE');
    expect(room.value.frozen).toBe(false);
  });

  it('REFUSES a non-participant', async () => {
    const dealId = await lockedDeal(alice, bob);
    const outsider = await newUser('room-outsider');
    const room = await dealRoom(bare(outsider), dealId);
    expect(room.ok).toBe(false);
    if (room.ok) return;
    expect(room.code).toBe('NOT_A_PARTICIPANT');
  });

  it('gives an unknown deal the SAME answer as a private one', async () => {
    const outsider = await newUser('room-prober');
    const unknown = await dealRoom(bare(outsider), crypto.randomUUID());
    const priv = await dealRoom(bare(outsider), await lockedDeal(alice, bob));
    expect(unknown.ok || priv.ok).toBe(false);
    if (unknown.ok || priv.ok) return;
    // An id cannot be probed for existence.
    expect(unknown.code).toBe(priv.code);
  });

  it('lets an authorised operator observe but act on nothing', async () => {
    const dealId = await lockedDeal(alice, bob);
    const room = await dealRoom(maker, dealId);
    expect(room.ok).toBe(true);
    if (!room.ok) return;
    expect(room.value.viewerRole).toBe('OPERATOR');
    expect(room.value.allowedActions).toEqual([]);
    // An operator sees no counterparty identity from this projection.
    expect(room.value.counterpartyId).toBeNull();
  });

  it('REFUSES an operator whose second factor is unproved', async () => {
    const dealId = await lockedDeal(alice, bob);
    const room = await dealRoom(withoutMfa(maker), dealId);
    expect(room.ok).toBe(false);
    if (room.ok) return;
    expect(room.code).toBe('MFA_REQUIRED');
  });

  it('closes the room the moment the operator role is revoked', async () => {
    const temp = await operatorPrincipal('OPERATOR', 'room-temp');
    const dealId = await lockedDeal(alice, bob);
    expect((await dealRoom(temp, dealId)).ok).toBe(true);

    await revokeRole({ userId: temp.userId, role: 'OPERATOR', revokedBy: null });

    // Rebuilt from LIVE grants, the way a request does.
    const { rolesFor, permissionsFor } = await import('@/server/identity/rbac');
    const roles = await rolesFor(temp.userId);
    const after = await dealRoom({ ...temp, roles, permissions: permissionsFor(roles) }, dealId);
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.code).toBe('NOT_A_PARTICIPANT');
  });

  it('carries payment state but never a destination', async () => {
    const dealId = await lockedDeal(alice, bob);
    const { openPaymentIntentCommand, issuePaymentInstructionCommand } = await import(
      '@/services/commands'
    );
    const opened = await openPaymentIntentCommand(alice, newCommandId(), {
      dealId,
      rail: 'USDT',
      network: 'TRC20',
      direction: 'COLLECT',
      payeeId: bob.userId,
      amountMinor: 10_000n,
    });
    if (!opened.ok) return;
    await issuePaymentInstructionCommand(alice, newCommandId(), {
      intentId: opened.value.intentId,
    });

    const room = await dealRoom(bare(alice), dealId);
    expect(room.ok).toBe(true);
    if (!room.ok) return;
    const payment = room.value.payments[0]!;
    expect(payment.state).toBe('INSTRUCTED');
    // Seeing that a payment exists is NOT being handed the address.
    expect(JSON.stringify(payment)).not.toContain('TSBX');
    expect(room.value.allowedActions).toContain('VIEW_PAYMENT_INSTRUCTION');
  });
});

/* ================================================================== *
 * Chat
 * ================================================================== */

describe('deal chat is ordered, idempotent and append-only', () => {
  it('orders concurrent messages deterministically and totally', async () => {
    const dealId = await lockedDeal(alice, bob);
    const sent = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        postDealMessageCommand(i % 2 === 0 ? alice : bob, newCommandId(), {
          dealId,
          body: `message ${i}`,
        }),
      ),
    );
    expect(sent.every((s) => s.ok)).toBe(true);

    const page = await messagesForDeal(dealId);
    const seqs = page.messages.map((m) => BigInt(m.seq));
    // Total: no two messages share a position.
    expect(new Set(seqs.map(String)).size).toBe(seqs.length);
    // Deterministic: strictly increasing, whatever order they committed.
    expect([...seqs].sort((a, b) => (a < b ? -1 : 1))).toEqual(seqs);
  });

  it('replays an identical command instead of posting twice', async () => {
    const dealId = await lockedDeal(alice, bob);
    const commandId = newCommandId();
    const first = await postDealMessageCommand(alice, commandId, { dealId, body: 'hello' });
    const replay = await postDealMessageCommand(alice, commandId, { dealId, body: 'hello' });
    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.value.messageId).toBe(first.value.messageId);

    const page = await messagesForDeal(dealId);
    expect(page.messages.filter((m) => m.kind === 'CHAT')).toHaveLength(1);
  });

  it('refuses the same command id with different text', async () => {
    const dealId = await lockedDeal(alice, bob);
    const commandId = newCommandId();
    await postDealMessageCommand(alice, commandId, { dealId, body: 'first' });
    const conflicting = await postDealMessageCommand(alice, commandId, { dealId, body: 'second' });
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('paginates by cursor without dropping or repeating a message', async () => {
    const dealId = await lockedDeal(alice, bob);
    for (let i = 0; i < 7; i += 1) {
      await postDealMessageCommand(alice, newCommandId(), { dealId, body: `m${i}` });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result: Awaited<ReturnType<typeof messagesForDeal>> = await messagesForDeal(dealId, {
        after: cursor,
        limit: 3,
      });
      seen.push(...result.messages.map((m) => m.messageId));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(7);
  });

  it('refuses an empty or oversized message', async () => {
    const dealId = await lockedDeal(alice, bob);
    const empty = await postDealMessageCommand(alice, newCommandId(), { dealId, body: '   ' });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('MESSAGE_EMPTY');

    const huge = await postDealMessageCommand(alice, newCommandId(), {
      dealId,
      body: 'x'.repeat(2001),
    });
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.code).toBe('MESSAGE_TOO_LONG');
  });

  it('rate-limits a flood', async () => {
    const dealId = await lockedDeal(alice, bob);
    const flooder = alice;
    let limited = false;
    for (let i = 0; i < 70; i += 1) {
      const sent = await postDealMessageCommand(flooder, newCommandId(), {
        dealId,
        body: `flood ${i}`,
      });
      if (!sent.ok && sent.code === 'RATE_LIMITED') {
        limited = true;
        break;
      }
    }
    expect(limited, 'a flood eventually meets the limit').toBe(true);
  });

  it('strips control characters and bidi overrides', async () => {
    const dealId = await lockedDeal(alice, bob);
    // A bidi override can make "refund" RENDER as something else.
    const sent = await postDealMessageCommand(alice, newCommandId(), {
      dealId,
      body: 'please ‮refund‬ me ',
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.value.body).not.toContain('‮');
    expect(sent.value.body).not.toContain(' ');
  });

  it('REFUSES a non-participant', async () => {
    const dealId = await lockedDeal(alice, bob);
    const outsider = await newUser('room-lurker');
    const sent = await postDealMessageCommand(outsider, newCommandId(), {
      dealId,
      body: 'let me in',
    });
    expect(sent.ok).toBe(false);
    if (sent.ok) return;
    expect(sent.code).toBe('NOT_A_PARTICIPANT');
  });

  it('cannot be edited or deleted, only redacted', async () => {
    const dealId = await lockedDeal(alice, bob);
    const sent = await postDealMessageCommand(alice, newCommandId(), { dealId, body: 'original' });
    if (!sent.ok) return;

    await expect(
      withTransaction((tx) =>
        tx.query(`UPDATE sandbox.deal_message SET body='edited' WHERE message_id=$1`, [
          sent.value.messageId,
        ]),
      ),
    ).rejects.toThrow(/append-only/);

    await expect(
      withTransaction((tx) =>
        tx.query(`DELETE FROM sandbox.deal_message WHERE message_id=$1`, [sent.value.messageId]),
      ),
    ).rejects.toThrow(/append-only/);

    // Redaction is additive: the row survives, the text stops showing.
    const { redactMessageCommand } = await import('@/services/commands');
    const redacted = await redactMessageCommand(maker, newCommandId(), {
      messageId: sent.value.messageId,
      reason: 'Contained another customer’s account number.',
    });
    expect(redacted.ok).toBe(true);

    const page = await messagesForDeal(dealId);
    const row = page.messages.find((m) => m.messageId === sent.value.messageId)!;
    expect(row.redacted).toBe(true);
    expect(row.body).not.toContain('original');

    // The ORIGINAL is still in the table for an authorised audit.
    const { rows } = await getPool().query(
      `SELECT body FROM sandbox.deal_message WHERE message_id = $1`,
      [sent.value.messageId],
    );
    expect(rows[0]!.body).toBe('original');
  });
});

/* ================================================================== *
 * Evidence
 * ================================================================== */

describe('evidence is scanned, capability-gated and immutable', () => {
  async function uploaded(user: SessionUser, dealId: string, bytes = pngBytes()) {
    const begun = await beginEvidenceUploadCommand(bare(user), newCommandId(), {
      dealId,
      filename: 'receipt.png',
      mediaType: 'image/png',
      byteSize: bytes.byteLength,
    });
    if (!begun.ok) throw new Error(`upload fixture: ${begun.code}`);
    const done = await completeEvidenceUploadCommand(bare(user), newCommandId(), {
      token: begun.value.capability.token,
      bytes,
    });
    if (!done.ok) throw new Error(`upload fixture: ${done.code}`);
    return done.value;
  }

  it('accepts a clean file and makes it READY', async () => {
    const dealId = await lockedDeal(alice, bob);
    const record = await uploaded(alice, dealId);
    expect(record.state).toBe('READY');
    expect(record.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('QUARANTINES then REJECTS an infected file, and never serves it', async () => {
    const dealId = await lockedDeal(alice, bob);
    const bytes = eicarBytes();
    const begun = await beginEvidenceUploadCommand(bare(alice), newCommandId(), {
      dealId,
      filename: 'invoice.pdf',
      mediaType: 'application/pdf',
      byteSize: bytes.byteLength,
    });
    if (!begun.ok) return;
    const done = await completeEvidenceUploadCommand(bare(alice), newCommandId(), {
      token: begun.value.capability.token,
      bytes,
    });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.state).toBe('REJECTED');

    const download = await requestEvidenceDownload(bare(alice), done.value.evidenceId);
    expect(download.ok).toBe(false);
    if (download.ok) return;
    expect(download.code).toBe('EVIDENCE_REJECTED');
  });

  it('REJECTS content that contradicts its declared type', async () => {
    const dealId = await lockedDeal(alice, bob);
    const bytes = mismatchedBytes();
    const begun = await beginEvidenceUploadCommand(bare(alice), newCommandId(), {
      dealId,
      filename: 'receipt.png',
      mediaType: 'image/png',
      byteSize: bytes.byteLength,
    });
    if (!begun.ok) return;
    const done = await completeEvidenceUploadCommand(bare(alice), newCommandId(), {
      token: begun.value.capability.token,
      bytes,
    });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.state).toBe('REJECTED');
  });

  it('refuses a disallowed media type or an oversized file up front', async () => {
    const dealId = await lockedDeal(alice, bob);
    const badType = await beginEvidenceUploadCommand(bare(alice), newCommandId(), {
      dealId,
      filename: 'payload.exe',
      mediaType: 'application/x-msdownload',
      byteSize: 10,
    });
    expect(badType.ok).toBe(false);
    if (!badType.ok) expect(badType.code).toBe('EVIDENCE_TYPE_REJECTED');

    const tooBig = await beginEvidenceUploadCommand(bare(alice), newCommandId(), {
      dealId,
      filename: 'huge.png',
      mediaType: 'image/png',
      byteSize: 6 * 1024 * 1024,
    });
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.code).toBe('EVIDENCE_TOO_LARGE');
  });

  it('serves bytes to the participant through a single-use capability', async () => {
    const dealId = await lockedDeal(alice, bob);
    const record = await uploaded(alice, dealId);

    const cap = await requestEvidenceDownload(bare(alice), record.evidenceId);
    expect(cap.ok).toBe(true);
    if (!cap.ok) return;

    const fetched = await withTransaction((tx) => fetchEvidence(tx, bare(alice), cap.value.token));
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.bytes.equals(pngBytes())).toBe(true);

    // SINGLE USE. The same token a second time is spent.
    const again = await withTransaction((tx) => fetchEvidence(tx, bare(alice), cap.value.token));
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe('CAPABILITY_CONSUMED');
  });

  it('refuses a forged capability', async () => {
    const dealId = await lockedDeal(alice, bob);
    await uploaded(alice, dealId);
    for (const forged of ['a'.repeat(64), 'not-a-token', '']) {
      const fetched = await withTransaction((tx) => fetchEvidence(tx, bare(alice), forged));
      expect(fetched.ok, forged).toBe(false);
      if (!fetched.ok) expect(fetched.code).toBe('CAPABILITY_INVALID');
    }
  });

  it('refuses an EXPIRED capability', async () => {
    const dealId = await lockedDeal(alice, bob);
    const record = await uploaded(alice, dealId);
    const cap = await requestEvidenceDownload(bare(alice), record.evidenceId);
    if (!cap.ok) return;

    /*
     * Age the capability the way time would: BOTH timestamps move back.
     * Pushing only `expires_at` into the past would violate
     * `evidence_capability_window`, which is the schema correctly
     * refusing a capability that expired before it was issued.
     */
    await getPool().query(
      `UPDATE sandbox.evidence_capability
          SET issued_at = now() - interval '10 minutes',
              expires_at = now() - interval '5 minutes'
        WHERE capability_id = $1`,
      [cap.value.capabilityId],
    );

    const fetched = await withTransaction((tx) => fetchEvidence(tx, bare(alice), cap.value.token));
    expect(fetched.ok).toBe(false);
    if (fetched.ok) return;
    expect(fetched.code).toBe('CAPABILITY_EXPIRED');
  });

  it('a capability is NOT transferable', async () => {
    const dealId = await lockedDeal(alice, bob);
    const record = await uploaded(alice, dealId);
    const cap = await requestEvidenceDownload(bare(alice), record.evidenceId);
    if (!cap.ok) return;

    // Bob is a participant and could request his own. He still cannot
    // spend Alice's: a link handed to a colleague carries no authority.
    const fetched = await withTransaction((tx) => fetchEvidence(tx, bare(bob), cap.value.token));
    expect(fetched.ok).toBe(false);
    if (fetched.ok) return;
    expect(fetched.code).toBe('CAPABILITY_INVALID');
  });

  it('refuses a NON-PARTICIPANT even with a valid evidence id', async () => {
    const dealId = await lockedDeal(alice, bob);
    const record = await uploaded(alice, dealId);
    const outsider = await newUser('room-snoop');
    const cap = await requestEvidenceDownload(bare(outsider), record.evidenceId);
    expect(cap.ok).toBe(false);
    if (cap.ok) return;
    expect(cap.code).toBe('NOT_A_PARTICIPANT');
  });

  it('lets an operator with case.evidence.read in, and an unproved factor out', async () => {
    const dealId = await lockedDeal(alice, bob);
    const record = await uploaded(alice, dealId);

    const allowed = await requestEvidenceDownload(maker, record.evidenceId);
    expect(allowed.ok, 'an authorised operator may read case evidence').toBe(true);

    const denied = await requestEvidenceDownload(withoutMfa(maker), record.evidenceId);
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.code).toBe('MFA_REQUIRED');

    // A REVIEWER approves rulings and does NOT hold evidence read.
    const reviewer = await requestEvidenceDownload(checker, record.evidenceId);
    expect(reviewer.ok).toBe(false);
  });

  it('is immutable once recorded', async () => {
    const dealId = await lockedDeal(alice, bob);
    const record = await uploaded(alice, dealId);

    await expect(
      withTransaction((tx) =>
        tx.query(`UPDATE sandbox.evidence_object SET filename='other.png' WHERE evidence_id=$1`, [
          record.evidenceId,
        ]),
      ),
    ).rejects.toThrow(/immutable in its identity/);

    await expect(
      withTransaction((tx) =>
        tx.query(`UPDATE sandbox.evidence_object SET content_hash=$2 WHERE evidence_id=$1`, [
          record.evidenceId,
          'b'.repeat(64),
        ]),
      ),
    ).rejects.toThrow(/already carries a content hash/);

    await expect(
      withTransaction((tx) =>
        tx.query(`DELETE FROM sandbox.evidence_object WHERE evidence_id=$1`, [record.evidenceId]),
      ),
    ).rejects.toThrow(/permanent/);
  });

  it('NEVER confirms a payment', async () => {
    const dealId = await lockedDeal(alice, bob);
    const before = await dealRow(dealId);
    const record = await uploaded(alice, dealId);

    // A receipt is a photograph of a claim.
    const after = await dealRow(dealId);
    expect(after.state).toBe(before.state);
    expect((await lockRow(dealId))!.state).toBe('LOCKED');

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.payment_intent WHERE deal_id = $1
        AND state = 'CONFIRMED'`,
      [dealId],
    );
    expect(rows[0]!.n).toBe(0);
    void record;
  });

  it('keeps raw content out of the audit trail and the outbox', async () => {
    const dealId = await lockedDeal(alice, bob);
    const record = await uploaded(alice, dealId);

    const { rows: audits } = await getPool().query(
      `SELECT detail::text AS d FROM sandbox.audit_event
        WHERE subject_kind='evidence' AND subject_id=$1`,
      [record.evidenceId],
    );
    for (const row of audits) {
      expect(row.d).not.toContain('IHDR-sandbox-evidence-fixture');
      // Nor a live capability token.
      expect(row.d).not.toMatch(/"token"/);
    }

    const { rows: events } = await getPool().query(
      `SELECT payload::text AS p FROM sandbox.outbox_event WHERE subject_id=$1`,
      [record.evidenceId],
    );
    for (const row of events) {
      expect(row.p).not.toContain('IHDR-sandbox-evidence-fixture');
    }
  });

  it('fails CLOSED in production', async () => {
    const dealId = await lockedDeal(alice, bob);
    enterProduction();
    const { getEvidenceStorageAdapter, getEvidenceScannerAdapter } = await import(
      '@/server/adapters/evidenceStorage'
    );
    expect(() => getEvidenceStorageAdapter()).toThrow(/nowhere durable/);
    expect(() => getEvidenceScannerAdapter()).toThrow(/nothing has inspected/);
    restore();
    void dealId;
  });
});

/* ================================================================== *
 * Opening a dispute
 * ================================================================== */

describe('a dispute freezes the deal', () => {
  it('records a statement and an immutable snapshot', async () => {
    const { caseId, dealId } = await disputedDeal();
    const row = await caseRow(caseId);
    expect(row.state).toBe('OPEN');
    expect((await dealRow(dealId)).state).toBe('DISPUTED');

    const { rows } = await getPool().query(
      `SELECT snapshot FROM sandbox.dispute_case WHERE case_id = $1`,
      [caseId],
    );
    const snapshot = rows[0]!.snapshot as Record<string, unknown>;
    // The facts at the time, not a live re-read at ruling time.
    expect(snapshot.valueLock).toMatchObject({ state: 'LOCKED' });
    expect(snapshot.deal).toBeTruthy();
  });

  it('BLOCKS release and refund while it is open', async () => {
    const { dealId } = await disputedDeal();

    const released = await releaseValueCommand(alice, newCommandId(), {
      dealId,
      beneficiaryId: bob.userId,
    });
    expect(released.ok, 'a participant cannot settle around a dispute').toBe(false);
    if (!released.ok) expect(released.code).toBe('DEAL_FROZEN');

    const refunded = await refundValueCommand(alice, newCommandId(), {
      dealId,
      beneficiaryId: alice.userId,
    });
    expect(refunded.ok).toBe(false);
    if (!refunded.ok) expect(refunded.code).toBe('DEAL_FROZEN');

    expect((await lockRow(dealId))!.state).toBe('LOCKED');
  });

  it('BLOCKS cancellation', async () => {
    const { dealId } = await disputedDeal();
    const cancelled = await cancelCommand(alice, newCommandId(), dealId);
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) return;
    expect(cancelled.code).toBe('DEAL_DISPUTED');
  });

  it('still allows chat and evidence — that is where a case is made', async () => {
    const { dealId } = await disputedDeal();
    const room = await dealRoom(bare(alice), dealId);
    expect(room.ok).toBe(true);
    if (!room.ok) return;
    expect(room.value.frozen).toBe(true);
    expect(room.value.allowedActions).toContain('POST_MESSAGE');
    expect(room.value.allowedActions).toContain('UPLOAD_EVIDENCE');
    expect(room.value.allowedActions).not.toContain('CONFIRM_RECEIPT');
    expect(room.value.allowedActions).not.toContain('CANCEL_DEAL');
  });

  it('refuses a SECOND case while one is open', async () => {
    const { dealId } = await disputedDeal();
    const second = await openDisputeCaseCommand(bob, newCommandId(), {
      dealId,
      category: 'WRONG_AMOUNT',
      statement: 'I disagree with what my counterparty has just claimed here.',
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('CASE_ALREADY_OPEN');
  });

  it('two SIMULTANEOUS openings produce exactly one case', async () => {
    const dealId = await lockedDeal(alice, bob);
    const [a, b] = await Promise.all([
      openDisputeCaseCommand(alice, newCommandId(), {
        dealId,
        category: 'PAYMENT_NOT_RECEIVED',
        statement: 'The money never arrived in my account despite what they say.',
      }),
      openDisputeCaseCommand(bob, newCommandId(), {
        dealId,
        category: 'NOT_AS_AGREED',
        statement: 'They are not honouring the terms we agreed when we started.',
      }),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.dispute_case
        WHERE deal_id = $1 AND state IN ('OPEN','UNDER_REVIEW')`,
      [dealId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('refuses a statement too short to act on', async () => {
    const dealId = await lockedDeal(alice, bob);
    const outcome = await openDisputeCaseCommand(alice, newCommandId(), {
      dealId,
      category: 'OTHER',
      statement: 'bad',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('STATEMENT_TOO_SHORT');
  });

  it('refuses a non-participant and a finished deal', async () => {
    const dealId = await lockedDeal(alice, bob);
    const outsider = await newUser('room-meddler');
    const byOutsider = await openDisputeCaseCommand(outsider, newCommandId(), {
      dealId,
      category: 'OTHER',
      statement: 'I would like to interfere with somebody else’s deal please.',
    });
    expect(byOutsider.ok).toBe(false);
    if (!byOutsider.ok) expect(byOutsider.code).toBe('NOT_A_PARTICIPANT');

    const cancelled = await lockedDeal(alice, bob);
    await cancelCommand(alice, newCommandId(), cancelled);
    const onTerminal = await openDisputeCaseCommand(alice, newCommandId(), {
      dealId: cancelled,
      category: 'OTHER',
      statement: 'This deal is already over but I want to complain anyway.',
    });
    expect(onTerminal.ok).toBe(false);
    if (onTerminal.ok) return;
    expect(onTerminal.code).toBe('DEAL_TERMINAL');
  });

  it('keeps the compatibility view agreeing with the case', async () => {
    const { caseId, dealId } = await disputedDeal();
    // `sandbox.dispute` is a VIEW now. One source of truth, so the old
    // readers cannot disagree with the new one.
    const { rows } = await getPool().query(
      `SELECT dispute_id, state, resolution FROM sandbox.dispute WHERE deal_id = $1`,
      [dealId],
    );
    expect(rows[0]!.dispute_id).toBe(caseId);
    expect(rows[0]!.state).toBe('OPEN');
    expect(rows[0]!.resolution).toBeNull();
  });
});

/* ================================================================== *
 * Maker-checker
 * ================================================================== */

describe('a ruling needs two different authorised people', () => {
  it('a participant cannot propose anything', async () => {
    const { caseId, version } = await disputedDeal();
    const outcome = await proposeRulingCommand(bare(alice), newCommandId(), {
      caseId,
      disposition: 'REFUND',
      rationale: 'I would like my own money back immediately, thank you very much.',
      caseVersion: version,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PERMISSION_DENIED');
  });

  it('an operator without a proved factor cannot propose', async () => {
    const { caseId, version } = await disputedDeal();
    const outcome = await proposeRulingCommand(withoutMfa(maker), newCommandId(), {
      caseId,
      disposition: 'RELEASE',
      rationale: 'The provider record shows a matching confirmed credit for this deal.',
      caseVersion: version,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('MFA_REQUIRED');
  });

  it('a REVIEWER cannot propose and an OPERATOR cannot approve', async () => {
    const { caseId, version } = await disputedDeal();
    const byReviewer = await proposeRulingCommand(checker, newCommandId(), {
      caseId,
      disposition: 'RELEASE',
      rationale: 'Approving is my job; proposing is not, and this should be refused.',
      caseVersion: version,
    });
    expect(byReviewer.ok).toBe(false);
    if (!byReviewer.ok) expect(byReviewer.code).toBe('PERMISSION_DENIED');

    const proposed = await proposeRulingCommand(maker, newCommandId(), {
      caseId,
      disposition: 'RELEASE',
      rationale: 'The provider record shows a matching confirmed credit for this deal.',
      caseVersion: version,
    });
    if (!proposed.ok) return;

    const byOperator = await approveRulingCommand(maker, newCommandId(), {
      proposalId: proposed.value.proposalId,
    });
    expect(byOperator.ok).toBe(false);
    if (byOperator.ok) return;
    // Refused for BOTH reasons; the permission is checked first.
    expect(byOperator.code).toBe('PERMISSION_DENIED');
  });

  it('SELF-APPROVAL is impossible even for someone holding both permissions', async () => {
    const both = await operatorPrincipal('OPERATOR', 'room-both');
    const { grantRole, permissionsFor } = await import('@/server/identity/rbac');
    await grantRole({
      userId: both.userId,
      role: 'REVIEWER',
      grantedBy: null,
      via: 'CLI',
      reason: 'Deliberately over-privileged, to prove maker-checker holds anyway.',
    });
    const dual = {
      ...both,
      roles: ['OPERATOR', 'REVIEWER'] as const,
      permissions: permissionsFor(['OPERATOR', 'REVIEWER']),
    };

    const { caseId, version } = await disputedDeal();
    const proposed = await proposeRulingCommand(dual, newCommandId(), {
      caseId,
      disposition: 'RELEASE',
      rationale: 'I hold both permissions and I am going to try to rule alone.',
      caseVersion: version,
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    const approved = await approveRulingCommand(dual, newCommandId(), {
      proposalId: proposed.value.proposalId,
    });
    expect(approved.ok, 'holding both permissions is not holding both roles').toBe(false);
    if (approved.ok) return;
    expect(approved.code).toBe('SELF_APPROVAL_FORBIDDEN');

    // And the database would have refused it too.
    await expect(
      withTransaction((tx) =>
        tx.query(
          `UPDATE sandbox.dispute_proposal SET state='APPROVED', approved_by=proposed_by,
                  decided_at=now() WHERE proposal_id=$1`,
          [proposed.value.proposalId],
        ),
      ),
    ).rejects.toThrow(/no_self_approval|check constraint/i);
  });

  it('refuses a proposal made against a stale case version', async () => {
    const { caseId, version } = await disputedDeal();
    const outcome = await proposeRulingCommand(maker, newCommandId(), {
      caseId,
      disposition: 'RELEASE',
      rationale: 'This proposal is anchored to a version of the case that has moved.',
      caseVersion: version + 5,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('CASE_STALE');
  });

  it('refuses a SECOND live proposal', async () => {
    const { caseId } = await proposedDeal();
    const { version } = await caseRow(caseId);
    const second = await proposeRulingCommand(maker, newCommandId(), {
      caseId,
      disposition: 'REFUND',
      rationale: 'A competing recommendation while the first is still outstanding.',
      caseVersion: version,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('PROPOSAL_EXISTS');
  });

  it('a rejected proposal stays in history and frees the case', async () => {
    const { caseId, proposalId } = await proposedDeal();
    const rejected = await rejectRulingCommand(checker, newCommandId(), {
      proposalId,
      note: 'The evidence does not support a release on these facts.',
    });
    expect(rejected.ok).toBe(true);

    const row = await proposalRow(proposalId);
    expect(row.state).toBe('REJECTED');
    expect(row.decision_note).toContain('does not support');

    // A decision is final: it cannot be edited back.
    await expect(
      withTransaction((tx) =>
        tx.query(`UPDATE sandbox.dispute_proposal SET state='PROPOSED' WHERE proposal_id=$1`, [
          proposalId,
        ]),
      ),
    ).rejects.toThrow(/already REJECTED|decision is final/);

    // And a fresh proposal is now possible.
    const { version } = await caseRow(caseId);
    const again = await proposeRulingCommand(maker, newCommandId(), {
      caseId,
      disposition: 'REFUND',
      rationale: 'Reconsidered on the evidence: the payer should get their value back.',
      caseVersion: version,
    });
    expect(again.ok).toBe(true);
  });
});

/* ================================================================== *
 * Execution
 * ================================================================== */

describe('approval executes exactly once, through the DEL-04 boundary', () => {
  it('RELEASES to the counterparty and completes the deal', async () => {
    const { dealId, proposalId, amountMinor } = await proposedDeal('RELEASE');
    const before = await balanceOf(bob.userId);

    const ruled = await approveRulingCommand(checker, newCommandId(), { proposalId });
    expect(ruled.ok).toBe(true);
    if (!ruled.ok) return;
    expect(ruled.value.disposition).toBe('RELEASE');

    expect(BigInt(await balanceOf(bob.userId)) - BigInt(before)).toBe(amountMinor);
    expect((await lockRow(dealId))!.state).toBe('RELEASED');
    expect((await dealRow(dealId)).state).toBe('COMPLETED');
    expect((await dealRow(dealId)).completed_at).not.toBeNull();
    expect((await caseRow(ruled.value.caseId)).state).toBe('RESOLVED');
  });

  it('REFUNDS to the owner and cancels the deal', async () => {
    const { dealId, proposalId, amountMinor } = await proposedDeal('REFUND');
    const before = await balanceOf(alice.userId);

    const ruled = await approveRulingCommand(checker, newCommandId(), { proposalId });
    expect(ruled.ok).toBe(true);
    if (!ruled.ok) return;

    expect(BigInt(await balanceOf(alice.userId)) - BigInt(before)).toBe(amountMinor);
    expect((await lockRow(dealId))!.state).toBe('REFUNDED');
    expect((await dealRow(dealId)).state).toBe('CANCELLED');
    expect((await dealRow(dealId)).completed_at).toBeNull();
  });

  it('replays an identical approval without paying twice', async () => {
    const { proposalId } = await proposedDeal('RELEASE');
    const commandId = newCommandId();
    const first = await approveRulingCommand(checker, commandId, { proposalId });
    expect(first.ok).toBe(true);
    const mid = await balanceOf(bob.userId);

    const replay = await approveRulingCommand(checker, commandId, { proposalId });
    expect(replay.ok).toBe(true);
    expect(await balanceOf(bob.userId)).toBe(mid);
  });

  it('two SIMULTANEOUS approvals execute once', async () => {
    const { dealId, proposalId, amountMinor } = await proposedDeal('RELEASE');
    const before = await balanceOf(bob.userId);
    const other = await operatorPrincipal('REVIEWER', 'room-checker2');

    const [a, b] = await Promise.all([
      approveRulingCommand(checker, newCommandId(), { proposalId }),
      approveRulingCommand(other, newCommandId(), { proposalId }),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);

    expect(BigInt(await balanceOf(bob.userId)) - BigInt(before)).toBe(amountMinor);
    expect((await lockRow(dealId))!.state).toBe('RELEASED');

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM inrp2p.journal_entry
        WHERE journal_code IN ('JD-RELEASE','JD-REFUND')
          AND entry_key_json->>'dealId' = $1`,
      [dealId],
    );
    expect(rows[0]!.n, 'exactly one settlement entry').toBe(1);
  });

  it('refuses an approver whose role was revoked between proposal and approval', async () => {
    const temp = await operatorPrincipal('REVIEWER', 'room-revoked');
    const { proposalId } = await proposedDeal('RELEASE');

    await revokeRole({ userId: temp.userId, role: 'REVIEWER', revokedBy: null });
    const { rolesFor, permissionsFor } = await import('@/server/identity/rbac');
    const roles = await rolesFor(temp.userId);

    const outcome = await approveRulingCommand(
      { ...temp, roles, permissions: permissionsFor(roles) },
      newCommandId(),
      { proposalId },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PERMISSION_DENIED');
  });

  it('refuses an approver whose factor is unproved', async () => {
    const { proposalId } = await proposedDeal('RELEASE');
    const outcome = await approveRulingCommand(withoutMfa(checker), newCommandId(), {
      proposalId,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('MFA_REQUIRED');
  });

  it('refuses a STALE proposal after the case moved on', async () => {
    const { caseId, proposalId } = await proposedDeal('RELEASE');
    // An operator note bumps nothing, but a rejection does: reject a
    // DIFFERENT way of moving the case and the proposal is stale.
    await getPool().query(`UPDATE sandbox.dispute_case SET version=version+1 WHERE case_id=$1`, [
      caseId,
    ]);
    const outcome = await approveRulingCommand(checker, newCommandId(), { proposalId });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PROPOSAL_STALE');
  });

  it('refuses a disposition with no live lock to dispose of', async () => {
    const { dealId, caseId, version } = await disputedDeal();
    // Reverse the lock out from under the case.
    const admin = await operatorPrincipal('ADMIN', 'room-admin');
    const { reverseLockCommand } = await import('@/services/commands');
    const reversed = await reverseLockCommand(admin, newCommandId(), {
      dealId,
      reason: 'Reversed during an unrelated support investigation.',
    });
    expect(reversed.ok).toBe(true);

    const outcome = await proposeRulingCommand(maker, newCommandId(), {
      caseId,
      disposition: 'RELEASE',
      rationale: 'There is nothing left locked here, so this cannot be executed.',
      caseVersion: version,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('VALUE_NOT_LOCKED');
  });

  it('writes command, case, deal, ledger, audit and outbox together', async () => {
    const { dealId, proposalId } = await proposedDeal('RELEASE');
    const commandId = newCommandId();
    const ruled = await approveRulingCommand(checker, commandId, { proposalId });
    expect(ruled.ok).toBe(true);
    if (!ruled.ok) return;

    expect((await readCommand(commandId))?.status).toBe('SUCCEEDED');
    expect((await caseRow(ruled.value.caseId)).state).toBe('RESOLVED');
    expect((await dealRow(dealId)).state).toBe('COMPLETED');
    expect((await lockRow(dealId))!.settle_entry_id).not.toBeNull();

    const { rows: audits } = await getPool().query(
      `SELECT outcome FROM sandbox.audit_event
        WHERE subject_kind='case' AND subject_id=$1 AND action='DISPUTE_APPROVE'`,
      [ruled.value.caseId],
    );
    expect(audits.map((a) => a.outcome)).toEqual(['OK']);

    const { rows: events } = await getPool().query(
      `SELECT event_type FROM sandbox.outbox_event WHERE event_key LIKE $1`,
      [`${commandId}:%`],
    );
    expect(events.map((e) => e.event_type)).toEqual(['dispute.resolved']);
  });

  it('an injected failure mid-ruling leaves NOTHING', async () => {
    const { dealId, proposalId } = await proposedDeal('RELEASE');
    const before = await balanceOf(bob.userId);
    const commandId = newCommandId();

    const { runCommand } = await import('@/server/boundary/command');
    const { approveResolution } = await import('@/server/room/disputes');

    await expect(
      runCommand({
        commandId,
        commandType: 'DISPUTE_APPROVE',
        actorId: checker.userId,
        payload: { proposalId, probe: true },
        body: async (ctx) => {
          const ruled = await approveResolution(ctx.tx, checker, { proposalId, commandId });
          // Case, proposal, deal, lock and ledger entry all exist now.
          throw new Error('injected failure mid-ruling');
          return ruled;
        },
        encodeResult: () => ({}),
        decodeResult: () => null,
      }),
    ).rejects.toThrow('injected failure mid-ruling');

    expect(await balanceOf(bob.userId)).toBe(before);
    expect((await lockRow(dealId))!.state).toBe('LOCKED');
    expect((await dealRow(dealId)).state).toBe('DISPUTED');
    expect((await proposalRow(proposalId)).state).toBe('PROPOSED');
    expect(await readCommand(commandId)).toBeNull();
  });

  it('creates no INR custodial balance, whatever the disposition', async () => {
    const { proposalId } = await proposedDeal('RELEASE');
    await approveRulingCommand(checker, newCommandId(), { proposalId });

    // TS-02 §4: there is no INR ledger asset, and there never will be.
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM inrp2p.ledger_account WHERE asset::text = 'INR'`,
    );
    expect(rows[0]!.n).toBe(0);
  });
});

/* ================================================================== *
 * Private notes
 * ================================================================== */

describe('operator notes are private', () => {
  it('are readable by an operator and invisible to a participant', async () => {
    const { caseId, dealId } = await disputedDeal();
    const added = await addCaseNoteCommand(maker, newCommandId(), {
      caseId,
      body: 'Suspect the payer is testing our dispute process. Watch for a pattern.',
    });
    expect(added.ok).toBe(true);

    const forOperator = await caseNotes(maker, caseId);
    expect(forOperator.ok).toBe(true);
    if (!forOperator.ok) return;
    expect(forOperator.value).toHaveLength(1);

    const forParticipant = await caseNotes(bare(alice), caseId);
    expect(forParticipant.ok).toBe(false);
    if (forParticipant.ok) return;
    expect(forParticipant.code).toBe('PERMISSION_DENIED');

    // And they do not leak through the room projection either.
    const room = await dealRoom(bare(alice), dealId);
    expect(JSON.stringify(room)).not.toContain('testing our dispute process');
  });

  it('the participant-facing case view carries no note or rationale column', async () => {
    const { rows } = await getPool().query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='sandbox' AND table_name='case_timeline'`,
    );
    const columns = rows.map((r) => r.column_name as string);
    expect(columns).not.toContain('snapshot');
    expect(columns).not.toContain('rationale');
  });
});

/* ================================================================== *
 * The queue
 * ================================================================== */

describe('the case queue is permission-gated', () => {
  it('is readable by an operator and refused to a customer', async () => {
    await disputedDeal();
    const forOperator = await caseQueue(maker);
    expect(forOperator.ok).toBe(true);
    if (!forOperator.ok) return;
    expect(forOperator.value.length).toBeGreaterThan(0);

    const forCustomer = await caseQueue(bare(alice));
    expect(forCustomer.ok).toBe(false);
    if (forCustomer.ok) return;
    expect(forCustomer.code).toBe('PERMISSION_DENIED');
  });

  it('is refused when the second factor is unproved', async () => {
    const outcome = await caseQueue(withoutMfa(maker));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('MFA_REQUIRED');
  });
});

/* ================================================================== *
 * Late events after resolution
 * ================================================================== */

describe('a late chain event cannot undo a completed ruling', () => {
  it('raises an INCIDENT instead of reversing value already disposed of', async () => {
    const { sign, usdtEvent } = await import('./support/rails');
    const { openPaymentIntentCommand, issuePaymentInstructionCommand, ingestRailEventCommand } =
      await import('@/services/commands');

    const dealId = await lockedDeal(alice, bob, 100_000n);
    const opened = await openPaymentIntentCommand(alice, newCommandId(), {
      dealId,
      rail: 'USDT',
      network: 'TRC20',
      direction: 'COLLECT',
      payeeId: bob.userId,
      amountMinor: 20_000n,
    });
    if (!opened.ok) return;
    const issued = await issuePaymentInstructionCommand(alice, newCommandId(), {
      intentId: opened.value.intentId,
    });
    if (!issued.ok) return;

    // The deposit confirms and posts.
    const confirmed = usdtEvent({ address: issued.value.destination, amountMinor: '20000' });
    expect((await ingestRailEventCommand(sign('sandbox-usdt', confirmed), confirmed)).ok).toBe(
      true,
    );

    // The value is then released to the counterparty.
    const released = await releaseValueCommand(alice, newCommandId(), {
      dealId,
      beneficiaryId: bob.userId,
    });
    expect(released.ok).toBe(true);
    const bobAfterRelease = await balanceOf(bob.userId);

    // NOW the chain reorganises.
    const reorg = usdtEvent({
      address: issued.value.destination,
      amountMinor: '20000',
      hash: confirmed.reference,
      status: 'REORGED',
    });
    const outcome = await ingestRailEventCommand(sign('sandbox-usdt', reorg), reorg);

    expect(outcome.ok, 'no safe automatic answer exists here').toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('INCIDENT_RAISED');

    // NOTHING was taken back from somebody who did nothing wrong.
    expect(await balanceOf(bob.userId)).toBe(bobAfterRelease);

    const { rows } = await getPool().query(
      `SELECT kind, state FROM sandbox.deal_incident WHERE deal_id = $1`,
      [dealId],
    );
    expect(rows[0]).toMatchObject({ kind: 'REORG_AFTER_DISPOSAL', state: 'OPEN' });

    // And no ledger history was rewritten.
    const { rows: entries } = await getPool().query(
      `SELECT count(*)::int AS n FROM inrp2p.journal_entry
        WHERE journal_code='JD-REVERSAL' AND entry_key_json->>'dealId' = $1`,
      [dealId],
    );
    expect(entries[0]!.n).toBe(0);
  });
});
