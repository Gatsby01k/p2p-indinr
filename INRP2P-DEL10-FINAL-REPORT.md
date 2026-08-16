# DEL-10 FINAL — Security, E2E, Product Completion and Release Gate

**Base commit:** `e2c280d7d6a6d0ba19af28b3650049cbfcdc36dc`
**Patch:** `INRP2P-DEL10-REVIEW.patch` — 89 files, verified to apply cleanly to the base commit
**Not committed, not pushed. No DEL-11 created.**

| Gate | Command | Exit | Result |
|---|---|---|---|
| Everything | `npm run gate` | **0** | **20 / 20** |
| Browser, against the built server | `npm run gate:browser` | **0** | **229 / 229** |
| Eleven-step staging rehearsal | `npm run rehearse:staging` | **0** | **33 / 33** |
| Performance budgets | `npm run perf:budget` | **0** | **21 / 21** |

**Artefacts** — `artifacts/gate.log` · `artifacts/e2e/` (34 screenshots +
`e2e-results.json`) · `artifacts/accessibility.json` ·
`artifacts/performance.json` · `artifacts/staging-rehearsal.log` ·
`artifacts/build.txt` · `artifacts/recovery-drill.log` ·
`MIGRATION-CONVERGENCE.json` · `sbom.json`
**Documents** — `UI-ROUTE-STATE-MATRIX.md` · `SECURITY-THREAT-MODEL.md` ·
`BROWSER-GATE-BLOCKER.md` (now a record of four closed blockers)

---

## 1 · What changed since the last report, and why it matters

The last report passed **51 of 62** browser checks and called the release
candidate a fail. Two changes to *how* the gate runs closed the gap and,
in doing so, found three defects that no test in this repository could
have caught.

**The gate stopped using `next dev`.** It now builds the application,
starts an isolated PostgreSQL, runs `next start` on a dedicated port and
drives that. `nextjs-portal`, the dev error overlay, first-request
compilation and the aborted navigations it caused are gone — **by
absence, not by exemption**. `assertNoDevArtefacts` runs on every page
the gate visits and fails the run if any dev scaffolding appears; the
`nextjs-portal` allowance the last run needed does not exist any more.

**The gate got a database of its own,** empty at the start of every run.
This is what exposed the largest defect in the stage: on the shared
development database, every account had been verified long ago by the
integration suite calling `decideVerification` directly. On a fresh one,
nobody could join anything.

---

## 2 · Four defects found by running the real product

Each was a complete, correct, tested server capability that **no person
could reach**. All four are closed; `BROWSER-GATE-BLOCKER.md` has the
detail.

### 2.1 · No verification case could ever be decided

Verification became a reviewed **case** in DEL-03. `decideVerification`
was written and tested. Nothing in the product could call it — no action,
no queue, no screen. Every submitted case stayed `SUBMITTED`,
`identity_verified` was never written, and **every attempt to join a
protected deal was refused, for everybody, permanently.** The core
journey could not be completed by anyone.

Worse, the subject's own screen could not tell them: it rendered only the
boolean, so pressing *Complete this step* produced a page identical to
the one before, and people pressed it again.

**Closed by** `/app/ops/verification` (reviewer queue, mandatory written
reason, no controls at all on one's own case — because the database
refuses a self-decision and a button it will refuse is a lie),
`decideVerificationAction`, an entrance from the Deal Desk for reviewers
only, and a `/app/profile/verification` that says **In review** with when
it was submitted.

### 2.2 · Enrolling a second factor signed you out of the device you used

`confirmMfaEnrolment` bumped the account's session version — right, so no
*other* device inherits the new authority — but it bumped the confirming
session too. The person finished enrolling and landed on a login page,
holding a factor they had never been offered a challenge for.

**Closed by** `bumpSessionVersionIn(tx, userId, keepSessionId)`: every
other session still dies, the device that just proved possession
survives. Exactly the shape `revokeAllSessions` already had for "sign out
my other devices", and covered by tests including one proving a session
id belonging to somebody else cannot be smuggled through the parameter.

### 2.3 · A tall dialog hung off the bottom of the screen

