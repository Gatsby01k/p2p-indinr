# UI route and state matrix

Every route this application serves, what a person can do on each, which
boundary catches a failure, and what the screen says in each of the four
states a screen can be in.

**How to read the four states.** They are not decoration; they are the
four things that can be true after a person acts, and the fourth is the
one most products get wrong.

| State | What it means | The rule this product follows |
|---|---|---|
| **Loading** | The data has not arrived | A skeleton shaped like the screen it replaces, `aria-busy`, one live "Loading" for a screen reader. A skeleton whose geometry is wrong is worse than a spinner. |
| **Success** | The server committed | The screen re-renders from the server's own view of the deal, never from an optimistic guess about what the mutation did. |
| **Rejection** | The server decided **no**, and said why | A named `SandboxError`, rendered as a `Notice`: what happened, **what was not changed**, and what to do next. Never "something went wrong". |
| **Unknown** | The server **did not answer** | Treated as *possibly committed*. The command id is **kept**, so the retry replays rather than acting twice — `isDefinitiveOutcome` in `src/lib/commandId.ts`. This is the only state where the interface must not claim to know anything. |

Rejection copy comes from one table — `FAILURE_COPY` in
`src/lib/sandboxContract.ts`, 56 named codes — so the same refusal reads
the same wherever it surfaces. A screen never invents copy for a code the
server named.

---

## Boundaries

Next.js file-convention boundaries actually present in the tree. A route
inherits the nearest one above it.

| Boundary | Scope | What it does |
|---|---|---|
| `src/app/error.tsx` | Everything | "This screen could not be displayed." States plainly that it is a **display** failure, not a transaction failure, and that nothing was created, changed or completed. Offers retry. |
| `src/app/app/error.tsx` | The authenticated app | Same statement, but **inside the shell** — header, navigation and Sign out survive, so somebody whose deal room failed can still reach their other deals. |
| `src/app/not-found.tsx` | Everything | An unknown address. No hint about whether the resource exists for somebody else. |
| `src/app/app/not-found.tsx` | The authenticated app | Same, in the shell. |
| `src/app/app/loading.tsx` | The authenticated app | Skeleton shell: header, intents, card grid. |
| `src/app/app/deal/[dealId]/loading.tsx` | One deal room | Skeleton in the room's three-column geometry. |
| `src/app/d/[publicId]/loading.tsx` | A shared link | Skeleton in the link page's geometry. |

Two further boundaries are **authorization**, not error handling, and they
render instead of the page rather than around it: `[data-testid="access-denied"]`
on `/app/ops`, `/app/ops/[dealId]` and `/app/ops/verification`, which is a
403 rendered *before any privileged data is read*, so a denied response
never contained it.

---

## Public routes

### `/` — the calculator and landing page

| | |
|---|---|
| **Controls** | Corridor radio group (`Protected payment`, `Buy USDT`, `Sell USDT`), amount field, `Protect …` submit, skip link, help and sign-in links |
| **Boundary** | `src/app/error.tsx` |
| **Loading** | Server-rendered; the quote recomputes client-side with no intermediate spinner (measured at 84 ms) |
| **Success** | Quote shown with the fee disclosed **before** commitment, the USDT network named (TRC-20), and the words "not a quote" — submitting carries the amount to `/login?next=…` |
| **Rejection** | An amount outside `MIN_INR_MINOR…MAX_INR_MINOR` is refused inline (`AMOUNT_TOO_SMALL`, `AMOUNT_TOO_LARGE`); an unavailable corridor renders `SCENARIO_UNAVAILABLE` rather than a dead button |
| **Unknown** | Not reachable — nothing here mutates |

### `/login` — email code sign-in

| | |
|---|---|
| **Controls** | Email field, `Email me a code`, code field, `Sign in`, `Use a different address` |
| **Boundary** | `src/app/error.tsx` |
| **Loading** | Buttons become `Sending…` / `Checking…` and are disabled while the transition is in flight |
| **Success** | Router pushes the validated `next` path; the session cookie is HTTP-only |
| **Rejection** | `AUTH_EMAIL_INVALID`, `AUTH_CHALLENGE_INVALID`, `RATE_LIMITED`. **The "code sent" screen is shown whether or not the address is known** — the server answers identically either way, so the screen cannot become an enumeration oracle |
| **Unknown** | The code is not consumed; the person may request a fresh one. A code is single-use, enforced by a conditional `UPDATE`, so a double submit cannot produce two sessions |

### `/d/[publicId]` — a shared deal link

