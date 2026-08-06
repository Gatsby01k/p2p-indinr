import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { Wordmark } from './Brand';
import { Icon, type IconName } from './Icon';
import { Avatar, SandboxChip } from './primitives';

/**
 * Product chrome — two postures, one information architecture.
 *
 *   MOBILE   a compact top bar and a fixed four-tab bottom bar. The tabs
 *            are the product's whole map, so a person is never more than
 *            one tap from any section.
 *   DESKTOP  a dark navigation rail on the left, the same four
 *            destinations plus the operator desk, and a content header
 *            that carries the page's own title and actions.
 *
 * Both are server-rendered. Navigation is plain links — no client router
 * state, and the product is fully navigable with JavaScript disabled.
 */

export type NavKey = 'home' | 'deals' | 'rewards' | 'profile' | 'ops';

interface NavEntry {
  readonly key: NavKey;
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
}

const MAIN_NAV: readonly NavEntry[] = [
  { key: 'home', href: '/app', label: 'Home', icon: 'home' },
  { key: 'deals', href: '/app/deals', label: 'Deals', icon: 'deals' },
  { key: 'rewards', href: '/app/rewards', label: 'Rewards', icon: 'gift' },
  { key: 'profile', href: '/app/profile', label: 'Profile', icon: 'profile' },
];

/* ------------------------------------------------------------------ *
 * Public top bar — the signed-out and shared-link surfaces
 * ------------------------------------------------------------------ */

export function TopBar({
  right,
  href = '/',
  suffix = 'DealSafe India',
  border = true,
}: {
  right?: ReactNode;
  href?: string;
  suffix?: string | null;
  border?: boolean;
}) {
  return (
    <header
      className={cn(
        'pt-safe sticky top-0 z-30 bg-[var(--color-canvas)]/88 backdrop-blur-[10px]',
        border && 'border-b border-[var(--color-line)]',
      )}
    >
      <div className="mx-auto flex h-[var(--h-topbar)] max-w-[var(--w-wide)] items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
        <Link href={href} className="-ml-1 inline-flex items-center rounded-[var(--radius-sm)] px-1">
          <Wordmark suffix={suffix} compact />
        </Link>
        <div className="flex items-center gap-2">{right}</div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ *
 * Mobile: the tab bar
 * ------------------------------------------------------------------ */

function Tab({ entry, active }: { entry: NavEntry; active: boolean }) {
  return (
    <Link
      href={entry.href}
      prefetch={false}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex flex-1 flex-col items-center justify-center gap-1 rounded-[var(--radius-md)] py-1.5',
        'text-[length:var(--text-2xs)] font-medium transition-colors',
        active ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-4)]',
      )}
    >
      <span className={active ? 'text-[var(--color-brand)]' : 'text-[var(--color-ink-4)]'}>
        <Icon name={entry.icon} className="h-[22px] w-[22px]" strokeWidth={active ? 2 : 1.7} />
      </span>
      {entry.label}
      {/* The active marker is a bar, not a colour change alone, so the
          current tab is identifiable without relying on hue. */}
      <span
        aria-hidden
        className={cn(
          'absolute inset-x-4 top-0 h-[2px] rounded-full transition-opacity duration-[var(--dur-base)]',
          active ? 'bg-[var(--color-brand)] opacity-100' : 'opacity-0',
        )}
      />
    </Link>
  );
}

/**
 * Fixed bottom bar, mobile only.
 *
 * Sits above the safe-area inset so it clears the iOS home indicator, and
 * pages reserve matching space (`pb-tabbar`) so it never covers content or
 * a keyboard-raised field.
 */
export function TabBar({ active }: { active: NavKey }) {
  return (
    <nav
      aria-label="Primary"
      className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-line)] bg-[var(--color-paper)]/96 backdrop-blur-[10px] lg:hidden"
    >
      <div className="mx-auto flex h-[var(--h-tabbar)] max-w-md items-stretch gap-1 px-2">
        {MAIN_NAV.map((entry) => (
          <Tab key={entry.key} entry={entry} active={active === entry.key} />
        ))}
      </div>
    </nav>
  );
}

/** Kept under its previous name for callers that still import it. */
export function BottomNav({ active }: { active: NavKey }) {
  return <TabBar active={active} />;
}

/* ------------------------------------------------------------------ *
 * Desktop: the navigation rail
 * ------------------------------------------------------------------ */

