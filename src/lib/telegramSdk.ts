/**
 * The slice of Telegram's WebApp API this product uses.
 *
 * Hand-typed rather than pulled from a package, for two reasons: the
 * surface we touch is small, and every member below is one we have
 * deliberately decided to depend on. A wide `any`-shaped global would let a
 * typo compile and fail silently inside someone's Telegram client, which is
 * the hardest place to debug.
 *
 * EVERY MEMBER IS OPTIONAL AT RUNTIME. Telegram clients ship different API
 * versions and an old Android build genuinely lacks methods a current iOS
 * build has, so callers must go through the guarded helpers at the bottom
 * rather than calling straight through.
 */

export interface TelegramThemeParams {
  readonly bg_color?: string;
  readonly text_color?: string;
  readonly hint_color?: string;
  readonly link_color?: string;
  readonly button_color?: string;
  readonly button_text_color?: string;
  readonly secondary_bg_color?: string;
  readonly header_bg_color?: string;
  readonly bottom_bar_bg_color?: string;
}

export interface TelegramInitUser {
  readonly id?: number;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly username?: string;
  readonly photo_url?: string;
  readonly is_premium?: boolean;
}

export interface TelegramInsets {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface TelegramButton {
  readonly isVisible: boolean;
  show(): void;
  hide(): void;
  onClick(handler: () => void): void;
  offClick(handler: () => void): void;
}

export interface TelegramMainButton extends TelegramButton {
  setParams(params: {
    text?: string;
    color?: string;
    text_color?: string;
    is_active?: boolean;
    is_visible?: boolean;
  }): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
}

export interface TelegramHaptics {
  impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
  notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  selectionChanged(): void;
}

export type TelegramEvent =
  | 'themeChanged'
  | 'viewportChanged'
  | 'safeAreaChanged'
  | 'contentSafeAreaChanged';

export interface TelegramWebApp {
  readonly initData: string;
  readonly initDataUnsafe: {
    readonly user?: TelegramInitUser;
    readonly start_param?: string;
  };
  readonly version: string;
  readonly platform: string;
  readonly colorScheme: 'light' | 'dark';
  readonly themeParams: TelegramThemeParams;
  readonly isExpanded: boolean;
  readonly viewportHeight: number;
  readonly viewportStableHeight: number;
  readonly safeAreaInset?: TelegramInsets;
  readonly contentSafeAreaInset?: TelegramInsets;

  readonly BackButton: TelegramButton;
  readonly MainButton: TelegramMainButton;
  readonly HapticFeedback?: TelegramHaptics;

  ready(): void;
  expand(): void;
  close(): void;
  isVersionAtLeast(version: string): boolean;

  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  setBottomBarColor?(color: string): void;

  enableClosingConfirmation(): void;
  disableClosingConfirmation(): void;
  disableVerticalSwipes?(): void;
  enableVerticalSwipes?(): void;

  openLink(url: string, options?: { try_instant_view?: boolean }): void;
  openTelegramLink(url: string): void;

  onEvent(event: TelegramEvent, handler: () => void): void;
  offEvent(event: TelegramEvent, handler: () => void): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

/**
 * The live WebApp object, or null.
 *
 * Null in three distinct situations that all mean the same thing to a
 * caller: server rendering, an ordinary browser, and a Telegram client
 * whose script has not finished loading.
 */
export function webApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

/**
 * Whether the app is genuinely running as a Mini App.
 *
 * The presence of the SDK object is NOT enough: `telegram-web-app.js`
 * defines `window.Telegram.WebApp` on any page that loads it, including an
 * ordinary browser tab, where `initData` comes back empty. A non-empty
 * `initData` is the only honest signal, and it is also the thing the server
 * can verify — so the client's notion of "in Telegram" and the server's
 * notion of "who this is" rest on the same fact.
 */
export function isMiniApp(): boolean {
  const app = webApp();
  return app !== null && typeof app.initData === 'string' && app.initData.length > 0;
}

/**
 * Call a method that may not exist in this client's API version.
 *
 * Telegram throws a `WebAppMethodUnsupported` error rather than no-opping,
 * and an unhandled throw during theme setup would take down the whole app
 * on an older client. Returns whether the call actually happened.
 */
export function guarded(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

/** Haptics, safely. A silent no-op is the correct outcome when absent. */
export function haptic(
  kind: 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error' | 'select',
): void {
  const h = webApp()?.HapticFeedback;
  if (!h) return;
  guarded(() => {
    switch (kind) {
      case 'success':
      case 'warning':
      case 'error':
        h.notificationOccurred(kind);
        break;
      case 'select':
        h.selectionChanged();
        break;
      default:
        h.impactOccurred(kind);
    }
  });
}

/**
 * Open a link the way Telegram expects.
 *
 * A `t.me` address must go through `openTelegramLink`, which switches to
 * the chat in place. Passing it to `openLink` opens Telegram's in-app
 * browser pointed at a web page that then tries to open Telegram again —
 * the loop users describe as "the share button does nothing".
 */
export function openLink(url: string): boolean {
  const app = webApp();
  if (!app) return false;
  const telegramLink = /^https:\/\/(t\.me|telegram\.me)\//.test(url);
  return guarded(() => (telegramLink ? app.openTelegramLink(url) : app.openLink(url)));
}