| | |
|---|---|
| **Controls** | Consent checkbox, `Join protected deal` (`[data-testid="join-button"]`), `Sign in to join` when signed out, `Protection terms` |
| **Boundary** | `src/app/error.tsx`; `src/app/d/[publicId]/loading.tsx` |
| **Loading** | Link-page skeleton |
| **Success** | Router pushes `/app/deal/<uuid>`; the room renders with `[data-deal-room]` carrying the committed state and the viewer's seat |
| **Rejection** | `LINK_CONSUMED` ("Someone joined first"), `LINK_EXPIRED`, `LINK_CLOSED`, `CANNOT_JOIN_OWN_LINK`, `REQUIRES_VERIFICATION`. Each carries **"Nothing was charged to you"** — a refusal that leaves somebody wondering whether they paid is not a refusal |
| **Unknown** | The command id is kept; a retry replays. `UNIQUE(deal.link_id)` means a replayed Join cannot seat two people |

---

## Authenticated routes

### `/app` and `/app/deals` — home and the deal list

| | |
|---|---|
| **Controls** | Intent tiles, `View all` (24 px minimum target), deal cards, tab bar |
| **Boundary** | `src/app/app/error.tsx`; `src/app/app/loading.tsx` |
| **Loading** | Card-grid skeleton |
| **Success** | Deals grouped by whose move it is |
| **Rejection** | Unauthenticated is a redirect to `/login?next=…`, not an error |
| **Unknown** | Read-only |

### `/app/new` — create a protected deal

| | |
|---|---|
| **Controls** | Corridor, amount, title, `Review deal`, `Protect ₹…` (`[data-testid="secure-submit"]`) |
| **Boundary** | `src/app/app/error.tsx` |
| **Loading** | Submit disabled with a spinner |
| **Success** | Redirect to `/d/INRP-…`, the shareable link |
| **Rejection** | `AMOUNT_TOO_LARGE` above the per-deal limit (with "No deal was created and no rate was locked"), `QUOTE_EXPIRED`, `FEE_EXCEEDS_AMOUNT`, `SCENARIO_UNAVAILABLE`, `ADAPTER_UNAVAILABLE` |
| **Unknown** | Command id kept. `feeBearer` is **server** policy and is not a form field, so a replay cannot alter an economic term |

### `/app/deal/[dealId]` — the deal room

| | |
|---|---|
| **Controls** | `Pay …` (payer only), `Confirm … received` (`[data-testid="confirm-open"]` → `confirm-submit`), `Report a problem`, `Cancel deal`, message composer, evidence upload, copy-deal-code |
| **Boundary** | `src/app/app/error.tsx`; `src/app/app/deal/[dealId]/loading.tsx` |
| **Loading** | Three-column skeleton |
| **Success** | `[data-deal-room]` re-renders with `data-deal-state` and `data-viewer-role` from the server; `COMPLETED` replaces the workspace with a receipt |
| **Rejection** | `NOT_A_PARTICIPANT` (a deal id grants nothing), `NOT_FIAT_SIDE`, `NOT_CRYPTO_SIDE`, `SELF_CONFIRM_FORBIDDEN`, `ALREADY_CLAIMED`, `NOT_CLAIMED_YET`, `DEAL_TERMINAL`, `DEAL_DISPUTED` |
| **Unknown** | Command id kept for confirm and cancel; both are keyed server-side |
| **Bounded** | The transcript renders at most **100** messages, newest first, and says so when trimmed (`[data-testid="transcript-truncated"]`) — a silently trimmed record is a record nobody can trust |

### `/app/deal/[dealId]/pay` — payment instructions

| | |
|---|---|
| **Controls** | Copy UPI ID / account / IFSC, UTR field, note, `I have paid …` (`claim-open` → `claim-submit`) |
| **Boundary** | `src/app/app/error.tsx` |
| **Loading** | Submit disabled with `Submitting…` |
| **Success** | Back to the room in `FIAT_CLAIMED` |
| **Rejection** | `UTR_INVALID`, `UTR_ALREADY_USED` (platform-wide `UNIQUE`), `VALUE_NOT_LOCKED`, `ALREADY_CLAIMED`. **Two distinct absences are told apart**: "this person has not added a way to be paid yet" versus "nothing is locked against this deal" — telling somebody to chase a handle when the truth is that nothing is protected would send them to transfer money against nothing |
| **Unknown** | Command id kept. `UNIQUE(utr)` means a replay cannot claim twice |
| **Note** | A non-payer is redirected to the room rather than shown a form whose submission would be refused |

