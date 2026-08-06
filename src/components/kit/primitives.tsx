import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from './Icon';

/**
 * INRP2P product primitives.
 *
 * Server components by default — none of these need client JavaScript.
 * Anything interactive that genuinely requires state lives in its own
 * 'use client' file, so the shared kit adds nothing to the bundle.
 *
 * The rule this kit exists to enforce: every screen is built from the same
 * dozen shapes. A card is a card everywhere; a status badge carries one
 * value; a money figure has one typographic treatment. Screens differ by
 * what they say, never by how they are drawn.
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
  width?: 'form' | 'prose' | 'content' | 'wide' | 'ops' | 'full';
  className?: string;
}) {
  const max = {
    form: 'max-w-[var(--w-form)]',
    prose: 'max-w-[var(--w-prose)]',
    content: 'max-w-[var(--w-content)]',
    wide: 'max-w-[var(--w-wide)]',
    ops: 'max-w-[var(--w-ops)]',
    full: '',
  }[width];
  return (
    <div className={cn('mx-auto w-full px-4 sm:px-6 lg:px-8', max, className)}>{children}</div>
  );
}

/**
 * The product's single surface.
 *
 * White on warm paper, hairline bordered, softly raised. `flush` removes the
 * padding for a card that manages its own rows; `seam` divides those rows
 * with hairlines rather than gaps, which is what stops a screen from looking
 * like a pile of loose cards.
 */
