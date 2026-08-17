# UI/UX finalisation — INRP2P V2 · DealSafe India

A presentation-quality pass over the whole implemented product, judged
against the **built** application: `next build` → isolated PostgreSQL →
`next start` → real browser journeys → real screenshots, looked at.

No business architecture changed. Ledger semantics, financial
calculations, deal state machines, authorization, MFA, maker-checker,
idempotency, risk decisions, migration history, rail meaning and the
existing security boundaries are all exactly as DEL-02…DEL-10 left them.
**No test was weakened to make a visual change pass** — and one visual
change was reverted because a test correctly refused it (§6).

| Gate | Exit | Result |
|---|---|---|
| Complete gate — `npm run gate` | **0** | **20 / 20** |
| Browser gate against `next start` | **0** | **243 / 243** |
| Accessibility, 11 surfaces | **0** | **70 / 70** |
| Responsive, 9 widths × 7 surfaces | **0** | **63 / 63** |
| Performance budgets | **0** | **21 / 21** |
| Eleven-step staging rehearsal | **0** | **33 / 33** |
| Unit / integration | **0** | 205 / 656 |

**Screenshots:** `artifacts/uiux/screens/` — 68 frames, every one at both
postures (390 phone, 1440 desktop), from a live server with real deals.
`artifacts/uiux/screens/index.json` lists them.
**Audit:** `artifacts/uiux/visual-audit.md`.

---

## 1 · The audit, and what it found

Grouped as required, read off the real screenshots rather than the code.
Full text in `artifacts/uiux/visual-audit.md`. The headline findings:

| Group | Finding |
|---|---|
| **Inconsistent** | Amounts rendered three ways: the calculator showed `₹ 25000` raw directly above `₹25,000.00`; the deals list showed the payer's **gross transfer** where the deal room showed the **protected amount** for the same deal |
| **Inconsistent** | The transfer figure appeared **three times** on the pay screen; status twice in the deal-room header; the deals list stated its counts three times |
| **Visually weak** | **Eight authenticated routes** rendered a 27.5rem column into a 1040px desktop area — ~70% of the viewport empty, with the reasons to trust the screen below the fold |
| **Visually weak** | The deal room drew its **five-step progress twice**, in two visual languages |
| **Visually weak** | Evidence empty state was **two stacked dashed boxes**, ~340px tall |
| **Unclear** | **Raw database vocabulary** in the operator audit trail: `link join`, `Seller … → fiat_pending` |
| **Unclear** | "Deal rail" — the system's internal metaphor — used as the heading over somebody's list of deals |
| **Missing state** | Chat rendered a ~350px void for a deal with three system notices |
| **Mobile** | The verification queue repeated an identical warning verbatim once per card |
| **Desktop** | The Deal Desk table was **clipped at 1280**, cutting the **Next action** column |
| **Desktop** | 768 and 1024 — the two widths where this layout actually changes — were never tested |
| **Trust** | Two separate sandbox warnings on the pay screen; the primary action 1700px below the fold |

One thing the audit initially got **wrong**, corrected by reading the
code: the shared deal link *does* name its creator — to a signed-in
reader only, which is the deliberate and correct disclosure boundary. The
screenshot I judged was a signed-out stranger.

---

## 2 · Design-system changes

Additive and shared, not route-level patches.

### `FocusLayout` — the desktop answer

One new layout primitive, and the highest-leverage change in the pass.
**Desktop is not a phone with margins**, but the answer is not to widen a
form either: a 27rem measure is right for a column of fields and a ₹
figure. So the *context* moves beside the *task*.

- One column on a phone, two from `lg`, the pair centred so it never
  drifts to the edge of a 1920px display.
- The aside is `lg:sticky`, so context stays in view while a long form
  scrolls.
- `asideFirst` puts context above the task on a phone — used where the
  context *is* the decision (a shared link, a payment).

Applied to **seven** routes: pay, dispute, security, verification,
payment methods, the shared deal link, and the link's other states.

### Other system-level changes

| Change | Why |
|---|---|
| `SectionHead` gained `level` | The a11y gate refuses skipped heading levels; asides nest under an `h2` and need `h3`. Size is unchanged — rank is structure, not scale |
| `auditActionLabel` / `auditStateLabel` in `dealPresenter` | One vocabulary for the audit trail, reusing `DEAL_STATE` so the trail and the badge on the same page cannot disagree. Unknown actions are tidied, never dropped |
| Amount grouping on blur in the calculator | `25000` → `25,000` when the field loses focus. Grouping *while* typing fights the caret; grouping when they finish costs nothing and makes the two figures one system |
| Colour discipline on the desk | Age already carries the at-risk signal. Colouring the action too meant two saffron marks per row across fifty rows. Only an **escalation** is coloured now |
| `--w-focus` token | 51rem: a 27.5rem task plus a 20rem aside plus the gutter, and no wider |