### `/app/deal/[dealId]/dispute` — report a problem

| | |
|---|---|
| **Controls** | Reason radio group, statement, evidence attach, `dispute-open` → `dispute-submit` |
| **Boundary** | `src/app/app/error.tsx` |
| **Loading** | Submit disabled |
| **Success** | Room re-renders in `DISPUTED`; release is paused until an operator rules |
| **Rejection** | `ALREADY_DISPUTED`, `DEAL_TERMINAL`, `WINDOW_LAPSED`, `EVIDENCE_TOO_LARGE`, `EVIDENCE_TYPE_REJECTED` |
| **Unknown** | Command id kept |

### `/app/profile/verification` — onboarding

| | |
|---|---|
| **Controls** | `Submit this step` / `Submit again` per step |
| **Boundary** | `src/app/app/error.tsx` |
| **Loading** | Button spinner |
| **Success** | The step shows **In review** with when it was submitted — *not* a tick. Approval is somebody else's decision |
| **Rejection** | A decided-against case shows **Not approved** and offers `Submit again` |
| **Unknown** | A second submission joins the open case by design, so a retry cannot create a queue of duplicates |
| **Note** | This screen previously showed only the boolean. A person who pressed the button saw a page identical to the one before they pressed it, so they pressed it again. |

### `/app/profile/payment-methods`

| | |
|---|---|
| **Controls** | `Add a payment method` → sheet (type radio, label, handle, bank, IFSC), `Save payment method`, make default, remove |
| **Boundary** | `src/app/app/error.tsx` |
| **Loading** | `Saving…` |
| **Success** | Method listed; the first one added becomes the default, because a payment screen with no default is a dead end |
| **Rejection** | Malformed UPI, account number or IFSC, and an invalid TRC-20 address, each named. **No credential is accepted anywhere**: there is no PIN, CVV or password field, and the schema has no column that could hold one |
| **Unknown** | Re-submitting adds a second method rather than corrupting the first |

### `/app/settings/security` — the second factor

| | |
|---|---|
| **Controls** | `Set up an authenticator app` (`mfa-begin`) → QR + secret + recovery codes → code field → `Confirm and enrol` (`mfa-confirm`); `Answer your second factor` (`mfa-verify`); `Use a recovery code`; `Replace the authenticator app`; `Sign out` |
| **Boundary** | `src/app/app/error.tsx` |
| **Loading** | `Preparing…` / `Checking…` |
| **Success** | Enrolment confirms, then the **document reloads**: the account's authority changed, so every payload the client router holds was rendered for an account without a factor. Answering the challenge with a validated same-origin `next` **replaces** the document at that exact path |
| **Rejection** | `MFA_INVALID` (including a replayed code inside its own window), `MFA_NOT_ENROLLED`, `RATE_LIMITED` |
| **Unknown** | The result settles into client state **before** anything navigates, so a failed presentation render can never swallow a confirmed enrolment — or lose the one-time secret with it |
| **Secret handling** | The TOTP secret exists in one component's state for the seconds between enrolling and confirming. Never in a URL, never in `localStorage` or `sessionStorage`, never logged, never in an audit detail or outbox payload. The QR is encoded **in the browser** so the `otpauth://` URI never reaches an RSC payload |

### `/app/settings`, `/app/settings/diagnostics`, `/app/notifications`, `/app/rewards`, `/app/profile`, `/app/help`

| | |
|---|---|
| **Controls** | Navigation rows, notification `Mark all read`, profile form, notification-preference switches |
| **Boundary** | `src/app/app/error.tsx` |
| **Loading** | Shell skeleton |
| **Success** | Toast plus a refresh, so the screen shows what happened rather than what was hoped for |
| **Rejection** | The failure toast carries the **server's** message; it never invents copy |
| **Unknown** | These mutations are preferences, not money; a retry is harmless |

---

## Operator routes

All three render a **403 instead of the page** when the caller lacks the
permission, a confirmed factor, or a satisfied one — and the three
reasons are told apart, because "you have no permission", "you need an
authenticator" and "answer it on this device" need three different next
steps.

### `/app/ops` — the Deal Desk

| | |
|---|---|
| **Controls** | Five view tabs, `Verification review` (reviewers only), case links, `Previous` / `Next` (`[data-testid="desk-pager"]`) |
| **Boundary** | `src/app/app/error.tsx`; 403 via `[data-testid="access-denied"]` |
| **Loading** | Shell skeleton |
| **Success** | One **bounded page of 50** rows with the exact total beside it ("Showing 50 of 203"), escalations first then oldest |
| **Rejection** | `PERMISSION_DENIED`, `MFA_NOT_ENROLLED`, `MFA_REQUIRED` — each with its own next step, and **the queue is never fetched**, so a denied response never contained operator data |
| **Unknown** | Read-only |
| **Disclosure** | Parties and amounts, because triage needs both. No email address, bank handle, wallet address or payment reference |

