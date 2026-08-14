import 'server-only';
import { getPool } from '@/server/db/pool';
import { accept, reject, type Outcome } from '@/server/boundary/outcome';
import { FAILURE_COPY } from '@/lib/sandboxContract';
import { denialFor, type Principal } from '@/server/identity/rbac';
import { lockForDeal } from '@/server/ledger/valueProtection';
import { intentsForDeal } from '@/server/rails/intents';
import { messagesForDeal, type DealMessage } from './chat';
import { evidenceForDeal, type EvidenceRecord } from './evidence';
import type { CaseCategory, CaseState, Disposition } from './disputes';

/**
 * The Deal Room — one authoritative server-side projection.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THE CLIENT IS TOLD WHAT IT MAY DO. IT NEVER DECIDES.              │
 * │                                                                    │
 * │  `allowedActions` is computed HERE from the deal's real state, the │
 * │  real value lock, the real payment intents and the caller's LIVE   │
 * │  authorization. The browser renders that list; it does not         │
 * │  contribute to it. A client that posts `action=RELEASE` is not     │
 * │  taking a shortcut, it is calling a command that will re-derive    │
 * │  every one of these facts and refuse.                              │
 * │                                                                    │
 * │  The room is therefore a VIEW, in the strict sense: it decides     │
 * │  nothing and it changes nothing. Every mutation goes through the   │
 * │  DEL-02 command boundary, which never trusts this projection.      │
 * └────────────────────────────────────────────────────────────────────┘
 */

export type RoomAction =
  | 'POST_MESSAGE'
  | 'UPLOAD_EVIDENCE'
  | 'LOCK_VALUE'
  | 'OPEN_PAYMENT_INTENT'
  | 'VIEW_PAYMENT_INSTRUCTION'
  | 'SUBMIT_PAYMENT_EVIDENCE'
  | 'CONFIRM_RECEIPT'
  | 'CANCEL_DEAL'
  | 'OPEN_DISPUTE';

export interface RoomCase {
  readonly caseId: string;
  readonly state: CaseState;
  readonly category: CaseCategory;
  readonly statement: string;
  readonly openedBy: string;
  readonly openedAt: string;
  readonly disposition: Disposition | null;
  readonly resolutionNote: string | null;
  readonly version: number;
}

export interface DealRoom {
  readonly dealId: string;
  readonly publicId: string;
  readonly viewerRole: 'FIAT_SIDE' | 'CRYPTO_SIDE' | 'OPERATOR';
  readonly counterpartyId: string | null;
  readonly state: string;
  readonly direction: string;
  readonly inrMinor: string;
  readonly usdtMinor: string | null;
  readonly actionDeadline: string | null;
  readonly quote: { readonly rateNum: string; readonly rateDen: string; readonly source: string };

  readonly valueLock: {
    readonly present: boolean;
    readonly state: string | null;
    readonly amountMinor: string | null;
    readonly asset: string | null;
  };

  readonly payments: readonly {
    readonly intentId: string;
    readonly rail: string;
    readonly network: string;
    readonly direction: string;
    readonly state: string;
    readonly amountMinor: string;
    readonly settled: boolean;
  }[];

  readonly dispute: RoomCase | null;
  readonly frozen: boolean;
  readonly allowedActions: readonly RoomAction[];
  readonly messages: readonly DealMessage[];
  readonly messageCursor: string | null;
  readonly evidence: readonly EvidenceRecord[];
}

/* ------------------------------------------------------------------ *
 * Access
 * ------------------------------------------------------------------ */

type Access =
  | { readonly kind: 'PARTICIPANT'; readonly role: 'FIAT_SIDE' | 'CRYPTO_SIDE' }
  | { readonly kind: 'OPERATOR' };

/**
 * Who is asking, and on what authority?
 *
 * Participation is read from `participant`, live. Operator access needs
 * `case.read` AND a satisfied second factor, checked here rather than
 * inherited from whatever rendered the page — so a revoked grant or an
 * unproved factor closes the room on the very next request.
 */
