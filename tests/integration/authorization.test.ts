/**
 * Authorization and state-transition enforcement — against the real database.
 *
 * Every assertion here calls the same service functions the UI calls. Nothing
 * is checked by inspecting a component: if the server would allow it, these
 * tests allow it, which is the point.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { makeOperator, type OperatorFixture } from './support/operator';
import { unique } from './support/room';
import { getPool } from '@/server/db/pool';
import {
  SandboxFailure,
  confirmReceipt,
  createDealLink,
  getDeal,
  getLinkPreview,
  issueFirmQuote,
  joinDealLink,
  operatorQueue,
  signInSandbox,
  submitPaymentClaim,
  type SessionUser,
} from '@/server/sandbox/service';

/*
 * A fixture identity THIS FILE owns.
 *
 * It used to be the literal `ops@sandbox.test` — and so did the one in
 * the other suite, meaning the same account, with the same TOTP factor,
 * was re-enrolled and step-burned by two files in a single run. In file
 * order it happened to survive; under shuffle it failed in `beforeAll`
 * and took the whole file down with it. A shared mutable credential is
 * not a fixture.
 */
const AUTHZ_OPS_EMAIL = `ops-${unique()}@sandbox.test`;

let seller: SessionUser; // creates links, CRYPTO_SIDE (supplies USDT)
let buyer: SessionUser; // joins, FIAT_SIDE (sends INR)
let outsider: SessionUser;
let operator: OperatorFixture;

/** A principal with no roles — what an ordinary signed-in person carries. */
const bare = (u: SessionUser) => ({
  userId: u.userId,
  roles: [] as const,
  permissions: [] as const,
  mfaSatisfied: false,
  mfaEnrolled: false,
});
let unverified: SessionUser;

beforeAll(async () => {
  seller = await signInSandbox('authz-seller@sandbox.test');
  buyer = await signInSandbox('authz-buyer@sandbox.test');
  outsider = await signInSandbox('authz-outsider@sandbox.test');
  operator = await makeOperator(AUTHZ_OPS_EMAIL);
  unverified = await signInSandbox('new@sandbox.test');
});

async function openLink(): Promise<string> {
  const q = await issueFirmQuote(seller, 'USDT_TO_INR', 500_000_000n);
  const l = await createDealLink(seller, q.quoteId);
  return l.publicId;
}

/** A joined deal: seller = CRYPTO_SIDE, buyer = FIAT_SIDE. */
async function joinedDeal(): Promise<string> {
  const publicId = await openLink();
  const r = await joinDealLink(buyer, publicId);
  return r.dealId;
}

const code = (c: string) => ({ code: c });

/**
 * A fresh, valid UTR.
 *
 * `UNIQUE(utr)` is platform-wide and the sandbox database PERSISTS between
 * runs, so a hard-coded literal passes once and then collides forever after.
 * Deriving one per call keeps each run independent without weakening the
 * constraint being tested.
 */
let utrSeq = 0;
function utr(): string {
  utrSeq += 1;
  const stamp = Date.now().toString(36).toUpperCase().slice(-8);
  return `${stamp}${String(utrSeq).padStart(4, '0')}`.slice(0, 12).padEnd(12, '0');
}

describe('join authorization', () => {
  it('rejects an unverified account', async () => {
    const publicId = await openLink();
    await expect(joinDealLink(unverified, publicId)).rejects.toMatchObject(
      code('REQUIRES_VERIFICATION'),
    );
  });

  it('forbids the creator joining their own link', async () => {
    const publicId = await openLink();
    await expect(joinDealLink(seller, publicId)).rejects.toMatchObject(
      code('CANNOT_JOIN_OWN_LINK'),
    );
    // And the link is still open for a real counterparty afterwards.
    expect((await getLinkPreview(publicId))?.joinable).toBe(true);
  });

  it('assigns the joiner the opposite seat to the creator', async () => {
    const publicId = await openLink();
    const joined = await joinDealLink(buyer, publicId);
    expect(joined.role).toBe('FIAT_SIDE'); // seller supplies USDT ⇒ CRYPTO_SIDE

    const asBuyer = await getDeal(buyer, joined.dealId);
    const asSeller = await getDeal(seller, joined.dealId);
    expect(asBuyer.viewerRole).toBe('FIAT_SIDE');
    expect(asSeller.viewerRole).toBe('CRYPTO_SIDE');
  });
});

