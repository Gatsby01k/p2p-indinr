import 'server-only';
import { getPool, type Tx } from '@/server/db/pool';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { consumeRate, type RateRule } from '@/server/identity/rateLimit';
import { denialFor, type Principal } from '@/server/identity/rbac';

/**
 * Deal chat: append-only, ordered, and unable to move money.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A CHAT MESSAGE CHANGES NOTHING FINANCIAL. EVER.                   │
 * │                                                                    │
 * │  Nothing in this file touches `deal.state`, the value lock, a      │
 * │  payment intent or the ledger — and it holds no import that could. │
 * │  "I've paid, please release" is a sentence, not an instruction to  │
 * │  the system, and the only way it becomes one is a person deciding  │
 * │  so through a boundary that checks something real.                 │
 * │                                                                    │
 * │  ORDER IS `seq`, NOT `sent_at`. Two messages sent in the same      │
 * │  millisecond used to order arbitrarily, which — in a dispute about │
 * │  who said what first — is precisely the question being asked.      │
 * └────────────────────────────────────────────────────────────────────┘
 */

export const MAX_MESSAGE_LENGTH = 2000;

/**
 * A sustainable conversation, not a firehose.
 *
 * Generous enough that a heated exchange never meets it; tight enough
 * that a script cannot fill another participant's room, or a database,
 * with a million rows nobody can delete — because these rows genuinely
 * cannot be deleted.
 */
export const CHAT_RATE: RateRule = { scope: 'DEAL_CHAT', limit: 60, windowSeconds: 5 * 60 };

export interface DealMessage {
  readonly messageId: string;
  readonly seq: string;
  readonly kind: 'CHAT' | 'SYSTEM';
  readonly authorId: string | null;
  readonly body: string;
  readonly sentAt: string;
  readonly redacted: boolean;
}

/**
 * Normalize what a person typed.
 *
 * Trims, collapses runaway blank lines, and strips control characters
 * that would let a message hide its own content or break a terminal that
 * renders the audit trail. It does NOT strip or escape markup: escaping
 * belongs at the point of rendering, and doing it here would store
 * mangled text that a future non-HTML consumer displays literally.
 */
export function normalizeMessageBody(raw: string): string {
  return (
    raw
      /*
       * Strip C0/C1 control characters (keeping tab and newline) and the
       * Unicode bidi overrides. Those overrides let text RENDER in an
       * order it is not written in — "please refund" that displays as
       * "please release" — which is a forgery a dispute reviewer would
       * have no way to see.
       */
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim()
  );
}

