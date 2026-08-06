import { cn } from '@/lib/cn';

/**
 * INRP2P brand mark — "the protected node".
 *
 * A rupee held at the centre of a three-point network, ringed by an open
 * circle of protection. It says the two things the product is: peer to peer
 * (three nodes, no hub) and protected (the ring is closed enough to shelter,
 * open enough to be a network rather than a vault).
 *
 * Pure SVG, sized in `em` so it inherits type size and colour. No bitmap, no
 * webfont, nothing to load.
 */
export function Mark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      className={cn('h-[1.5em] w-[1.5em] shrink-0', className)}
      fill="none"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
      focusable="false"
    >
      {/* The protective ring, broken at each node so the network reads as
          open. Three arcs, drawn with butt caps so the gaps stay crisp. */}
      <g stroke="currentColor" strokeWidth="3.1" strokeLinecap="butt">
        <path d="M27.18 4.59A17 17 0 0 1 36.94 21.48" />
        <path d="M29.75 33.93a17 17 0 0 1-19.5 0" />
        <path d="M3.06 21.48A17 17 0 0 1 12.82 4.59" />
      </g>

      {/* Spokes from the centre to each node: value passing between peers. */}
      <g stroke="currentColor" strokeWidth="2.9" strokeLinecap="round">
        <path d="M20 12.4V7" />
        <path d="m14.6 23.4-4.7 2.7" />
        <path d="m25.4 23.4 4.7 2.7" />
      </g>

      {/* The three peers. */}
      <g fill="currentColor">
        <circle cx="20" cy="5.5" r="3.6" />
        <circle cx="7.44" cy="27.25" r="3.6" />
        <circle cx="32.56" cy="27.25" r="3.6" />
      </g>

      {/* The value at the centre. */}
      <circle cx="20" cy="20" r="8.2" fill="currentColor" />
      <g
        stroke="var(--mark-counter, #fff)"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        <path d="M16.6 16.1h6.8" />
        <path d="M16.6 18.8h6.8" />
        <path d="M16.6 21.5h3.6a2.7 2.7 0 0 0 0-5.4" />
        <path d="m18.4 21.5 4.4 3.9" />
      </g>
    </svg>
  );
}

/**
 * The wordmark.
 *
 * `INRP2P` in the ink colour with `DealSafe India` beneath it — the product
 * name is the promise, and it belongs with the brand rather than buried in a
 * page heading.
 */
export function Wordmark({
  className,
  suffix = 'DealSafe India',
  tone = 'ink',
  compact = false,
}: {
  className?: string;
  suffix?: string | null;
  tone?: 'ink' | 'nav';
  compact?: boolean;
}) {
  const ink = tone === 'nav' ? 'text-[var(--color-nav-ink)]' : 'text-[var(--color-ink)]';
  const sub = tone === 'nav' ? 'text-[var(--color-nav-ink-3)]' : 'text-[var(--color-ink-4)]';
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <Mark className={cn('text-[var(--color-brand)]', compact ? 'h-6 w-6' : 'h-7 w-7')} />
      <span className="flex min-w-0 flex-col leading-none">
        <span
          className={cn(
            'font-semibold tracking-[-0.035em]',
            ink,
            compact ? 'text-[length:var(--text-md)]' : 'text-[length:var(--text-lg)]',
          )}
        >
          INRP2P
        </span>
        {suffix ? (
          <span className={cn('mt-0.5 truncate text-[length:var(--text-2xs)] font-medium', sub)}>
            {suffix}
          </span>
        ) : null}
      </span>
    </span>
  );
}

/**
 * The seal drawn once on a completed deal.
 *
 * The single sanctioned celebratory moment in the product: a checkmark that
 * draws itself inside a ring, then stops. It never loops — a celebration
 * that repeats forever is decoration, and decoration on a receipt undermines
 * the receipt.
 */
export function Seal({ className, size = 64 }: { className?: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={cn('animate-seal', className)}
      fill="none"
      aria-hidden
    >
      <circle cx="32" cy="32" r="30" fill="currentColor" opacity="0.1" />
      <circle cx="32" cy="32" r="23" fill="currentColor" opacity="0.16" />
      <circle cx="32" cy="32" r="16.5" fill="currentColor" />
      <path
        d="m24.5 32.6 5.2 5.2 10-11"
        stroke="var(--mark-counter, #fff)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The completion burst.
 *
 * Six marks thrown outward once, then gone — the moment the reference
 * screens show around a settled deal. Positions are fixed rather than
 * random, so the animation is identical every time and cannot be mistaken
 * for a live indicator.
 */
const SPARKS: readonly { dx: string; dy: string; delay: string; tone: string }[] = [
  { dx: '-54px', dy: '-38px', delay: '80ms', tone: 'var(--color-brand)' },
  { dx: '46px', dy: '-44px', delay: '120ms', tone: 'var(--color-final)' },
  { dx: '-66px', dy: '10px', delay: '160ms', tone: 'var(--color-final)' },
  { dx: '62px', dy: '4px', delay: '100ms', tone: 'var(--color-brand)' },
  { dx: '-30px', dy: '-58px', delay: '200ms', tone: 'var(--color-final)' },
  { dx: '26px', dy: '-60px', delay: '150ms', tone: 'var(--color-brand)' },
];

export function Celebration({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('pointer-events-none absolute inset-0', className)}>
      {SPARKS.map((s, i) => (
        <span
          key={i}
          className="absolute left-1/2 top-1/2 block h-1.5 w-1.5 rounded-[1px]"
          style={
            {
              background: s.tone,
              '--dx': s.dx,
              '--dy': s.dy,
              animation: `spark 900ms var(--ease-out) ${s.delay} both`,
            } as React.CSSProperties
          }
        />
      ))}
    </span>
  );
}