`.sheet` is centred with `translate(-50%, -50%)`. Its animation was
`rise`, which ends at `transform: none`, and `animation-fill-mode: both`
made that permanent. Measured at 1280×900: the dialog spanned 450→1136 in
a 900px window and could not scroll, because its content fitted its own
box. **Nobody on a laptop could add a payment method**, and every tall
dialog was affected.

**Closed by** `@keyframes dialog-in`, the same six-pixel rise expressed as
an offset from the centred position. Guarded at all seven widths by a
check that an open dialog must fit the window or scroll.

### 2.4 · The MFA return did not land where it said

Answering the factor for a route you were refused used
`router.replace(next)`. Answering a second factor **changes the authority
of the session**, so every RSC payload the client router holds — starting
with the 403 for the very route being returned to — was rendered for the
session as it was before. The router could put the old refusal back, or
settle the new tree under the old URL.

**Closed by** a full document load to the validated same-origin path,
after the definitive result has settled into client state. The gate
asserts all four parts of the contract separately: the challenge
succeeded, the URL is **exactly** `/app/ops`, a Deal-Desk-specific
control is present, the 403 is gone, and no Security subtree survives.

---

## 3 · The browser gate — 229 / 229, exit 0

`node scripts/browser-gate.mjs` → build · isolated PostgreSQL ·
`next start` · headless Chrome. It waits for **readiness**, not for a
socket, and refuses to start on an occupied port.

| Area | Result |
|---|---|
| Verification review (reviewer, separation, refusal for a non-reviewer) | 8 / 8 |
| No development scaffolding in the DOM | 17 / 17 |
| Authentication | 3 / 3 |
| Calculator handoff | 5 / 5 |
| INR → INR full journey | 14 / 14 |
| INR → USDT corridor | 9 / 9 |
| USDT → INR corridor | 9 / 9 |
| Concurrency (duplicate join) | 3 / 3 |
| Operator MFA and the return contract | 22 / 22 |
| Telegram initData | 4 / 4 |
| Responsive, 7 widths × 7 surfaces | 49 / 49 |
| Accessibility, 11 surfaces | 70 / 70 |
| Performance, quiet and under backlog | 16 / 16 |

**Every journey walks the whole path a person walks:** sign in with a code
read from the sandbox mailbox, submit the three verification steps, have
a *different* person approve them, add a way to be paid, create, join,
pay, confirm. Nothing is seeded. The one out-of-band step — granting an
operator role — goes through `scripts/grant-role.mjs`, the same CLI an
administrator uses, and the gate asserts that doing so **ends the
operator's live session**.

### Harness faults found and fixed, separately from product faults

The last report attributed several failures to the product. They were the
harness, and each is now impossible rather than merely fixed:

- **Sign-in codes never arrived.** The gate ran the harness with a
  blocking `spawnSync` while owning the server's stdout *pipe*, so every
  code sat in a buffer until teardown. The log is now a file descriptor
  handed to the child; nothing this process does can delay it.
- **A partially written log line** satisfied "a new code appeared" and
  then yielded no code. The pattern now spans the address *and* the
  digits.
- **Typing that beat hydration.** A built server delivers the document in
  milliseconds, so text landed in the DOM while React's state stayed
  empty and the submit button never enabled. `typeInto` now retries until
  a named control actually goes live.
- **The claim was never submitted.** The old harness clicked *I have
  paid*, which only opens a confirmation sheet, then read a URL it was
  already on. Two controls, two clicks, and the wait is on the room
  reporting `FIAT_CLAIMED`.
- **`USDT_TO_INR` used an INR amount for a USDT leg** — 83,000 USDT, ≈₹73.7
  lakh — and the product correctly refused it as over the per-deal limit.
- **The paying side flips per corridor.** Selling USDT, the *joiner*
  pays. The harness assumed the creator always does and then waited on
  `has-text("Pay")`, which matched the disabled *"Waiting for payment"*
  button the receiving side is correctly shown. The payer is now found by
  the control the server chose to render.
- **A refusal read from the first 400 characters of the page** cut off
  before the sentence it was checking for. Refusals are now read from the
  `Notice`.

---

## 4 · Accessibility — 70 / 70 against the production server