function mapMessage(r: Record<string, unknown>): DealMessage {
  const redacted = r.redacted === true;
  return {
    messageId: r.message_id as string,
    seq: String(r.seq),
    kind: r.kind as 'CHAT' | 'SYSTEM',
    authorId: (r.author_id as string | null) ?? null,
    /*
     * A redacted message keeps its row and loses its text.
     *
     * The record that something was said, by whom and when, survives —
     * that is what a dispute needs. What a moderator removed is removed
     * at the point of reading, so the original is still there for an
     * audit that has the authority to see it.
     */
    body: redacted ? '[removed by a moderator]' : (r.body as string),
    sentAt: (r.sent_at as Date).toISOString(),
    redacted,
  };
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export interface MessagePage {
  readonly messages: readonly DealMessage[];
  /** Pass back as `after` to continue. `null` when the end is reached. */
  readonly nextCursor: string | null;
}

/**
 * One page of a deal's conversation.
 *
 * The cursor is `seq`, which is total and monotonic, so a page boundary
 * cannot drop or repeat a message the way a timestamp cursor does when
 * two rows share a millisecond.
 */
export async function messagesForDeal(
  dealId: string,
  options: { readonly after?: string | null; readonly limit?: number } = {},
): Promise<MessagePage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const after = options.after ?? null;

  const { rows } = await getPool().query(
    `SELECT m.message_id, m.seq, m.kind, m.author_id, m.body, m.sent_at,
            (r.redaction_id IS NOT NULL) AS redacted
       FROM sandbox.deal_message m
       LEFT JOIN sandbox.message_redaction r ON r.message_id = m.message_id
      WHERE m.deal_id = $1 AND ($2::bigint IS NULL OR m.seq > $2::bigint)
      ORDER BY m.seq
      LIMIT $3`,
    [dealId, after, limit + 1],
  );

  const page = rows.slice(0, limit).map(mapMessage);
  const hasMore = rows.length > limit;
  return {
    messages: page,
    nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.seq : null,
  };
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

export async function postMessage(
  tx: Tx,
  input: {
    readonly actorId: string;
    readonly dealId: string;
    readonly body: string;
    readonly commandId: string;
  },
): Promise<Outcome<DealMessage>> {
  const { rows: seat } = await tx.query(
    `SELECT 1 FROM sandbox.participant WHERE deal_id = $1 AND user_id = $2`,
    [input.dealId, input.actorId],
  );
  if (!seat[0]) return reject('NOT_A_PARTICIPANT', FAILURE_COPY.NOT_A_PARTICIPANT.reason);

  const body = normalizeMessageBody(input.body);
  if (body.length === 0) return reject('MESSAGE_EMPTY', FAILURE_COPY.MESSAGE_EMPTY.reason);
  if (body.length > MAX_MESSAGE_LENGTH) {
    return reject('MESSAGE_TOO_LONG', FAILURE_COPY.MESSAGE_TOO_LONG.reason, {
      length: body.length,
      limit: MAX_MESSAGE_LENGTH,
    });
  }

  const verdict = await consumeRate(CHAT_RATE, `${input.actorId}:${input.dealId}`);
  if (!verdict.allowed) {
    return reject('RATE_LIMITED', FAILURE_COPY.RATE_LIMITED.reason, {
      retryAfterSeconds: verdict.retryAfterSeconds,
    });
  }

  /*
   * `ON CONFLICT DO NOTHING` on `command_id` makes a resend idempotent
   * AND makes two simultaneous sends of the same command safe: the
   * second blocks on the first's speculative insert and then reads the
   * committed row. The author is never inserted from the request —
   * `author_id` is the session's user, so a client cannot speak as
   * somebody else — and `sent_at` is the database's clock for the same
   * reason.
   */
  const inserted = await tx.query(
    `INSERT INTO sandbox.deal_message (deal_id, author_id, kind, body, command_id)
     VALUES ($1,$2,'CHAT',$3,$4)
     ON CONFLICT (command_id) WHERE command_id IS NOT NULL DO NOTHING
     RETURNING message_id, seq, kind, author_id, body, sent_at, FALSE AS redacted`,
    [input.dealId, input.actorId, body, input.commandId],
  );

  if (inserted.rowCount === 0) {
    const { rows } = await tx.query(
      `SELECT message_id, seq, kind, author_id, body, sent_at, FALSE AS redacted
         FROM sandbox.deal_message WHERE command_id = $1`,
      [input.commandId],
    );
    return accept(mapMessage(rows[0]!));
  }
  return accept(mapMessage(inserted.rows[0]!));
}

/* ------------------------------------------------------------------ *
 * Moderation
 * ------------------------------------------------------------------ */

/**
 * Hide a message without rewriting history.
 *
 * The original row is untouched — the trigger on `deal_message` would
 * refuse anything else. This adds a row saying who hid it and why, and
 * readers join against it. A chat log that could be edited would prove
 * nothing in the dispute it exists to inform.
 */
export async function redactMessage(
  tx: Tx,
  principal: Principal,
  input: { readonly messageId: string; readonly reason: string },
): Promise<Outcome<{ redactionId: string }>> {
  if (denialFor(principal, 'case.read') !== null) {
    return reject('PERMISSION_DENIED', FAILURE_COPY.PERMISSION_DENIED.reason);
  }
  const reason = input.reason.trim();
  if (reason.length < 10) {
    return reject('STATEMENT_TOO_SHORT', FAILURE_COPY.STATEMENT_TOO_SHORT.reason);
  }

  const { rows } = await tx.query(
    `INSERT INTO sandbox.message_redaction (message_id, redacted_by, reason)
     VALUES ($1,$2,$3)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING redaction_id`,
    [input.messageId, principal.userId, reason],
  );
  if (rows[0] === undefined) {
    const { rows: prior } = await tx.query(
      `SELECT redaction_id FROM sandbox.message_redaction WHERE message_id = $1`,
      [input.messageId],
    );
    if (prior[0] === undefined) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);
    return accept({ redactionId: prior[0].redaction_id as string });
  }
  return accept({ redactionId: rows[0].redaction_id as string });
}
