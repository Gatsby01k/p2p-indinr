import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { getPool, withTransaction, type Tx } from '@/server/db/pool';
import { FAILURE_COPY, type SandboxError } from '@/lib/sandboxContract';
import { accept, reject, type Outcome, type Rejected } from './outcome';

/**
 * The DEL-02 command boundary.
 *
 * Every externally retryable mutation runs through `runCommand`, and one
 * transaction carries all four of the things TS-02 requires to move
 * together:
 *
 *   · the command record (identity + canonical payload hash + outcome);
 *   · the domain mutation;
 *   · the audit event;
 *   · the outbox event.
 *
 * They commit together or not at all. There is no code path that writes
 * one without the others, because they are all issued on the same `Tx`
 * handle and the handle is only reachable from inside the body.
 */

/* ------------------------------------------------------------------ *
 * Canonical payload hashing
 * ------------------------------------------------------------------ */

/**
 * A stable JSON encoding, so two structurally identical payloads hash the
 * same regardless of key order.
 *
 * `{a:1,b:2}` and `{b:2,a:1}` are the same request. A naive
 * `JSON.stringify` would give them different hashes and turn an honest
 * retry into an idempotency conflict, so keys are sorted at every depth.
 * `undefined` is dropped rather than encoded, matching JSON semantics;
 * `bigint` is encoded as its decimal string, because a money-shaped value
 * must never pass through a JS `number` even to be hashed.
 */
export function canonicalise(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number in command payload');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
  }
  // `undefined`, functions and symbols cannot appear in a command payload.
  throw new TypeError(`unserialisable value in command payload: ${typeof value}`);
}

export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalise(payload)).digest('hex');
}

/* ------------------------------------------------------------------ *
 * Durable rejection representation
 * ------------------------------------------------------------------ */

/**
 * The stored shape of a refused command.
 *
 * `v` is a format marker so a later stage can extend this without having
 * to guess what an old row meant.
 */
interface StoredRejection {
  readonly v: 1;
  readonly code: string;
  readonly message: string;
  readonly detail?: Record<string, unknown>;
}

function encodeRejection(rejected: Rejected): StoredRejection {
  return rejected.detail === undefined
    ? { v: 1, code: rejected.code, message: rejected.message }
    : { v: 1, code: rejected.code, message: rejected.message, detail: rejected.detail };
}

/**
 * Rebuild a refusal from its stored form.
 *
 * MIGRATION STRATEGY for rows written before this existed: those carry
 * `result = '{}'`, so there is no stored message to replay. Rather than
 * fail on them — they are perfectly valid records of a real decision —
 * the code is authoritative and the sentence falls back to `FAILURE_COPY`,
 * which is exactly what the old implementation returned. Old rows
 * therefore keep behaving as they always did, and every row written from
 * now on replays verbatim. No data migration is required, which is the
 * point: a backfill of historical refusal wording would be inventing it.
 */
function replayRejection(code: SandboxError, stored: Record<string, unknown>): Rejected {
  const hasStoredMessage = typeof stored.message === 'string' && stored.message.length > 0;
  const message = hasStoredMessage
    ? (stored.message as string)
    : (FAILURE_COPY[code]?.reason ?? 'That request was refused.');
  const detail =
    stored.detail && typeof stored.detail === 'object'
      ? (stored.detail as Record<string, unknown>)
      : undefined;
  return reject(code, message, detail);
}

/** A caller-supplied command id must be a UUID; anything else is refused. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCommandId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** For server-initiated work that has no client to supply an id. */
export function newCommandId(): string {
  return randomUUID();
}

/* ------------------------------------------------------------------ *
 * Audit and outbox, bound to one transaction
 * ------------------------------------------------------------------ */

/**
 * What an audit or domain event is ABOUT.
 *
 * A closed union rather than a string, mirroring the CHECK constraints on
 * `audit_event` and `outbox_event`. Adding a kind therefore requires
 * touching the migration and this type together — which is the point: a
 * trail that accepts any subject kind is a trail nobody can query with
 * confidence.
 */
export type SubjectKind =
  | 'link'
  | 'deal'
  | 'quote'
  | 'user'
  | 'payment'
  | 'case'
  | 'evidence'
  | 'policy'
  | 'control';

export interface AuditEvent {
  readonly actorId: string | null;
  readonly action: string;
  readonly subjectKind: SubjectKind;
  readonly subjectId: string;
  readonly fromState?: string | null;
  readonly toState?: string | null;
  readonly outcome: string;
  readonly detail?: Record<string, unknown>;
}

export interface DomainEvent {
  readonly type: string;
  readonly subjectKind: SubjectKind;
  readonly subjectId: string;
  readonly payload?: Record<string, unknown>;
}

