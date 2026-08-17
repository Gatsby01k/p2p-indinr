/**
 * The figures behind the LANDING-02 demonstration.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  ISOLATED, TYPED, AND INERT.                                       │
 * │                                                                    │
 * │  Nothing here reads or writes a deal, a quote, a ledger row or a   │
 * │  session, and nothing here is imported by the product. It is a     │
 * │  table of constants plus one call to the real fee rule, so the     │
 * │  marketing page cannot create or mutate anything and the numbers   │
 * │  it shows cannot silently diverge from a second implementation.    │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ⚠ THE ILLUSTRATIVE RATE IS NOT `REFERENCE_RATE`.
 *
 * The approved design states ₹83.60 / USDT on the buy leg and ₹83.20 on
 * the sell leg — a spread, which is what a real desk quotes. The sandbox
 * reference price in `src/lib/rate.ts` is a single mid at ₹88.80 and has
 * no spread to show. Both are stated here as constants rather than one
 * being derived from the other, because they answer different questions:
 * this one illustrates the shape of a quote, that one prices the sandbox.
 * Change `BUY_RATE` / `SELL_RATE` here and every figure below follows.
 */

import { feesFor } from '@/lib/fees';
import { formatMinor } from '@/lib/format';
import type { CapabilityKey } from './demo';

/* ---- The illustration, stated once --------------------------------- */

const USDT_QTY = '1,000';
const BUY_RATE = '83.60';
const SELL_RATE = '83.20';

/** ₹83,600.00 in paise — the INR leg of the buy, and of the payment. */
const BUY_INR_MINOR = 8_360_000n;
const SELL_INR_MINOR = 8_320_000n;

/** `8360000` → `83,600`. Whole rupees: a quote with `.00` reads as noise. */
function rupees(minor: bigint): string {
  return `₹${formatMinor(minor.toString(), 'INR').replace(/\.00$/, '')}`;
}

/**
 * The protection fee on the INR → INR leg, from the product's own rule.
 *
 * 1.50% of ₹83,600 is ₹1,254, inside the ₹25–₹2,000 band, so this is what
 * `/app/new` would actually quote for the same amount.
 */
const PROTECTION_FEE = rupees(feesFor('INR_TO_INR', BUY_INR_MINOR).totalMinor);

/* ---- The three modes ------------------------------------------------ */

export interface EngineLeg {
  readonly amount: string;
  readonly unit: 'INR' | 'USDT';
}

export interface EngineMode {
  readonly key: CapabilityKey;
  /** The tab's own name. */
  readonly label: string;
  /** The line under it — a direction, or what the mode is for. */
  readonly summary: string;
  readonly payLabel: string;
  readonly pay: EngineLeg;
  /**
   * `You receive` on an exchange, `They receive` on a payment: on an
   * INR → INR deal the money lands with the OTHER side, and saying "you"
   * there would describe the wrong person's account.
   */
  readonly receiveLabel: string;
  readonly receive: EngineLeg;
  /** What is frozen at creation: a rate, or a fee. */
  readonly lockLabel: string;
  readonly lockValue: string;
  /** Read to a screen reader in place of the visual figures. */
  readonly spoken: string;
}