describe('deal privacy', () => {
  it('refuses an outsider any deal content', async () => {
    const dealId = await joinedDeal();
    await expect(getDeal(outsider, dealId)).rejects.toBeInstanceOf(SandboxFailure);
    await expect(getDeal(outsider, dealId)).rejects.toMatchObject(code('NOT_A_PARTICIPANT'));
  });

  it('refuses an outsider even when they know the deal id', async () => {
    const dealId = await joinedDeal();
    // The id is not a capability: knowing it grants nothing.
    await expect(getDeal(outsider, dealId)).rejects.toMatchObject(code('NOT_A_PARTICIPANT'));
    await expect(getDeal(operator.user, dealId)).rejects.toMatchObject(code('NOT_A_PARTICIPANT'));
  });

  it('lets both participants read it', async () => {
    const dealId = await joinedDeal();
    await expect(getDeal(buyer, dealId)).resolves.toMatchObject({ state: 'FIAT_PENDING' });
    await expect(getDeal(seller, dealId)).resolves.toMatchObject({ state: 'FIAT_PENDING' });
  });
});

describe('payment claim authorization', () => {
  it('only FIAT_SIDE may claim', async () => {
    const dealId = await joinedDeal();
    await expect(submitPaymentClaim(seller, dealId, 'ABC123456789')).rejects.toMatchObject(
      code('NOT_FIAT_SIDE'),
    );
    await expect(submitPaymentClaim(outsider, dealId, utr())).rejects.toMatchObject(
      code('NOT_A_PARTICIPANT'),
    );
    await expect(submitPaymentClaim(buyer, dealId, utr())).resolves.toMatchObject({
      state: 'FIAT_CLAIMED',
    });
  });

  it('rejects a malformed UTR before touching the deal', async () => {
    const dealId = await joinedDeal();
    // Note `lowercase123` is deliberately absent: it is twelve alphanumerics
    // and is *valid* once normalized — see the next test.
    for (const bad of ['', 'short', 'TOOLONG123456789', 'ABC 12345678', 'ABC-123456789']) {
      await expect(submitPaymentClaim(buyer, dealId, bad)).rejects.toMatchObject(
        code('UTR_INVALID'),
      );
    }
    expect((await getDeal(buyer, dealId)).state).toBe('FIAT_PENDING');
  });

  it('normalizes case and surrounding whitespace rather than punishing the typist', async () => {
    // A bank reference is case-insensitive. Someone copying it out of an SMS
    // in lowercase, or pasting it with a trailing space, has still given the
    // right reference; rejecting them would be a usability defect dressed up
    // as validation. It is normalized once, at the server, then stored in the
    // canonical form the UNIQUE constraint sees.
    const dealId = await joinedDeal();
    const canonical = utr();
    const typed = `  ${canonical.toLowerCase()} `;

    const after = await submitPaymentClaim(buyer, dealId, typed);
    expect(after.state).toBe('FIAT_CLAIMED');
    expect(after.claim?.utr).toBe(canonical);

    // And the normalized form is what collides, so case cannot be used to
    // sneak the same reference onto a second deal.
    const other = await joinedDeal();
    await expect(submitPaymentClaim(buyer, other, canonical.toLowerCase())).rejects.toMatchObject(
      code('UTR_ALREADY_USED'),
    );
  });

  it('refuses a UTR already used on another deal', async () => {
    const first = await joinedDeal();
    const second = await joinedDeal();
    const reused = utr();
    await submitPaymentClaim(buyer, first, reused);
    await expect(submitPaymentClaim(buyer, second, reused)).rejects.toMatchObject(
      code('UTR_ALREADY_USED'),
    );
    expect((await getDeal(buyer, second)).state).toBe('FIAT_PENDING');
  });

  it('refuses a second claim on the same deal', async () => {
    const dealId = await joinedDeal();
    await submitPaymentClaim(buyer, dealId, utr());
    await expect(submitPaymentClaim(buyer, dealId, utr())).rejects.toMatchObject(
      code('ALREADY_CLAIMED'),
    );
  });
});

describe('confirmation authorization', () => {
  it('only CRYPTO_SIDE may confirm, and never the claimant', async () => {
    const dealId = await joinedDeal();
    await submitPaymentClaim(buyer, dealId, utr());

    await expect(confirmReceipt(buyer, dealId)).rejects.toMatchObject(code('NOT_CRYPTO_SIDE'));
    await expect(confirmReceipt(outsider, dealId)).rejects.toMatchObject(code('NOT_A_PARTICIPANT'));
    await expect(confirmReceipt(seller, dealId)).resolves.toMatchObject({ state: 'COMPLETED' });
  });

  it('refuses confirmation before a claim exists', async () => {
    const dealId = await joinedDeal();
    await expect(confirmReceipt(seller, dealId)).rejects.toMatchObject(code('NOT_CLAIMED_YET'));
  });
});

