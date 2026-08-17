'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { Mark } from '@/components/kit/Brand';
import { Icon } from '@/components/kit/Icon';
import { CAPABILITIES, CAPABILITY_KEYS, createDealHref } from './demo';
import { LandingShell } from './LandingShell';
import { TelegramAction } from './TelegramAction';

/**
 * The public header.
 *
 * ⚠ NO SANDBOX CHIP. It used to sit beside `Sign in` on this page and it
 * has been removed from the PUBLIC MARKETING SURFACE ONLY. `SandboxChip`
 * still ships, still renders on `/login` and on a shared deal link, and
 * `SandboxLine` still states the position in full wherever somebody might
 * otherwise believe money is moving. Nothing about sandbox BEHAVIOUR
 * changed — only the badge a first-time visitor met before they knew what
 * the product was.
 *
 * Three zones on desktop, because the nav is a peer of the brand rather
 * than a tail on it: brand left, navigation centred, actions right. Below
 * `lg` the navigation collapses into a disclosure, so the two things that
 * matter on a phone — the brand and the Telegram action — never compete
 * with four links for the same 390px.
 */
export function LandingHeader({ miniAppUrl }: { miniAppUrl: string | null }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [productOpen, setProductOpen] = useState(false);
  const productId = useId();
  const menuId = useId();
  const productRef = useRef<HTMLLIElement>(null);

  /* Escape closes whichever disclosure is open, from anywhere inside it. */
  useEffect(() => {
    if (!menuOpen && !productOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setProductOpen(false);
      setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen, productOpen]);

  /*
   * A pointer landing outside the product menu closes it. Deliberately
   * `pointerdown` rather than `click`: a person clicking a link elsewhere
   * in the header should see the menu shut as they press, not after the
   * navigation has already started.
   */
  useEffect(() => {
    if (!productOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!productRef.current?.contains(e.target as Node)) setProductOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [productOpen]);

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-line)] bg-[var(--color-canvas)]/85 backdrop-blur-[12px]">
      <LandingShell className="flex h-[4.5rem] items-center justify-between gap-4 lg:h-[5.25rem]">
        {/* ---- Brand ------------------------------------------------ */}
        <Link
          href="/"
          className="-ml-1 inline-flex shrink-0 items-center gap-2.5 rounded-[var(--radius-md)] px-1 py-1 sm:gap-3"
          aria-label="INRP2P — DealSafe India, home"
        >
          <Mark className="h-8 w-8 text-[var(--color-brand)] sm:h-10 sm:w-10" />
          <span className="flex flex-col leading-none">
            <span className="text-[1.15rem] font-bold tracking-[-0.04em] text-[var(--color-ink)] sm:text-[1.4rem]">
              INRP2P
            </span>
            <span className="mt-1 text-[length:var(--text-xs)] font-medium text-[var(--color-ink-3)]">
              DealSafe India
            </span>
          </span>
        </Link>

        {/* ---- Navigation, centred --------------------------------- */}
        <nav aria-label="Main" className="hidden lg:block">
          <ul className="flex items-center gap-1">
            <li ref={productRef} className="relative">
              <button
                type="button"
                aria-expanded={productOpen}
                aria-controls={productId}
                onClick={() => setProductOpen((open) => !open)}
                className={cn(NAV_LINK, 'gap-1')}
              >
                Product
                <Icon
                  name="chevron-down"
                  className={cn(
                    'h-3.5 w-3.5 text-[var(--color-ink-4)] transition-transform duration-[var(--dur-fast)]',
                    productOpen && 'rotate-180',
                  )}
                  strokeWidth={2.2}
                />
              </button>

              {productOpen ? (
                <div
                  id={productId}
                  className="animate-rise absolute left-1/2 top-[calc(100%+0.6rem)] w-[19rem] -translate-x-1/2 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-paper)] p-1.5 shadow-[var(--shadow-lift)]"
                >
                  {CAPABILITY_KEYS.map((key) => {
                    const capability = CAPABILITIES[key];
                    return (
                      <Link
                        key={key}
                        href={createDealHref(key)}
                        prefetch={false}
                        onClick={() => setProductOpen(false)}
                        className="press flex items-start gap-3 rounded-[var(--radius-md)] px-3 py-2.5 hover:bg-[var(--color-sunken)]"
                      >
                        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--color-brand-tint)] text-[var(--color-brand)]">
                          <Icon
                            name={
                              key === 'SEND_INR' ? 'rupee' : key === 'BUY_USDT' ? 'shield' : 'swap'
                            }
                            className="h-4 w-4"
                          />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[length:var(--text-base)] font-semibold text-[var(--color-ink)]">
                            {capability.label}
                          </span>
                          <span className="mt-0.5 block text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
                            {capability.summary}
                          </span>
                        </span>
                      </Link>
                    );
                  })}
                </div>
              ) : null}
            </li>

            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <Link href={item.href} prefetch={false} className={NAV_LINK}>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {/* ---- Actions --------------------------------------------- */}
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <Link
            href="/login"
            prefetch={false}
            className="press hidden h-11 items-center rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-paper)] px-5 text-[length:var(--text-base)] font-semibold text-[var(--color-ink)] hover:border-[var(--color-edge)] hover:bg-[var(--color-sunken)] sm:inline-flex"
          >
            Sign in
          </Link>

          <TelegramAction
            miniAppUrl={miniAppUrl}
            className="h-11 px-3.5 text-[length:var(--text-base)] sm:px-5"
          >
            {/*
              Below 384px the brand, this button and the menu control add
              up to more than the viewport, and the first thing to give
              was the right-hand gutter — the header ran flush into the
              screen edge. The LABEL collapses to screen-reader-only there
              rather than the button: the plane on blue is unmistakable,
              the accessible name is unchanged, and the 44px target is
              untouched. From 384px up the words are back.
            */}
            <span className="max-[383px]:sr-only">Open Telegram</span>
          </TelegramAction>

          <button
            type="button"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMenuOpen((open) => !open)}
            className="press tap grid h-11 w-11 place-items-center rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-paper)] text-[var(--color-ink)] lg:hidden"
          >
            <Icon name={menuOpen ? 'close' : 'menu'} className="h-5 w-5" strokeWidth={2} />
          </button>
        </div>
      </LandingShell>

      {/* ---- The small-screen disclosure --------------------------- */}
      {menuOpen ? (
        <div
          id={menuId}
          className="animate-rise border-t border-[var(--color-line)] bg-[var(--color-paper)] lg:hidden"
        >
          <LandingShell className="py-3">
            <nav aria-label="Main">
              <ul className="divide-y divide-[var(--color-line)]">
                {CAPABILITY_KEYS.map((key) => (
                  <li key={key}>
                    <Link
                      href={createDealHref(key)}
                      prefetch={false}
                      onClick={() => setMenuOpen(false)}
                      className="tap flex items-center gap-2 py-3 text-[length:var(--text-md)] font-semibold text-[var(--color-ink)]"
                    >
                      <Icon
                        name={key === 'SEND_INR' ? 'rupee' : key === 'BUY_USDT' ? 'shield' : 'swap'}
                        className="h-4 w-4 text-[var(--color-brand)]"
                      />
                      {CAPABILITIES[key].label}
                    </Link>
                  </li>
                ))}
                {NAV_ITEMS.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      prefetch={false}
                      onClick={() => setMenuOpen(false)}
                      className="tap flex items-center py-3 text-[length:var(--text-md)] font-semibold text-[var(--color-ink)]"
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
                <li>
                  <Link
                    href="/login"
                    prefetch={false}
                    onClick={() => setMenuOpen(false)}
                    className="tap flex items-center py-3 text-[length:var(--text-md)] font-semibold text-[var(--color-ink)]"
                  >
                    Sign in
                  </Link>
                </li>
              </ul>
            </nav>
          </LandingShell>
        </div>
      ) : null}
    </header>
  );
}

const NAV_LINK =
  'press inline-flex h-10 items-center rounded-[var(--radius-md)] px-3.5 text-[length:var(--text-md)] font-semibold text-[var(--color-ink-2)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)] xl:px-4';

/**
 * Where the remaining three go.
 *
 * `#how-it-works` is the section this stage builds. `Rewards` and `Safety`
 * point at the REAL screens that already exist rather than at anchors for
 * sections that do not — a nav link to nothing is a broken link, and the
 * later landing stages can repoint these without anyone meeting a dead end
 * in the meantime.
 */
const NAV_ITEMS: readonly { label: string; href: string }[] = [
  { label: 'How it works', href: '#how-it-works' },
  { label: 'Rewards', href: '/app/rewards' },
  { label: 'Safety', href: '#safety' },
];