---

## 3 · Route coverage

All 28 required surfaces exist and were opened. 23 are in the screenshot
set at both postures; the remainder are refusal and boundary states
covered by the browser gate's assertions.

| # | Surface | Screens |
|---|---|---|
| 1–2 | Landing, calculator → auth handoff | `01-landing`, `02-calculator-usdt` |
| 3 | Login and one-time code | `03-login` |
| 4 | Authenticated home | `10-home` |
| 5 | Deals list, empty and populated | `11-deals-empty`, `28-deals-list` |
| 6 | New deal | `12-new-deal` |
| 7–8 | Shareable link: creator, stranger, corridor | `20`, `21`, `30` |
| 9 | Deal Room, four lifecycle states | `22`, `23`, `25`, `26`, `27`, `31` |
| 10–11 | Payment instructions, confirmation | `24`, `26` |
| 12–13 | Chat, evidence | in `22`–`27`, `81` |
| 14 | Dispute | `40-dispute-form` |
| 15 | RELEASE outcome (receipt) | `27-deal-room-completed` |
| 16 | Rewards, referrals, reputation | `55-rewards` |
| 17 | Notifications | `56-notifications` |
| 18 | Profile and verification | `50`, `51` |
| 19 | Payment methods | `52` |
| 20 | Security, MFA, sessions | `53`, `54` |
| 21 | Help and safety | `57`, `58` |
| 22 | Deal Desk | `70`, `80` |
| 23 | Verification review queue | `71` |
| 24 | Operator case | `72` |
| 27 | Permission refusal | `60-ops-refused` |
| 28 | Not-found / unavailable link | `04-not-found` |

Surfaces 25–26 (risk holds, emergency pause, two-person resume, policy
maker-checker) are exercised **executably** rather than as screenshots:
step 7 of the staging rehearsal drives a real pause, a refused
one-person resume, a second person's approval and the resume.

---

## 4 · State coverage

Every state in the brief is designed deliberately. The ones this pass
changed:

| State | Before | After |
|---|---|---|
| Empty (evidence) | Two stacked dashed boxes, ~340px | One line above one control |
| Empty (operator payment claim) | Untitled grey box | Titled card stating the fact |
| Empty (chat) | Fixed 32rem panel with a 350px void | `max-h`, sizes to content |
| Waiting on the other side | Full-width **disabled button** | A status line — a control that exists only to be unavailable teaches nothing |
| Pending verification | Indistinguishable from "not started" | **In review**, with when it was submitted |
| Rejected verification | — | **Not approved**, with "Submit again" |
| Home, no deals | Headed "Deal rail" | Headed "Get started" |
| Refusals | — | Unchanged: every one is a `Notice` carrying what happened, **what was not changed**, and what to do next |

A generic toast is nowhere the only explanation of a financial state.

---

## 5 · Responsive evidence

Nine widths, sequentially, each on its own page: **360, 375, 390, 430,
768, 1024, 1280, 1440, 1920** across seven surfaces — **63/63**, exit 0.
768 and 1024 are new to the gate and are the two widths where this
layout actually changes.

Beyond horizontal overflow, each width now also **opens a real dialog**
and requires it to fit the window or scroll — a check added after the
defect in §6.

---

## 6 · Genuine defects discovered

### A tall dialog hung off the bottom of the screen — **fixed**

Found by driving the payment-method form at 1280×900. `.sheet` is centred
with `translate(-50%, -50%)`; its animation was `rise`, which ends at
`transform: none`, and `animation-fill-mode: both` made that final value
**permanent**. Measured: the dialog spanned 450→1136 in a 900px window
and could not scroll, because its content fitted its own box. The only
submit button was off-screen.

**Nobody on a laptop could add a way to be paid**, and every tall dialog
was affected — payment methods, disputes, the operator ruling. Fixed with
`@keyframes dialog-in`, the same six-pixel rise expressed as an offset
from the centred position. Guarded at all nine widths.

### The Deal Desk table clipped its action column — **fixed**