export function Card({
  children,
  className,
  tone = 'paper',
  seam = false,
  flush = false,
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  tone?: 'paper' | 'sunken' | 'brand' | 'ink' | 'ghost';
  seam?: boolean;
  flush?: boolean;
  as?: 'section' | 'div' | 'article' | 'aside' | 'li';
}) {
  const tones = {
    paper: 'bg-[var(--color-paper)] border-[var(--color-line)] shadow-[var(--shadow-card)]',
    sunken: 'bg-[var(--color-sunken)] border-[var(--color-line)]',
    brand: 'bg-[var(--color-brand-tint)] border-[var(--color-brand-line)]',
    ink: 'bg-[var(--color-nav)] border-[var(--color-nav-3)] text-[var(--color-nav-ink)]',
    ghost: 'bg-transparent border-dashed border-[var(--color-rule)]',
  }[tone];
  return (
    <Tag
      className={cn(
        'overflow-hidden rounded-[var(--radius-lg)] border',
        tones,
        !flush && 'p-4 sm:p-5',
        seam && 'divide-y divide-[var(--color-line)]',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/** Backward-compatible alias. `Panel` was the old name for `Card`. */
export function Panel(props: Parameters<typeof Card>[0]) {
  return <Card {...props} flush={props.flush ?? true} />;
}

export function CardHead({
  title,
  meta,
  icon,
  className,
  level = 2,
}: {
  title: ReactNode;
  meta?: ReactNode;
  icon?: IconName;
  className?: string;
  level?: 2 | 3;
}) {
  const H = level === 2 ? 'h2' : 'h3';
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <H className="flex min-w-0 items-center gap-2 text-[length:var(--text-md)] font-semibold text-[var(--color-ink)]">
        {icon ? <Icon name={icon} className="h-4 w-4 text-[var(--color-ink-3)]" /> : null}
        <span className="truncate">{title}</span>
      </H>
      {meta ? (
        <div className="shrink-0 text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
          {meta}
        </div>
      ) : null}
    </div>
  );
}

export function PanelHead(props: Parameters<typeof CardHead>[0]) {
  return <CardHead {...props} className={cn('px-4 py-3 sm:px-5', props.className)} />;
}

/**
 * A section heading with an optional action on the right.
 *
 * Used between cards to group a screen. Deliberately quiet: the heading is
 * small and the rule beside it does the separating, so a page of five
 * sections does not read as five competing titles.
 */
export function SectionHead({
  title,
  action,
  count,
  accent = false,
  className,
}: {
  title: string;
  action?: { href: string; label: string };
  count?: number;
  accent?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3', className)}>
      <h2
        className={cn(
          'flex items-baseline gap-2 text-[length:var(--text-base)] font-semibold',
          accent ? 'text-[var(--color-brand-ink)]' : 'text-[var(--color-ink)]',
        )}
      >
        {title}
        {count !== undefined ? (
          <span className="tnum text-[length:var(--text-xs)] font-medium text-[var(--color-ink-4)]">
            {count}
          </span>
        ) : null}
      </h2>
      {action ? (
        <Link
          href={action.href}
          prefetch={false}
          className="inline-flex items-center gap-0.5 text-[length:var(--text-xs)] font-medium text-[var(--color-brand)] hover:text-[var(--color-brand-hover)]"
        >
          {action.label}
          <Icon name="chevron-right" className="h-3.5 w-3.5" strokeWidth={2} />
        </Link>
      ) : null}
    </div>
  );
}

/** Small uppercase label. The only place tracking is widened. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'text-[length:var(--text-2xs)] font-semibold uppercase tracking-[0.07em] text-[var(--color-ink-4)]',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cn('border-0 border-t border-[var(--color-line)]', className)} />;
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
export function ExchangeRail({
  caption,
  live = false,
  className,
}: {
  caption: ReactNode;
  live?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-3', className)} role="presentation">
      <Rail cap="start" className="flex-1" />
      <span className="tnum shrink-0 text-[length:var(--text-xs)] font-medium text-[var(--color-ink-3)]">
        {caption}
      </span>
      <Rail live={live} cap="end" className="flex-1" />
    </div>
  );
}

/**
 * The swap affordance between two amount fields.
 *
 * Sits on the seam, so the two legs read as one control rather than two
 * stacked inputs. Rendered as a button by the client calculator and as a
 * plain glyph everywhere else.
 */
export function SwapSeam({ children }: { children?: ReactNode }) {
  return (
    <div className="relative h-0" aria-hidden={children ? undefined : true}>
      <div className="absolute inset-x-0 top-0 -translate-y-1/2">
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-[var(--color-line)]" />
          {children ?? (
            <span className="grid h-8 w-8 place-items-center rounded-full border border-[var(--color-line)] bg-[var(--color-paper)] text-[var(--color-ink-3)]">
              <Icon name="arrow-down" className="h-4 w-4" />
            </span>
          )}
          <div className="h-px flex-1 bg-[var(--color-line)]" />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

export type Tone = 'final' | 'risk' | 'hold' | 'idle' | 'action' | 'info';

const TONE_CLASS: Record<Tone, string> = {
  final: 'bg-[var(--color-final-tint)] text-[var(--color-final)] border-[var(--color-final-line)]',
  risk: 'bg-[var(--color-risk-tint)] text-[var(--color-risk)] border-[var(--color-risk-line)]',
  hold: 'bg-[var(--color-hold-tint)] text-[var(--color-hold)] border-[var(--color-hold-line)]',
  idle: 'bg-[var(--color-idle-tint)] text-[var(--color-idle)] border-[var(--color-idle-line)]',
  action:
    'bg-[var(--color-brand-tint)] text-[var(--color-brand-ink)] border-[var(--color-brand-line)]',
  info: 'bg-[var(--color-info-tint)] text-[var(--color-info)] border-[var(--color-info-line)]',
};

const TONE_GLYPH: Record<Tone, IconName> = {
  final: 'check',
  risk: 'alert',
  hold: 'clock',
  idle: 'more',
  action: 'chevron-right',
  info: 'info',
};

/**
 * Status badge carrying a GLYPH as well as a colour, so status is never
 * conveyed by colour alone (WCAG 1.4.1). One badge, one value — composing
 * two badges from separate booleans is how contradictory states happen.
 */
export function Status({
  tone,
  children,
  size = 'md',
  className,
}: {
  tone: Tone;
  children: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <span
      data-testid="status"
      className={cn(
        'inline-flex items-center gap-1 rounded-[var(--radius-full)] border font-semibold whitespace-nowrap',
        size === 'sm'
          ? 'px-2 py-0.5 text-[length:var(--text-2xs)]'
          : 'px-2.5 py-1 text-[length:var(--text-xs)]',
        TONE_CLASS[tone],
        className,
      )}
    >
      <Icon name={TONE_GLYPH[tone]} className="h-3 w-3" strokeWidth={2.4} />
      {children}
    </span>
  );
}

/** A neutral chip. Metadata, never status. */
export function Chip({
  children,
  icon,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  icon?: IconName;
  tone?: 'neutral' | 'brand' | 'quiet';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-[var(--color-sunken)] text-[var(--color-ink-2)] border-transparent',
    brand: 'bg-[var(--color-brand-tint)] text-[var(--color-brand-ink)] border-[var(--color-brand-line)]',
    quiet: 'bg-transparent text-[var(--color-ink-3)] border-[var(--color-line)]',
  }[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--radius-full)] border px-2.5 py-1',
        'text-[length:var(--text-2xs)] font-medium whitespace-nowrap',
        tones,
        className,
      )}
    >
      {icon ? <Icon name={icon} className="h-3.5 w-3.5" /> : null}
      {children}
    </span>
  );
}

/**
 * The verification tick.
 *
 * ⚠ In this sandbox it attests that a person completed a verification STEP,
 * not that any document or bank account was checked. Every surface that
 * shows it says so nearby; the tick alone never implies more than it knows.
 */
export function VerifiedTick({ label = 'Verified' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[length:var(--text-2xs)] font-semibold text-[var(--color-final)]">
      <Icon name="check-circle" className="h-3.5 w-3.5" strokeWidth={2} />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * People
 * ------------------------------------------------------------------ */

/** Deterministic tint from a name, so a person looks the same everywhere. */
const AVATAR_TONES = [
  'bg-[var(--color-brand-tint-2)] text-[var(--color-brand-ink)]',
  'bg-[var(--color-final-tint)] text-[var(--color-final)]',
  'bg-[var(--color-info-tint)] text-[var(--color-info)]',
  'bg-[var(--color-hold-tint)] text-[var(--color-hold)]',
  'bg-[var(--color-idle-tint)] text-[var(--color-idle)]',
] as const;

export function Avatar({
  name,
  size = 'md',
  verified = false,
  className,
}: {
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  verified?: boolean;
  className?: string;
}) {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const tone = AVATAR_TONES[hash % AVATAR_TONES.length]!;
  const box = {
    xs: 'h-6 w-6 text-[10px]',
    sm: 'h-8 w-8 text-[12px]',
    md: 'h-10 w-10 text-[14px]',
    lg: 'h-14 w-14 text-[20px]',
  }[size];

  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      <span
        aria-hidden
        className={cn('grid place-items-center rounded-full font-semibold', box, tone)}
      >
        {initial}
      </span>
      {verified ? (
        <span
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 grid h-4 w-4 place-items-center rounded-full bg-[var(--color-paper)]"
        >
          <Icon name="check-circle" className="h-3.5 w-3.5 text-[var(--color-final)]" strokeWidth={2} />
        </span>
      ) : null}
    </span>
  );
}

/** A named party with their seat in the deal. */
export function Party({
  name,
  role,
  verified = false,
  align = 'left',
}: {
  name: string;
  role: string;
  verified?: boolean;
  align?: 'left' | 'right';
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2',
        align === 'right' && 'flex-row-reverse text-right',
      )}
    >
      <Avatar name={name} size="sm" verified={verified} />
      <div className="min-w-0">
        <p className="truncate text-[length:var(--text-sm)] font-semibold text-[var(--color-ink)]">
          {name}
        </p>
        <p className="truncate text-[length:var(--text-2xs)] text-[var(--color-ink-3)]">{role}</p>
      </div>
    </div>
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
  tone = 'ink',
}: {
  value: string;
  unit: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'display';
  className?: string;
  srLabel?: string;
  tone?: 'ink' | 'muted' | 'final' | 'brand';
}) {
  const sizes = {
    xs: 'text-[length:var(--text-md)]',
    sm: 'text-[length:var(--text-lg)]',
    md: 'text-[length:var(--text-xl)]',
    lg: 'text-[length:var(--text-3xl)]',
    xl: 'text-[length:var(--text-4xl)]',
    display: 'text-[length:var(--text-4xl)] sm:text-[length:var(--text-5xl)]',
  }[size];
  const unitSizes = {
    xs: 'text-[length:var(--text-2xs)]',
    sm: 'text-[length:var(--text-xs)]',
    md: 'text-[length:var(--text-sm)]',
    lg: 'text-[length:var(--text-base)]',
    xl: 'text-[length:var(--text-lg)]',
    display: 'text-[length:var(--text-lg)] sm:text-[length:var(--text-xl)]',
  }[size];
  const tones = {
    ink: 'text-[var(--color-ink)]',
    muted: 'text-[var(--color-ink-3)]',
    final: 'text-[var(--color-final)]',
    brand: 'text-[var(--color-brand)]',
  }[tone];

  return (
    <span className={cn('inline-flex items-baseline gap-1.5', className)}>
      <span
        className={cn('tnum font-semibold tracking-[-0.028em]', sizes, tones)}
        aria-hidden={srLabel ? true : undefined}
      >
        {value}
      </span>
      {unit ? (
        <span
          className={cn('font-medium text-[var(--color-ink-3)]', unitSizes)}
          aria-hidden={srLabel ? true : undefined}
        >
          {unit}
        </span>
      ) : null}
      {srLabel ? <span className="sr-only">{srLabel}</span> : null}
    </span>
  );
}