async function accessFor(principal: Principal, dealId: string): Promise<Outcome<Access>> {
  const { rows } = await getPool().query(
    `SELECT role FROM sandbox.participant WHERE deal_id = $1 AND user_id = $2`,
    [dealId, principal.userId],
  );
  if (rows[0]) {
    return accept({ kind: 'PARTICIPANT', role: rows[0].role as 'FIAT_SIDE' | 'CRYPTO_SIDE' });
  }

  const denial = denialFor(principal, 'case.read');
  if (denial === null) return accept({ kind: 'OPERATOR' });
  if (denial === 'MFA_REQUIRED') return reject('MFA_REQUIRED', FAILURE_COPY.MFA_REQUIRED.reason);
  if (denial === 'MFA_NOT_ENROLLED') {
    return reject('MFA_NOT_ENROLLED', FAILURE_COPY.MFA_NOT_ENROLLED.reason);
  }
  // The same answer a non-existent deal gives, so ids cannot be probed.
  return reject('NOT_A_PARTICIPANT', FAILURE_COPY.NOT_A_PARTICIPANT.reason);
}

/* ------------------------------------------------------------------ *
 * Allowed actions
 * ------------------------------------------------------------------ */

/**
 * What this person may do right now.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THIS LIST IS A HINT FOR THE UI, NOT A PERMISSION.                 │
 * │                                                                    │
 * │  Every command re-checks everything this function considers. If    │
 * │  the two ever disagree, the COMMAND is right and the room is       │
 * │  showing a stale button — which is a cosmetic bug. The reverse     │
 * │  arrangement, where the room grants and the command trusts, is how │
 * │  a hidden button becomes an authorization model.                   │
 * └────────────────────────────────────────────────────────────────────┘
 */
function deriveActions(input: {
  access: Access;
  dealState: string;
  frozen: boolean;
  lockLive: boolean;
  hasInstructedPayment: boolean;
}): readonly RoomAction[] {
  const actions: RoomAction[] = [];
  const terminal = input.dealState === 'COMPLETED' || input.dealState === 'CANCELLED';

  // An operator observes. Every mutation an operator may make runs
  // through the case boundary, which has its own permissions.
  if (input.access.kind === 'OPERATOR') return actions;

  // Chat stays open on a frozen deal — that is where the parties put
  // their side of the story — but closes once the deal is finished.
  if (!terminal) {
    actions.push('POST_MESSAGE', 'UPLOAD_EVIDENCE');
  }

  if (input.frozen) {
    // A frozen deal admits nothing that would settle it. The dispute is
    // the only path forward, and a reviewer decides.
    return actions;
  }

  if (terminal) return actions;

  actions.push('OPEN_DISPUTE', 'CANCEL_DEAL');

  if (!input.lockLive) {
    actions.push('LOCK_VALUE');
    return actions;
  }

  actions.push('OPEN_PAYMENT_INTENT');
  if (input.hasInstructedPayment) {
    actions.push('VIEW_PAYMENT_INSTRUCTION', 'SUBMIT_PAYMENT_EVIDENCE');
  }
  if (input.access.role === 'CRYPTO_SIDE' && input.dealState === 'FIAT_CLAIMED') {
    actions.push('CONFIRM_RECEIPT');
  }

  return actions;
}

/* ------------------------------------------------------------------ *
 * The projection
 * ------------------------------------------------------------------ */

