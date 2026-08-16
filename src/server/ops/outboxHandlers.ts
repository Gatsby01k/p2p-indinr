import 'server-only';
import { noopHandler, type OutboxHandler } from './outboxWorker';

/**
 * The outbox handler registry.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  EVERY EVENT TYPE THE PRODUCT EMITS APPEARS HERE, EXPLICITLY.      │
 * │                                                                    │
 * │  A type that is absent is not "handled by doing nothing" — it is   │
 * │  quarantined as UNSUPPORTED, dead-lettered and audited. That is    │
 * │  the DEL-10 correction: DEL-09 marked an unhandled event           │
 * │  DELIVERED, so a dropped registration would have made a            │
 * │  `payment.confirmed` vanish while the record said it succeeded.    │
 * │                                                                    │
 * │  `noopHandler` is therefore load-bearing. Registering it says      │
 * │  somebody looked at this event and decided nothing needs to        │
 * │  happen yet. Silence says nobody looked.                           │
 * │                                                                    │
 * │  NOTHING HERE CONTACTS THE OUTSIDE WORLD. No notification,         │
 * │  email or push provider has credentials in this repository, so     │
 * │  every entry below is a deliberate no-op awaiting DEL-11's         │
 * │  delivery adapters — and a no-op that is RECORDED as such, not     │
 * │  one that pretends a message was sent.                             │
 * └────────────────────────────────────────────────────────────────────┘
 */

/**
 * Types that MUST be classified, checked by a manifest test.
 *
 * Grouped by the boundary that emits them so a new event is added
 * beside its siblings rather than appended to a flat list nobody reads.
 */
export const DECLARED_EVENT_TYPES = [
  /* ---- DEL-02: links, quotes and deals ---- */
  'quote.issued',
  'quote.expired',
  'link.created',
  'link.closed',
  'deal.joined',
  'deal.payment_claimed',
  'deal.completed',
  'deal.cancelled',
  'deal.expired',
  'deal.disputed',
  'deal.ruled',
  'deal.message_posted',

  /* ---- DEL-04: value protection ---- */
  'ledger.funded',
  'value.locked',
  'value.released',
  'value.refunded',
  'value.reversed',

  /* ---- DEL-05: payment rails ---- */
  'payment.intent_opened',
  'payment.instruction_issued',
  'payment.evidence_submitted',
  'payment.observed',
  'payment.confirmed',
  'payment.reversed',

  /* ---- DEL-06: deal room, evidence and disputes ---- */
  'dispute.opened',
  'dispute.proposed',
  'dispute.resolved',
  'evidence.ready',
  'evidence.rejected',

  /* ---- DEL-07: commercial ---- */
  'fee.policy_activated',
  'reward.granted',

  /* ---- DEL-08: risk and controls ---- */
  'ops.case_resolved',
  'control.paused',
  'control.resumed',
] as const;

export type DeclaredEventType = (typeof DECLARED_EVENT_TYPES)[number];

/**
 * Event types whose only correct action, today, is none.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THIS LIST IS A STATEMENT, NOT A BACKLOG.                          │
 * │                                                                    │
 * │  Each of these would, in a deployment with providers, notify       │
 * │  somebody. None of them can here, because no notification          │
 * │  provider is configured — and a handler that pretended to send an  │
 * │  email would make an undelivered notification look delivered,      │
 * │  which is the same class of lie the UNSUPPORTED state exists to    │
 * │  prevent.                                                          │
 * │                                                                    │
 * │  So they are recorded as genuinely delivered no-ops. The event     │
 * │  happened, the platform considered it, and nothing was sent.       │
 * └────────────────────────────────────────────────────────────────────┘
 */
const INTENTIONAL_NOOPS: readonly DeclaredEventType[] = [
  'quote.issued',
  'quote.expired',
  'link.created',
  'link.closed',
  'deal.joined',
  'deal.payment_claimed',
  'deal.completed',
  'deal.cancelled',
  'deal.expired',
  'deal.disputed',
  'deal.ruled',
  'deal.message_posted',
  'ledger.funded',
  'value.locked',
  'value.released',
  'value.refunded',
  'value.reversed',
  'payment.intent_opened',
  'payment.instruction_issued',
  'payment.evidence_submitted',
  'payment.observed',
  'payment.confirmed',
  'payment.reversed',
  'dispute.opened',
  'dispute.proposed',
  'dispute.resolved',
  'evidence.ready',
  'evidence.rejected',
  'fee.policy_activated',
  'reward.granted',
  'ops.case_resolved',
  'control.paused',
  'control.resumed',
];

/**
 * The registry the worker runs against.
 *
 * Built from the classification above rather than written twice, so the
 * manifest test and the runtime cannot disagree — a registry that drifts
 * from its own manifest is exactly the gap this stage is closing.
 */
export function outboxHandlers(
  overrides: Readonly<Record<string, OutboxHandler>> = {},
): Readonly<Record<string, OutboxHandler>> {
  const registry: Record<string, OutboxHandler> = {};
  for (const type of INTENTIONAL_NOOPS) registry[type] = noopHandler;
  return { ...registry, ...overrides };
}

/**
 * Which declared types are NOT classified?
 *
 * The manifest test asserts this is empty. A new event type added to a
 * command without a decision here fails CI rather than reaching
 * production and being quarantined by a worker at 03:00.
 */
export function unclassifiedTypes(): readonly string[] {
  const classified = new Set<string>(INTENTIONAL_NOOPS);
  return DECLARED_EVENT_TYPES.filter((t) => !classified.has(t));
}