const AUDIT_SQL = `
  INSERT INTO sandbox.audit_event
    (actor_id, action, subject_kind, subject_id, from_state, to_state, outcome, detail)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;

export async function writeAudit(tx: Tx, e: AuditEvent): Promise<void> {
  await tx.query(AUDIT_SQL, [
    e.actorId,
    e.action,
    e.subjectKind,
    e.subjectId,
    e.fromState ?? null,
    e.toState ?? null,
    e.outcome,
    JSON.stringify(e.detail ?? {}),
  ]);
}

/**
 * The context a command body receives.
 *
 * It exposes the transaction, an audit writer and an event emitter — and
 * nothing that could reach a second connection. A body physically cannot
 * write outside the transaction it was given.
 */
export interface BoundaryContext {
  readonly tx: Tx;
  readonly commandId: string;
  /** Append an audit row inside this transaction. */
  audit(e: AuditEvent): Promise<void>;
  /** Append a domain event inside this transaction. */
  emit(e: DomainEvent): Promise<void>;
}

/**
 * Build a context over an existing transaction.
 *
 * `runCommand` uses this, and so do the two entry points that legitimately
 * have no client-supplied command id: the lifecycle sweep, and the
 * throwing primitives the integration suite drives directly. Both mint
 * their own id, so their outbox keys are still unique and still traceable
 * back to a single execution.
 */
export function boundaryContextFor(tx: Tx, commandId: string): BoundaryContext {
  let eventSequence = 0;
  return {
    tx,
    commandId,
    audit: (e) => writeAudit(tx, e),
    emit: async (e) => {
      eventSequence += 1;
      await tx.query(
        `INSERT INTO sandbox.outbox_event
           (event_key, event_type, subject_kind, subject_id, payload)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          // Derived from the command, so a replay cannot emit a second
          // copy even if the body were somehow re-entered.
          `${commandId}:${eventSequence}`,
          e.type,
          e.subjectKind,
          e.subjectId,
          JSON.stringify(e.payload ?? {}),
        ],
      );
    },
  };
}

/* ------------------------------------------------------------------ *
 * The executor
 * ------------------------------------------------------------------ */

export interface CommandSpec<T> {
  readonly commandId: string;
  readonly commandType: string;
  readonly actorId: string | null;
  /** Hashed canonically. Must contain every input that changes the result. */
  readonly payload: Record<string, unknown>;
  /**
   * The body is listed FIRST in inference order for a reason: `T` is
   * whatever the domain function returns, and the two codecs must follow
   * it. Declaring `encodeResult` before `body` would make TypeScript infer
   * `T` from the codec and then fail to check the body against it.
   */
  readonly body: (ctx: BoundaryContext) => Promise<Outcome<T>>;
  /** The serialisable form of a success, stored for replay. */
  readonly encodeResult: (value: T) => Record<string, unknown>;
  /**
   * Replays the recorded success. The stored JSON is the exact value the
   * first execution returned, so a replay is indistinguishable from it.
   */
  readonly decodeResult: (stored: Record<string, unknown>) => T;
}

/**
 * Run one command exactly once.
 *
 * The interesting case is not the happy path but the three ways a caller
 * can arrive twice:
 *
 *   IDENTICAL REPLAY — same id, same payload hash. The recorded outcome is
 *     returned verbatim, success or rejection alike. Nothing runs again.
 *
 *   CONFLICTING REPLAY — same id, different payload hash. Refused with
 *     `IDEMPOTENCY_CONFLICT`. Returning the old answer would be worse than
 *     an error: the caller would receive a result for a request it never
 *     made.
 *
 *   CONCURRENT DUPLICATE — two requests with the same id in flight at
 *     once. `INSERT ... ON CONFLICT DO NOTHING` makes the second wait on
 *     the first transaction's speculative insertion rather than racing it;
 *     when the first commits, the second sees zero inserted rows, reads
 *     the committed record under `FOR UPDATE`, and replays it. Exactly one
 *     execution occurs, decided by the database.
 */