export async function dealRoom(
  principal: Principal,
  dealId: string,
  options: { readonly messageCursor?: string | null; readonly messageLimit?: number } = {},
): Promise<Outcome<DealRoom>> {
  const access = await accessFor(principal, dealId);
  if (!access.ok) return access;

  const { rows } = await getPool().query(
    `SELECT d.deal_id, d.public_id, d.state, d.direction, d.inr_minor::text AS inr_minor,
            d.usdt_minor::text AS usdt_minor, d.action_deadline,
            d.rate_num::text AS rate_num, d.rate_den::text AS rate_den, d.pricing_source
       FROM sandbox.deal d WHERE d.deal_id = $1`,
    [dealId],
  );
  const d = rows[0];
  if (d === undefined) return reject('NOT_FOUND', FAILURE_COPY.NOT_FOUND.reason);

  const [lock, intents, messages, evidence, caseRows] = await Promise.all([
    lockForDeal(dealId),
    intentsForDeal(dealId),
    messagesForDeal(dealId, {
      after: options.messageCursor ?? null,
      limit: options.messageLimit,
    }),
    evidenceForDeal(principal, dealId),
    /*
     * Read through `case_timeline`, which carries no operator note and no
     * proposal rationale. A participant sees that a case exists, what
     * they or their counterparty said, and the outcome — not what an
     * investigator was thinking while deciding it.
     */
    getPool().query(
      `SELECT case_id, state, category, statement, opened_by, opened_at,
              disposition, resolution_note, version
         FROM sandbox.case_timeline
        WHERE deal_id = $1
        ORDER BY opened_at DESC LIMIT 1`,
      [dealId],
    ),
  ]);

  const kase = caseRows.rows[0];
  const dispute: RoomCase | null =
    kase === undefined
      ? null
      : {
          caseId: kase.case_id as string,
          state: kase.state as CaseState,
          category: kase.category as CaseCategory,
          statement: kase.statement as string,
          openedBy: kase.opened_by as string,
          openedAt: (kase.opened_at as Date).toISOString(),
          disposition: (kase.disposition as Disposition | null) ?? null,
          resolutionNote: (kase.resolution_note as string | null) ?? null,
          version: kase.version as number,
        };

  const frozen = dispute !== null && (dispute.state === 'OPEN' || dispute.state === 'UNDER_REVIEW');
  const lockLive = lock !== null && lock.state === 'LOCKED';

  const { rows: counterparty } = await getPool().query(
    `SELECT user_id FROM sandbox.participant WHERE deal_id = $1 AND user_id <> $2`,
    [dealId, principal.userId],
  );

  return accept({
    dealId,
    publicId: d.public_id as string,
    viewerRole: access.value.kind === 'OPERATOR' ? 'OPERATOR' : access.value.role,
    counterpartyId:
      access.value.kind === 'OPERATOR' ? null : ((counterparty[0]?.user_id as string) ?? null),
    state: d.state as string,
    direction: d.direction as string,
    inrMinor: d.inr_minor as string,
    usdtMinor: (d.usdt_minor as string | null) ?? null,
    actionDeadline: d.action_deadline === null ? null : (d.action_deadline as Date).toISOString(),
    quote: {
      rateNum: d.rate_num as string,
      rateDen: d.rate_den as string,
      source: d.pricing_source as string,
    },
    valueLock: {
      present: lock !== null,
      state: lock?.state ?? null,
      amountMinor: lock?.amountMinor ?? null,
      asset: lock?.asset ?? null,
    },
    /*
     * Payment rows carry state and amount, and NO destination, address,
     * reference or provider payload. Seeing that a payment is instructed
     * is not the same as being handed the account to pay into: that is
     * DEL-05's separately authorised, live-lock-gated disclosure.
     */
    payments: intents.map((i) => ({
      intentId: i.intentId,
      rail: i.rail,
      network: i.network,
      direction: i.direction,
      state: i.state,
      amountMinor: i.amountMinor,
      settled: i.state === 'CONFIRMED' || i.state === 'REVERSED',
    })),
    dispute,
    frozen,
    allowedActions: deriveActions({
      access: access.value,
      dealState: d.state as string,
      frozen,
      lockLive,
      hasInstructedPayment: intents.some((i) => i.state === 'INSTRUCTED' || i.state === 'OBSERVED'),
    }),
    messages: messages.messages,
    messageCursor: messages.nextCursor,
    evidence: evidence.ok ? evidence.value : [],
  });
}
