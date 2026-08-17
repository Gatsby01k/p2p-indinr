/**
 * The chat that starts a deal, and the states a deal moves through.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  CONSTANTS ONLY. NO SERVER IMPORT, NO SESSION, NO MUTATION.        │
 * │                                                                    │
 * │  The chat fragment, the Mini App preview and the protection flow   │
 * │  are pictures. `Rahul` is a name on a message bubble, not an       │
 * │  account; the deal card opens nothing; and the state diagram is a  │
 * │  drawing of the product's real vocabulary rather than a live read  │
 * │  of any deal.                                                      │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * The STATE NAMES are the product's own — a protected value is available,
 * then locked, then released or refunded, and a dispute pauses ordinary
 * release. LANDING-04 says the page must communicate those rules; it must
 * not restate them in the vocabulary of the code that enforces them, so
 * nothing here mentions a table, a migration, a transaction or a lock.
 */

/* ------------------------------------------------------------------ *
 * Section 1 — the chat
 * ------------------------------------------------------------------ */

export const CHAT = {
  /** A first name on a bubble. No photograph, no account, no handle. */
  contact: 'Rahul',
  presence: 'online',
  message: "Need to send ₹25,000. Let's use a protected link.",
  at: '10:21 AM',
  card: {
    title: 'INRP2P Protected Deal',
    terms: '₹25,000 · INR → INR',
    locked: 'Terms locked',
    action: 'Open Deal',
  },
} as const;

export interface TelegramBenefit {
  readonly title: string;
  readonly body: string;
  readonly icon: 'telegram' | 'globe' | 'code';
}

export const TELEGRAM_BENEFITS: readonly TelegramBenefit[] = [
  {
    title: 'No separate app install',
    body: 'Use the Mini App inside Telegram.',
    icon: 'telegram',
  },
  {
    title: 'Web fallback for every link',
    body: 'Open any deal link in your browser.',
    icon: 'globe',
  },
  {
    title: 'Deal Code when previews fail',
    body: 'Share a short code and open the deal on the web.',
    icon: 'code',
  },
];

/* ------------------------------------------------------------------ *
 * Section 2 — where protected value can be
 * ------------------------------------------------------------------ */

export interface ValueState {
  readonly key: 'available' | 'locked' | 'released' | 'refunded';
  readonly label: string;
  readonly tone: 'idle' | 'locked' | 'final' | 'risk';
}

export const VALUE_STATES: Readonly<Record<ValueState['key'], ValueState>> = {
  available: { key: 'available', label: 'Available', tone: 'idle' },
  locked: { key: 'locked', label: 'Locked in escrow', tone: 'locked' },
  released: { key: 'released', label: 'Released', tone: 'final' },
  refunded: { key: 'refunded', label: 'Refunded', tone: 'risk' },
};

export const SAFEGUARDS = [
  { label: 'Immutable deal terms', icon: 'shield-check' },
  { label: 'Proof stays attached', icon: 'paperclip' },
  { label: 'Disputes pause release', icon: 'flag' },
  { label: 'Every action is recorded', icon: 'clock' },
] as const;

export const SETTLEMENT = {
  from: { title: 'INR payment', note: 'UPI / bank transfer', foot: 'Sent by you' },
  to: {
    title: 'Protected USDT settlement',
    note: 'Held securely by DealSafe',
    foot: 'Released on success',
  },
} as const;

/* ------------------------------------------------------------------ *
 * Section 3 — the questions worth answering first
 * ------------------------------------------------------------------ */

export interface FaqItem {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
}

/**
 * Four answers, and every one of them describes behaviour this repository
 * actually implements: the web route exists alongside the Mini App, `join`
 * is an atomic single-winner transition, a dispute case suspends ordinary
 * release, and the fee is frozen into the quote before a deal is created.
 * No guarantee of recovery, no insurance, no regulator is claimed.
 */
export const FAQ: readonly FaqItem[] = [
  {
    id: 'telegram',
    question: 'Do I need Telegram?',
    answer: 'No. Every deal can open on the web. The Mini App is simply the fastest way in.',
  },
  {
    id: 'one-joiner',
    question: 'Can two people join the same deal?',
    answer:
      'No. A deal accepts one eligible counterparty. Once it is taken, the same link cannot be joined again.',
  },
  {
    id: 'dispute',
    question: 'What happens during a dispute?',
    answer:
      'Ordinary release pauses while the deal history and submitted evidence are reviewed. Protected assets remain in their permitted locked state until resolution.',
  },
  {
    id: 'fee',
    question: 'When do I see the fee?',
    answer:
      'Before the deal is created. The final amount and applicable fee are shown with the terms before you confirm.',
  },
];

/* ------------------------------------------------------------------ *
 * Section 5 — the footer's map of the page and the product
 * ------------------------------------------------------------------ */

/**
 * A destination, or an honest absence.
 *
 * `href: null` is not an oversight — it means the repository has no such
 * page, and the footer renders the entry as visibly unavailable rather
 * than linking somewhere that merely sounds close. There is no `/terms`,
 * no `/privacy`, no `/about`, no `/contact`, no `/legal` and no status
 * page in this codebase, and inventing one on a page about trust would be
 * the worst possible place to start.
 */
export interface FooterEntry {
  readonly label: string;
  readonly href: string | null;
}

export interface FooterColumn {
  readonly title: string;
  readonly entries: readonly FooterEntry[];
}

export const FOOTER_COLUMNS: readonly FooterColumn[] = [
  {
    title: 'Product',
    entries: [
      { label: 'How it works', href: '#how-it-works' },
      { label: 'Deal Room', href: '#deal-room' },
      { label: 'Rewards', href: '#rewards' },
      { label: 'Fees', href: '#rewards' },
    ],
  },
  {
    title: 'Safety',
    entries: [
      { label: 'Protection', href: '#protection' },
      { label: 'Disputes', href: '#faq' },
      { label: 'Privacy', href: null },
      { label: 'Security', href: null },
    ],
  },
  {
    title: 'Company',
    entries: [
      { label: 'About', href: null },
      { label: 'Contact', href: null },
      { label: 'Legal', href: null },
      { label: 'Status', href: null },
    ],
  },
];

export const FOOTER_BOTTOM: readonly FooterEntry[] = [
  { label: 'Terms', href: null },
  { label: 'Privacy', href: null },
  /* `/app/help` is the real help surface, behind the existing sign-in. */
  { label: 'Support', href: '/login?next=%2Fapp%2Fhelp' },
];

export const FOOTER_BRAND = {
  name: 'INRP2P',
  suffix: 'DealSafe India',
  line: 'Protected deal infrastructure for India.',
  copyright: '© 2026 INRP2P',
} as const;
