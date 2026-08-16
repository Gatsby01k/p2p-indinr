'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { guarded, haptic, isMiniApp, webApp, type TelegramWebApp } from '@/lib/telegramSdk';
import { Mark } from '@/components/kit/Brand';

/**
 * The Mini App runtime.
 *
 * Owns everything that has to happen once, in order, before the product is
 * usable inside Telegram:
 *
 *   1. tell Telegram we are ready and take the full height;
 *   2. paint Telegram's own chrome in OUR colours, so the seam disappears;
 *   3. publish Telegram's viewport and insets as CSS variables;
 *   4. pin the light palette, whatever scheme the client is in;
 *   5. exchange the signed launch data for a session, once;
 *   6. hand the rest of the app a small, guarded API.
 *
 * ⚠ ON BRANDING. Telegram offers `themeParams` — the user's chat colours —
 * and many Mini Apps adopt them wholesale. This one does not, and it does
 * not follow the client's dark scheme either. A payments product whose
 * confirm button is whatever colour the user picked for their chat
 * background is a product whose confirm button cannot be recognised, and a
 * near-black INRP2P is not a variant of this product but a different-
 * looking one. The palette is pinned; Telegram's own header and bottom bar
 * are painted to match it instead. The result reads as native without the
 * brand dissolving into it.
 */

interface TelegramContextValue {
  /** True only when a verified Mini App launch is present. */
  readonly inTelegram: boolean;
  /** Null outside Telegram, and until the SDK script has loaded. */
  readonly app: TelegramWebApp | null;
  readonly platform: string | null;
  /** True while the launch is being exchanged for a session. */
  readonly authenticating: boolean;
  readonly haptic: typeof haptic;
  /** Ask Telegram to confirm before the person swipes the app closed. */
  setClosingGuard: (guard: boolean) => void;
}

const TelegramContext = createContext<TelegramContextValue>({
  inTelegram: false,
  app: null,
  platform: null,
  authenticating: false,
  haptic: () => {},
  setClosingGuard: () => {},
});

export function useTelegram(): TelegramContextValue {
  return useContext(TelegramContext);
}

/** Read a CSS custom property from the document root at runtime. */
function rootColor(name: string): string | null {
  if (typeof window === 'undefined') return null;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // Telegram's colour setters accept `#rrggbb` only; anything else throws.
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
}

