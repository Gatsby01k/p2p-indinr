import { cn } from '@/lib/cn';

/**
 * INRP2P brand mark — "the junction".
 *
 * Two rails meet at a single square node. It means: two parties, one
 * settlement point. It is not a wheel, not a coin, not a globe, and it
 * carries no motion of its own — the product's movement lives in the rail
 * components, where it describes real state.
 *
 * Pure SVG at 1em so it inherits type size and colour. No bitmap, no font.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('h-[1.15em] w-[1.15em]', className)}
      aria-hidden
      focusable="false"
    >
      {/* Incoming rail from the left, outgoing to the right. */}
      <path
        d="M1 8h7.5M15.5 16H23"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="square"
        fill="none"
      />
      {/* The junction: the two rails bridged through one node. */}
      <path
        d="M8.5 8h2.2a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h0.8"
        stroke="currentColor"
        strokeWidth="1.75"
        fill="none"
        strokeLinecap="square"
      />
      {/* Terminals — squares on their corner, matching the rail motif. */}
      <rect
        x="0"
        y="6.6"
        width="2.8"
        height="2.8"
        transform="rotate(45 1.4 8)"
        fill="currentColor"
      />
      <rect
        x="21.2"
        y="14.6"
        width="2.8"
        height="2.8"
        transform="rotate(45 22.6 16)"
        fill="currentColor"
      />
    </svg>
  );
}

export function Wordmark({ className, suffix }: { className?: string; suffix?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 text-[length:var(--text-base)] font-semibold tracking-[-0.03em] text-[var(--color-ink)]',
        className,
      )}
    >
      <Mark className="text-[var(--color-action)]" />
      <span>
        INRP2P
        {suffix ? (
          <span className="ml-1.5 font-normal tracking-normal text-[var(--color-ink-4)]">
            {suffix}
          </span>
        ) : null}
      </span>
    </span>
  );
}

/**
 * The seal drawn once on a completed transaction. The single sanctioned
 * celebratory moment in the product, and it is a checkmark inside the
 * junction — finality expressed in the brand's own grammar.
 */
export function Seal({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={cn('animate-seal h-10 w-10', className)} aria-hidden>
      <circle
        cx="20"
        cy="20"
        r="19"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        opacity="0.28"
      />
      <path
        d="M12.5 20.5l5 5 10-11"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="square"
      />
    </svg>
  );
}
