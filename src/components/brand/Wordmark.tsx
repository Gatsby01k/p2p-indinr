export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className}>
      <svg
        width="26"
        height="26"
        viewBox="0 0 64 64"
        aria-hidden="true"
        className="inline-block align-middle"
      >
        <rect width="64" height="64" rx="14" fill="var(--color-ink)" />
        <circle
          cx="32"
          cy="32"
          r="20"
          fill="none"
          stroke="var(--color-brand)"
          strokeWidth="2.5"
          strokeDasharray="29 13"
          strokeLinecap="round"
        />
        <circle
          cx="32"
          cy="32"
          r="12"
          fill="none"
          stroke="var(--color-surface)"
          strokeWidth="1.5"
          strokeDasharray="15 10"
          strokeLinecap="round"
          opacity="0.75"
        />
      </svg>
      <span className="ml-2 align-middle text-[17px] font-semibold tracking-tight text-[var(--color-ink)]">
        INRP2P
      </span>
    </span>
  );
}
