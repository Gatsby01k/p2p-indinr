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
 * `themeColor` follows the scheme, so the browser chrome on Android and the
 * iOS status bar match the page rather than framing it in the wrong ground.
 * `viewportFit: cover` is what lets the tab bar sit under the home indicator
 * while `pb-safe` keeps its contents clear of it.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f5f2' },
    { media: '(prefers-color-scheme: dark)', color: '#100e0c' },
  ],
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
    <html lang="en-IN">
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
