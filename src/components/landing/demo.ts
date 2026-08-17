/**
 * The figures behind the landing demonstration.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THIS IS A DEMONSTRATION, AND IT TOUCHES NOTHING.                  │
 * │                                                                    │
 * │  Nothing in this module reads or writes a deal, a quote, a ledger  │
 * │  entry or a session. It is pure arithmetic over constants, so the  │
 * │  marketing page cannot create, mutate or leak production state.    │
 * │                                                                    │
 * │  It does, however, borrow the PRODUCT'S OWN maths — `usdtFromInr`  │
 * │  at the reference rate, and `settlementFor` for the fee — rather   │
 * │  than hardcoding invented numbers. A landing page that quotes a    │
 * │  USDT figure the product would never produce is a lie told in the  │
 * │  one place a person has no way to check it.                        │
 * └────────────────────────────────────────────────────────────────────┘
 */

import { settlementFor, usdtFromInr } from '@/lib/fees';
import { formatMinor } from '@/lib/format';
import { REFERENCE_RATE } from '@/lib/rate';
import { SCENARIO, type Scenario } from '@/lib/scenario';

/** The three things the unified engine does, named the way the page says them. */
export type CapabilityKey = 'SEND_INR' | 'BUY_USDT' | 'SELL_USDT';

export const CAPABILITY_KEYS: readonly CapabilityKey[] = ['SEND_INR', 'BUY_USDT', 'SELL_USDT'];

/**
 * The INR leg every demonstration mode is drawn around.
 *
 * One figure across all three modes, so switching mode changes the
 * CORRIDOR and nothing else — which is the point the control is making.
 */
const DEMO_INR_MINOR = 2_500_000n; // ₹25,000.00

const DEMO_USDT_MICRO = usdtFromInr(DEMO_INR_MINOR, REFERENCE_RATE.num, REFERENCE_RATE.den);

/*
 * The FIGURE only — no ticker.
 *
 * Each leg is rendered beside a unit chip that already says `INR` or
 * `USDT`, exactly as the composer does, so a ticker in the figure too
 * produced `281.53 USDT` next to a `USDT` selector and then truncated
 * itself to `281.53 US…`. The rupee sign stays: it is a currency SIGN
 * attached to the numeral, not a second statement of the unit.
 */
const INR_LABEL = `₹${formatMinor(DEMO_INR_MINOR.toString(), 'INR', false).replace(/\.00$/, '')}`;
const USDT_LABEL = formatMinor(DEMO_USDT_MICRO.toString(), 'USDT');

export interface CapabilityDemo {
  readonly key: CapabilityKey;
  /** The label on the hero control and on the composer tab. */
  readonly label: string;
  /** The existing product scenario this capability maps onto. */
  readonly scenario: Scenario;
  /** What the creator commits. */
  readonly pay: { readonly amount: string; readonly unit: 'INR' | 'USDT' };
  /** What the counterparty ends up with. */
  readonly receive: { readonly amount: string; readonly unit: 'INR' | 'USDT' };
  /** `₹25,000 · INR → INR`, the line the shared card leads with. */
  readonly cardLine: string;
  /** One sentence for the accessible description of the mode. */
  readonly summary: string;
}

function line(scenario: Scenario): string {
  return `${INR_LABEL} · ${SCENARIO[scenario].short}`;
}

export const CAPABILITIES: Readonly<Record<CapabilityKey, CapabilityDemo>> = {
  SEND_INR: {
    key: 'SEND_INR',
    label: 'Send INR',
    scenario: 'INR_TO_INR',
    /*
     * ₹25,000 on both legs, and that is not a rounding slip.
     *
     * The amount a person enters IS what the other side receives:
     * `settlementFor(..., 'PAYER')` adds the protection fee on top of it
     * rather than taking it out of the receipt. The fee is stated
     * separately, below, exactly as the real composer states it.
     */
    pay: { amount: INR_LABEL, unit: 'INR' },
    receive: { amount: INR_LABEL, unit: 'INR' },
    cardLine: line('INR_TO_INR'),
    summary: 'Send rupees to someone and release them when the work or the goods land.',
  },
  BUY_USDT: {
    key: 'BUY_USDT',
    label: 'Buy USDT',
    scenario: 'INR_TO_USDT',
    pay: { amount: INR_LABEL, unit: 'INR' },
    receive: { amount: USDT_LABEL, unit: 'USDT' },
    cardLine: line('INR_TO_USDT'),
    summary: 'Pay rupees to one verified counterparty and receive USDT.',
  },
  SELL_USDT: {
    key: 'SELL_USDT',
    label: 'Sell USDT',
    scenario: 'USDT_TO_INR',
    pay: { amount: USDT_LABEL, unit: 'USDT' },
    receive: { amount: INR_LABEL, unit: 'INR' },
    cardLine: line('USDT_TO_INR'),
    summary: 'Supply USDT to one verified counterparty and receive rupees.',
  },
};

/** The protection fee on the demonstration amount, in the product's own words. */
export const DEMO_PROTECTION_FEE = `₹${formatMinor(
  settlementFor('INR_TO_INR', DEMO_INR_MINOR, 'PAYER').fees.totalMinor.toString(),
  'INR',
).replace(/\.00$/, '')}`;

/** The public identifier the demonstration deal carries throughout. */
export const DEMO_DEAL_CODE = 'AB12CD';

/**
 * Where the primary call to action goes.
 *
 * ⚠ NO SECOND CREATE-DEAL SYSTEM. This is the existing route, with the
 * existing query contract that `/app/new` already parses, carried across
 * the existing sign-in handoff — the same path the calculator has always
 * used. No amount travels: the figures above are an illustration, and the
 * server issues the only quote that binds.
 */
export function createDealHref(key: CapabilityKey): string {
  const next = `/app/new?scenario=${CAPABILITIES[key].scenario}`;
  return `/login?next=${encodeURIComponent(next)}`;
}
