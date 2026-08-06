import type { Metadata, Viewport } from 'next';
import './globals.css';
import { RouteFocus } from '@/components/kit/RouteFocus';

export const metadata: Metadata = {
  title: {
    default: 'INRP2P — INR ⇄ USDT settlement',
    template: '%s · INRP2P',
  },
  description:
    'Send a link, settle INR ⇄ USDT with a verified desk. Exact amounts, held funds, and a receipt for every deal.',
  applicationName: 'INRP2P',
  manifest: '/manifest.webmanifest',
  formatDetection: { telephone: false, email: false, address: false },
  openGraph: {
    type: 'website',
    siteName: 'INRP2P',
    title: 'INRP2P — INR ⇄ USDT settlement',
    description: 'Exact amounts. Verified desks. A receipt for every deal.',
  },
};

export const viewport: Viewport = {
  themeColor: '#0c0a09',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-[var(--radius-sm)] focus:bg-[var(--color-ink)] focus:px-3 focus:py-2 focus:text-sm focus:text-white"
        >
          Skip to content
        </a>
        {children}
        <RouteFocus />
      </body>
    </html>
  );
}
