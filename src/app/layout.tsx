import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import './globals.css';
import { RouteFocus } from '@/components/kit/RouteFocus';
import { TelegramProvider } from '@/components/telegram/TelegramProvider';
import { TelegramBackButton } from '@/components/telegram/TelegramButtons';
import { currentUser } from '@/services';

export const metadata: Metadata = {
  title: {
    default: 'INRP2P · DealSafe India — protected payments and INR ⇄ USDT',
    template: '%s · INRP2P',
  },
  description:
    'Protected deals for Indian freelancers, buyers and traders. Fix the amount, share one link, and the money is released only when the person receiving it confirms it arrived.',
  applicationName: 'INRP2P',
  manifest: '/manifest.webmanifest',
  formatDetection: { telephone: false, email: false, address: false },
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/icon.svg' }],
  },
  openGraph: {
    type: 'website',
    siteName: 'INRP2P DealSafe India',
    title: 'INRP2P · DealSafe India',
    description: 'One link. One counterparty. Released only when both sides agree.',
  },
};

/**
 * `themeColor` is ONE colour, because the page is now one palette.
 *
 * ⚠ It used to be a pair keyed on `prefers-color-scheme`, which was right
 * while the page followed the scheme too. With `data-theme="light"` pinned
 * on <html> it would be actively wrong: a phone in dark mode would paint
 * the Android chrome and the iOS status bar `#100e0c` above an ivory page
 * — the seam the pairing existed to prevent, now caused by it.
 *
 * `viewportFit: cover` is what lets the tab bar sit under the home
 * indicator while `pb-safe` keeps its contents clear of it.
 */
export const viewport: Viewport = {
  themeColor: '#f7f5f2',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  /*
   * Read once, here, so the Mini App runtime knows whether it still has to
   * exchange its launch data for a session. Doing it in the provider would
   * mean a round trip on every load just to discover the answer is "already
   * signed in", and doing it per page would mean each page remembering to.
   */
  const signedIn = (await currentUser()) !== null;

  return (
    /*
     * ┌──────────────────────────────────────────────────────────────┐
     * │  `data-theme="light"` — THE BRAND IS PINNED, NOT THEMED.      │
     * │                                                              │
     * │  `TelegramProvider` already did exactly this, and gives the   │
     * │  reason: a person whose client was in dark mode got a         │
     * │  near-black INRP2P, "which is not a variant of this product,  │
     * │  it is a different-looking product". DealSafe is designed on  │
     * │  warm paper — the saffron action colour, the tinted status    │
     * │  pills and the amount typography were all judged against it.  │
     * │                                                              │
     * │  That argument never only applied inside Telegram. A phone    │
     * │  browser in dark mode reached the same near-black page, the   │
     * │  public landing included, and the Mini App mock-up drawn in   │
     * │  the hero — a picture of a white Telegram screen — went dark  │
     * │  along with it. The media query in `globals.css` is written   │
     * │  as `:root:not([data-theme='light'])` precisely so this       │
     * │  attribute can settle it; nothing had ever set it.            │
     * │                                                              │
     * │  The ~120 lines of `--dk-*` tokens stay where they are. They  │
     * │  cost nothing while dormant, and removing the attribute is    │
     * │  the whole of the way back.                                   │
     * └──────────────────────────────────────────────────────────────┘
     *
     * `suppressHydrationWarning` on <html>, and ONLY here.
     *
     * Telegram's SDK loads `beforeInteractive` and writes
     * `--tg-viewport-height` and `--tg-viewport-stable-height` onto the
     * root element BEFORE React hydrates. React then sees a `style`
     * attribute the server never rendered, reports a mismatch, and
     * discards the server HTML for the subtree — which is a visible
     * flash on first paint.
     *
     * This is the case React documents the attribute for: a third party
     * mutating an element outside React's control. It is scoped to the
     * root element, so a genuine mismatch anywhere inside the app is
     * still reported.
     */
    <html lang="en-IN" data-theme="light" suppressHydrationWarning>
      <head>
        {/*
          Telegram's SDK, loaded before hydration so `window.Telegram` is
          already there when the provider's first effect runs. Without
          `beforeInteractive` the app spends its first frames believing it
          is an ordinary web page and paints the signed-out landing screen.

          It is the one external script in the product, and it is required:
          Telegram does not publish it on npm, and a self-hosted copy would
          go stale against clients that ship new API versions.
        */}
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
      </head>
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-[var(--radius-sm)] focus:bg-[var(--color-ink)] focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-[var(--color-paper)]"
        >
          Skip to content
        </a>
        <TelegramProvider signedIn={signedIn}>
          {children}
          <TelegramBackButton />
        </TelegramProvider>
        <RouteFocus />
      </body>
    </html>
  );
}