`artifacts/accessibility.json`. Release-blocking rules only, on eleven
surfaces including **authenticated and operator** ones: landing, login,
home, deals, **deal room**, new deal, security, notifications, help,
**Deal Desk**, **one operator case**.

Two genuine target-size failures were found and fixed; both are 24 px
now, and neither moved anything:

| Control | Was | Fix |
|---|---|---|
| `View all` on the home screen | 61 × 18 | `min-h-6` with a matching negative margin, so the row keeps its height and the baseline does not move |
| `Open rewards` chevron in the deal room | 19 × 19 | `min-h-6 min-w-6` centred, `-m-1` to keep the row |
| `Back to the desk` on an operator case | 368 × 20 | `min-h-6` |

The skip link keeps its exemption while visually hidden, and the
exemption is **earned**: focused, it must measure ≥ 24 px, and it does
(120 × 35).

---

## 5 · Responsive — 49 / 49

Seven widths (360, 375, 390, 430, 1280, 1440, 1920) × seven surfaces,
**sequentially**, each on its own page closed before the next opens — so a
navigation cancelled by the next width cannot be reported as an abort
against the route it was leaving. Every navigation has a bounded timeout
and one retry; anything still failing is a finding.

A horizontal-overflow failure now names the widest offending element
rather than reporting a number. And because the dialog defect in §2.3 was
**vertical**, each width also opens a real dialog and requires it to fit
the window or scroll.

---

## 6 · Pagination and performance budgets — CI-enforced

### Two unbounded queries, closed

**The Deal Desk** selected every open deal on the platform — *twice* per
render, once to count and once to filter — and rendered every row. It was
slowest exactly when it was busiest. It is now one bounded page of 50,
filtered and ordered in the database, with the page size clamped so a
query string cannot widen it, and **exact** counts from a
`count(*) FILTER` so an operator still sees that there are 203 open deals
while looking at 50 of them. A pager makes the rest reachable.

**The deal room** rendered the entire transcript. Two people arguing
about a payment can exchange hundreds of messages, so the room got slower
the longer a dispute ran. It is now the most recent 100 — and it **says
so** when trimmed, because both sides read that thread as evidence.

### The budgets

`scripts/performance-budget.mjs`, measured against the built server. Two
kinds, and the second is the one that matters:

| Latency and weight | Measured | Budget |
|---|---|---|
| Shared First Load JS | 103 kB | 130 kB |
| Heaviest route (`/app/deal/[dealId]`) | 134 kB | 170 kB |
| Landing / login load | 148 / 156 ms | 900 ms |
| Landing / login CLS | 0 / 0 | 0.1 |
| Quote recompute | 72 ms | 500 ms |
| Deals list · deal room | 144 · 147 ms | 900 ms |
| Deal Desk · filtered · one case | 150 · 166 · 143 ms | 900 ms |
| **Deal Desk under a 203-deal backlog** | 483 ms | 1500 ms |
| **Filtered, under backlog** | 287 ms | 1500 ms |
| **Second page of the desk** | 217 ms | 1500 ms |
| **Deal room with a full transcript** | 263 ms | 1500 ms |

| Shape — what the page *rendered* | Measured | Budget |
|---|---|---|
| Desk rows under a 203-deal backlog | 50 | 50 |
| Room messages with 140 seeded | 98 | 100 |
| Backlog the shape budgets were measured against | 203 | ≥ 100 (floor) |

A latency budget on a fast machine can stay green through the exact
regression it exists to catch. **The shape budgets cannot be satisfied by
a faster CPU**, and the backlog floor stops them passing trivially
against an empty queue.

`largestRouteKb` also had a real bug: the route-table regex omitted `┌`,
so the **first** route in the report — the landing page, the one most
people hit — was silently excluded from "heaviest route".

**Enforcement.** Weight budgets run in CI's build job
(`--bundle-only`, no browser needed). The pagination invariants run in
CI's integration job (`tests/integration/deskPagination.test.ts`). A
`browser` job runs the whole gate and then every budget. ⚠ **That CI job
has not been executed on a GitHub runner from here** — it is written
against `ubuntu-latest`'s preinstalled Chrome and reviewed, not observed.
The same commands are what produced every number above locally.