`min-w-[64rem]` inside a 1040px content area at 1280 overflowed by a few
pixels, and `overflow-x-auto` cut the right-hand **Next action** column —
the one an operator reaches for. Reduced to 56rem.

### `grant-role` silently targeted a hosted database — **fixed**

The screenshot script shelled out to `scripts/grant-role.mjs` without
`DATABASE_URL` set. The CLI fell back to `.env.local`, which points at a
**hosted Neon database**, and attempted to grant an operator role there.
It failed only because the account did not exist on the far side.

Two fixes: the script now names its cluster before anything spawns, and
`grant-role.mjs` **prints the target host on every invocation** —
`⚠ REMOTE database: …` — because a script that grants operator authority
should never leave you guessing which database you are changing. The
credential is never printed.

### A disclosure I removed, and the gate refused — **reverted**

Consolidating the pay screen's two sandbox warnings, I deleted the
caption under the QR code as well. The browser gate failed on
`sandbox handle disclosed honestly`, correctly: the footer says no funds
move anywhere in the product; **that** line says the specific thing
somebody is about to point their bank's camera at cannot reach a bank.
It is restored, with a comment recording why it is not redundant.

This is the one case in the pass where a check refused a visual change.
The check was right and the change was reverted rather than the check
adjusted.

---

## 7 · Accessibility

**70 / 70** across eleven surfaces including the authenticated deal room,
the Deal Desk and a live operator case — `artifacts/accessibility.json`.

Preserved: accessible names, 24px minimum targets, declared language, one
`h1`, no skipped heading levels, labelled fields, visible focus at every
stop, an earned skip-link exemption, reduced motion.

Improved by this pass: `SectionHead` carries a heading level, so the new
asides nest correctly rather than skipping from `h1` to `h2` twice; the
counterparty name in the deal room wraps instead of truncating; a
disabled button was replaced by a status line, removing a focusable
control that could never be operated.

---

## 8 · Performance

**21 / 21**, all measured against the built server. The redesign did not
cost anything measurable:

| | Before this pass | After |
|---|---|---|
| Shared First Load JS | 103 kB | **103 kB** |
| Heaviest route | 134 kB | **134 kB** |
| Landing / login load | 148 / 156 ms | 145 / 156 ms |
| Deal room | 147 ms | 147 ms |
| Deal Desk (203-deal backlog) | 214 ms | 214 ms |
| Desk rows rendered under backlog | 50 | **50** (bound holds) |
| Room messages rendered | 98 | **100** (bound holds) |

`FocusLayout` is a server component and adds nothing to the client
bundle. No animation or component library was added.

---

## 9 · Remaining external limitations

Unchanged by this pass and not fixable in it:

- Five production adapters (value protection, INR rail, USDT rail,
  evidence storage, screening) are unimplemented and probe `false`.
- No mail provider — in production `getEmailDeliveryAdapter()` throws.
- No scheduler calls `/api/worker/tick`, so no deployment's outbox drains.
- Six mandatory production secrets absent; production readiness is
  `false`, which is correct.
- The **Open Graph unfurl carries no image**. The metadata is already
  correct and privacy-bounded — economic terms only, `noindex`, no
  creator name — but a `summary` card without an image is the weakest
  unfurl in WhatsApp and Telegram. Adding a generated image is a real
  improvement I did **not** make in this pass; it is scoped and safe
  (server-only, no client bundle cost, inside the existing disclosure
  boundary) and is the single highest-value remaining item for the
  shared-link experience.
- Two generic three-card grids remain on the landing page. They carry
  distinct meaning rather than filler, so they were left; a stronger
  editorial treatment is available if wanted.
- The environment findings from DEL-10 stand: this checkout's directory
  name contains `#`, which breaks `next build` and `vitest`, so those
  stages run from a byte-identical mirror at a safe path. CI is
  unaffected.

---

## 10 · Artefact paths

| Artefact | Path |
|---|---|
| Screenshots, 68 frames, both postures | `artifacts/uiux/screens/` |
| Screenshot index | `artifacts/uiux/screens/index.json` |
| Visual audit | `artifacts/uiux/visual-audit.md` |
| Browser result | `artifacts/e2e/e2e-results.json` |
| Accessibility result | `artifacts/accessibility.json` |
| Performance result | `artifacts/performance.json` |
| Staging rehearsal | `artifacts/staging-rehearsal.log` |
| Complete gate transcript | `artifacts/gate.log` |
| Build report | `artifacts/build.txt` |
| Route/state matrix | `UI-ROUTE-STATE-MATRIX.md` |
