/**
 * The fee rule — stated once, in exact integer paise.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  PROTECTED PAYMENT (INR → INR)                                   │
 * │    Protection fee   1.50% of the amount                          │
 * │                     minimum ₹25.00, maximum ₹2,000.00            │
 * │                                                                  │
 * │  EXCHANGE (INR ⇄ USDT)                                           │
 * │    Service fee      1.25% of the INR leg                         │
 * │                     minimum ₹25.00, maximum ₹2,500.00            │
 * │    Network fee      ₹180.00 flat                                 │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * No floating point participates anywhere. Percentages are applied as
 * exact integer ratios over paise and TRUNCATED, so a fee can only ever be
 * a fraction of a paisa lower than the nominal rate — never higher. A fee
 * that rounded up would charge more than the percentage advertised.
 *
 * These figures are computed on the SERVER at quote issuance and frozen
 * into the quote. The client recomputes them only to preview a number it
 * explicitly labels indicative; no client figure is ever binding.
 */

import type { Scenario } from './scenario';

/* ---- The rule, as constants rather than magic numbers -------------- */

const PROTECTION_BPS = 150n; // 1.50%
const PROTECTION_MIN = 2_500n; // ₹25.00
const PROTECTION_MAX = 200_000n; // ₹2,000.00

const SERVICE_BPS = 125n; // 1.25%
const SERVICE_MIN = 2_500n; // ₹25.00
const SERVICE_MAX = 250_000n; // ₹2,500.00

const NETWORK_FLAT = 18_000n; // ₹180.00

const BPS_DEN = 10_000n;

/** Who absorbs the protection fee. The payer, unless the creator says otherwise. */
export type FeeBearer = 'PAYER' | 'PAYEE';

export interface FeeBreakdown {
  /** Protection (INR→INR) or service (exchange). Always INR paise. */
  readonly protectionMinor: bigint;
  /** Network / liquidity cost on an exchange. Zero for INR→INR. */
  readonly networkMinor: bigint;
  readonly totalMinor: bigint;
  /** Label the UI shows for `protectionMinor` in this scenario. */
  readonly protectionLabel: string;
  /** Human statement of the rate applied, for the breakdown row. */
  readonly protectionBasis: string;
}

function clamp(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Fees for an INR amount under a given scenario.
 *
 * `inrMinor` is the deal's INR leg in paise. The result is exact and is
 * what gets written to the quote — the UI never re-derives it.
 */
export function feesFor(scenario: Scenario, inrMinor: bigint): FeeBreakdown {
  if (inrMinor <= 0n) {
    return {
      protectionMinor: 0n,
      networkMinor: 0n,
      totalMinor: 0n,
      protectionLabel: scenario === 'INR_TO_INR' ? 'Protection fee' : 'Service fee',
      protectionBasis: '',
    };
  }

  if (scenario === 'INR_TO_INR') {
    const protection = clamp(
      (inrMinor * PROTECTION_BPS) / BPS_DEN,
      PROTECTION_MIN,
      PROTECTION_MAX,
    );
    return {
      protectionMinor: protection,
      networkMinor: 0n,
      totalMinor: protection,
      protectionLabel: 'Protection fee',
      protectionBasis: '1.50% of the amount',
    };
  }

  const service = clamp((inrMinor * SERVICE_BPS) / BPS_DEN, SERVICE_MIN, SERVICE_MAX);
  return {
    protectionMinor: service,
    networkMinor: NETWORK_FLAT,
    totalMinor: service + NETWORK_FLAT,
    protectionLabel: 'Service fee',
    protectionBasis: '1.25% of the INR leg',
  };
}

/**
 * What the payer actually transfers, and what the payee actually keeps.
 *
 * This is the one calculation a person checks twice, so it is expressed
 * as a single function rather than assembled ad hoc on each screen.
 *
 *   bearer = PAYER  → the payer sends amount + fees; the payee keeps the
 *                     full amount.
 *   bearer = PAYEE  → the payer sends exactly the amount; the fees come
 *                     out of what the payee receives.
 */
export interface Settlement {
  readonly payerSendsMinor: bigint;
  readonly payeeReceivesMinor: bigint;
  readonly fees: FeeBreakdown;
}

export function settlementFor(
  scenario: Scenario,
  inrMinor: bigint,
  bearer: FeeBearer,
): Settlement {
  const fees = feesFor(scenario, inrMinor);
  if (bearer === 'PAYER') {
    return {
      payerSendsMinor: inrMinor + fees.totalMinor,
      payeeReceivesMinor: inrMinor,
      fees,
    };
  }
  // The payee cannot be left owing money: a fee larger than the amount
  // floors the receipt at zero rather than producing a negative figure.
  const net = inrMinor - fees.totalMinor;
  return {
    payerSendsMinor: inrMinor,
    payeeReceivesMinor: net > 0n ? net : 0n,
    fees,
  };
}

/**
 * The INR leg implied by a USDT amount at an exact rational rate.
 *
 * Truncating division, matching the server: rounding up would credit a
 * customer with rupees that were never priced.
 */
export function inrFromUsdt(usdtMicro: bigint, rateNum: bigint, rateDen: bigint): bigint {
  return (usdtMicro * rateNum) / (rateDen * 10_000n);
}

/** The USDT leg implied by an INR amount. Same truncation discipline. */
export function usdtFromInr(inrMinor: bigint, rateNum: bigint, rateDen: bigint): bigint {
  return (inrMinor * rateDen * 10_000n) / rateNum;
}