describe('terminal deals reject further mutation', () => {
  it('rejects claim and confirm once COMPLETED', async () => {
    const dealId = await joinedDeal();
    await submitPaymentClaim(buyer, dealId, utr());
    await confirmReceipt(seller, dealId);

    const done = await getDeal(buyer, dealId);
    expect(done.state).toBe('COMPLETED');
    expect(done.permitted.canClaim).toBe(false);
    expect(done.permitted.canConfirm).toBe(false);

    await expect(submitPaymentClaim(buyer, dealId, utr())).rejects.toMatchObject(
      code('DEAL_TERMINAL'),
    );
    await expect(confirmReceipt(seller, dealId)).rejects.toMatchObject(code('DEAL_TERMINAL'));
  });
});

describe('permitted actions are server-decided', () => {
  /**
   * Asserted as a WHOLE OBJECT, not with `toMatchObject`.
   *
   * The point of this test is that the server hands the UI a complete,
   * closed set of permissions. A loose match would let a future permission
   * appear — silently granted to the wrong seat — without failing anything.
   */
  it('never grants FIAT_SIDE a confirm or CRYPTO_SIDE a claim', async () => {
    const dealId = await joinedDeal();

    const pendingBuyer = await getDeal(buyer, dealId);
    expect(pendingBuyer.permitted).toEqual({
      canClaim: true,
      canConfirm: false,
      canDispute: true,
      canMessage: true,
      canUpload: true,
      canCancel: true,
    });

    const pendingSeller = await getDeal(seller, dealId);
    expect(pendingSeller.permitted).toEqual({
      canClaim: false,
      canConfirm: false,
      canDispute: true,
      canMessage: true,
      canUpload: true,
      canCancel: true,
    });

    await submitPaymentClaim(buyer, dealId, utr());

    // Once a payment is claimed, cancelling would strand a real transfer,
    // so it stops being permitted for either side. The route out is a
    // dispute, which stays open to both.
    const claimedBuyer = await getDeal(buyer, dealId);
    expect(claimedBuyer.permitted).toEqual({
      canClaim: false,
      canConfirm: false,
      canDispute: true,
      canMessage: true,
      canUpload: true,
      canCancel: false,
    });

    const claimedSeller = await getDeal(seller, dealId);
    expect(claimedSeller.permitted).toEqual({
      canClaim: false,
      canConfirm: true,
      canDispute: true,
      canMessage: true,
      canUpload: true,
      canCancel: false,
    });
  });

  it('closes every action once the deal is terminal', async () => {
    const dealId = await joinedDeal();
    await submitPaymentClaim(buyer, dealId, utr());
    await confirmReceipt(seller, dealId);

    for (const viewer of [buyer, seller]) {
      const done = await getDeal(viewer, dealId);
      expect(done.permitted).toEqual({
        canClaim: false,
        canConfirm: false,
        canDispute: false,
        canMessage: false,
        canUpload: false,
        canCancel: false,
      });
    }
  });
});

describe('operator access', () => {
  it('denies a non-operator before any row is read', async () => {
    await expect(operatorQueue(bare(buyer))).rejects.toBeInstanceOf(SandboxFailure);
    await expect(operatorQueue(bare(seller))).rejects.toBeInstanceOf(SandboxFailure);
  });

  it('allows an operator', async () => {
    await joinedDeal();
    await expect(operatorQueue(operator.principal)).resolves.toBeInstanceOf(Array);
  });

  it('never exposes identities or UTRs in the operator queue', async () => {
    const dealId = await joinedDeal();
    await submitPaymentClaim(buyer, dealId, utr());
    const rows = await operatorQueue(operator.principal);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(utr());
    expect(text).not.toContain(buyer.email);
    expect(text).not.toContain(seller.email);
  });
});

describe('link status is server-derived and never contradictory', () => {
  it('reports exactly one status, and a consumed link is never joinable', async () => {
    const publicId = await openLink();

    const open = await getLinkPreview(publicId);
    expect(open?.displayStatus).toBe('OPEN');
    expect(open?.joinable).toBe(true);

    await joinDealLink(buyer, publicId);

    const consumed = await getLinkPreview(publicId);
    expect(consumed?.displayStatus).toBe('CONSUMED');
    expect(consumed?.joinable).toBe(false);
  });

  it('marks a link consumed even after its expiry passes', async () => {
    // CONSUMED outranks expiry: a taken link is taken regardless of the clock.
    const publicId = await openLink();
    await joinDealLink(buyer, publicId);
    await getPool().query(
      `UPDATE sandbox.deal_link SET expires_at = now() - interval '1 hour' WHERE public_id = $1`,
      [publicId],
    );
    const p = await getLinkPreview(publicId);
    expect(p?.displayStatus).toBe('CONSUMED');
    expect(p?.joinable).toBe(false);
  });

  it('reports EXPIRED (not OPEN) once the server clock passes expiry', async () => {
    const publicId = await openLink();
    await getPool().query(
      `UPDATE sandbox.deal_link SET expires_at = now() - interval '1 second' WHERE public_id = $1`,
      [publicId],
    );
    const p = await getLinkPreview(publicId);
    expect(p?.displayStatus).toBe('EXPIRED');
    expect(p?.joinable).toBe(false);
    await expect(joinDealLink(buyer, publicId)).rejects.toMatchObject(code('LINK_EXPIRED'));
  });

  it('exposes no identity in the public preview', async () => {
    const publicId = await openLink();
    const text = JSON.stringify(await getLinkPreview(publicId));
    expect(text).not.toContain(seller.email);
    expect(text).not.toContain(seller.userId);
    expect(text).not.toContain(seller.displayName);
    expect(text).not.toMatch(/IFSC|account number|wallet|utr/i);
  });
});

