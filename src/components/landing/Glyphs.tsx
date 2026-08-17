import { cn } from '@/lib/cn';

/**
 * Landing-only marks.
 *
 * Deliberately NOT added to `@/components/kit/Icon`. That set is the
 * product's own vocabulary and every entry there is a single stroked path
 * in one house style; these are third-party channel marks and a few pieces
 * of demonstration chrome, and mixing the two would make the product icon
 * set look like a logo grab-bag.
 *
 * The channel marks exist for one reason: a person has to recognise, in
 * under a second, that a deal link goes wherever they already talk. They
 * are drawn in each service's own colour for that reason and nowhere else
 * in the product.
 */

export type ChannelKey = 'telegram' | 'whatsapp' | 'discord' | 'imessage' | 'code';

export interface ChannelMeta {
  readonly key: ChannelKey;
  readonly label: string;
  /** The service's own colour, used only as the disc behind the mark. */
  readonly disc: string;
  readonly ink: string;
}

export const CHANNELS: readonly ChannelMeta[] = [
  { key: 'telegram', label: 'Telegram', disc: '#229ED9', ink: '#ffffff' },
  { key: 'whatsapp', label: 'WhatsApp', disc: '#25D366', ink: '#ffffff' },
  { key: 'discord', label: 'Discord', disc: '#5865F2', ink: '#ffffff' },
  { key: 'imessage', label: 'iMessage', disc: '#34C759', ink: '#ffffff' },
  { key: 'code', label: 'Deal Code', disc: 'var(--color-inset)', ink: 'var(--color-ink-2)' },
];

/** The mark alone, inheriting `currentColor`. */
export function ChannelGlyph({ channel, className }: { channel: ChannelKey; className?: string }) {
  const common = {
    viewBox: '0 0 24 24',
    className: cn('h-[1.25em] w-[1.25em] shrink-0', className),
    'aria-hidden': true as const,
    focusable: 'false' as const,
  };

  switch (channel) {
    case 'telegram':
      return (
        <svg {...common} fill="currentColor">
          <path d="M21.6 4.03 2.9 11.24c-.86.33-.85 1.57.02 1.87l4.6 1.58 1.77 5.4c.22.66 1.05.85 1.53.35l2.45-2.55 4.53 3.33c.6.44 1.46.12 1.62-.61l3.13-14.9c.17-.8-.6-1.47-1.35-1.19zm-4.4 3.4-7.3 6.42a.86.86 0 0 0-.28.5l-.4 2.5-1.2-3.66z" />
        </svg>
      );

    case 'whatsapp':
      return (
        <svg {...common} fill="currentColor">
          <path d="M12.02 3.2a8.72 8.72 0 0 0-7.4 13.32L3.4 20.8l4.4-1.15a8.72 8.72 0 1 0 4.22-16.45zm0 1.7a7.02 7.02 0 0 1 3.4 13.16.85.85 0 0 0-.63.08l-2.7.71.72-2.6a.85.85 0 0 0-.09-.67A7.02 7.02 0 0 1 12.02 4.9zM9.2 8.1c-.2 0-.52.07-.8.37-.27.3-1.04 1-1.04 2.45s1.07 2.85 1.22 3.05c.15.2 2.06 3.28 5.1 4.47 2.53.98 3.05.79 3.6.74.55-.05 1.77-.72 2.02-1.42.25-.7.25-1.3.17-1.42-.07-.13-.27-.2-.57-.35-.3-.15-1.77-.87-2.04-.97-.28-.1-.48-.15-.68.15-.2.3-.77.97-.95 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48a9 9 0 0 1-1.66-2.06c-.17-.3-.02-.46.13-.61.14-.14.3-.35.45-.53.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.68-1.63-.93-2.23-.24-.58-.49-.5-.68-.51z" />
        </svg>
      );

    case 'discord':
      return (
        <svg {...common} fill="currentColor">
          <path d="M19.3 6.2A15.5 15.5 0 0 0 15.5 5l-.24.48c1.2.3 2.24.75 3.2 1.32a11.9 11.9 0 0 0-9.92 0c.96-.57 2-1.02 3.2-1.32L11.5 5a15.5 15.5 0 0 0-3.8 1.2C5.1 10.1 4.4 13.9 4.75 17.6a15.6 15.6 0 0 0 4.74 2.4l.9-1.28c-.53-.2-1.03-.44-1.5-.73l.37-.28a11.1 11.1 0 0 0 9.4 0l.36.28c-.47.29-.97.53-1.5.73l.9 1.28a15.6 15.6 0 0 0 4.74-2.4c.42-4.28-.72-8.03-2.86-11.4zM9.7 15.3c-.92 0-1.68-.85-1.68-1.88 0-1.04.74-1.88 1.68-1.88.95 0 1.7.85 1.68 1.88 0 1.03-.74 1.88-1.68 1.88zm6.2 0c-.92 0-1.68-.85-1.68-1.88 0-1.04.74-1.88 1.68-1.88.95 0 1.7.85 1.68 1.88 0 1.03-.73 1.88-1.68 1.88z" />
        </svg>
      );

    case 'imessage':
      return (
        <svg {...common} fill="currentColor">
          <path d="M12 3.4c-5 0-9.1 3.4-9.1 7.6 0 2.4 1.32 4.53 3.38 5.92-.24 1.5-.98 2.83-2 3.78-.24.22-.1.6.22.6 2.03-.05 3.9-.75 5.3-1.86.71.1 1.45.16 2.2.16 5 0 9.1-3.4 9.1-7.6S17 3.4 12 3.4z" />
        </svg>
      );

    case 'code':
      return (
        <svg
          {...common}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9.6 4.2 7.7 19.8M16.3 4.2l-1.9 15.6M4.4 9h15.2M3.7 15h15.2" />
        </svg>
      );
  }
}

