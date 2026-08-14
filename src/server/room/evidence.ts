import 'server-only';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getPool, type Tx } from '@/server/db/pool';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { denialFor, type Principal } from '@/server/identity/rbac';
import {
  getEvidenceScannerAdapter,
  getEvidenceStorageAdapter,
} from '@/server/adapters/evidenceStorage';

/**
 * Evidence: metadata here, bytes behind an adapter, access proved twice.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A RECEIPT IS EVIDENCE. IT IS NOT A PAYMENT.                       │
 * │                                                                    │
 * │  Nothing in this file touches a payment intent, a value lock or    │
 * │  the ledger, and it imports nothing that could. A screenshot of a  │
 * │  bank app is a photograph of a claim; only a signed provider       │
 * │  observation (DEL-05) confirms that money moved.                   │
 * │                                                                    │
 * │  THE ACCESS MODEL, in three parts:                                 │
 * │                                                                    │
 * │  1. Authorization is re-derived on EVERY request. Not cached, not  │
 * │     inherited from the upload, not implied by holding an id.       │
 * │  2. A capability is short-lived, single-use, single-purpose, and   │
 * │     stored only as a hash — a database dump hands nobody a         │
 * │     download.                                                      │
 * │  3. Bytes are served only from `READY`, which only a scanner can   │
 * │     produce. Unscanned evidence is unreachable, not merely         │
 * │     discouraged.                                                   │
 * └────────────────────────────────────────────────────────────────────┘
 */

export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

export const ACCEPTED_MEDIA_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;
export type EvidenceMediaType = (typeof ACCEPTED_MEDIA_TYPES)[number];

/**
 * How long a capability lives.
 *
 * Five minutes: long enough for a slow upload on a bad connection, short
 * enough that a token captured from a proxy log tomorrow is worthless.
 */
export const CAPABILITY_TTL_SECONDS = 300;

export type EvidenceState = 'PENDING' | 'QUARANTINED' | 'READY' | 'REJECTED';

export interface EvidenceRecord {
  readonly evidenceId: string;
  readonly dealId: string;
  readonly caseId: string | null;
  readonly uploadedBy: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly contentHash: string | null;
  readonly state: EvidenceState;
  readonly version: number;
  readonly supersedes: string | null;
}

