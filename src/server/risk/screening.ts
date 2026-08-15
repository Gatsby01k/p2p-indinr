import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getPool, type Tx } from '@/server/db/pool';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { AdapterUnavailableError, deploymentMode } from '@/server/adapters/mode';

/**
 * Screening — provider-neutral, and honest about what it is not.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  NOTHING HERE CLEARS ANYBODY AGAINST A REAL LIST.                  │
 * │                                                                    │
 * │  No sanctions, PEP, adverse-media or KYC provider is connected.    │
 * │  The sandbox provider is named `sandbox-screening` and every row   │
 * │  records which provider produced it, so no result in this database │
 * │  can be read as a real clearance.                                  │
 * │                                                                    │
 * │  Production therefore REFUSES rather than returning a clean        │
 * │  result. A false "no hit" is the single most dangerous output this │
 * │  module could produce: it is an affirmative statement that         │
 * │  somebody was checked when nobody was.                             │
 * │                                                                    │
 * │  A HIT never seizes anything. It opens a case with reason codes    │
 * │  and — at most — places a reversible hold. Concluding that a       │
 * │  person is sanctioned is a determination this software is in no    │
 * │  position to make.                                                 │
 * └────────────────────────────────────────────────────────────────────┘
 */

export type ScreeningKind = 'SANCTIONS' | 'PEP' | 'ADVERSE_MEDIA' | 'IDENTITY' | 'PAYMENT_RISK';

/** Not a secret. Published deliberately, so nobody trusts it. */
const SANDBOX_SCREENING_SECRET = 'sandbox-screening-key-not-a-secret';

/** How long a screening result is usable before it must be re-obtained. */
export const SCREENING_FRESH_SECONDS = 30 * 24 * 60 * 60;

/** Tolerance on a provider timestamp, as with the DEL-05 rails. */
export const SCREENING_SKEW_SECONDS = 300;

export function screeningSecret(providerKey: string): string {
  if (deploymentMode() === 'PRODUCTION') {
    throw new AdapterUnavailableError(
      `screening:${providerKey}`,
      'DEL-09 (Operations, Secrets and Dispatch)',
      'No screening provider is integrated and no signing key exists. Refusing ' +
        'to verify a compliance result with a published sandbox key.',
    );
  }
  return `${SANDBOX_SCREENING_SECRET}:${providerKey}`;
}

export function screeningAvailable(): boolean {
  return deploymentMode() !== 'PRODUCTION';
}

export interface ScreeningResponse {
  readonly providerKey: string;
  readonly providerRef: string;
  readonly kind: ScreeningKind;
  readonly subjectKind: 'user' | 'deal' | 'payment';
  readonly subjectId: string;
  /** The EXACT bytes received. Re-serialising before verifying breaks it. */
  readonly rawBody: string;
  readonly signature: string | null;
  readonly timestamp: string | null;
  /** Normalized, REDACTED findings. Never a provider's free-text narrative. */
  readonly findings: Readonly<Record<string, string | number | boolean>>;
  readonly hit: boolean;
}

