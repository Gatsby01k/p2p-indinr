import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';

/**
 * INRP2P product primitives.
 *
 * Server components by default — none of these need client JavaScript.
 * Anything interactive that genuinely requires state lives in its own
 * 'use client' file, so the shared kit adds nothing to the bundle.
 */

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

export function Shell({
  children,
  width = 'content',
  className,
}: {
  children: ReactNode;
  width?: 'form' | 'prose' | 'content' | 'wide' | 'ops';
  className?: string;
}) {
  const max = {
    form: 'max-w-[var(--w-form)]',
    prose: 'max-w-[var(--w-prose)]',
    content: 'max-w-[var(--w-content)]',
    wide: 'max-w-[var(--w-wide)]',
    ops: 'max-w-[var(--w-ops)]',
  }[width];
  return <div className={cn('mx-auto w-full px-4 sm:px-6', max, className)}>{children}</div>;
}

/**
 * A structural panel. Bordered and grounded — not a floating card.
 * `seam` splits it into rows divided by hairlines rather than gaps, which
 * is what keeps a screen from looking like a pile of cards.
 */
export function Panel({
  children,
  className,
  seam = false,
  tone = 'paper',
}: {
  children: ReactNode;
  className?: string;
  seam?: boolean;
  tone?: 'paper' | 'sunken' | 'ink';
}) {
  const tones = {
    paper: 'bg-[var(--color-paper)] border-[var(--color-line)]',
    sunken: 'bg-[var(--color-sunken)] border-[var(--color-line)]',
    ink: 'bg-[var(--color-ink)] border-[var(--color-ink)] text-[var(--color-paper)]',
  }[tone];
  return (
    <section
      className={cn(
        'overflow-hidden rounded-[var(--radius-lg)] border',
        tones,
        seam && 'divide-y divide-[var(--color-line)]',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function PanelHead({
  title,
  meta,
  className,
}: {
  title: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3 px-4 py-3 sm:px-5', className)}>
      <h2 className="text-[length:var(--text-sm)] font-semibold text-[var(--color-ink)]">
        {title}
      </h2>
      {meta ? (
        <div className="text-[length:var(--text-xs)] text-[var(--color-ink-3)]">{meta}</div>
      ) : null}
    </div>
  );
}

/** Small uppercase label. The only place tracking is widened. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'text-[length:var(--text-2xs)] font-medium uppercase tracking-[0.07em] text-[var(--color-ink-4)]',
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * The rail
 * ------------------------------------------------------------------ */

/**
 * Hairline rail. `cap` selects which terminals this segment owns, so a
 * split rail reads as one origin and one destination rather than as a
 * repeated pattern. `live` colours the destination in the action tone.
 */
export function Rail({
  live = false,
  cap = 'both',
  className,
}: {
  live?: boolean;
  cap?: 'both' | 'start' | 'end' | 'none';
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        'rail',
        live && 'rail-live',
        cap === 'start' && 'rail-cap-start',
        cap === 'end' && 'rail-cap-end',
        cap === 'none' && 'rail-cap-none',
        className,
      )}
    />
  );
}

/**
 * Directional exchange rail: FROM ── rate ──▶ TO.
 *
 * This is the product's core sentence rendered as geometry. It appears on
 * the calculator, the deal link and the deal room, so the same idea is
 * recognisable everywhere.
 */
export function ExchangeRail({ caption, live = false }: { caption: string; live?: boolean }) {
  return (
    <div className="flex items-center gap-3" role="presentation">
      <Rail cap="start" className="flex-1" />
      <span className="tnum shrink-0 text-[length:var(--text-xs)] font-medium text-[var(--color-ink-3)]">
        {caption}
      </span>
      <Rail live={live} cap="end" className="flex-1" />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

export type Tone = 'final' | 'risk' | 'hold' | 'idle' | 'action';

const TONE_CLASS: Record<Tone, string> = {
  final: 'bg-[var(--color-final-tint)] text-[var(--color-final)] border-[var(--color-final-line)]',
  risk: 'bg-[var(--color-risk-tint)] text-[var(--color-risk)] border-[var(--color-risk-line)]',
  hold: 'bg-[var(--color-hold-tint)] text-[var(--color-hold)] border-[var(--color-hold-line)]',
  idle: 'bg-[var(--color-idle-tint)] text-[var(--color-idle)] border-[var(--color-idle-line)]',
  action:
    'bg-[var(--color-action-tint)] text-[var(--color-action-press)] border-[var(--color-action-line)]',
};

/**
 * Status badge carrying a GLYPH as well as a colour, so status is never
 * conveyed by colour alone (WCAG 1.4.1). One badge, one value — composing
 * two badges from separate booleans is how contradictory states happen.
 */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  const glyph = { final: '✓', risk: '!', hold: '•', idle: '–', action: '›' }[tone];
  return (
    <span
      data-testid="status"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--radius-full)] border px-2.5 py-1',
        'text-[length:var(--text-xs)] font-medium whitespace-nowrap',
        TONE_CLASS[tone],
      )}
    >
      <span aria-hidden className="font-semibold">
        {glyph}
      </span>
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Money
 * ------------------------------------------------------------------ */

/**
 * A monetary figure.
 *
 * The unit is a separate, smaller, lighter span so the NUMBER dominates
 * and two figures of different assets stay comparable down the page.
 * `USDT` is always a trailing ticker — never a `$` prefix.
 */
export function Money({
  value,
  unit,
  size = 'md',
  className,
  srLabel,
}: {
  value: string;
  unit: string;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'display';
  className?: string;
  srLabel?: string;
}) {
  const sizes = {
    sm: 'text-[length:var(--text-lg)]',
    md: 'text-[length:var(--text-xl)]',
    lg: 'text-[length:var(--text-3xl)]',
    xl: 'text-[length:var(--text-4xl)]',
    display: 'text-[length:var(--text-4xl)] sm:text-[length:var(--text-5xl)]',
  }[size];
  const unitSizes = {
    sm: 'text-[length:var(--text-xs)]',
    md: 'text-[length:var(--text-sm)]',
    lg: 'text-[length:var(--text-base)]',
    xl: 'text-[length:var(--text-lg)]',
    display: 'text-[length:var(--text-lg)] sm:text-[length:var(--text-xl)]',
  }[size];

  return (
    <span className={cn('inline-flex items-baseline gap-1.5', className)}>
      <span
        className={cn('tnum font-semibold tracking-[-0.02em] text-[var(--color-ink)]', sizes)}
        aria-hidden={srLabel ? true : undefined}
      >
        {value}
      </span>
      <span
        className={cn('font-medium text-[var(--color-ink-3)]', unitSizes)}
        aria-hidden={srLabel ? true : undefined}
      >
        {unit}
      </span>
      {srLabel ? <span className="sr-only">{srLabel}</span> : null}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

const BTN_BASE =
  'press tap inline-flex items-center justify-center gap-2 rounded-[var(--radius-md)] ' +
  'text-[length:var(--text-base)] font-medium select-none ' +
  'disabled:pointer-events-none disabled:opacity-45';

const BTN_VARIANT = {
  /** The single dominant action on a screen. */
  primary:
    'bg-[var(--color-action)] text-white hover:bg-[var(--color-action-hover)] active:bg-[var(--color-action-press)]',
  /** Confirmation of arrival — the only place green is a button. */
  final: 'bg-[var(--color-final)] text-white hover:brightness-110',
  /** Structural, non-conversion actions. */
  solid: 'bg-[var(--color-ink)] text-[var(--color-paper)] hover:bg-[var(--color-ink-2)]',
  outline:
    'border border-[var(--color-rule)] bg-[var(--color-paper)] text-[var(--color-ink)] hover:border-[var(--color-edge)] hover:bg-[var(--color-sunken)]',
  quiet: 'text-[var(--color-ink-2)] hover:bg-[var(--color-sunken)]',
} as const;

const BTN_SIZE = {
  sm: 'h-9 px-3 text-[length:var(--text-sm)]',
  md: 'h-11 px-4',
  lg: 'h-12 px-5 text-[length:var(--text-lg)]',
} as const;

export type ButtonVariant = keyof typeof BTN_VARIANT;

export function buttonClass(
  variant: ButtonVariant = 'primary',
  size: keyof typeof BTN_SIZE = 'md',
  full = false,
) {
  return cn(BTN_BASE, BTN_VARIANT[variant], BTN_SIZE[size], full && 'w-full');
}

export function ActionLink({
  href,
  children,
  variant = 'primary',
  size = 'md',
  full,
  className,
  prefetch = false,
}: {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: keyof typeof BTN_SIZE;
  full?: boolean;
  className?: string;
  prefetch?: boolean;
}) {
  /*
   * Prefetch is OFF by default. Most destinations in this product are
   * `force-dynamic` and per-user, so a prefetch cannot be cached or reused:
   * it buys nothing and costs a full server render, a database round trip
   * and one of the browser's six connections per origin.
   */
  return (
    <Link
      href={href}
      prefetch={prefetch}
      className={cn(buttonClass(variant, size, full), className)}
    >
      {children}
    </Link>
  );
}

/* ------------------------------------------------------------------ *
 * Key–value rows
 * ------------------------------------------------------------------ */

export function Facts({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn('divide-y divide-[var(--color-line)]', className)}>{children}</dl>;
}

export function Fact({
  term,
  children,
  mono = false,
}: {
  term: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-baseline gap-3 px-4 py-2.5 sm:grid-cols-[9rem_1fr] sm:px-5">
      <dt className="text-[length:var(--text-xs)] text-[var(--color-ink-3)]">{term}</dt>
      <dd
        className={cn(
          'text-[length:var(--text-sm)] text-[var(--color-ink)]',
          mono && 'tnum font-mono text-[length:var(--text-xs)]',
        )}
      >
        {children}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Notices
 * ------------------------------------------------------------------ */

/**
 * A blocked, expired or failed state.
 *
 * Always three things: what happened, whether anything changed, and the
 * one safe thing to do next. "Something went wrong" is never acceptable
 * when a precise explanation exists.
 */
export function Notice({
  tone = 'idle',
  title,
  body,
  reassurance,
  nextStep,
  action,
  className,
}: {
  tone?: Tone;
  title: string;
  body?: string;
  reassurance?: string;
  nextStep: string;
  action?: { href: string; label: string };
  className?: string;
}) {
  const accent = {
    final: 'border-l-[var(--color-final)]',
    risk: 'border-l-[var(--color-risk)]',
    hold: 'border-l-[var(--color-hold)]',
    idle: 'border-l-[var(--color-edge)]',
    action: 'border-l-[var(--color-action)]',
  }[tone];

  return (
    <div
      role="alert"
      data-testid="notice"
      className={cn(
        'rounded-[var(--radius-lg)] border border-l-[3px] border-[var(--color-line)] bg-[var(--color-paper)] p-5 sm:p-6',
        accent,
        className,
      )}
    >
      <h2 className="text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
        {title}
      </h2>
      {body ? (
        <p className="mt-1.5 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
          {body}
        </p>
      ) : null}
      {reassurance ? (
        <p className="mt-2 text-[length:var(--text-sm)] font-medium text-[var(--color-ink)]">
          {reassurance}
        </p>
      ) : null}
      <div className="mt-4 border-t border-[var(--color-line)] pt-3">
        <Label>What to do next</Label>
        <p className="mt-1 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
          {nextStep}
        </p>
      </div>
      {action ? (
        <ActionLink href={action.href} variant="outline" size="sm" className="mt-4">
          {action.label}
        </ActionLink>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Sandbox disclosure
 * ------------------------------------------------------------------ */

/**
 * Honest, permanent, and deliberately quiet.
 *
 * A banner shouting on every screen would be ignored within a minute and
 * would dominate a product whose whole job is clarity. This sits in the
 * header as a persistent chip, and `SandboxLine` restates it in full at
 * the exact moments a person might otherwise believe money is moving.
 */
export function SandboxChip({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--radius-full)] border border-[var(--color-hold-line)] bg-[var(--color-hold-tint)] px-2.5 py-1',
        'text-[length:var(--text-2xs)] font-medium text-[var(--color-hold)]',
        className,
      )}
      title="No real funds are held or moved anywhere in this product."
    >
      <span aria-hidden>●</span> Sandbox
      <span className="hidden sm:inline"> · no real funds</span>
    </span>
  );
}

export function SandboxLine({ className, full = false }: { className?: string; full?: boolean }) {
  return (
    <p
      className={cn(
        'rounded-[var(--radius-md)] border border-[var(--color-hold-line)] bg-[var(--color-hold-tint)] px-3 py-2',
        'text-[length:var(--text-xs)] leading-relaxed text-[var(--color-hold)]',
        className,
      )}
    >
      <strong className="font-semibold">Sandbox.</strong>{' '}
      {full
        ? 'No real funds are held or moved. No bank transfer, blockchain transaction or custody takes place. Do not send a real payment.'
        : 'Nothing settles and no money moves.'}
    </p>
  );
}

/* ------------------------------------------------------------------ *
 * Skeletons
 * ------------------------------------------------------------------ */

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton', className)} />;
}
