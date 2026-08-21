import type { Metadata } from 'next';
import Link from 'next/link';
import { Mark } from '@/components/kit/Brand';
import { SignInExperience } from '@/components/auth/SignInExperience';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sign in · INRP2P',
  description: 'Passwordless sign-in. One email, one one-time code, no password stored.',
  robots: { index: false, follow: false },
};

/**
 * Sign in — a continuation of an intention, not a portal door.
 *
 * INTENT: only the destination travels across authentication, and only as a
 * same-origin relative path. No rate, quote id or expiry is preserved,
 * because an indicative rate is not binding and restating one after sign-in
 * would present a stale price as if it still held.
 *
 * ⚠ No password is asked for, accepted or stored — and nothing is signed in
 * without proof either. A one-time code goes to the address and must come
 * back before a session exists (DEL-03). The code proves control of that
 * mailbox and the copy says exactly that, rather than implying an identity
 * check nobody performed.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHY THE SANDBOX DISCLOSURE IS NOT ON THIS SCREEN.                 │
 * │                                                                    │
 * │  It was here, and it has been removed from the PRESENTATION of the │
 * │  authentication route at AUTH-UI-01's instruction — the same       │
 * │  decision LANDING-04 made for the public page. Nothing behind it   │
 * │  moved: `INRP2P_SANDBOX` still selects the stand-in payment rails, │
 * │  `deploymentMode()` still refuses to serve production without a    │
 * │  mail provider, and the chip is still rendered by `TopBar` on      │
 * │  every screen inside `/app` — which is where a person is about to  │
 * │  act on money rather than prove a mailbox.                         │
 * └────────────────────────────────────────────────────────────────────┘
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; invite?: string }>;
}) {
  const { next, invite } = await searchParams;
  /*
   * THE ONLY PLACE A `next` PARAMETER IS HONOURED (T12).
   *
   * A relative path on this origin, or nothing. `//evil.example` starts
   * with a slash and is a full URL to a browser, so it is refused by
   * name rather than by the general test.
   */
  const dest = next && next.startsWith('/') && !next.startsWith('//') ? next : '/app';
  const code = /^[a-z0-9]{6,16}$/.test(invite ?? '') ? invite! : '';

  return (
    <div data-auth className="auth-page">
      {/* ---- Header ------------------------------------------------ */}
      <header className="auth-header">
        <div className="auth-header-inner">
          <Link href="/" className="auth-brand" aria-label="INRP2P — DealSafe India, home">
            <Mark className="auth-brand-mark" />
            <span className="auth-brand-text">
              <span className="auth-brand-name">INRP2P</span>
              <span className="auth-brand-suffix">DealSafe India</span>
            </span>
          </Link>
          <Link href="/" className="auth-back">
            Back to INRP2P
          </Link>
        </div>
      </header>

      {/* ---- The flow ---------------------------------------------- */}
      <main id="main" className="auth-main">
        <SignInExperience next={dest} invite={code} />
      </main>

      {/* ---- Footer ------------------------------------------------ */}
      <footer className="auth-footer">
        <div className="auth-footer-inner">
          <p className="auth-footer-mark tnum">© 2026 INRP2P</p>
          <ul className="auth-footer-links">
            {FOOTER.map((entry) => (
              <li key={entry.label}>
                <FooterEntry entry={entry} />
              </li>
            ))}
          </ul>
        </div>
      </footer>
    </div>
  );
}

/**
 * The small print, and an honest map of what exists.
 *
 * There is no `/terms` and no `/privacy` page in this repository. The
 * tempting move is a `href="#"` or a link to something adjacent, and both
 * are small lies in the footer of a product whose entire subject is
 * trust — so an entry with no destination renders as text: dimmer,
 * `aria-disabled`, and saying "not published yet" in its accessible name.
 * Support has a real destination — `/app/help`, behind this very sign-in.
 * When the pages are written, one `href` here turns each back into a link.
 */
const FOOTER: readonly { label: string; href: string | null }[] = [
  { label: 'Terms', href: null },
  { label: 'Privacy', href: null },
  { label: 'Support', href: '/login?next=%2Fapp%2Fhelp' },
];

function FooterEntry({ entry }: { entry: { label: string; href: string | null } }) {
  if (entry.href === null) {
    return (
      <span aria-disabled className="auth-footer-link auth-footer-link-off">
        {entry.label}
        <span className="sr-only"> — not published yet</span>
      </span>
    );
  }
  return (
    <Link href={entry.href} className="auth-footer-link">
      {entry.label}
    </Link>
  );
}
