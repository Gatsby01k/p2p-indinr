# INRP2P as a Telegram Mini App

The product runs in two places from one codebase: an ordinary web app, and a
Telegram Mini App. Nothing is forked. Every Telegram-specific behaviour is
either scoped to `html[data-tg="1"]` in CSS or guarded by `isMiniApp()` in
TypeScript, so the web app is bit-for-bit unchanged when Telegram is absent.

This document is what someone needs to set it up, plus the reasoning behind
the three decisions that are not obvious.

---

## 1. Set it up

You need a public **HTTPS** URL. Telegram refuses `http://`, and the Mini
App's session cookie is `Secure`, so a plain-HTTP host would drop it and the
sign-in would appear to work and then not stick.

In [@BotFather](https://t.me/BotFather):

```
/newbot          create the bot; copy the token
/newapp          attach a Mini App: pick the bot, give it your HTTPS URL
                 and a short name — that short name is the /app in the link
/setmenubutton   optional: open the app from the chat header
```

Then set two environment variables:

| Variable | Secret? | What it is |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | **Yes** | The key every launch signature is verified against |
| `NEXT_PUBLIC_TELEGRAM_MINI_APP` | No | `https://t.me/<bot>/<app>` — the address people share |

Leave both unset and nothing breaks: the Mini App simply refuses to sign
anyone in, and the web app is unaffected.

The bot token deserves the care you would give a private key. Anyone holding
it can forge a launch for **any** Telegram user, which means signing in as
them. Never commit it, never expose it to the browser, and rotate it with
`/revoke` if it leaks.

---

## 2. How signing in works

A Mini App receives `initData` — a query string describing who opened it.
**The browser can set that string to anything**, so on its own it is worth
nothing. What makes it evidence is `hash`: an HMAC Telegram computed over
the other fields using a key derived from the bot token.

```
POST /api/telegram/auth  { initData }
        │
        ├─ verifyInitData()          src/server/telegram/verify.ts
        │    · HMAC-SHA256 against the bot token, compared in constant time
        │    · auth_date within 24h, so a captured string cannot be replayed
        │      for ever
        │    · closed result union — no boolean-plus-payload a caller might
        │      read before checking
        │
        ├─ signInWithTelegram()      src/server/telegram/auth.ts
        │    · UNIQUE(telegram_id): one Telegram account ⇄ one INRP2P account
        │    · is_operator is never set here, at all
        │
        └─ setSessionCookie(id, embedded: true)
```

Two privileges are deliberately withheld in `signInWithTelegram`:

- **Operator access is never granted.** A value arriving from a client
  launch, however well signed, must not be able to create an operator.
- **An account is never re-keyed** to a different Telegram id.

The security boundary is covered by `tests/telegramVerify.test.ts`, which
tests forgery rather than formatting: a swapped user id with an intact
signature, an injected unsigned field, a foreign bot token, replay outside
the window, and a placeholder token treated as no token at all.

---

## 3. The three non-obvious decisions

### `SameSite=None` for Telegram sessions only

Telegram Web and Desktop host a Mini App in a **cross-site iframe**. A
`SameSite=Lax` cookie is not sent from one, so the person would sign in and
immediately appear signed out. `None` is the only value browsers send there,
and browsers require `Secure` alongside it.

The CSRF objection is answered rather than ignored: every mutation in this
product is a Next.js server action, and those verify the request `Origin`
against the `Host` before running. Ordinary web sessions stay `Lax` — the
relaxation is scoped to the sessions that need it.

### `frame-ancestors` instead of `X-Frame-Options: DENY`

`DENY` forbids the iframe outright and has no allowlist. It is replaced by a
CSP directive naming exactly two origins:

```
frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org
```

`X-Frame-Options` is deliberately **not** sent alongside — a browser that
understands both applies the stricter one, which would defeat the point.

### We do not adopt Telegram's `themeParams`

Telegram offers the user's chat colours, and many Mini Apps adopt them
wholesale. This one does not. A payments product whose confirm button is
whatever colour the user picked for their chat background is a product whose
confirm button cannot be recognised.

Instead the app follows Telegram's **light/dark scheme** and pushes **its own
palette** back into Telegram's header and bottom bar via `setHeaderColor` and
`setBottomBarColor`. The seam disappears without the brand dissolving.

---

## 4. What the app does inside Telegram

| Behaviour | Where |
| --- | --- |
| `ready()`, `expand()`, vertical swipe-to-close disabled | `TelegramProvider` |
| Telegram's colour scheme overrides the OS one | `TelegramProvider` → `data-theme` |
| Header, background and bottom bar painted in brand colours | `TelegramProvider` |
| Viewport and safe-area insets published as CSS variables | `--tg-vh`, `--tg-safe-*` |
| Telegram's header back button drives the router | `TelegramBackButton` |
| Primary actions mirrored onto Telegram's MainButton | `TelegramMainButton` |
| Confirmation before a swipe-close loses typed work | `TelegramClosingGuard` |
| Haptics on every confirmation and failure | `ToastProvider` |
| Share opens Telegram's forward sheet | `ShareLink` |
| `?startapp=d_INRP-…` opens the app on that deal | `destinationForStartParam` |

**`100dvh` lies inside Telegram.** The webview reports a viewport that
includes area behind Telegram's own header and, on Android, behind the
keyboard. `viewportStableHeight` is the honest number and is published as
`--tg-vh`; a fixed bottom bar measured against `dvh` ends up off-screen.

**`env(safe-area-inset-*)` is zero inside the webview** because Telegram has
already consumed it. The app uses the insets Telegram hands back instead.

---

## 5. Deep links

One opaque `startapp` token, decoded server-side in `destinationForStartParam`:

| Payload | Opens |
| --- | --- |
| `d_INRP-XXXXXXXXXX` | that deal link |
| `r_<code>` | sign-up carrying a referral code |
| anything else | home |

Every branch returns a **hard-coded relative path** with a validated fragment
interpolated. The payload never becomes a path itself, so it cannot be used
to build an open redirect.

Telegram restricts `startapp` to `A-Za-z0-9_-` and so do we, in both
directions: `sanitizeStartParam` on the way in, `miniAppLink` on the way out.

---

## 6. Testing it

Telegram will not open an `http://localhost` URL, so you need a public HTTPS
tunnel:

```bash
npm run dev
npx localtunnel --port 3000     # or ngrok, cloudflared — any HTTPS tunnel
```

Point `/newapp` at the tunnel URL, set `TELEGRAM_BOT_TOKEN` and
`NEXT_PUBLIC_TELEGRAM_MINI_APP`, restart, and open the app from the bot.

Worth checking on a real device, because these are the things that only break
in the client:

- **iOS and Android**, not just Telegram Web — the webviews differ most in
  viewport and safe-area behaviour.
- **Telegram Web**, which is the only surface that uses the cross-site iframe
  and therefore the only one that exercises the `SameSite=None` path.
- **Dark mode toggled inside Telegram** while the OS stays light.
- **A deal link forwarded to a second account**, which is the whole product:
  share from one, open from the other, and exactly one of them can join.
