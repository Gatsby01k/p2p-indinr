import type { NextConfig } from 'next';

/**
 * Framing policy.
 *
 * The product runs as a Telegram Mini App, and Telegram Web and Desktop
 * host one in a cross-site IFRAME. `X-Frame-Options: DENY` forbids that
 * outright and has no allowlist beyond a single origin, so it is replaced
 * by a CSP `frame-ancestors` directive naming exactly the two Telegram web
 * origins and nothing else.
 *
 * This is a real relaxation and it is worth being precise about what it
 * costs. Clickjacking a framed page means tricking someone into clicking a
 * control they cannot see. Three things stand against it here:
 *
 *   · only `web.telegram.org` and `webk.telegram.org` may frame us — an
 *     arbitrary attacker page still cannot;
 *   · every mutation is a Next.js server action, which verifies the
 *     request Origin against the Host before running;
 *   · the consequential actions in this product (release, dispute) are
 *     server-authorized against the caller's seat in the deal, so a
 *     mis-aimed click still cannot make someone act as the other party.
 *
 * `X-Frame-Options` is deliberately NOT set alongside: browsers that
 * understand both apply the stricter, and `DENY` would defeat the point.
 * Every browser Telegram ships supports `frame-ancestors`.
 */
const TELEGRAM_FRAME_ANCESTORS = [
  "frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Content-Security-Policy', value: TELEGRAM_FRAME_ANCESTORS },
        ],
      },
    ];
  },
};

export default nextConfig;