/**
 * The mark on its coloured disc, as the reference shows it.
 *
 * `size` is a Tailwind class rather than a number so the disc can respond
 * to the breakpoint without a second render path.
 */
export function ChannelDisc({
  channel,
  className,
  glyphClassName,
}: {
  channel: ChannelMeta;
  className?: string;
  glyphClassName?: string;
}) {
  return (
    <span
      aria-hidden
      style={{ background: channel.disc, color: channel.ink }}
      className={cn(
        'grid shrink-0 place-items-center rounded-full',
        channel.key === 'code' && 'border border-[var(--color-rule)]',
        className,
      )}
    >
      <ChannelGlyph channel={channel.key} className={glyphClassName} />
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Demonstration chrome
 * ------------------------------------------------------------------ */

/** The phone's status-bar cluster: signal, wi-fi, battery. */
export function StatusCluster({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 44 12"
      className={cn('h-3 w-[44px] shrink-0', className)}
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      {/* Signal bars */}
      <rect x="0" y="7.5" width="2.4" height="3.5" rx="0.6" />
      <rect x="3.8" y="5.5" width="2.4" height="5.5" rx="0.6" />
      <rect x="7.6" y="3.5" width="2.4" height="7.5" rx="0.6" />
      <rect x="11.4" y="1.5" width="2.4" height="9.5" rx="0.6" />
      {/* Wi-fi */}
      <path
        d="M17.4 4.6a7.4 7.4 0 0 1 8.6 0"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M19.2 7a4.6 4.6 0 0 1 5 0"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="21.7" cy="9.6" r="1.2" />
      {/* Battery */}
      <rect x="29" y="2" width="13" height="8" rx="2.2" opacity="0.4" />
      <rect x="30.2" y="3.2" width="9.4" height="5.6" rx="1.4" />
      <path d="M43 5.2v3.6a2 2 0 0 0 0-3.6z" opacity="0.4" />
    </svg>
  );
}

/**
 * The dashed connector between two layers of the demonstration.
 *
 * Drawn as an SVG rather than a border so the arrowhead and the dash
 * rhythm survive a resize, and marked `aria-hidden` because it says
 * nothing a screen reader has not already been told in words.
 */
export function FlowConnector({
  className,
  direction = 'right',
}: {
  className?: string;
  direction?: 'right' | 'down';
}) {
  const down = direction === 'down';
  return (
    <svg
      viewBox={down ? '0 0 24 56' : '0 0 56 24'}
      className={cn('text-[var(--color-brand)]', className)}
      fill="none"
      aria-hidden
      focusable="false"
      preserveAspectRatio="none"
    >
      <path
        d={down ? 'M12 4v40' : 'M4 12h40'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="4 5"
        opacity="0.85"
      />
      <path
        d={down ? 'm7.5 42 4.5 6 4.5-6' : 'm42 7.5 6 4.5-6 4.5'}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
