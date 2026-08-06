import { formatMinor } from './format';
import { SCENARIO, type Role, type Scenario } from './scenario';
import type { DealState, DealView, LinkPreview, Terms } from './sandboxContract';

/**
 * The presenter — one place that turns server truth into screen language.
 *
 * Every screen that mentions a deal asks the same four questions:
 *
 *   What is being exchanged?        · legs
 *   Where is it now?                · steps, statusLabel, tone
 *   Whose move is it?               · whoseMove
 *   What does the viewer do next?   · callToAction
 *
 * Answering them in one module is what makes the deal card, the deal room,
 * the receipt and the operator case agree with each other. A screen that
 * derived its own answer would eventually disagree, and a person watching a
 * ₹50,000 transfer must never see two screens contradict.
 *
 * NOTHING HERE DECIDES ANYTHING. Permission comes from `deal.permitted`,
 * computed on the server. This module only chooses words.
 */

export type Tone = 'final' | 'risk' | 'hold' | 'idle' | 'action' | 'info';

/* ------------------------------------------------------------------ *
 * Amounts, from the viewer's seat
 * ------------------------------------------------------------------ */

export interface Leg {
  /** Formatted for display, without the symbol. */
  readonly value: string;
  readonly asset: 'INR' | 'USDT';
  /** `₹1,25,000.00` or `1,142.85 USDT`, ready to print. */
  readonly display: string;
  readonly srLabel: string;
}

export function leg(minor: string | null, asset: 'INR' | 'USDT'): Leg {
  const value = formatMinor(minor ?? '0', asset);
  return {
    value,
    asset,
    display: asset === 'INR' ? `₹${value}` : `${value} USDT`,
    srLabel: asset === 'INR' ? `${value} rupees` : `${value} USDT`,
  };
}

/**
 * What leaves and what arrives, FROM THE VIEWER'S SEAT.
 *
 * The two seats experience opposite journeys, and labelling them identically
 * would tell one of them the reverse of what they are actually doing. The
 * fiat side always sends INR; the crypto side always receives it.
 */
export function legsFor(terms: Terms, role: Role): { send: Leg; receive: Leg } {
  const inr = leg(terms.inrMinor, 'INR');
  const usdt = leg(terms.usdtMinor, 'USDT');

  if (terms.direction === 'INR_TO_INR') {
    // Both legs are rupees, so "send" and "receive" differ only by fee
    // incidence — which `settlementLegs` below expresses exactly.
    return role === 'FIAT_SIDE' ? { send: inr, receive: inr } : { send: inr, receive: inr };
  }
  return role === 'FIAT_SIDE' ? { send: inr, receive: usdt } : { send: usdt, receive: inr };
}

/**
 * The figures a person actually transacts, fees included.
 *
 * `payerSends` is what leaves the payer's bank. `payeeReceives` is what
 * lands. Which of the two the viewer is looking at depends on their seat,
 * and getting this wrong is the single most damaging error the UI could
 * make, so it is computed once here from the deal's own frozen fee fields.
 */
export function settlementLegs(terms: Terms): {
  amount: Leg;
  fees: bigint;
  payerSends: Leg;
  payeeReceives: Leg;
  /** The exact paise figure, for anywhere that needs the number not the label. */
  payerSendsMinor: string;
  payeeReceivesMinor: string;
} {
  const amount = BigInt(terms.inrMinor);
  const fees = BigInt(terms.protectionFeeMinor) + BigInt(terms.networkFeeMinor);
  const payerSendsMinor = terms.feeBearer === 'PAYER' ? amount + fees : amount;
  const netMinor = amount - fees;
  const payeeReceivesMinor = terms.feeBearer === 'PAYER' ? amount : netMinor > 0n ? netMinor : 0n;
  return {
    amount: leg(terms.inrMinor, 'INR'),
    fees,
    payerSends: leg(payerSendsMinor.toString(), 'INR'),
    payeeReceives: leg(payeeReceivesMinor.toString(), 'INR'),
    payerSendsMinor: payerSendsMinor.toString(),
    payeeReceivesMinor: payeeReceivesMinor.toString(),
  };
}