export function TelegramProvider({
  children,
  signedIn,
}: {
  children: ReactNode;
  signedIn: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [app, setApp] = useState<TelegramWebApp | null>(null);
  const [inTelegram, setInTelegram] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authCode, setAuthCode] = useState<string | null>(null);
  const attempted = useRef(false);

  /* ---------------- 1–4. Bootstrap the runtime ---------------- */

  useEffect(() => {
    if (!isMiniApp()) return;
    const tg = webApp();
    if (!tg) return;

    setApp(tg);
    setInTelegram(true);
    document.documentElement.dataset.tg = '1';

    guarded(() => tg.ready());
    guarded(() => tg.expand());

    /*
     * Vertical swipe-to-close fights a scrolling list: a person scrolling
     * up through their deals closes the app instead. Telegram added the
     * opt-out in 7.7; on older clients this is simply unavailable and the
     * `guarded` call returns false.
     */
    guarded(() => tg.disableVerticalSwipes?.());

    const applyChrome = () => {
      /*
       * ⚠ THE MINI APP IS ALWAYS LIGHT.
       *
       * This used to follow `tg.colorScheme`, so anyone whose Telegram was
       * in dark mode got a near-black INRP2P — which is not a variant of
       * this product, it is a different-looking product. DealSafe is
       * designed on warm paper: the saffron action colour, the tinted
       * status pills and the amount typography were all judged against it,
       * and the dark palette exists for the desktop web app.
       *
       * A payments screen that looks unfamiliar is a payments screen people
       * hesitate on, so the brand is pinned rather than themed. Telegram's
       * own chrome is then painted to match, below, which is what removes
       * the seam a dark client would otherwise show.
       */
      document.documentElement.dataset.theme = 'light';

      // Painted AFTER the scheme is applied, so these read the palette that
      // is actually in force rather than the one being replaced.
      requestAnimationFrame(() => {
        const canvas = rootColor('--color-canvas');
        const paper = rootColor('--color-paper');
        if (canvas) {
          guarded(() => tg.setHeaderColor(canvas));
          guarded(() => tg.setBackgroundColor(canvas));
        }
        if (paper) guarded(() => tg.setBottomBarColor?.(paper));
      });
    };

    const applyViewport = () => {
      const root = document.documentElement.style;
      // `viewportStableHeight` excludes the keyboard, which is what a fixed
      // bottom bar must be measured against.
      root.setProperty('--tg-vh', `${Math.round(tg.viewportStableHeight)}px`);

      const safe = tg.safeAreaInset;
      if (safe) {
        root.setProperty('--tg-safe-top', `${safe.top}px`);
        root.setProperty('--tg-safe-bottom', `${safe.bottom}px`);
        root.setProperty('--tg-safe-left', `${safe.left}px`);
        root.setProperty('--tg-safe-right', `${safe.right}px`);
      }
      const content = tg.contentSafeAreaInset;
      if (content) root.setProperty('--tg-content-top', `${content.top}px`);
    };

    applyChrome();
    applyViewport();

    tg.onEvent('themeChanged', applyChrome);
    tg.onEvent('viewportChanged', applyViewport);
    guarded(() => tg.onEvent('safeAreaChanged', applyViewport));
    guarded(() => tg.onEvent('contentSafeAreaChanged', applyViewport));

    return () => {
      tg.offEvent('themeChanged', applyChrome);
      tg.offEvent('viewportChanged', applyViewport);
      guarded(() => tg.offEvent('safeAreaChanged', applyViewport));
      guarded(() => tg.offEvent('contentSafeAreaChanged', applyViewport));
    };
  }, []);

  /* ---------------- 5. Exchange the launch for a session ---------------- */

  useEffect(() => {
    if (!inTelegram || signedIn || attempted.current) return;
    const tg = webApp();
    if (!tg?.initData) return;

    attempted.current = true;
    setAuthenticating(true);

    void (async () => {
      try {
        const response = await fetch('/api/telegram/auth', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ initData: tg.initData }),
        });
        const payload: unknown = await response.json();
        const data = (payload ?? {}) as {
          ok?: boolean;
          code?: string;
          message?: string;
          destination?: string;
          warning?: string | null;
        };

        if (!response.ok || data.ok !== true) {
          console.warn('[telegram] launch rejected', response.status, data.code);
          setAuthError(data.message ?? 'Telegram sign-in did not complete.');
          setAuthCode(data.code ?? `HTTP ${response.status}`);
          return;
        }
        if (data.warning) console.warn('[telegram]', data.warning);

        haptic('success');
        /*
         * `refresh()` before `push()`: the session cookie only just landed,
         * so the current tree was rendered as a signed-out visitor and
         * would otherwise navigate with stale data.
         */
        router.refresh();
        const destination = data.destination ?? '/app';
        if (destination !== pathname) router.replace(destination);
      } catch {
        setAuthError('Could not reach INRP2P. Check your connection and reopen the app.');
        setAuthCode('NETWORK');
      } finally {
        setAuthenticating(false);
      }
    })();
  }, [inTelegram, signedIn, router, pathname]);

  /* ---------------- Deep link for an already-signed-in launch ------------ */

  useEffect(() => {
    if (!inTelegram || !signedIn) return;
    // Only redirect from the entry points. A person who has already
    // navigated somewhere must not be yanked back by a stale launch param.
    if (pathname !== '/' && pathname !== '/app') return;

    /*
     * `initDataUnsafe` is exactly what its name says, so this value is used
     * as a NAVIGATION HINT ONLY: it is matched against a strict pattern and
     * interpolated into a hard-coded path, and the destination page
     * performs its own authorization regardless of how it was reached.
     */
    const startParam = webApp()?.initDataUnsafe?.start_param;
    const deal = startParam ? /^d_(INRP-[0-9A-HJ-NP-Z]{10})$/.exec(startParam) : null;
    if (deal) {
      router.replace(`/d/${deal[1]}`);
      return;
    }

    /*
     * ⚠ THE MINI APP MUST NEVER SETTLE ON THE LANDING PAGE.
     *
     * `/` is the marketing landing page and it does not redirect a signed-in
     * visitor — it never has. Entry into the product used to happen ONLY as a
     * side effect of the sign-in handshake above, which returns early once a
     * session cookie exists. So the FIRST launch reached `/app` and every
     * launch after it showed the brochure instead: the person who had already
     * signed in was the one who got the worse result.
     *
     * Inside Telegram the root is an entry point, not a destination.
     */
    if (pathname === '/') router.replace('/app');
  }, [inTelegram, signedIn, pathname, router]);

  /* ---------------- 6. The API handed to the rest of the app ------------- */

  const setClosingGuard = useCallback((guard: boolean) => {
    const tg = webApp();
    if (!tg) return;
    guarded(() => (guard ? tg.enableClosingConfirmation() : tg.disableClosingConfirmation()));
  }, []);

  const value = useMemo<TelegramContextValue>(
    () => ({
      inTelegram,
      app,
      platform: app?.platform ?? null,
      authenticating,
      haptic,
      setClosingGuard,
    }),
    [inTelegram, app, authenticating, setClosingGuard],
  );

  return (
    <TelegramContext.Provider value={value}>
      {children}
      {authenticating ? <LaunchSplash /> : null}
      {authError ? <LaunchError message={authError} code={authCode} /> : null}
    </TelegramContext.Provider>
  );
}