export const ENGINE_MODES: Readonly<Record<CapabilityKey, EngineMode>> = {
  SEND_INR: {
    key: 'SEND_INR',
    label: 'Send INR',
    summary: 'Freelance payment',
    payLabel: 'You pay',
    pay: { amount: rupees(BUY_INR_MINOR), unit: 'INR' },
    receiveLabel: 'They receive',
    receive: { amount: rupees(BUY_INR_MINOR), unit: 'INR' },
    lockLabel: 'Fee locked',
    lockValue: `${PROTECTION_FEE} protection`,
    spoken: `Send rupees: you pay ${rupees(BUY_INR_MINOR)}, they receive ${rupees(
      BUY_INR_MINOR,
    )}, with a ${PROTECTION_FEE} protection fee fixed at creation.`,
  },
  BUY_USDT: {
    key: 'BUY_USDT',
    label: 'Buy USDT',
    summary: `${rupees(BUY_INR_MINOR)} → ${USDT_QTY} USDT`,
    payLabel: 'You pay',
    pay: { amount: rupees(BUY_INR_MINOR), unit: 'INR' },
    receiveLabel: 'You receive',
    receive: { amount: `${USDT_QTY} USDT`, unit: 'USDT' },
    lockLabel: 'Rate locked',
    lockValue: `₹${BUY_RATE} / USDT`,
    spoken: `Buy USDT: you pay ${rupees(BUY_INR_MINOR)} and receive ${USDT_QTY} USDT at ₹${BUY_RATE} per USDT, fixed at creation.`,
  },
  SELL_USDT: {
    key: 'SELL_USDT',
    label: 'Sell USDT',
    summary: `${USDT_QTY} USDT → ${rupees(SELL_INR_MINOR)}`,
    payLabel: 'You send',
    pay: { amount: `${USDT_QTY} USDT`, unit: 'USDT' },
    receiveLabel: 'You receive',
    receive: { amount: rupees(SELL_INR_MINOR), unit: 'INR' },
    lockLabel: 'Rate locked',
    lockValue: `₹${SELL_RATE} / USDT`,
    spoken: `Sell USDT: you send ${USDT_QTY} USDT and receive ${rupees(
      SELL_INR_MINOR,
    )} at ₹${SELL_RATE} per USDT, fixed at creation.`,
  },
};

/* ---- The deal room transcript --------------------------------------- */

export interface RoomEvent {
  readonly id: string;
  readonly kind: 'message' | 'evidence' | 'system';
  readonly who: string;
  readonly at: string;
  readonly side: 'you' | 'them' | 'system';
  readonly body?: string;
  /** Present on `evidence` only. */
  readonly file?: { readonly name: string; readonly size: string; readonly note: string };
  /** Present on an outgoing message: the delivered-and-read pair of ticks. */
  readonly receipt?: boolean;
}

export const ROOM_EVENTS: readonly RoomEvent[] = [
  {
    id: 'sent',
    kind: 'message',
    who: 'You',
    at: '10:32 AM',
    side: 'you',
    body: `I have sent ${rupees(BUY_INR_MINOR)} by UPI.`,
    receipt: true,
  },
  {
    id: 'proof',
    kind: 'evidence',
    who: 'You',
    at: '10:32 AM',
    side: 'you',
    file: { name: 'payment-proof.jpg', size: '245 KB', note: 'Verified upload' },
  },
  {
    id: 'marked',
    kind: 'system',
    who: 'System',
    at: '10:33 AM',
    side: 'system',
    body: 'Payment marked as sent',
  },
  {
    id: 'ack',
    kind: 'message',
    who: 'Counterparty',
    at: '10:35 AM',
    side: 'them',
    body: 'Thanks, I will confirm.',
  },
];

export interface RoomState {
  readonly label: string;
  readonly at: string;
  readonly state: 'done' | 'now' | 'todo';
}

export const ROOM_TIMELINE: readonly RoomState[] = [
  { label: 'Created', at: '10:28 AM', state: 'done' },
  { label: 'Shared', at: '10:29 AM', state: 'done' },
  { label: 'Joined', at: '10:30 AM', state: 'done' },
  { label: 'Paid', at: '10:32 AM', state: 'now' },
  { label: 'Released', at: '—', state: 'todo' },
];

/** The room's own header line, kept beside the figures it quotes. */
export const ROOM_HEAD = {
  title: `Buy ${USDT_QTY} USDT`,
  status: 'Payment pending',
  expiresIn: '29:46',
  asset: `${USDT_QTY} USDT`,
  assetNote: 'locked in escrow',
} as const;