describe('quote expiry is server-controlled', () => {
  it('refuses to build a link from an expired quote', async () => {
    const q = await issueFirmQuote(seller, 'USDT_TO_INR', 100_000_000n);
    await getPool().query(
      // Backdate BOTH timestamps: `quote_expiry_after_issue` correctly forbids
      // a quote whose expiry precedes its issuance, so simulating the passage
      // of time means moving the whole row back, not just its deadline.
      `UPDATE sandbox.quote
          SET created_at = now() - interval '10 minutes',
              expires_at = now() - interval '1 second'
        WHERE quote_id = $1`,
      [q.quoteId],
    );
    await expect(createDealLink(seller, q.quoteId)).rejects.toMatchObject(code('QUOTE_EXPIRED'));
  });

  it('refuses to reuse a quote already turned into a link', async () => {
    const q = await issueFirmQuote(seller, 'USDT_TO_INR', 100_000_000n);
    await createDealLink(seller, q.quoteId);
    await expect(createDealLink(seller, q.quoteId)).rejects.toMatchObject(code('QUOTE_CONSUMED'));
  });

  it("refuses another user's quote", async () => {
    const q = await issueFirmQuote(seller, 'USDT_TO_INR', 100_000_000n);
    await expect(createDealLink(buyer, q.quoteId)).rejects.toMatchObject(code('NOT_A_PARTICIPANT'));
  });
});

describe('audit trail persists every transition', () => {
  it('records join, claim and confirm with actor and outcome', async () => {
    const dealId = await joinedDeal();
    await submitPaymentClaim(buyer, dealId, utr());
    await confirmReceipt(seller, dealId);

    const { rows } = await getPool().query(
      `SELECT action, from_state, to_state, outcome, actor_id
         FROM sandbox.audit_event WHERE subject_id = $1 ORDER BY audit_id`,
      [dealId],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('LINK_JOIN');
    expect(actions).toContain('PAYMENT_CLAIM');
    expect(actions).toContain('CONFIRM_RECEIPT');
    expect(rows.every((r) => r.outcome === 'OK')).toBe(true);
    expect(rows.find((r) => r.action === 'CONFIRM_RECEIPT')?.to_state).toBe('COMPLETED');
  });

  it('records rejections too, with the rejection code as the outcome', async () => {
    const dealId = await joinedDeal();
    await expect(submitPaymentClaim(seller, dealId, utr())).rejects.toBeInstanceOf(SandboxFailure);
    const { rows } = await getPool().query(
      `SELECT outcome FROM sandbox.audit_event
        WHERE subject_id = $1 AND outcome <> 'OK'`,
      [dealId],
    );
    expect(rows.map((r) => r.outcome)).toContain('NOT_FIAT_SIDE');
  });

  it('is append-only: updates and deletes are refused', async () => {
    const dealId = await joinedDeal();
    const before = await getPool().query(
      `SELECT count(*)::int AS n FROM sandbox.audit_event WHERE subject_id = $1`,
      [dealId],
    );
    await getPool().query(`UPDATE sandbox.audit_event SET outcome = 'TAMPERED'`);
    await getPool().query(`DELETE FROM sandbox.audit_event WHERE subject_id = $1`, [dealId]);
    const after = await getPool().query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE outcome = 'TAMPERED')::int AS bad
         FROM sandbox.audit_event WHERE subject_id = $1`,
      [dealId],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(after.rows[0]!.bad).toBe(0);
  });
});

describe('persistence across a fresh read', () => {
  it('survives a completely new connection and query', async () => {
    const dealId = await joinedDeal();
    const submitted = utr();
    await submitPaymentClaim(buyer, dealId, submitted);
    await confirmReceipt(seller, dealId);

    // Nothing cached: read the row straight out of the database.
    const { rows } = await getPool().query(
      `SELECT state, completed_at FROM sandbox.deal WHERE deal_id = $1`,
      [dealId],
    );
    expect(rows[0]!.state).toBe('COMPLETED');
    expect(rows[0]!.completed_at).not.toBeNull();

    const reread = await getDeal(buyer, dealId);
    expect(reread.state).toBe('COMPLETED');
    expect(reread.claim?.utr).toBe(submitted);
  });
});