function mapEvidence(r: Record<string, unknown>): EvidenceRecord {
  return {
    evidenceId: r.evidence_id as string,
    dealId: r.deal_id as string,
    caseId: (r.case_id as string | null) ?? null,
    uploadedBy: r.uploaded_by as string,
    filename: r.filename as string,
    mediaType: r.media_type as string,
    byteSize: Number(r.byte_size),
    contentHash: (r.content_hash as string | null) ?? null,
    state: r.state as EvidenceState,
    version: Number(r.version),
    supersedes: (r.supersedes as string | null) ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

/**
 * May this principal touch this deal's evidence?
 *
 * A PARTICIPANT may, because it is their deal. An OPERATOR may only with
 * `case.evidence.read` AND a satisfied second factor — reading somebody's
 * bank receipt is a disclosure, not a convenience, and it is the kind of
 * access that must cost something to obtain.
 */
async function mayReachDealEvidence(
  tx: Tx,
  principal: Principal,
  dealId: string,
): Promise<Outcome<'PARTICIPANT' | 'OPERATOR'>> {
  const { rows } = await tx.query(
    `SELECT 1 FROM sandbox.participant WHERE deal_id = $1 AND user_id = $2`,
    [dealId, principal.userId],
  );
  if (rows[0]) return accept('PARTICIPANT');

  const denial = denialFor(principal, 'case.evidence.read');
  if (denial === null) return accept('OPERATOR');
  if (denial === 'MFA_REQUIRED') return reject('MFA_REQUIRED', FAILURE_COPY.MFA_REQUIRED.reason);
  if (denial === 'MFA_NOT_ENROLLED') {
    return reject('MFA_NOT_ENROLLED', FAILURE_COPY.MFA_NOT_ENROLLED.reason);
  }
  /*
   * A non-participant with no permission is told the deal is private —
   * the same answer they would get for a deal that does not exist, so an
   * id cannot be probed for existence.
   */
  return reject('NOT_A_PARTICIPANT', FAILURE_COPY.NOT_A_PARTICIPANT.reason);
}

/* ------------------------------------------------------------------ *
 * Capabilities
 * ------------------------------------------------------------------ */

export interface Capability {
  /** Returned ONCE. Never stored, never logged, never re-derivable. */
  readonly token: string;
  readonly capabilityId: string;
  readonly expiresAt: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function issueCapability(
  tx: Tx,
  input: {
    readonly evidenceId: string;
    readonly kind: 'UPLOAD' | 'DOWNLOAD';
    readonly issuedTo: string;
  },
): Promise<Capability> {
  // 32 bytes of CSPRNG: not guessable, and not derived from the evidence
  // id, so knowing an id gives no head start on forging a token.
  const token = randomBytes(32).toString('hex');
  const { rows } = await tx.query(
    `INSERT INTO sandbox.evidence_capability
       (evidence_id, kind, token_hash, issued_to, expires_at)
     VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5))
     RETURNING capability_id, expires_at`,
    [input.evidenceId, input.kind, hashToken(token), input.issuedTo, CAPABILITY_TTL_SECONDS],
  );
  return {
    token,
    capabilityId: rows[0]!.capability_id as string,
    expiresAt: (rows[0]!.expires_at as Date).toISOString(),
  };
}

/**
 * Redeem a capability, exactly once.
 *
 * The lookup is by token HASH, so a stolen database gives nothing usable.
 * The comparison of the stored hash is constant-time for the same reason
 * a session token comparison is: an early-exit compare leaks the expected
 * value one byte at a time to anybody willing to measure.
 *
 * `consumed_at IS NULL` in the WHERE clause of the UPDATE is what makes
 * redemption single-use under concurrency — two simultaneous redemptions
 * update one row and zero rows.
 */
async function redeemCapability(
  tx: Tx,
  token: string,
  kind: 'UPLOAD' | 'DOWNLOAD',
): Promise<Outcome<{ evidenceId: string; issuedTo: string }>> {
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return reject('CAPABILITY_INVALID', FAILURE_COPY.CAPABILITY_INVALID.reason);
  }
  const digest = hashToken(token);

  const { rows } = await tx.query(
    `SELECT capability_id, evidence_id, issued_to, token_hash, kind,
            expires_at <= now() AS expired, consumed_at IS NOT NULL AS consumed
       FROM sandbox.evidence_capability WHERE token_hash = $1 FOR UPDATE`,
    [digest],
  );
  const row = rows[0];
  if (row === undefined || row.kind !== kind) {
    return reject('CAPABILITY_INVALID', FAILURE_COPY.CAPABILITY_INVALID.reason);
  }

  const stored = Buffer.from(row.token_hash as string, 'hex');
  const offered = Buffer.from(digest, 'hex');
  if (stored.length !== offered.length || !timingSafeEqual(stored, offered)) {
    return reject('CAPABILITY_INVALID', FAILURE_COPY.CAPABILITY_INVALID.reason);
  }

  if (row.consumed === true) {
    return reject('CAPABILITY_CONSUMED', FAILURE_COPY.CAPABILITY_CONSUMED.reason);
  }
  // Expiry is the DATABASE's clock, not the application's: a server with
  // a skewed clock must not be able to extend a capability's life.
  if (row.expired === true) {
    return reject('CAPABILITY_EXPIRED', FAILURE_COPY.CAPABILITY_EXPIRED.reason);
  }

  const { rowCount } = await tx.query(
    `UPDATE sandbox.evidence_capability SET consumed_at = now()
      WHERE capability_id = $1 AND consumed_at IS NULL`,
    [row.capability_id],
  );
  if (rowCount === 0) {
    return reject('CAPABILITY_CONSUMED', FAILURE_COPY.CAPABILITY_CONSUMED.reason);
  }

  return accept({
    evidenceId: row.evidence_id as string,
    issuedTo: row.issued_to as string,
  });
}

/* ------------------------------------------------------------------ *
 * Upload
 * ------------------------------------------------------------------ */

export async function beginUpload(
  tx: Tx,
  principal: Principal,
  input: {
    readonly dealId: string;
    readonly caseId?: string | null;
    readonly filename: string;
    readonly mediaType: string;
    readonly byteSize: number;
    readonly supersedes?: string | null;
  },
): Promise<Outcome<{ evidence: EvidenceRecord; capability: Capability }>> {
  // Only a PARTICIPANT uploads. An operator investigating a case reads
  // evidence; they do not add to the parties' own record of events.
  const { rows: seat } = await tx.query(
    `SELECT 1 FROM sandbox.participant WHERE deal_id = $1 AND user_id = $2`,
    [input.dealId, principal.userId],
  );
  if (!seat[0]) return reject('NOT_A_PARTICIPANT', FAILURE_COPY.NOT_A_PARTICIPANT.reason);

  if (!(ACCEPTED_MEDIA_TYPES as readonly string[]).includes(input.mediaType)) {
    return reject('EVIDENCE_TYPE_REJECTED', FAILURE_COPY.EVIDENCE_TYPE_REJECTED.reason);
  }
  if (!Number.isInteger(input.byteSize) || input.byteSize <= 0) {
    return reject('EVIDENCE_TOO_LARGE', FAILURE_COPY.EVIDENCE_TOO_LARGE.reason);
  }
  if (input.byteSize > MAX_EVIDENCE_BYTES) {
    return reject('EVIDENCE_TOO_LARGE', FAILURE_COPY.EVIDENCE_TOO_LARGE.reason);
  }

  // `getEvidenceStorageAdapter` throws in production. Deliberately not
  // caught: a missing storage provider is a deployment fault and must be
  // loud, not rendered as a tidy message on a screen that looks fine.
  const storage = getEvidenceStorageAdapter();

  /*
   * The id is minted HERE, before the insert.
   *
   * The storage key is derived from it, so the row can be written once,
   * complete. The earlier shape — insert a placeholder key, then UPDATE
   * it — was refused by the immutability trigger, and correctly so: an
   * evidence row whose storage key can change is an evidence row whose
   * bytes can be swapped after the fact.
   */
  const evidenceId = randomUUID();
  const { storageKey } = await storage.reserve(evidenceId);

  const { rows: created } = await tx.query(
    `INSERT INTO sandbox.evidence_object
       (evidence_id, deal_id, case_id, uploaded_by, storage_key, provider_key,
        filename, media_type, byte_size, supersedes, version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             coalesce((SELECT version + 1 FROM sandbox.evidence_object
                        WHERE evidence_id = $10), 1))
     RETURNING evidence_id, deal_id, case_id, uploaded_by, filename, media_type,
               byte_size, content_hash, state, version, supersedes`,
    [
      evidenceId,
      input.dealId,
      input.caseId ?? null,
      principal.userId,
      storageKey,
      storage.providerKey,
      // The filename is stored for display and NEVER used in a path: a
      // user-supplied name in a storage key is a traversal bug waiting
      // to be written, and two people uploading `receipt.pdf` must not
      // collide.
      input.filename.slice(0, 200),
      input.mediaType,
      input.byteSize,
      input.supersedes ?? null,
    ],
  );

  const capability = await issueCapability(tx, {
    evidenceId,
    kind: 'UPLOAD',
    issuedTo: principal.userId,
  });

  return accept({ evidence: mapEvidence(created[0]!), capability });
}

/**
 * Accept bytes and scan them.
 *
 * The declared size and type are checked against what ACTUALLY arrived,
 * not trusted from the request that announced it — a client that says
 * "1 KB PNG" and sends 4 MB of something else is the ordinary case, not
 * the exotic one.
 */
export async function completeUpload(
  tx: Tx,
  input: { readonly token: string; readonly bytes: Buffer },
): Promise<Outcome<EvidenceRecord>> {
  const redeemed = await redeemCapability(tx, input.token, 'UPLOAD');
  if (!redeemed.ok) return redeemed;

  const { rows } = await tx.query(
    `SELECT evidence_id, deal_id, case_id, uploaded_by, storage_key, filename,
            media_type, byte_size, content_hash, state, version, supersedes
       FROM sandbox.evidence_object WHERE evidence_id = $1 FOR UPDATE`,
    [redeemed.value.evidenceId],
  );
  const row = rows[0];
  if (row === undefined) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);
  if (row.state !== 'PENDING') {
    return reject('EVIDENCE_REJECTED', 'That upload has already been completed.');
  }

  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_EVIDENCE_BYTES) {
    await tx.query(
      `UPDATE sandbox.evidence_object
          SET state='REJECTED', rejected_reason=$2, uploaded_at=now()
        WHERE evidence_id=$1`,
      [row.evidence_id, 'The uploaded content was empty or larger than 5 MB.'],
    );
    return reject('EVIDENCE_TOO_LARGE', FAILURE_COPY.EVIDENCE_TOO_LARGE.reason);
  }

  const storage = getEvidenceStorageAdapter();
  const stored = await storage.put(row.storage_key as string, input.bytes);

  /*
   * QUARANTINED FIRST, ALWAYS.
   *
   * The row is written as quarantined before the scanner is consulted,
   * so a crash between arrival and verdict leaves evidence that is
   * un-downloadable rather than evidence that defaults to readable.
   */
  await tx.query(
    `UPDATE sandbox.evidence_object
        SET state='QUARANTINED', uploaded_at=now(), content_hash=$2
      WHERE evidence_id=$1`,
    [row.evidence_id, stored.contentHash],
  );

  const scanner = getEvidenceScannerAdapter();
  const verdict = await scanner.scan(input.bytes, row.media_type as string);

  if (verdict.verdict !== 'CLEAN') {
    const { rows: rejected } = await tx.query(
      `UPDATE sandbox.evidence_object
          SET state='REJECTED', scan_verdict=$2, scanned_at=now(), rejected_reason=$3
        WHERE evidence_id=$1
        RETURNING evidence_id, deal_id, case_id, uploaded_by, filename, media_type,
                  byte_size, content_hash, state, version, supersedes`,
      [row.evidence_id, verdict.verdict, verdict.detail],
    );
    return accept(mapEvidence(rejected[0]!));
  }

  const { rows: ready } = await tx.query(
    `UPDATE sandbox.evidence_object
        SET state='READY', scan_verdict='CLEAN', scanned_at=now()
      WHERE evidence_id=$1
      RETURNING evidence_id, deal_id, case_id, uploaded_by, filename, media_type,
                byte_size, content_hash, state, version, supersedes`,
    [row.evidence_id],
  );
  return accept(mapEvidence(ready[0]!));
}