export function signScreening(providerKey: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', screeningSecret(providerKey))
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

export interface RecordedScreening {
  readonly screeningId: string;
  readonly hit: boolean;
  readonly kind: ScreeningKind;
  readonly freshUntil: string;
}

/**
 * Verify and record a provider response.
 *
 * Same three checks as the DEL-05 rails, for the same reasons: the
 * signature covers `timestamp.body` so a captured request cannot be
 * replayed with a fresh header, the timestamp bounds how long a capture
 * is useful, and `(provider, ref)` uniqueness stops a replay inside the
 * window.
 *
 * The RAW BYTES ARE NOT STORED — only their SHA-256. A sanctions payload
 * is sensitive data about a named person, and keeping it in a
 * general-purpose table is how it reaches a log, an export or a support
 * screenshot.
 */
export async function recordScreening(
  tx: Tx,
  response: ScreeningResponse,
  now = new Date(),
): Promise<Outcome<RecordedScreening>> {
  if (deploymentMode() === 'PRODUCTION') {
    return reject('SCREENING_UNAVAILABLE', FAILURE_COPY.SCREENING_UNAVAILABLE.reason);
  }
  if (response.signature === null || response.timestamp === null) {
    return reject('SCREENING_UNVERIFIED', FAILURE_COPY.SCREENING_UNVERIFIED.reason);
  }
  if (!/^[0-9a-f]{64}$/i.test(response.signature) || !/^[0-9]{1,15}$/.test(response.timestamp)) {
    return reject('SCREENING_UNVERIFIED', FAILURE_COPY.SCREENING_UNVERIFIED.reason);
  }

  const providerAt = new Date(Number(response.timestamp) * 1000);
  const skew = (now.getTime() - providerAt.getTime()) / 1000;
  if (Math.abs(skew) > SCREENING_SKEW_SECONDS) {
    return reject('SCREENING_STALE', FAILURE_COPY.SCREENING_STALE.reason, {
      skewSeconds: Math.round(skew),
    });
  }

  const expected = Buffer.from(
    signScreening(response.providerKey, response.timestamp, response.rawBody),
    'hex',
  );
  const offered = Buffer.from(response.signature, 'hex');
  if (expected.length !== offered.length || !timingSafeEqual(expected, offered)) {
    return reject('SCREENING_UNVERIFIED', FAILURE_COPY.SCREENING_UNVERIFIED.reason);
  }

  const rawHash = createHash('sha256').update(response.rawBody).digest();

  const { rows } = await tx.query(
    `INSERT INTO sandbox.screening_result
       (provider_key, provider_ref, kind, subject_kind, subject_id, raw_hash,
        signature_verified, findings, hit, provider_at, fresh_until)
     VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8,$9::timestamptz,
             $9::timestamptz + make_interval(secs => $10))
     ON CONFLICT (provider_key, provider_ref) DO NOTHING
     RETURNING screening_id, hit, kind, fresh_until`,
    [
      response.providerKey,
      response.providerRef,
      response.kind,
      response.subjectKind,
      response.subjectId,
      rawHash,
      JSON.stringify(response.findings),
      response.hit,
      providerAt,
      SCREENING_FRESH_SECONDS,
    ],
  );

  if (rows[0] === undefined) {
    // A REPLAY. The first result stands; redelivery changes nothing.
    const { rows: prior } = await tx.query(
      `SELECT screening_id, hit, kind, fresh_until FROM sandbox.screening_result
        WHERE provider_key = $1 AND provider_ref = $2`,
      [response.providerKey, response.providerRef],
    );
    return reject('SCREENING_UNVERIFIED', FAILURE_COPY.SCREENING_UNVERIFIED.reason, {
      reason: 'REPLAYED',
      screeningId: prior[0]!.screening_id as string,
    });
  }

  return accept({
    screeningId: rows[0].screening_id as string,
    hit: rows[0].hit as boolean,
    kind: rows[0].kind as ScreeningKind,
    freshUntil: (rows[0].fresh_until as Date).toISOString(),
  });
}

/**
 * The freshest usable result of a kind for a subject.
 *
 * `fresh_until > now()` is evaluated by the DATABASE, so a stale result
 * is invisible rather than filtered — and a skewed application server
 * cannot extend a compliance check's life.
 */
export async function freshScreening(
  tx: Tx,
  input: {
    readonly subjectKind: 'user' | 'deal' | 'payment';
    readonly subjectId: string;
    readonly kind: ScreeningKind;
  },
): Promise<{ screeningId: string; hit: boolean } | null> {
  const { rows } = await tx.query(
    `SELECT screening_id, hit FROM sandbox.screening_result
      WHERE subject_kind = $1 AND subject_id = $2 AND kind = $3
        AND signature_verified AND fresh_until > now()
      ORDER BY received_at DESC LIMIT 1`,
    [input.subjectKind, input.subjectId, input.kind],
  );
  const r = rows[0];
  return r === undefined ? null : { screeningId: r.screening_id as string, hit: r.hit as boolean };
}

/**
 * The redacted screening history for a subject.
 *
 * Carries the normalized findings and never the raw hash's preimage —
 * because there is none stored. Even an authorised reader cannot obtain
 * the provider's original payload from this system, which is the
 * strongest form of "excluded from logs and exports".
 */
export async function screeningHistory(
  subjectKind: string,
  subjectId: string,
): Promise<
  readonly {
    screeningId: string;
    providerKey: string;
    kind: ScreeningKind;
    hit: boolean;
    findings: Record<string, unknown>;
    receivedAt: string;
  }[]
> {
  const { rows } = await getPool().query(
    `SELECT screening_id, provider_key, kind, hit, findings, received_at
       FROM sandbox.screening_result
      WHERE subject_kind = $1 AND subject_id = $2
      ORDER BY received_at DESC`,
    [subjectKind, subjectId],
  );
  return rows.map((r) => ({
    screeningId: r.screening_id as string,
    providerKey: r.provider_key as string,
    kind: r.kind as ScreeningKind,
    hit: r.hit as boolean,
    findings: r.findings as Record<string, unknown>,
    receivedAt: (r.received_at as Date).toISOString(),
  }));
}
