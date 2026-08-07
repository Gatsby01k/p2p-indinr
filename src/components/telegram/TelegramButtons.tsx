'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { guarded, haptic, webApp } from '@/lib/telegramSdk';

/**
 * Telegram's own controls, driven by the app.
 *
 * Telegram renders a back button in its header and a large action button
 * pinned above the keyboard. Both are outside our DOM, so they cannot be
 * styled — but they are what a Telegram user's thumb already expects, and
 * ignoring them leaves the app feeling like a website in a frame.
 *
 * The rule these components follow: Telegram's control MIRRORS something
 * the page already has. It never becomes the only way to do something,
 * because the same page has to work in an ordinary browser where none of
 * this exists.
 */

/* ------------------------------------------------------------------ *
 * Back
 * ------------------------------------------------------------------ */

/** Routes that are a root of the tab bar and therefore have nothing above. */
const ROOTS = new Set(['/', '/app', '/app/deals', '/app/rewards', '/app/profile']);

/** The parent of a path, for when there is no history to go back through. */
function parentOf(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length <= 1) return '/app';
  return `/${parts.slice(0, -1).join('/')}`;
}

/**
 * Wire Telegram's header back button to the router.
 *
 * Mounted once, high in the tree. It reacts to the pathname rather than
 * being configured per page, so a new screen cannot forget to opt in — and
 * `data-tg-back` lets the CSS hide the in-page chevron so there is never a
 * second back button two centimetres below Telegram's.
 */
export function TelegramBackButton() {
  const router = useRouter();
  const pathname = usePathname();
  // The handler is registered once and reads the current path through a ref,
  // so Telegram is not handed a new closure on every navigation — which it
  // would accumulate rather than replace.
  const current = useRef(pathname);
  current.current = pathname;

  useEffect(() => {
    const tg = webApp();
    if (!tg?.initData) return;

    const onBack = () => {
      haptic('light');
      if (window.history.length > 1) router.back();
      else router.push(parentOf(current.current));
    };

    tg.BackButton.onClick(onBack);
    return () => {
      tg.BackButton.offClick(onBack);
      guarded(() => tg.BackButton.hide());
      delete document.documentElement.dataset.tgBack;
    };
  }, [router]);

  useEffect(() => {
    const tg = webApp();
    if (!tg?.initData) return;

    const atRoot = ROOTS.has(pathname);
    guarded(() => (atRoot ? tg.BackButton.hide() : tg.BackButton.show()));
    if (atRoot) delete document.documentElement.dataset.tgBack;
    else document.documentElement.dataset.tgBack = '1';
  }, [pathname]);

  return null;
}

/* ------------------------------------------------------------------ *
 * Main button
 * ------------------------------------------------------------------ */

/**
 * Mirror a screen's primary action into Telegram's MainButton.
 *
 * Mount it beside the real button, passing the same label and handler. In
 * Telegram the in-page button hides (via `data-mirrored-cta`) and this one
 * takes over, sitting exactly where a Telegram user reaches for it. In a
 * browser this renders nothing and the page is unchanged.
 *
 * `loading` drives Telegram's own spinner rather than a second one in the
 * page, so a submit in flight looks like every other Telegram Mini App.
 */
export function TelegramMainButton({
  text,
  onClick,
  disabled = false,
  loading = false,
  tone = 'brand',
}: {
  text: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  tone?: 'brand' | 'final';
}) {
  // Telegram keeps the handler it was given; a fresh closure each render
  // would leave a stale one attached. The ref keeps one registration alive
  // while always calling the newest callback.
  const handler = useRef(onClick);
  handler.current = onClick;

  useEffect(() => {
    const tg = webApp();
    if (!tg?.initData) return;

    const fire = () => handler.current();
    tg.MainButton.onClick(fire);

    return () => {
      tg.MainButton.offClick(fire);
      guarded(() => tg.MainButton.hide());
      guarded(() => tg.MainButton.hideProgress());
      delete document.documentElement.dataset.tgMainbutton;
    };
  }, []);

  useEffect(() => {
    const tg = webApp();
    if (!tg?.initData) return;

    /*
     * Telegram's button colours come from the client's theme by default,
     * which would make the confirm action a different colour in every
     * user's app. The brand palette is read from CSS so the button matches
     * the page in both light and dark.
     */
    const style = getComputedStyle(document.documentElement);
    const raw = style.getPropertyValue(tone === 'final' ? '--color-final' : '--color-brand').trim();
    const color = /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : undefined;

    const applied = guarded(() =>
      tg.MainButton.setParams({
        text,
        is_visible: true,
        is_active: !disabled && !loading,
        ...(color ? { color, text_color: '#ffffff' } : {}),
      }),
    );
    guarded(() => (loading ? tg.MainButton.showProgress(false) : tg.MainButton.hideProgress()));

    /*
     * ⚠ THE IN-PAGE BUTTON ONLY HIDES ONCE TELEGRAM'S IS REALLY THERE.
     *
     * `data-tg-mainbutton` drives a stylesheet rule that hides
     * `[data-mirrored-cta]`. Setting it on mount — as this did — meant that
     * on any client where `setParams` was refused (an older API version,
     * where `guarded` swallows the throw) the page hid its own button and
     * Telegram never showed one. The person is then looking at a payment
     * screen with no way to pay.
     *
     * So the flag is set from what Telegram REPORTS, not from what we
     * asked for: both that the call succeeded and that `isVisible` is now
     * true. If either is false the page keeps its own button, and the worst
     * case is two buttons rather than none.
     */
    const visible = applied && tg.MainButton.isVisible === true;
    if (visible) document.documentElement.dataset.tgMainbutton = '1';
    else delete document.documentElement.dataset.tgMainbutton;
  }, [text, disabled, loading, tone]);

  return null;
}

/* ------------------------------------------------------------------ *
 * Closing confirmation
 * ------------------------------------------------------------------ */

/**
 * Ask Telegram to confirm before the app is swiped closed.
 *
 * Mounted on the screens where a swipe would lose real work — a
 * half-entered payment reference, an unsent dispute. Deliberately NOT
 * global: a confirmation prompt on every screen trains people to dismiss it
 * without reading, which is exactly when it stops protecting anything.
 */
export function TelegramClosingGuard({ active = true }: { active?: boolean }) {
  useEffect(() => {
    const tg = webApp();
    if (!tg?.initData) return;
    guarded(() => (active ? tg.enableClosingConfirmation() : tg.disableClosingConfirmation()));
    return () => {
      guarded(() => tg.disableClosingConfirmation());
    };
  }, [active]);

  return null;
}