/**
 * The headline amount block: a caption, the figure, and an optional note.
 *
 * Every screen that states an amount uses this, so "You pay" on the review
 * screen and "You pay" in the deal room are typographically identical and a
 * person can compare them without re-reading.
 */
export function AmountBlock({
  caption,
  value,
  unit,
  note,
  size = 'lg',
  tone = 'ink',
  right,
  className,
}: {
  caption: ReactNode;
  value: string;
  unit: string;
  note?: ReactNode;
  size?: Parameters<typeof Money>[0]['size'];
  tone?: Parameters<typeof Money>[0]['tone'];
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-2">
        <Label>{caption}</Label>
        {right}
      </div>
      <div className="mt-1.5">
        <Money value={value} unit={unit} size={size} tone={tone} />
      </div>
      {note ? (
        <p className="mt-1 text-[length:var(--text-xs)] text-[var(--color-ink-3)]">{note}</p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

const BTN_BASE =
  'press inline-flex items-center justify-center gap-2 rounded-[var(--radius-md)] ' +
  'font-semibold select-none whitespace-nowrap ' +
  'disabled:pointer-events-none disabled:opacity-40';

const BTN_VARIANT = {
  /** The single dominant action on a screen. */
  primary:
    'bg-[var(--color-brand)] text-white shadow-[var(--shadow-brand)] hover:bg-[var(--color-brand-hover)] active:bg-[var(--color-brand-press)]',
  /** Confirmation of arrival — the only place green is a button. */
  final: 'bg-[var(--color-final)] text-white hover:brightness-110',
  /** Structural, non-conversion actions. */
  solid: 'bg-[var(--color-ink)] text-[var(--color-paper)] hover:bg-[var(--color-ink-2)]',
  outline:
    'border border-[var(--color-rule)] bg-[var(--color-paper)] text-[var(--color-ink)] hover:border-[var(--color-edge)] hover:bg-[var(--color-sunken)]',
  /** A secondary action that still belongs to the brand. */
  tinted:
    'border border-[var(--color-brand-line)] bg-[var(--color-brand-tint)] text-[var(--color-brand-ink)] hover:bg-[var(--color-brand-tint-2)]',
  /** Something destructive or escalating: report, dispute, cancel. */
  danger:
    'border border-[var(--color-risk-line)] bg-[var(--color-paper)] text-[var(--color-risk)] hover:bg-[var(--color-risk-tint)]',
  quiet: 'text-[var(--color-ink-2)] hover:bg-[var(--color-sunken)]',
} as const;

const BTN_SIZE = {
  xs: 'h-8 px-2.5 text-[length:var(--text-xs)] rounded-[var(--radius-sm)]',
  sm: 'h-9 px-3 text-[length:var(--text-sm)] rounded-[var(--radius-sm)]',
  md: 'h-11 px-4 text-[length:var(--text-base)]',
  lg: 'h-[3.25rem] px-5 text-[length:var(--text-md)]',
} as const;

export type ButtonVariant = keyof typeof BTN_VARIANT;
export type ButtonSize = keyof typeof BTN_SIZE;

export function buttonClass(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  full = false,
) {
  return cn(
    BTN_BASE,
    BTN_VARIANT[variant],
    BTN_SIZE[size],
    // Only md and lg meet the 44px touch floor on their own; the smaller
    // sizes are for desktop-density toolbars where the pointer is precise.
    (size === 'md' || size === 'lg') && 'tap',
    full && 'w-full',
  );
}

export function ActionLink({
  href,
  children,
  variant = 'primary',
  size = 'md',
  full,
  className,
  prefetch = false,
  icon,
  iconAfter,
}: {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  full?: boolean;
  className?: string;
  prefetch?: boolean;
  icon?: IconName;
  iconAfter?: IconName;
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
      {icon ? <Icon name={icon} className="h-4 w-4" /> : null}
      {children}
      {iconAfter ? <Icon name={iconAfter} className="h-4 w-4" /> : null}
    </Link>
  );
}

/**
 * A tappable row that leads somewhere.
 *
 * The mobile reference's core list idiom: icon, label, optional value,
 * chevron. Used for settings, payment methods, help topics and the deal
 * terms list — one shape, so a person learns it once.
 */
export function ListRow({
  href,
  icon,
  title,
  subtitle,
  value,
  tone = 'neutral',
  className,
  trailing,
}: {
  href?: string;
  icon?: IconName;
  title: ReactNode;
  subtitle?: ReactNode;
  value?: ReactNode;
  tone?: 'neutral' | 'brand' | 'risk';
  className?: string;
  trailing?: ReactNode;
}) {
  const iconTone = {
    neutral: 'bg-[var(--color-sunken)] text-[var(--color-ink-2)]',
    brand: 'bg-[var(--color-brand-tint)] text-[var(--color-brand)]',
    risk: 'bg-[var(--color-risk-tint)] text-[var(--color-risk)]',
  }[tone];

  const inner = (
    <>
      {icon ? (
        <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-sm)]', iconTone)}>
          <Icon name={icon} className="h-[18px] w-[18px]" />
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-[length:var(--text-base)] font-medium',
            tone === 'risk' ? 'text-[var(--color-risk)]' : 'text-[var(--color-ink)]',
          )}
        >
          {title}
        </span>
        {subtitle ? (
          <span className="mt-0.5 block truncate text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
            {subtitle}
          </span>
        ) : null}
      </span>
      {value ? (
        <span className="shrink-0 text-[length:var(--text-sm)] text-[var(--color-ink-3)]">
          {value}
        </span>
      ) : null}
      {trailing ??
        (href ? (
          <Icon name="chevron-right" className="h-4 w-4 shrink-0 text-[var(--color-ink-4)]" />
        ) : null)}
    </>
  );

  const shape = cn(
    'tap flex w-full items-center gap-3 px-4 py-3 text-left transition-colors sm:px-5',
    href && 'press hover:bg-[var(--color-sunken)]',
    className,
  );

  if (!href) return <div className={shape}>{inner}</div>;
  return (
    <Link href={href} prefetch={false} className={shape}>
      {inner}
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
  hint,
  strong = false,
}: {
  term: ReactNode;
  children: ReactNode;
  mono?: boolean;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="flex shrink-0 items-baseline gap-1 text-[length:var(--text-sm)] text-[var(--color-ink-3)]">
        {term}
        {hint ? (
          <span
            title={hint}
            aria-label={hint}
            className="cursor-help text-[var(--color-ink-4)]"
            role="note"
          >
            <Icon name="info" className="h-3.5 w-3.5" />
          </span>
        ) : null}
      </dt>
      <dd
        className={cn(
          'min-w-0 text-right text-[length:var(--text-sm)] text-[var(--color-ink)]',
          strong && 'font-semibold',
          mono && 'tnum break-anywhere font-mono text-[length:var(--text-xs)]',
        )}
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * The fee breakdown.
 *
 * A total that does not visibly equal the sum of its parts is the fastest
 * way to lose a person's trust, so the total row is always the last child
 * and always separated by a rule.
 */
export function TotalRow({
  term,
  children,
  tone = 'ink',
}: {
  term: ReactNode;
  children: ReactNode;
  tone?: 'ink' | 'brand';
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-[var(--color-rule)] pt-3">
      <span className="text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
        {term}
      </span>
      <span
        className={cn(
          'tnum text-[length:var(--text-lg)] font-semibold',
          tone === 'brand' ? 'text-[var(--color-brand)]' : 'text-[var(--color-ink)]',
        )}
      >
        {children}
      </span>
    </div>
  );
}

/** A compact statistic. Four of these make the trust profile's header. */
export function StatTile({
  value,
  label,
  tone = 'ink',
}: {
  value: ReactNode;
  label: string;
  tone?: 'ink' | 'final' | 'risk' | 'brand';
}) {
  const tones = {
    ink: 'text-[var(--color-ink)]',
    final: 'text-[var(--color-final)]',
    risk: 'text-[var(--color-risk)]',
    brand: 'text-[var(--color-brand)]',
  }[tone];
  return (
    <div className="min-w-0">
      <p className={cn('tnum text-[length:var(--text-xl)] font-semibold tracking-[-0.02em]', tones)}>
        {value}
      </p>
      <p className="mt-0.5 text-[length:var(--text-2xs)] leading-tight text-[var(--color-ink-3)]">
        {label}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Progress
 * ------------------------------------------------------------------ */

export type StepState = 'done' | 'now' | 'todo' | 'stopped';

export interface Step {
  readonly key: string;
  readonly label: string;
  readonly state: StepState;
  readonly detail?: string;
}

/**
 * The horizontal stepper.
 *
 * State comes from the server's deal state, never from a timer and never
 * from a local guess. `stopped` is a real member of the vocabulary because
 * a disputed or expired deal must show where it halted rather than quietly
 * pretending to be mid-flight.
 */
export function Stepper({ steps, className }: { steps: readonly Step[]; className?: string }) {
  const current = steps.find((s) => s.state === 'now' || s.state === 'stopped');
  return (
    <ol
      className={cn('stepper', className)}
      aria-label={`Progress${current ? `: ${current.label}` : ''}`}
    >
      {steps.map((s) => (
        <li key={s.key} className="stepper-node" data-state={s.state}>
          <span className="stepper-dot">
            {s.state === 'done' ? (
              <Icon name="check" className="h-2.5 w-2.5" strokeWidth={3.5} />
            ) : s.state === 'stopped' ? (
              '!'
            ) : null}
          </span>
          <span className="stepper-label">{s.label}</span>
          <span className="sr-only">
            {s.state === 'done'
              ? ' — done'
              : s.state === 'now'
                ? ' — current step'
                : s.state === 'stopped'
                  ? ' — halted here'
                  : ' — not started'}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The vertical variant, where each step carries a sentence of its own. */
export function RailSteps({ steps, className }: { steps: readonly Step[]; className?: string }) {
  return (
    <ol className={cn('rail-steps', className)}>
      {steps.map((s) => (
        <li key={s.key} className="rail-step" data-state={s.state}>
          <p
            className={cn(
              'text-[length:var(--text-sm)] font-semibold',
              s.state === 'now'
                ? 'text-[var(--color-brand-ink)]'
                : s.state === 'stopped'
                  ? 'text-[var(--color-risk)]'
                  : s.state === 'done'
                    ? 'text-[var(--color-ink)]'
                    : 'text-[var(--color-ink-4)]',
            )}
          >
            {s.label}
          </p>
          {s.detail ? (
            <p className="mt-0.5 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
              {s.detail}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** A determinate meter. Width comes from real, server-known quantities. */
export function Meter({
  percent,
  tone = 'brand',
  label,
  className,
}: {
  percent: number;
  tone?: 'brand' | 'final' | 'risk';
  label?: string;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      className={cn('rail-progress', className)}
      data-tone={tone}
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span style={{ width: `${clamped}%` }} />
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
    action: 'border-l-[var(--color-brand)]',
    info: 'border-l-[var(--color-info)]',
  }[tone];

  return (
    <div
      role="alert"
      data-testid="notice"
      className={cn(
        'rounded-[var(--radius-lg)] border border-l-[3px] border-[var(--color-line)] bg-[var(--color-paper)] p-5 shadow-[var(--shadow-card)] sm:p-6',
        accent,
        className,
      )}
    >
      <h2 className="text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
        {title}
      </h2>
      {body ? (
        <p className="mt-1.5 text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink-2)]">
          {body}
        </p>
      ) : null}
      {reassurance ? (
        <p className="mt-2 text-[length:var(--text-base)] font-medium text-[var(--color-ink)]">
          {reassurance}
        </p>
      ) : null}
      <div className="mt-4 border-t border-[var(--color-line)] pt-3">
        <Label>What to do next</Label>
        <p className="mt-1 text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink-2)]">
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

/** An inline aside. Shorter than a Notice, and never a blocking state. */
export function Callout({
  tone = 'info',
  icon,
  children,
  className,
  role,
}: {
  tone?: Tone;
  icon?: IconName;
  children: ReactNode;
  className?: string;
  /** Set to `alert` when the callout appears in response to a failed action. */
  role?: 'alert' | 'status';
}) {
  return (
    <div
      role={role}
      className={cn(
        'flex items-start gap-2.5 rounded-[var(--radius-md)] border px-3 py-2.5',
        'text-[length:var(--text-xs)] leading-relaxed',
        TONE_CLASS[tone],
        className,
      )}
    >
      <Icon name={icon ?? TONE_GLYPH[tone]} className="mt-px h-4 w-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * An empty state that offers the next move.
 *
 * A blank panel saying "no data" is a dead end. Every empty state in this
 * product names what would fill it and gives the control that starts.
 */
export function EmptyState({
  icon = 'deals',
  title,
  body,
  action,
  className,
}: {
  icon?: IconName;
  title: string;
  body: string;
  action?: { href: string; label: string };
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius-lg)] border border-dashed border-[var(--color-rule)] bg-[var(--color-paper)] px-6 py-10 text-center',
        className,
      )}
    >
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[var(--color-sunken)] text-[var(--color-ink-4)]">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <h3 className="mt-4 text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
        {title}
      </h3>
      <p className="mx-auto mt-1.5 max-w-[42ch] text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink-2)]">
        {body}
      </p>
      {action ? (
        <ActionLink href={action.href} variant="primary" size="md" className="mt-5">
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
        'text-[length:var(--text-2xs)] font-semibold text-[var(--color-hold)]',
        className,
      )}
      title="No real funds are held or moved anywhere in this product."
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" /> Sandbox
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

/**
 * The loading shape of a deal card.
 *
 * Matched to the real card's geometry so the page does not jump when the
 * data lands — a skeleton that is the wrong size is worse than a spinner.
 */
export function DealCardSkeleton() {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-paper)] p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <Skeleton className="mt-3 h-7 w-40" />
      <Skeleton className="mt-3 h-3 w-full" />
      <div className="mt-4 flex items-center gap-2">
        <Skeleton className="h-8 w-8 rounded-full" />
        <Skeleton className="h-3 w-32" />
      </div>
    </div>
  );
}

export function LineSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn('h-3', i === rows - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}
