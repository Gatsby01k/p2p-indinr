import 'server-only';
import { AdapterUnavailableError, deploymentMode } from './mode';
import { REFERENCE_RATE } from '@/lib/rate';
import type { Scenario } from '@/lib/scenario';

/**
 * The pricing adapter — the seam DEL-05 attaches a real rate provider to.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A SANDBOX PRICE MAY NEVER BE PRESENTED AS A FIRM QUOTE.           │
 * │                                                                    │
 * │  `@/lib/rate` holds a FIXED rational reference — 8880/100 — that   │
 * │  no market produced. Until this adapter existed, quote issuance    │
 * │  read it directly, which meant a production deployment could       │
 * │  commit a command, a quote, a shareable link, audit rows and       │
 * │  outbox events against a number nobody had priced. The quote would │
 * │  have carried `pricing_source = 'SANDBOX_REFERENCE'` and been      │
 * │  firm, expiring and binding in every other respect.                │
 * │                                                                    │
 * │  So pricing is now a CAPABILITY. The sandbox has one. Production   │
 * │  does not, because DEL-05 has not been implemented — and asking    │
 * │  for one there throws before a single row is written.              │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Exactness is preserved end to end: a snapshot is an integer numerator
 * and denominator, never a float, and it is frozen into the quote exactly
 * as it arrives here.
 */

export interface RateSnapshot {
  /** INR paise per USDT micro, as an exact rational. */
  readonly num: bigint;
  readonly den: bigint;
  /** Provenance, written to `quote.pricing_source`. Never invented. */
  readonly source: string;
}

export interface PricingAdapter {
  readonly kind: 'SANDBOX' | 'PRODUCTION';
  /**
   * The rate to freeze into a quote for this scenario.
   *
   * `INR_TO_INR` has no rate to decay — both legs are rupees — so it
   * receives the unit rational rather than a market number. That keeps
   * the column non-null and arithmetically inert instead of encoding
   * "no rate" as a zero somebody later divides by.
   */
  rateFor(scenario: Scenario): RateSnapshot;
}

class SandboxPricing implements PricingAdapter {
  readonly kind = 'SANDBOX' as const;

  rateFor(scenario: Scenario): RateSnapshot {
    if (scenario === 'INR_TO_INR') {
      return { num: 1n, den: 1n, source: 'SANDBOX_NO_RATE' };
    }
    return {
      num: REFERENCE_RATE.num,
      den: REFERENCE_RATE.den,
      // Named so it is unmistakable in a database dump, a receipt or a
      // support ticket that no market produced this figure.
      source: REFERENCE_RATE.source,
    };
  }
}

/**
 * Resolve the pricing adapter, or refuse.
 *
 * Throws rather than returning a rejection code, for the same reason the
 * value-protection adapter does: a missing price feed is a deployment
 * fault, not a decision about the caller's request. Throwing inside the
 * command boundary rolls the whole transaction back, so a production
 * deployment produces **no command row, no quote, no link, no audit row
 * and no outbox event** — which is the only safe outcome when the system
 * cannot say what something costs.
 */
export function getPricingAdapter(): PricingAdapter {
  if (deploymentMode() === 'PRODUCTION') {
    throw new AdapterUnavailableError(
      'pricing',
      'DEL-05 (INR and USDT Payment Rails)',
      'The only rate available is a fixed sandbox reference that no market produced. ' +
        'Issuing a firm, expiring quote against it would present a simulation as a price.',
    );
  }
  return new SandboxPricing();
}

/** Whether quotes can be priced at all, without throwing. Drives read paths. */
export function pricingAvailable(): boolean {
  return deploymentMode() !== 'PRODUCTION';
}