---

## 7 · The eleven-step staging rehearsal — 33 / 33, exit 0

`node scripts/staging-rehearsal.mjs` · transcript in
`artifacts/staging-rehearsal.log`. Its own cluster, its own port, its own
per-run scheduler credential.

| # | Step | What it proves |
|---|---|---|
| 1 | Least-privilege roles | Four runtime roles exist, none is a superuser, may create roles or bypasses RLS; a password under 24 characters is **refused** |
| 2 | Configuration | Staging validates; production with nothing set **refuses and names every missing variable**; no value reaches the verdict |
| 3 | Convergent migration | Empty, DEL-05 and DEL-09 populations converge on one schema at v15, one checksum |
| 4 | Web and worker startup | The built artefact serves; the scheduler endpoint refuses an unauthenticated caller and the wrong credential, and runs a pass with the right one |
| 5 | Readiness | Liveness green and readiness `{ready:true}` with **no detail**; kill the database — liveness stays green, readiness goes **503**; restore it and readiness recovers **without a restart** |
| 6 | Full sandbox E2E | **229 / 229** browser checks against the rehearsal server |
| 7 | Pause / resume | One operator pauses; the **same** operator cannot resume (`APPROVAL_REQUIRED`); propose, a second person approves, resume succeeds |
| 8 | Backup / restore | An admin funds the ledger and a participant locks value first, so the drill has something to verify; the restored copy balances per asset, every entry keeps both legs, history is still immutable |
| 9 | Adapter failure | A genuine production-mode process comes up, serves **503** with `{"ready":false}` and nothing else, while liveness stays green — a restart would not help |
| 10 | Worker crash recovery | A lease orphaned by a dead worker is recovered and the event delivered, both directly and through the scheduler endpoint |
| 11 | Application-code rollback | The process is replaced against the **same** database; readiness returns, the schema version and checksum are unchanged, and 110 audit events written before the rollback are still there |

Steps 5, 7, 9 and 10 assert the **refusal** as well as the success. A
rehearsal that only ever does the allowed thing cannot tell a working
control from an absent one.

### Two things the rehearsal needed that did not exist

- **`/api/health/live` and `/api/health/ready`.** `docs/ops/RUNBOOKS.md`
  §1 has told operators to `GET /api/health/ready` since DEL-09 and
  neither endpoint existed — the runbook's first instruction could not be
  carried out. The public body is `{ ready }` and nothing else; the
  itemised view needs `ops.queue.read`.
- **`/api/worker/tick`.** The outbox worker is one-shot by design and the
  runbook says the scheduler is an external readiness dependency — but
  nothing exposed it, so no deployment's outbox would ever drain.
  Authenticated by a bearer secret compared in constant time, **failing
  closed** when unset, and it recovers lapsed leases before every pass.

---

## 8 · Migration-path convergence — unchanged, still proven

Accepted in the previous report and re-run in every gate since. Three
independently built populations — empty → head, populated DEL-05 → head
crossing the edited `0010`, and populated DEL-09 with the **original**
`0010` taken from the baseline commit — converge on one schema at v15
with one checksum. The script asserts the divergence **exists** on path C
before `0015` repairs it, so the proof is not hollow. `0015` reads
`pg_get_constraintdef`, is idempotent, and touches no rows.

---

## 9 · Complete gate — 20 / 20, exit 0

`npm run gate` · transcript in `artifacts/gate.log`.

| Gate | Exit | Result |
|---|---|---|
| format · lint · types | 0 | clean |
| unit tests | 0 | **205 / 205** |
| coverage manifest · outbox manifest · mutation surface | 0 | 16 / 16 · 33 / 33 · 36 gated entry points |
| secret scan · schema check · boundary contracts | 0 | clean |
| integration tests | 0 | **656 / 656** across 29 files |
| migration convergence | 0 | three paths, one checksum |
| upgrade drill from the DEL-08 baseline | 0 | passed |
| recovery drill | 0 | `"passed": true` |
| `npm audit --omit=dev` · full | 0 | **0 vulnerabilities** |
| SBOM | 0 | 648 components |
| browser gate against the built server | 0 | **229 / 229** |
| performance budgets | 0 | **21 / 21** |
| eleven-step staging rehearsal | 0 | **33 / 33** |