/* ------------------------------------------------------------------ *
 * Download
 * ------------------------------------------------------------------ */

/**
 * Issue a download capability.
 *
 * Authorization is re-derived HERE, at the moment of the request. An
 * operator who could read this yesterday, and whose grant was revoked
 * this morning, gets nothing — because nothing about the earlier
 * permission was written down anywhere that this path consults.
 */
export async function requestDownload(
  tx: Tx,
  principal: Principal,
  evidenceId: string,
): Promise<Outcome<Capability>> {
  const { rows } = await tx.query(
    `SELECT evidence_id, deal_id, state FROM sandbox.evidence_object WHERE evidence_id = $1`,
    [evidenceId],
  );
  const row = rows[0];
  if (row === undefined) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);

  const allowed = await mayReachDealEvidence(tx, principal, row.deal_id as string);
  if (!allowed.ok) return allowed;

  if (row.state === 'REJECTED') {
    return reject('EVIDENCE_REJECTED', FAILURE_COPY.EVIDENCE_REJECTED.reason);
  }
  // Only `READY` is servable. Quarantined bytes exist and are
  // unreachable, which is the entire point of the state.
  if (row.state !== 'READY') {
    return reject('EVIDENCE_NOT_READY', FAILURE_COPY.EVIDENCE_NOT_READY.reason);
  }

  return accept(
    await issueCapability(tx, { evidenceId, kind: 'DOWNLOAD', issuedTo: principal.userId }),
  );
}