/* ------------------------------------------------------------------ *
 * Launch states
 * ------------------------------------------------------------------ */

/**
 * Covers the app for the fraction of a second the handshake takes.
 *
 * Without it the person sees a signed-out landing page flash before being
 * replaced — which, in a product about money, reads as something going
 * wrong rather than something loading.
 */
function LaunchSplash() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="animate-fade fixed inset-0 z-[90] grid place-items-center bg-[var(--color-canvas)]"
    >
      <div className="flex flex-col items-center gap-4">
        <Mark className="h-12 w-12 text-[var(--color-brand)]" />
        <p className="text-[length:var(--text-sm)] font-medium text-[var(--color-ink-3)]">
          Opening INRP2P…
        </p>
        <div className="track w-32">
          <span />
        </div>
      </div>
    </div>
  );
}

/**
 * The handshake failed.
 *
 * Says what to do rather than what broke, because the only remedies a
 * person has are to reopen the app or to use the web version — and both are
 * offered here instead of leaving them on a blank screen.
 */
function LaunchError({ message, code }: { message: string; code: string | null }) {
  return (
    <div
      role="alert"
      className="fixed inset-0 z-[90] grid place-items-center bg-[var(--color-canvas)] p-6"
    >
      <div className="max-w-sm text-center">
        <Mark className="mx-auto h-10 w-10 text-[var(--color-ink-4)]" />
        <h1 className="mt-4 text-[length:var(--text-lg)] font-semibold text-[var(--color-ink)]">
          Could not open INRP2P
        </h1>
        <p className="mt-2 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-ink-2)]">
          {message}
        </p>
        <p className="mt-3 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
          Nothing was changed, and no deal was affected. Close this window and open the app from the
          bot again.
        </p>
        {/*
          The reason code, in small print. It is the only thing a person can
          read back from a screenshot when a Mini App fails on their phone,
          and without it every failure looks identical to every other.
        */}
        {code ? (
          <p className="mt-4 font-mono text-[length:var(--text-2xs)] text-[var(--color-ink-4)]">
            {code}
          </p>
        ) : null}
      </div>
    </div>
  );
}