### `/app/ops/[dealId]` — one case

| | |
|---|---|
| **Controls** | Evidence links, `Release` / `Refund` / `Cancel` with a mandatory written reason, `Back to the desk` |
| **Boundary** | 403 as above |
| **Loading** | Shell skeleton |
| **Success** | The ruling applies and the reason is shown to **both** sides — operators are told that here, not after the fact |
| **Rejection** | `DEAL_TERMINAL`, `REVIEWER_CONFLICT`, `STATEMENT_TOO_SHORT`, `APPROVAL_REQUIRED` |
| **Unknown** | Command id kept; the ruling is anchored to a case **version**, so a stale replay is refused rather than applied twice |
| **Disclosure** | The product's widest. Available only for a genuinely blocked deal, and opening one writes `OPERATOR_CASE_OPEN` to the audit trail |

### `/app/ops/verification` — the reviewer queue

| | |
|---|---|
| **Controls** | Reason textarea, `Approve` (`verification-approve`), `Reject` (`verification-reject`) per case |
| **Boundary** | 403 as above, on `verification.review` |
| **Loading** | Shell skeleton |
| **Success** | Toast, then the row leaves the queue and the subject's badge follows the decision |
| **Rejection** | `PERMISSION_DENIED`; a reason under eight characters is refused by the server whatever the screen does; `REVIEWER_CONFLICT` for one's own case — which is shown **with no controls at all**, because offering a button the database will refuse is a lie about what is possible |
| **Unknown** | The toast settles from the definitive result before the refresh |
| **Note** | This screen did not exist. `decideVerification` was implemented and tested from DEL-03 and nothing could reach it, so no case was ever decided, no account was ever verified, and **no protected deal could be joined by anybody**. |

---

## API routes

| Route | Method | Authentication | Success | Rejection |
|---|---|---|---|---|
| `/api/health/live` | GET | None | `{ alive, version }`. Never touches the database — a slow query must not get a healthy process restart-looped | — |
| `/api/health/ready` | GET | None for the boolean; `ops.queue.read` for detail | `{ ready: true }`, or the itemised checks for an authorised operator | `503 { ready: false }` and **nothing else** — a readiness endpoint is reachable by anyone, and a detailed one is a free reconnaissance report |
| `/api/telegram/auth` | POST | HMAC over `initData`, keyed by the bot token | Session cookie (`SameSite=None; Secure` for the Mini App iframe) | 400/401/503 with a reason code: malformed, bad signature, stale, replayed, or no bot token configured |
| `/api/evidence/[evidenceId]` | GET | Session + a seat in the deal, or `case.evidence.read` | The bytes | 403/404 without revealing whether the file exists |
| `/api/worker/tick` | POST | Bearer `WORKER_TICK_SECRET`, constant-time | `{ recovered, claimed, delivered, retried, deadLettered, unsupported }` | `401` with no detail; `503` when the credential is unset, so a deployment that forgot it exposes no lever |

---

## What is enforced rather than described

| Claim in this document | Where it fails if it stops being true |
|---|---|
| Every route renders without dev scaffolding | `assertNoDevArtefacts`, asserted on every page the browser gate visits |
| Every interactive control is ≥ 24 × 24 px and has an accessible name | `scripts/e2e/a11y.mjs`, run on 11 surfaces including the authenticated Deal Room, the operator desk and one operator case |
| No route overflows horizontally at seven widths, and dialogs fit the window | Browser gate section 8, 360–1920 px |
| The Deal Desk renders at most one page | `opsQueueRenderedRows` shape budget, measured under a 203-deal backlog, plus `tests/integration/deskPagination.test.ts` |
| The deal room renders at most one page of transcript | `dealRoomRenderedMessages` shape budget |
| A 403 contains no operator data | Browser gate section 6 |
| The MFA return lands on the exact path with a role-specific control and no stale Security tree | Browser gate section 6, four separate assertions |
| Refusal copy comes from one table | `FAILURE_COPY`, and `tests/integration/rejectionAudit.test.ts` |
| No interface file reaches past the service boundary | `tests/serviceBoundary.test.ts` |
| Only the QR encoders set raw HTML | `tests/webSecurity.test.ts` |
