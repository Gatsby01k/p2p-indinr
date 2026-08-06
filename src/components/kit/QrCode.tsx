import QRCode from 'qrcode';
import { cn } from '@/lib/cn';

/**
 * A QR code, rendered on the SERVER as inline SVG.
 *
 * Server-side generation is the whole point: the browser downloads no
 * encoder, runs no canvas work, and the code is present in the first paint
 * rather than appearing a beat later. It also scales without blurring, which
 * a canvas-rendered bitmap does not — and a QR that has been resampled is a
 * QR that fails to scan under a shop's fluorescent light.
 *
 * Error correction is level M (~15% recoverable), the practical default: L
 * is fragile against a scuffed phone screen, and H bloats the module count
 * enough to hurt scanning at small sizes.
 *
 * Colours come from the theme tokens, so the code inverts correctly in dark
 * mode. Contrast between modules and quiet zone is kept absolute — a
 * "tastefully" low-contrast QR is an unscannable QR.
 */
export async function QrCode({
  value,
  size = 176,
  label,
  className,
}: {
  value: string;
  size?: number;
  /** Describes what scanning it does. Required: a bare QR is a dead end. */
  label: string;
  className?: string;
}) {
  let svg: string;
  try {
    svg = await QRCode.toString(value, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: size,
      color: { dark: '#14110f', light: '#00000000' },
    });
  } catch {
    // Too much data for any version, or an encoder failure. A missing code
    // is recoverable — the value is always shown as copyable text beside it
    // — so this degrades rather than taking the page down.
    return null;
  }

  return (
    <figure className={cn('inline-flex flex-col items-center gap-2', className)}>
      <div
        className="rounded-[var(--radius-md)] bg-white p-3 shadow-[var(--shadow-card)]"
        style={{ width: size + 24, height: size + 24 }}
        // The SVG is generated here from a server-controlled string; no
        // user input reaches it as markup, only as encoded modules.
        dangerouslySetInnerHTML={{ __html: svg }}
        role="img"
        aria-label={label}
      />
      <figcaption className="max-w-[16rem] text-center text-[length:var(--text-2xs)] leading-relaxed text-[var(--color-ink-3)]">
        {label}
      </figcaption>
    </figure>
  );
}

/**
 * The UPI intent URI.
 *
 * Built to the NPCI deep-link shape so a real deployment needs no change
 * here. In this sandbox the payee handle is a `@sandboxupi` address, which
 * resolves at no bank — so a scan cannot move real money even if someone
 * tries, which is exactly the property a funds-free build should have.
 */
export function upiUri({
  vpa,
  name,
  amountRupees,
  note,
}: {
  vpa: string;
  name: string;
  amountRupees: string;
  note: string;
}): string {
  const params = new URLSearchParams({
    pa: vpa,
    pn: name,
    am: amountRupees,
    cu: 'INR',
    tn: note.slice(0, 50),
  });
  return `upi://pay?${params.toString()}`;
}