/** `88.80 INR / USDT`, from the exact rational the server froze. */
export function rateLabel(terms: Pick<Terms, 'rateNum' | 'rateDen'>): string {
  const num = Number(terms.rateNum);
  const den = Number(terms.rateDen);
  if (!den) return '—';
  return `${(num / den).toFixed(2)} INR / USDT`;
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

export interface StateMeta {
  readonly label: string;
  readonly tone: Tone;
  /** One sentence stating the situation to both sides identically. */
  readonly headline: string;
  /** Which of the five flow steps is current. 1-based. */
  readonly step: number;
  readonly halted: boolean;
}

export const DEAL_STATE: Readonly<Record<DealState, StateMeta>> = {
  FIAT_PENDING: {
    label: 'Awaiting payment',
    tone: 'action',
    headline: 'The deal is protected. The INR transfer is outstanding.',
    step: 3,
    halted: false,
  },
  FIAT_CLAIMED: {
    label: 'Awaiting confirmation',
    tone: 'hold',
    headline: 'A payment has been marked. The receiver is checking their account.',
    step: 4,
    halted: false,
  },
  DISPUTED: {
    label: 'Release paused',
    tone: 'risk',
    headline: 'A problem was reported. Release is paused until an operator rules.',
    step: 4,
    halted: true,
  },
  COMPLETED: {
    label: 'Completed',
    tone: 'final',
    headline: 'Settled. Both sides are done.',
    step: 5,
    halted: false,
  },
  CANCELLED: {
    label: 'Cancelled',
    tone: 'idle',
    headline: 'This deal ended before any payment was made.',
    step: 3,
    halted: true,
  },
  EXPIRED: {
    label: 'Expired',
    tone: 'idle',
    headline: 'The payment window passed with no transfer. Nothing was released.',
    step: 3,
    halted: true,
  },
  REFUNDED: {
    label: 'Refunded',
    tone: 'idle',
    headline: 'An operator returned the protected value to its origin.',
    step: 5,
    halted: true,
  },
};

/* ------------------------------------------------------------------ *
 * The five-step flow
 * ------------------------------------------------------------------ */

export type StepState = 'done' | 'now' | 'todo' | 'stopped';

export interface FlowStep {
  readonly key: string;
  readonly label: string;
  readonly state: StepState;
  readonly detail?: string;
}

/**
 * The flow, named for the scenario.
 *
 * An exchange says "INR sent" and "Release"; a protected payment says "Pay"
 * and "Release". The five positions are identical either way, so the
 * stepper's geometry — and a person's understanding of it — carries across.
 */
export function flowFor(deal: {
  state: DealState;
  direction: Scenario;
  claim: unknown;
}): readonly FlowStep[] {
  const meta = DEAL_STATE[deal.state];
  const exchange = deal.direction !== 'INR_TO_INR';

  const labels = [
    'Secured',
    'Joined',
    exchange ? 'INR sent' : 'Pay',
    exchange ? 'Verify' : 'Confirm',
    'Release',
  ];

  const details = [
    'Value protected by INRP2P.',
    'Both sides are in the room.',
    exchange ? 'The rupee leg is transferred.' : 'The payer sends the rupees.',
    'The receiver checks the money landed.',
    'Funds released and the deal closes.',
  ];

  return labels.map((label, i) => {
    const position = i + 1;
    let state: StepState;
    if (position < meta.step) state = 'done';
    else if (position === meta.step) state = meta.halted ? 'stopped' : 'now';
    else state = 'todo';
    // A completed deal has no current step: everything is behind it.
    if (deal.state === 'COMPLETED') state = 'done';
    return { key: label, label, state, detail: details[i] };
  });
}

/* ------------------------------------------------------------------ *
 * Whose move, and what it is
 * ------------------------------------------------------------------ */

export interface Move {
  readonly who: 'you' | 'them' | 'operator' | 'nobody';
  readonly title: string;
  readonly detail: string;
}

export function whoseMove(deal: DealView): Move {
  const meta = DEAL_STATE[deal.state];
  const isFiat = deal.viewerRole === 'FIAT_SIDE';
  const them = deal.counterpartyName;

  if (deal.state === 'DISPUTED') {
    return {
      who: 'operator',
      title: 'An operator is reviewing this',
      detail:
        'Release is paused. Add anything that supports your side — messages and files are part of the case.',
    };
  }
  if (deal.state === 'COMPLETED') {
    return { who: 'nobody', title: 'Settled', detail: meta.headline };
  }
  if (deal.state === 'CANCELLED' || deal.state === 'EXPIRED' || deal.state === 'REFUNDED') {
    return { who: 'nobody', title: meta.label, detail: meta.headline };
  }

  if (deal.permitted.canClaim) {
    return {
      who: 'you',
      title: 'Your turn to pay',
      detail: `Send the rupees to ${them}, then mark it with the bank reference.`,
    };
  }
  if (deal.permitted.canConfirm) {
    return {
      who: 'you',
      title: 'Your turn to confirm',
      detail: 'Check your account for the exact amount, then release.',
    };
  }
  return {
    who: 'them',
    title: `Waiting on ${them}`,
    detail: isFiat
      ? 'They are checking their account for your payment.'
      : 'They still have to send the rupees and mark them paid.',
  };
}

/** The label on the one button a viewer is allowed to press, if any. */
export function callToAction(deal: DealView): { label: string; href: string } | null {
  if (deal.permitted.canClaim) {
    const legs = settlementLegs(deal);
    return { label: `Pay ${legs.payerSends.display}`, href: `/app/deal/${deal.dealId}/pay` };
  }
  if (deal.permitted.canConfirm) {
    return { label: 'Confirm and release', href: `/app/deal/${deal.dealId}` };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Titles
 * ------------------------------------------------------------------ */

/** What this deal is called on a card, a list row, or a browser tab. */
export function dealTitle(deal: Pick<DealView, 'title' | 'direction'>): string {
  return deal.title?.trim() || SCENARIO[deal.direction].title;
}

/** `Buy USDT` / `Protected payment` — never viewer-dependent. */
export function scenarioTitle(direction: Scenario): string {
  return SCENARIO[direction].title;
}

/** What the viewer's seat is called in this scenario. */
export function roleLabel(direction: Scenario, role: Role): string {
  return SCENARIO[direction].roleLabel[role];
}

/* ------------------------------------------------------------------ *
 * Link previews
 * ------------------------------------------------------------------ */

export const PREVIEW_META: Readonly<
  Record<LinkPreview['displayStatus'], { label: string; tone: Tone; term: string }>
> = {
  OPEN: { label: 'Open · Protected', tone: 'action', term: 'Expires' },
  CONSUMED: { label: 'Already taken', tone: 'idle', term: 'Deadline was' },
  EXPIRED: { label: 'Expired', tone: 'hold', term: 'Expired' },
  CLOSED: { label: 'Withdrawn', tone: 'idle', term: 'Deadline was' },
};

/**
 * The headline for a shared link.
 *
 * Carries the ECONOMIC TERMS ONLY — no name, no reference, nothing that
 * identifies either party. This string ends up in an unfurl, which is
 * public, forwardable and cached by intermediaries the sender does not
 * control.
 */
export function previewHeadline(preview: LinkPreview): string {
  const inr = leg(preview.inrMinor, 'INR');
  if (preview.direction === 'INR_TO_INR') return `${inr.display} protected payment`;
  const usdt = leg(preview.usdtMinor, 'USDT');
  return preview.direction === 'USDT_TO_INR'
    ? `${usdt.display} → ${inr.display}`
    : `${inr.display} → ${usdt.display}`;
}