New tests added this pass: `tests/integration/verificationQueue.test.ts`
(9 — the reviewer queue, reviewer separation, and the session that must
survive enrolment), `tests/integration/deskPagination.test.ts` (7 — the
page is bounded, the counts are not, and a caller cannot widen it), and
`tests/rehearsal/` (5).

---

## 10 · Two environment findings, stated plainly

Neither is a defect in this application, and both would mislead a reader
who tried to reproduce the gate here.

**This checkout's directory name contains `#`.** Both `next build`
(through `@vercel/nft`) and `vitest` (through `vite-node`) corrupt a path
containing one:

```
TypeError: The argument 'path' must be a string, Uint8Array, or URL
without null bytes. Received '…/inrp2p \x00#1 fintech india/node_modules/…'
```

Reproducible, in vendored tooling, and gone one directory up. Those
stages therefore run from a byte-identical mirror at a `#`-free path,
made with APFS clones. **On any ordinary checkout — CI included —
`buildRoot()` is the project itself and nothing is copied.** The
application, the build output and the served artefact are the same
either way.

**`.env.local` points `DATABASE_URL` at a hosted Neon database.** Every
gate and drill overrides it explicitly, and `scripts/db.mjs` **refused**
to start, stop or reset when it leaked through during one manual
invocation — which is the guard working. Worth knowing before running
anything here by hand.

---

## 11 · Production-adapter matrix — unchanged

| Adapter | Implemented | Production probe |
|---|---|---|
| Value protection · INR rail · USDT rail · Evidence storage · Screening | **No** | `false` |
| Email delivery | Sandbox only — **throws** in production | n/a |

Six mandatory production secrets absent. Production readiness is `false`,
and step 9 of the rehearsal now *demonstrates* that rather than asserting
it: a real production-mode process comes up and serves 503.

---

## 12 · Remaining blockers

**Code** — none. Every DEL-10 requirement is met and executable. The one
piece of evidence I cannot produce from here is the CI `browser` job
running on a GitHub runner (§6).

**External provider** — five adapters, a mail provider, a scheduler to
call `/api/worker/tick`, an alert destination, a CDN/edge rate limit.

**Legal** — licensing, regulatory and privacy approval; a KYC/AML
programme; an external penetration test.

**Operational** — production secrets, activated production fee and risk
policies, a backup destination and retention policy, log retention,
out-of-band operator grants.

---

## 13 · Verdicts

### `CODE RELEASE CANDIDATE: PASS`

Every gate exits 0. Every browser journey completes through the rendered
application against the built server, including the two that were blocked
and the four that were failing. The eleven-step rehearsal runs and
passes, refusals included. The three deliverables that were missing —
the route/state matrix, CI-enforced pagination and performance budgets,
and the executable rehearsal — exist and are exercised.

I am passing this where the last report failed it, and the reason is
specific: the evidence that was missing is now present, and it was
productive exactly as predicted. Running the built product against a
database with no history in it found three defects that made the core
journey impossible for every user — none of which any test in this
repository could see, because the tests had verified the fixtures
themselves.

The qualification I will not drop: this is a **sandbox** release
candidate. It moves no money and touches no real customer data.

### `STAGING READY: PASS`

Unconditionally, on the evidence above: the rehearsal is the staging
sign-off, it runs in 182 seconds, and it exits 0. Sandbox adapters only,
no real funds, no real customer data.

### `PRODUCTION GO-LIVE: FAIL`

Correctly, and not to be softened:

- All five mandatory adapters probe `false`; none is implemented.
- Six mandatory production secrets are absent.
- No mail provider — in production `getEmailDeliveryAdapter()` throws, so
  no sign-in code is minted and nobody can authenticate.
- No production fee or risk policy is activated.
- No scheduler is calling `/api/worker/tick`, so no outbox would drain.

The product's own answer to "may this take traffic?" in production is
`false`, and step 9 of the rehearsal demonstrates it. That is the right
answer and it should stay that way until the items above are real.
