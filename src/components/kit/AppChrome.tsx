import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { Wordmark } from './Brand';
import { SandboxChip } from './primitives';

/**
 * Product chrome.
 *
 * Desktop: a single hairline top bar. Mobile: the same top bar plus a
 * fixed bottom action bar, because the primary action must be reachable
 * one-handed and the thumb does not travel to the top of a 932px phone.
 *
 * Both are server-rendered. Navigation is plain links — no client router
 * state, no JavaScript required to move around the product.
 */

export function TopBar({
  right,
  href = '/',
  suffix,
}: {
  right?: ReactNode;
  href?: string;
  suffix?: string;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-[var(--color-line)] bg-[var(--color-canvas)]/92 backdrop-blur-[6px]">
      <div className="mx-auto flex h-14 max-w-[var(--w-wide)] items-center justify-between gap-3 px-4 sm:px-6">
        <Link
          href={href}
          className="tap -ml-1 inline-flex items-center rounded-[var(--radius-sm)] px-1"
        >
          <Wordmark suffix={suffix} />
        </Link>
        <div className="flex items-center gap-2.5">{right}</div>
      </div>
    </header>
  );
}

/** Nav item for the mobile bottom bar. Icons are inline SVG at 1em. */
function NavItem({
  href,
  label,
  active,
  children,
}: {
  href: string;
  label: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'tap flex flex-1 flex-col items-center justify-center gap-0.5 rounded-[var(--radius-sm)] py-1.5',
        'text-[length:var(--text-2xs)] font-medium transition-colors',
        active ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-4)]',
      )}
    >
      <span aria-hidden className={active ? 'text-[var(--color-action)]' : undefined}>
        {children}
      </span>
      {label}
    </Link>
  );
}

const IconDeals = (
  <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M2 6h9M9 14h9" strokeLinecap="square" />
    <rect
      x="11.5"
      y="4.5"
      width="3"
      height="3"
      transform="rotate(45 13 6)"
      fill="currentColor"
      stroke="none"
    />
    <rect
      x="5.5"
      y="12.5"
      width="3"
      height="3"
      transform="rotate(45 7 14)"
      fill="currentColor"
      stroke="none"
    />
  </svg>
);

const IconNew = (
  <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
    <path d="M10 4v12M4 10h12" strokeLinecap="square" />
  </svg>
);

const IconOps = (
  <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 5h14M3 10h14M3 15h9" strokeLinecap="square" />
  </svg>
);

/**
 * Fixed bottom bar, mobile only.
 *
 * Sits above the safe-area inset so it clears the iOS home indicator, and
 * pages reserve matching space so it never covers content or a keyboard-
 * raised field.
 */
export function BottomNav({
  active,
  isOperator,
}: {
  active: 'deals' | 'new' | 'ops';
  isOperator: boolean;
}) {
  return (
    <nav
      aria-label="Primary"
      className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-[var(--color-line)] bg-[var(--color-paper)] md:hidden"
    >
      <div className="mx-auto flex max-w-md items-stretch gap-1 px-2 py-1">
        <NavItem href="/app" label="Deals" active={active === 'deals'}>
          {IconDeals}
        </NavItem>
        <NavItem href="/app/new" label="Create" active={active === 'new'}>
          {IconNew}
        </NavItem>
        {isOperator ? (
          <NavItem href="/app/ops" label="Queue" active={active === 'ops'}>
            {IconOps}
          </NavItem>
        ) : null}
      </div>
    </nav>
  );
}

/** Desktop inline nav, shown in the top bar. */
export function DeskNav({ active, isOperator }: { active: string; isOperator: boolean }) {
  const item = (href: string, label: string, key: string) => (
    <Link
      key={key}
      href={href}
      prefetch={false}
      aria-current={active === key ? 'page' : undefined}
      className={cn(
        'rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[length:var(--text-sm)] font-medium transition-colors',
        active === key
          ? 'bg-[var(--color-sunken)] text-[var(--color-ink)]'
          : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]',
      )}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Sections" className="hidden items-center gap-0.5 md:flex">
      {item('/app', 'Deals', 'deals')}
      {item('/app/new', 'Create', 'new')}
      {isOperator ? item('/app/ops', 'Queue', 'ops') : null}
    </nav>
  );
}

export { SandboxChip };
