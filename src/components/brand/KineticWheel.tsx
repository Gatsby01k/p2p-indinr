/**
 * The three-segment kinetic wheel.
 *
 * Brand mark only. It is deliberately quiet: thin strokes, one slow rotation,
 * muted tints, honours prefers-reduced-motion, and is `aria-hidden` so no
 * assistive technology treats it as content. It sits *behind* the exchange
 * form and never competes with the conversion action.
 *
 * The three segments read as the three parties a settlement needs: the sender,
 * the desk, and the receiver.
 */
export function KineticWheel({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 400 400"
      className={className}
      aria-hidden="true"
      focusable="false"
      role="presentation"
    >
      <defs>
        <linearGradient id="seg-a" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--color-brand)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--color-brand)" stopOpacity="0.12" />
        </linearGradient>
      </defs>

      <g className="wheel-spin">
        {/* Three arcs at 120° spacing, thin and open. */}
        <circle
          cx="200"
          cy="200"
          r="150"
          fill="none"
          stroke="url(#seg-a)"
          strokeWidth="1.5"
          strokeDasharray="220 94"
          strokeLinecap="round"
        />
        <circle
          cx="200"
          cy="200"
          r="118"
          fill="none"
          stroke="var(--color-line-strong)"
          strokeWidth="1"
          strokeDasharray="150 97"
          strokeLinecap="round"
          opacity="0.7"
        />
        <circle
          cx="200"
          cy="200"
          r="86"
          fill="none"
          stroke="var(--color-brand)"
          strokeWidth="1"
          strokeDasharray="90 90"
          strokeLinecap="round"
          opacity="0.28"
        />
      </g>

      {/* Static hairline ring anchors the motion so it reads as engineered, not spinning for effect. */}
      <circle
        cx="200"
        cy="200"
        r="182"
        fill="none"
        stroke="var(--color-line)"
        strokeWidth="1"
        opacity="0.8"
      />
    </svg>
  );
}