/**
 * Redeem a download capability and return the bytes.
 *
 * Authorization is checked AGAIN, even though the capability was issued
 * to this person moments ago. A capability proves "somebody was allowed
 * to ask for this recently"; it does not prove they still are, and a
 * revoked operator holding a live token must not be able to spend it.
 */
export async function fetchEvidence(
  tx: Tx,
  principal: Principal,
  token: string,
): Promise<Outcome<{ bytes: Buffer; record: EvidenceRecord }>> {
  const redeemed = await redeemCapability(tx, token, 'DOWNLOAD');
  if (!redeemed.ok) return redeemed;

  // A capability is not transferable. Handing a colleague your download
  // link must not hand them your authority.
  if (redeemed.value.issuedTo !== principal.userId) {
    return reject('CAPABILITY_INVALID', FAILURE_COPY.CAPABILITY_INVALID.reason);
  }

  const { rows } = await tx.query(
    `SELECT evidence_id, deal_id, case_id, uploaded_by, storage_key, filename,
            media_type, byte_size, content_hash, state, version, supersedes
       FROM sandbox.evidence_object WHERE evidence_id = $1`,
    [redeemed.value.evidenceId],
  );
  const row = rows[0];
  if (row === undefined) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);

  const allowed = await mayReachDealEvidence(tx, principal, row.deal_id as string);
  if (!allowed.ok) return allowed;

  if (row.state !== 'READY') {
    return reject('EVIDENCE_NOT_READY', FAILURE_COPY.EVIDENCE_NOT_READY.reason);
  }

  const bytes = await getEvidenceStorageAdapter().get(row.storage_key as string);
  if (bytes === null) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);

  /*
   * The hash is re-verified against the bytes that came back.
   *
   * Storage is a separate system that could be restored from a backup,
   * mis-keyed, or tampered with. Evidence whose content no longer
   * matches what was recorded is not evidence, and serving it silently
   * would put a different file in front of a reviewer under the
   * uploader's name.
   */
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== row.content_hash) {
    return reject('EVIDENCE_REJECTED', 'The stored file no longer matches its recorded hash.');
  }

  return accept({ bytes, record: mapEvidence(row) });
}

/* ------------------------------------------------------------------ *
 * Manifest
 * ------------------------------------------------------------------ */

/**
 * The evidence list for a deal.
 *
 * Reads the `evidence_manifest` VIEW, which carries no storage key. A
 * caller cannot leak what it was never given, and the exclusion lives in
 * the view rather than in each query that must remember it.
 */
export async function evidenceForDeal(
  principal: Principal,
  dealId: string,
): Promise<Outcome<readonly EvidenceRecord[]>> {
  const allowed = await withPool((tx) => mayReachDealEvidence(tx, principal, dealId));
  if (!allowed.ok) return allowed;

  const { rows } = await getPool().query(
    `SELECT evidence_id, deal_id, case_id, uploaded_by, filename, media_type,
            byte_size, content_hash, state, version, supersedes
       FROM sandbox.evidence_manifest WHERE deal_id = $1 ORDER BY created_at`,
    [dealId],
  );
  return accept(rows.map(mapEvidence));
}

/** Run a read-only authorization probe on the pool without a transaction. */
async function withPool<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client as unknown as Tx);
  } finally {
    client.release();
  }
}