function RailItem({ entry, active, badge }: { entry: NavEntry; active: boolean; badge?: number }) {
  return (
    <li>
      <Link
        href={entry.href}
        prefetch={false}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'group flex items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2.5 transition-colors duration-[var(--dur-fast)]',
          'text-[length:var(--text-base)] font-medium',
          active
            ? 'bg-[var(--color-brand)] text-white'
            : 'text-[var(--color-nav-ink-2)] hover:bg-[var(--color-nav-3)] hover:text-[var(--color-nav-ink)]',
        )}
      >
        <Icon name={entry.icon} className="h-[18px] w-[18px]" strokeWidth={active ? 2 : 1.7} />
        <span className="flex-1 truncate">{entry.label}</span>
        {badge && badge > 0 ? (
          <span
            className={cn(
              'tnum grid min-w-5 place-items-center rounded-full px-1.5 py-0.5 text-[length:var(--text-2xs)] font-semibold',
              active ? 'bg-white/20 text-white' : 'bg-[var(--color-brand)] text-white',
            )}
          >
            {badge > 99 ? '99+' : badge}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

export function SideRail({
  active,
  isOperator,
  displayName,
  signOut,
  disputeCount,
}: {
  active: NavKey;
  isOperator: boolean;
  displayName: string;
  signOut: ReactNode;
  disputeCount?: number;
}) {
  return (
    <aside
      className="fixed inset-y-0 left-0 z-40 hidden w-[var(--rail-w)] flex-col bg-[var(--color-nav)] lg:flex"
      style={{ ['--mark-counter' as string]: 'var(--color-nav)' }}
    >
      <div className="px-5 pb-4 pt-6">
        <Link href="/app" className="inline-flex rounded-[var(--radius-sm)]">
          <Wordmark tone="nav" />
        </Link>
      </div>

      <nav aria-label="Primary" className="flex-1 overflow-y-auto px-3">
        <ul className="space-y-1">
          {MAIN_NAV.map((entry) => (
            <RailItem key={entry.key} entry={entry} active={active === entry.key} />
          ))}
        </ul>

        {isOperator ? (
          <>
            <p className="px-3 pb-2 pt-6 text-[length:var(--text-2xs)] font-semibold uppercase tracking-[0.08em] text-[var(--color-nav-ink-3)]">
              Operations
            </p>
            <ul className="space-y-1">
              <RailItem
                entry={{ key: 'ops', href: '/app/ops', label: 'Deal Desk', icon: 'briefcase' }}
                active={active === 'ops'}
                badge={disputeCount}
              />
            </ul>
          </>
        ) : null}
      </nav>

      <div className="space-y-1 border-t border-[var(--color-nav-3)] px-3 py-4">
        <Link
          href="/app/help"
          prefetch={false}
          className="flex items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2.5 text-[length:var(--text-base)] font-medium text-[var(--color-nav-ink-2)] transition-colors hover:bg-[var(--color-nav-3)] hover:text-[var(--color-nav-ink)]"
        >
          <Icon name="help" className="h-[18px] w-[18px]" />
          Help &amp; support
        </Link>
        {signOut}
        <div className="flex items-center gap-2.5 px-3 pt-3">
          <Avatar name={displayName} size="xs" />
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-xs)] capitalize text-[var(--color-nav-ink-2)]">
            {displayName}
          </span>
        </div>
      </div>
    </aside>
  );
}

/**
 * The in-app header.
 *
 * On desktop it carries the page's own title, so the rail says *where you
 * are in the product* and the header says *what this screen is*. On mobile
 * it collapses to a back affordance, the title, and the notification bell —
 * the tab bar is already saying where you are.
 */
export function AppHeader({
  title,
  subtitle,
  back,
  actions,
  unread = 0,
  sticky = true,
  bell = true,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: { href: string; label: string };
  actions?: ReactNode;
  unread?: number;
  sticky?: boolean;
  bell?: boolean;
}) {
  return (
    <header
      className={cn(
        'pt-safe z-30 border-b border-[var(--color-line)] bg-[var(--color-canvas)]/88 backdrop-blur-[10px]',
        sticky && 'sticky top-0',
      )}
    >
      <div className="flex min-h-[var(--h-topbar)] items-center gap-3 px-4 py-2.5 sm:px-6 lg:px-8">
        {back ? (
          <Link
            href={back.href}
            prefetch={false}
            aria-label={back.label}
            className="press -ml-1.5 grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--color-ink-2)] hover:bg-[var(--color-sunken)]"
          >
            <Icon name="chevron-left" className="h-5 w-5" strokeWidth={2} />
          </Link>
        ) : null}

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[length:var(--text-lg)] font-semibold tracking-[-0.025em] text-[var(--color-ink)] lg:text-[length:var(--text-xl)]">
            {title}
          </h1>
          {subtitle ? (
            <p className="truncate text-[length:var(--text-xs)] text-[var(--color-ink-3)]">
              {subtitle}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          {bell ? <NotificationBell unread={unread} /> : null}
        </div>
      </div>
    </header>
  );
}

export function NotificationBell({ unread }: { unread: number }) {
  return (
    <Link
      href="/app/notifications"
      prefetch={false}
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      className="press relative grid h-10 w-10 place-items-center rounded-full text-[var(--color-ink-2)] hover:bg-[var(--color-sunken)]"
    >
      <Icon name="bell" className="h-[19px] w-[19px]" />
      {unread > 0 ? (
        <span
          aria-hidden
          className="tnum absolute right-1 top-1 grid min-w-[1.05rem] place-items-center rounded-full bg-[var(--color-brand)] px-1 text-[10px] font-bold leading-[1.05rem] text-white"
        >
          {unread > 9 ? '9+' : unread}
        </span>
      ) : null}
    </Link>
  );
}

/**
 * The authenticated page frame.
 *
 * One component owns the relationship between the rail, the header and the
 * tab bar, including the exact space each reserves. Pages never position
 * themselves against fixed chrome — that is how a button ends up under a
 * tab bar on one screen and not on another.
 */
export function AppFrame({
  children,
  active,
  isOperator,
  displayName,
  signOut,
  disputeCount,
  wide = false,
}: {
  children: ReactNode;
  active: NavKey;
  isOperator: boolean;
  displayName: string;
  signOut: ReactNode;
  disputeCount?: number;
  wide?: boolean;
}) {
  return (
    <div className="min-h-dvh">
      <SideRail
        active={active}
        isOperator={isOperator}
        displayName={displayName}
        signOut={signOut}
        disputeCount={disputeCount}
      />
      <div className={wide ? 'lg:pl-[var(--rail-w)]' : 'lg:pl-[var(--rail-w)]'}>
        <main id="main" className="pb-tabbar min-h-dvh lg:pb-12">
          {children}
        </main>
      </div>
      <TabBar active={active} />
    </div>
  );
}

export { SandboxChip };
