/**
 * The three scenarios, named once.
 *
 * The product asks one question — what are you doing? — and everything
 * downstream is a consequence of the answer. Copy, roles, the shape of the
 * deal room and which leg carries a rate all derive from this module, so a
 * scenario cannot mean one thing on the create screen and another in the
 * deal room.
 *
 * Free of `server-only` and of any database import: the server decides
 * scenarios, the client renders them, and both need the same vocabulary.
 */

export type Scenario = 'INR_TO_INR' | 'INR_TO_USDT' | 'USDT_TO_INR';

export const SCENARIOS: readonly Scenario[] = ['INR_TO_INR', 'INR_TO_USDT', 'USDT_TO_INR'];

/** The two seats. FIAT_SIDE always SENDS the INR; CRYPTO_SIDE receives it. */
export type Role = 'FIAT_SIDE' | 'CRYPTO_SIDE';

export interface ScenarioMeta {
  readonly id: Scenario;
  /** Short label for tabs and chips. */
  readonly short: string;
  /** Full sentence for the picker. */
  readonly title: string;
  readonly blurb: string;
  /** Symbols for the FROM → TO pair, used by the direction glyph. */
  readonly from: 'INR' | 'USDT';
  readonly to: 'INR' | 'USDT';
  /** True when the deal has a rate at all. INR→INR does not. */
  readonly hasRate: boolean;
  /** What each seat is called, from the outside. */
  readonly roleLabel: Readonly<Record<Role, string>>;
  /** What each seat actually does, in the imperative. */
  readonly roleAction: Readonly<Record<Role, string>>;
}

export const SCENARIO: Readonly<Record<Scenario, ScenarioMeta>> = {
  INR_TO_INR: {
    id: 'INR_TO_INR',
    short: 'INR → INR',
    title: 'Protected payment',
    blurb: 'For freelance work, services and goods.',
    from: 'INR',
    to: 'INR',
    hasRate: false,
    roleLabel: { FIAT_SIDE: 'Payer', CRYPTO_SIDE: 'Payee' },
    roleAction: { FIAT_SIDE: 'Pay the INR', CRYPTO_SIDE: 'Receive the INR' },
  },
  INR_TO_USDT: {
    id: 'INR_TO_USDT',
    short: 'INR → USDT',
    title: 'Buy USDT',
    blurb: 'You pay rupees. Your counterparty supplies the USDT.',
    from: 'INR',
    to: 'USDT',
    hasRate: true,
    roleLabel: { FIAT_SIDE: 'INR payer', CRYPTO_SIDE: 'USDT provider' },
    roleAction: { FIAT_SIDE: 'Pay the INR', CRYPTO_SIDE: 'Supply the USDT' },
  },
  USDT_TO_INR: {
    id: 'USDT_TO_INR',
    short: 'USDT → INR',
    title: 'Sell USDT',
    blurb: 'You supply the USDT. Your counterparty sends the rupees.',
    from: 'USDT',
    to: 'INR',
    hasRate: true,
    roleLabel: { FIAT_SIDE: 'INR payer', CRYPTO_SIDE: 'USDT provider' },
    roleAction: { FIAT_SIDE: 'Pay the INR', CRYPTO_SIDE: 'Supply the USDT' },
  },
};

/**
 * Which seat the CREATOR takes.
 *
 * The rule is one sentence: whoever supplies the non-INR leg, or is owed
 * the money, sits on CRYPTO_SIDE. So:
 *
 *   USDT_TO_INR  creator supplies USDT   → CRYPTO_SIDE
 *   INR_TO_USDT  creator pays INR        → FIAT_SIDE
 *   INR_TO_INR   depends on intent, so the caller states it.
 */
export function creatorRoleFor(scenario: Scenario, intent: 'PAY' | 'RECEIVE'): Role {
  if (scenario === 'USDT_TO_INR') return 'CRYPTO_SIDE';
  if (scenario === 'INR_TO_USDT') return 'FIAT_SIDE';
  return intent === 'PAY' ? 'FIAT_SIDE' : 'CRYPTO_SIDE';
}

export function otherRole(role: Role): Role {
  return role === 'FIAT_SIDE' ? 'CRYPTO_SIDE' : 'FIAT_SIDE';
}

/** True when this scenario carries a USDT leg at all. */
export function hasCryptoLeg(scenario: Scenario): boolean {
  return scenario !== 'INR_TO_INR';
}

/**
 * The label under which a deal is filed in history and search.
 * Deliberately viewer-independent — a shared reference reads the same to
 * both sides.
 */
export function scenarioShort(scenario: Scenario): string {
  return SCENARIO[scenario].short;
}