export async function runCommand<T>(spec: CommandSpec<T>): Promise<Outcome<T>> {
  if (!isCommandId(spec.commandId)) {
    return reject('COMMAND_ID_INVALID', FAILURE_COPY.COMMAND_ID_INVALID.reason);
  }

  const hash = payloadHash(spec.payload);

  return withTransaction(async (tx) => {
    // Claim the command id. DO NOTHING rather than DO UPDATE: an existing
    // row is a completed decision and must never be overwritten.
    const claimed = await tx.query(
      `INSERT INTO sandbox.command
         (command_id, command_type, actor_id, payload_hash, status, result)
       VALUES ($1,$2,$3,$4,'SUCCEEDED','{}'::jsonb)
       ON CONFLICT (command_id) DO NOTHING
       RETURNING command_id`,
      [spec.commandId, spec.commandType, spec.actorId, hash],
    );

    if (claimed.rowCount === 0) {
      // Someone got here first. Read their decision, holding the row so a
      // third caller queues behind us rather than reading a partial state.
      const { rows } = await tx.query(
        `SELECT actor_id, command_type, payload_hash, status, outcome_code, result
           FROM sandbox.command WHERE command_id = $1 FOR UPDATE`,
        [spec.commandId],
      );
      const prior = rows[0]!;

      /*
       * OWNERSHIP IS CHECKED FIRST, AND DELIBERATELY SO.
       *
       * A command id is not a secret, but the result behind it can be: the
       * public id of somebody else's deal link, the id of their deal. If a
       * different actor replayed a guessed or leaked id we would otherwise
       * hand them that result verbatim.
       *
       * The check runs BEFORE the payload-hash and command-type
       * comparisons, so a stranger cannot use the difference between
       * "conflict" and "not yours" to learn whether they guessed the
       * original payload. They get one answer: it is not theirs.
       *
       * Anonymous ownership is explicit rather than incidental. A command
       * recorded with no actor is owned by "no actor", and only another
       * anonymous caller may replay it; a signed-in caller may not adopt
       * it, and an anonymous caller may not reach a signed-in one's.
       */
      const priorActor: string | null = prior.actor_id ?? null;
      if (priorActor !== spec.actorId) {
        await writeAudit(tx, {
          actorId: spec.actorId,
          action: spec.commandType,
          subjectKind: 'user',
          subjectId: spec.actorId ?? spec.commandId,
          outcome: 'COMMAND_NOT_YOURS',
          detail: { commandId: spec.commandId },
        });
        return reject('COMMAND_NOT_YOURS', FAILURE_COPY.COMMAND_NOT_YOURS.reason);
      }

      if (prior.payload_hash !== hash || prior.command_type !== spec.commandType) {
        // Recorded, because a caller contradicting itself is a signal.
        await writeAudit(tx, {
          actorId: spec.actorId,
          action: spec.commandType,
          subjectKind: 'user',
          subjectId: spec.actorId ?? spec.commandId,
          outcome: 'IDEMPOTENCY_CONFLICT',
          detail: { commandId: spec.commandId, expected: prior.payload_hash, received: hash },
        });
        return reject('IDEMPOTENCY_CONFLICT', FAILURE_COPY.IDEMPOTENCY_CONFLICT.reason);
      }

      if (prior.status === 'REJECTED') {
        return replayRejection(
          prior.outcome_code as SandboxError,
          prior.result as Record<string, unknown>,
        );
      }
      return accept(spec.decodeResult(prior.result as Record<string, unknown>));
    }

    // First execution. Everything below commits with the command row.
    const outcome = await spec.body(boundaryContextFor(tx, spec.commandId));

    if (outcome.ok) {
      await tx.query(
        `UPDATE sandbox.command
            SET status='SUCCEEDED', outcome_code=NULL, result=$2, completed_at=now()
          WHERE command_id=$1`,
        [spec.commandId, JSON.stringify(spec.encodeResult(outcome.value))],
      );
      return outcome;
    }

    /*
     * A REJECTION COMMITS — AND SO DOES ITS EXACT WORDING.
     *
     * The body returned rather than threw, so the transaction is healthy
     * and this write succeeds. No domain mutation accompanies it: every
     * guard in every body runs before the first write, which is what makes
     * "no financial writes on rejection" structural rather than a promise.
     *
     * The whole rejection is stored, not just the code. A replay used to
     * rebuild the sentence from `FAILURE_COPY`, which is wrong whenever
     * the refusal carried its own words — "Write at least a sentence
     * explaining the ruling", "That message is longer than 2000
     * characters" — so the second caller received a different answer from
     * the first for the same command. `encodeRejection` keeps them
     * identical.
     */
    await tx.query(
      `UPDATE sandbox.command
          SET status='REJECTED', outcome_code=$2, result=$3, completed_at=now()
        WHERE command_id=$1`,
      [spec.commandId, outcome.code, JSON.stringify(encodeRejection(outcome))],
    );
    return outcome;
  });
}

/* ------------------------------------------------------------------ *
 * Read-side helper
 * ------------------------------------------------------------------ */

/** The recorded outcome of a command, for tests and operator inspection. */
export async function readCommand(commandId: string): Promise<{
  commandType: string;
  status: string;
  outcomeCode: string | null;
  payloadHash: string;
  result: Record<string, unknown>;
} | null> {
  const { rows } = await getPool().query(
    `SELECT command_type, status, outcome_code, payload_hash, result
       FROM sandbox.command WHERE command_id = $1`,
    [commandId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    commandType: r.command_type,
    status: r.status,
    outcomeCode: r.outcome_code ?? null,
    payloadHash: r.payload_hash,
    result: r.result as Record<string, unknown>,
  };
}
