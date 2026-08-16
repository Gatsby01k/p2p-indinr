'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * A QR code rendered in the BROWSER, for values that must never leave it.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHY THIS EXISTS ALONGSIDE THE SERVER `QrCode`.                    │
 * │                                                                    │
 * │  Almost every code in this product is drawn on the server, which   │
 * │  is better: no encoder in the bundle, present in the first paint.  │
 * │  The authenticator enrolment code cannot be. Its `otpauth://` URI  │
 * │  contains the TOTP SECRET, and the whole discipline around that    │
 * │  secret is that it exists in one component's memory for the few    │
 * │  seconds between enrolling and confirming — never in a URL, never  │
 * │  in storage, never in a log, and never in an RSC payload that      │
 * │  could be cached or traced.                                        │
 * │                                                                    │
 * │  So the encoding happens here, and the encoder is imported lazily  │
 * │  so the many people who never enrol do not download it.            │
 * │                                                                    │
 * │  ⚠ THIS IS THE ONLY CLIENT COMPONENT ALLOWED TO SET RAW HTML, and  │
 * │  `tests/webSecurity.test.ts` enforces that by name. The string it  │
 * │  sets is the encoder's own SVG output, built here from the value:  │
 * │  the value becomes path geometry, never markup. Keeping it in one  │
 * │  place is the point — a second component doing this by hand is     │
 * │  exactly the drift the test is looking for.                        │
 * └────────────────────────────────────────────────────────────────────┘
 */
export function QrCodeClient({
  value,
  size = 184,
  label,
  fallback,
  className,
}: {
  value: string;
  size?: number;
  /** Describes what scanning it does. Required: a bare QR is a dead end. */
  label: string;
  /** Shown when the code cannot be drawn. */
  fallback: React.ReactNode;
  className?: string;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const QRCode = (await import('qrcode')).default;
        const drawn = await QRCode.toString(value, {
          type: 'svg',
          errorCorrectionLevel: 'M',
          margin: 1,
          width: size,
          color: { dark: '#14110f', light: '#00000000' },
        });
        if (live) setSvg(drawn);
      } catch {
        // Recoverable: the caller always shows the value as text too.
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [value, size]);

  if (failed) return <>{fallback}</>;
  if (!svg) {
    // A reserved box, so the card does not jump when the code arrives.
    return (
      <div
        className={cn('rounded-[var(--radius-md)] bg-[var(--color-wash)]', className)}
        style={{ width: size + 24, height: size + 24 }}
        aria-hidden
      />
    );
  }

  return (
    <div
      className={cn('inline-flex rounded-[var(--radius-md)] bg-white p-3', className)}
      style={{ width: size + 24, height: size + 24 }}
      // Encoder output, built in this browser from the URI above — the
      // value becomes path geometry, never markup.
      dangerouslySetInnerHTML={{ __html: svg }}
      role="img"
      aria-label={label}
    />
  );
}
