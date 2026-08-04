# INRP2P — Part C: Frontend implementation evidence

All ten requested items. Where something could not be verified, this file says
so plainly rather than describing intent as result.

**Nothing was committed. Nothing was pushed.** The repository had **no git
history at all** when this pass began; `git init` was run solely to produce
items 3 and 4, and files were staged with `git add -A -N` (intent-to-add only).
There is no commit, no branch, no remote, no push.

---

## 1. Revised `docs/product/UX-01.md`

Version 1.1. Design direction, route map, copy voice, layout and accessibility
floor are unchanged. Three safety boundaries were added as **§2**, numbered to
match the `UX-01 §2.1` references already present in the source:

| Section | Requirement |
|---|---|
| **§2.1 Scenario isolation** | `?scenario=` and synthetic `publicId` suffixes are a build-time capability, permitted only in mock/development/test/Storybook. Hard-disabled in production **regardless of the opt-in flag**. They may never override a real deal, real SSR output, Open Graph metadata, authorization, available actions, deal state or funds-location presentation. A production URL cannot fake `completed`, `refunded`, `disputed`, `verification required` or any other state. |
| **§2.2 Presentation versus authority** | `dealPresentation.ts` centralizes wording only and must not become a client-side state machine. TS-03 stays authoritative for canonical state, obligations, allowed actions, cancel/dispute availability, funds location, deadlines and authorization. A disabled button is a courtesy, not a guard; a timer is cosmetic; a cached response is not truth. |
| **§2.3 Preserved pre-auth intent** | Direction, amount and destination intent may survive authentication. An indicative rate may not become binding, and client-carried economics are never authoritative — the server issues or validates a **fresh firm quote before MOVE**. Public OG metadata excludes identities, bank instructions, wallet addresses, payment proof and private deal evidence. |

§6 was also corrected: it previously implied scenario URLs were universally
reachable.

## 2. Revised `docs/specs/TS-02.md`

Complete replacement, v2.0, 3,272 lines. All nine corrections addressed — see
TS-02 §0 for the defect-by-defect disposition, and §12 for what is and is not
verified.

## 3. `git diff --stat`

Against the empty tree, since there was no prior history.

```
 .gitignore                                    |   11 +
 .prettierrc.json                              |    8 +
 docs/evidence/SCREEN-EVIDENCE.md              |  139 ++
 docs/product/UX-01.md                         |  213 ++
 docs/specs/TS-01.4.md                         | 2764 +++++++++++++++++++++
 docs/specs/TS-02-ANNEX-M.md                   |  651 +++++
 docs/specs/TS-02.md                           | 3272 +++++++++++++++++++++++++
 eslint.config.mjs                             |   23 +
 next.config.ts                                |   22 +
 package.json                                  |   44 +
 postcss.config.mjs                            |    7 +
 public/icon.svg                               |    5 +
 public/manifest.webmanifest                   |   20 +
 scripts/boundary-contracts.mjs                |  138 ++
 scripts/check-schema.mjs                      |  240 ++
 scripts/coverage-manifest.mjs                 |  428 ++++
 scripts/screen-evidence.ts                    |  208 ++
 scripts/verify-offline.sh                     |   47 +
 src/app/app/deal/[dealId]/page.tsx            |   10 +
 src/app/app/history/page.tsx                  |   51 +
 src/app/app/layout.tsx                        |    6 +
 src/app/app/new/page.tsx                      |   20 +
 src/app/app/notifications/page.tsx            |  108 +
 src/app/app/ops/page.tsx                      |   88 +
 src/app/app/page.tsx                          |   83 +
 src/app/app/settings/page.tsx                 |  138 ++
 src/app/d/[publicId]/page.tsx                 |   59 +
 src/app/error.tsx                             |   33 +
 src/app/globals.css                           |  144 ++
 src/app/layout.tsx                            |   46 +
 src/app/loading.tsx                           |   11 +
 src/app/login/page.tsx                        |   29 +
 src/app/not-found.tsx                         |   23 +
 src/app/page.tsx                              |  141 ++
 src/app/register/page.tsx                     |   29 +
 src/components/auth/AuthForm.tsx              |  179 ++
 src/components/brand/KineticWheel.tsx         |   76 +
 src/components/brand/Wordmark.tsx             |   33 +
 src/components/deal/CreateDealFlow.tsx        |  187 ++
 src/components/deal/DealLinkPreviewCard.tsx   |  252 ++
 src/components/deal/DealListItem.tsx          |   42 +
 src/components/deal/DealRoom.tsx              |  354 +++
 src/components/deal/ShareLink.tsx             |  101 +
 src/components/deal/dealPresentation.ts       |  229 ++
 src/components/exchange/ExchangeForm.tsx      |  214 ++
 src/components/layout/AppShell.tsx            |  120 +
 src/components/layout/SiteFooter.tsx          |   40 +
 src/components/layout/SiteHeader.tsx          |   28 +
 src/components/providers/ServicesProvider.tsx |   33 +
 src/components/ui/Badge.tsx                   |   36 +
 src/components/ui/Button.tsx                  |   68 +
 src/components/ui/Card.tsx                    |   50 +
 src/components/ui/Countdown.tsx               |   58 +
 src/components/ui/Field.tsx                   |   57 +
 src/components/ui/LinkButton.tsx              |   51 +
 src/components/ui/MockNotice.tsx              |   47 +
 src/components/ui/MoneyText.tsx               |   36 +
 src/components/ui/States.tsx                  |   95 +
 src/lib/cn.ts                                 |   13 +
 src/lib/env.ts                                |   31 +
 src/lib/money.ts                              |  150 ++
 src/lib/time.ts                               |   50 +
 src/lib/useAsync.ts                           |   80 +
 src/mocks/fixtures.ts                         |  360 +++
 src/mocks/index.ts                            |  509 ++++
 src/mocks/scenarios.ts                        |   61 +
 src/types/domain.ts                           |  245 ++
 src/types/services.ts                         |  144 ++
 tests/dealPresentation.test.ts                |   76 +
 tests/joinFlow.test.tsx                       |   83 +
 tests/money.test.ts                           |   77 +
 tests/node-harness/money.check.ts             |   80 +
 tests/node-harness/presentation.check.ts      |  115 +
 tests/node-harness/scenarioIsolation.check.ts |   63 +
 tests/setup.ts                                |    9 +
 tsconfig.json                                 |   29 +
 vitest.config.ts                              |   19 +
 77 files changed, 13839 insertions(+)
```

## 4. Complete changed-file list

Every file listed below is new; nothing was modified from a previous commit,
because there was no previous commit.

```
.gitignore
.prettierrc.json
docs/evidence/SCREEN-EVIDENCE.md
docs/product/UX-01.md
docs/specs/TS-01.4.md
docs/specs/TS-02-ANNEX-M.md
docs/specs/TS-02.md
eslint.config.mjs
next.config.ts
package.json
postcss.config.mjs
public/icon.svg
public/manifest.webmanifest
scripts/boundary-contracts.mjs
scripts/check-schema.mjs
scripts/coverage-manifest.mjs
scripts/screen-evidence.ts
scripts/verify-offline.sh
src/app/app/deal/[dealId]/page.tsx
src/app/app/history/page.tsx
src/app/app/layout.tsx
src/app/app/new/page.tsx
src/app/app/notifications/page.tsx
src/app/app/ops/page.tsx
src/app/app/page.tsx
src/app/app/settings/page.tsx
src/app/d/[publicId]/page.tsx
src/app/error.tsx
src/app/globals.css
src/app/layout.tsx
src/app/loading.tsx
src/app/login/page.tsx
src/app/not-found.tsx
src/app/page.tsx
src/app/register/page.tsx
src/components/auth/AuthForm.tsx
src/components/brand/KineticWheel.tsx
src/components/brand/Wordmark.tsx
src/components/deal/CreateDealFlow.tsx
src/components/deal/DealLinkPreviewCard.tsx
src/components/deal/DealListItem.tsx
src/components/deal/DealRoom.tsx
src/components/deal/ShareLink.tsx
src/components/deal/dealPresentation.ts
src/components/exchange/ExchangeForm.tsx
src/components/layout/AppShell.tsx
src/components/layout/SiteFooter.tsx
src/components/layout/SiteHeader.tsx
src/components/providers/ServicesProvider.tsx
src/components/ui/Badge.tsx
src/components/ui/Button.tsx
src/components/ui/Card.tsx
src/components/ui/Countdown.tsx
src/components/ui/Field.tsx
src/components/ui/LinkButton.tsx
src/components/ui/MockNotice.tsx
src/components/ui/MoneyText.tsx
src/components/ui/States.tsx
src/lib/cn.ts
src/lib/env.ts
src/lib/money.ts
src/lib/time.ts
src/lib/useAsync.ts
src/mocks/fixtures.ts
src/mocks/index.ts
src/mocks/scenarios.ts
src/types/domain.ts
src/types/services.ts
tests/dealPresentation.test.ts
tests/joinFlow.test.tsx
tests/money.test.ts
tests/node-harness/money.check.ts
tests/node-harness/presentation.check.ts
tests/node-harness/scenarioIsolation.check.ts
tests/setup.ts
tsconfig.json
vitest.config.ts
```

## 5. Implemented frontend routes

| Route | Auth | File |
|---|---|---|
| `/` | public | `src/app/page.tsx` |
| `/d/[publicId]` | public | `src/app/d/[publicId]/page.tsx` |
| `/login` | public | `src/app/login/page.tsx` |
| `/register` | public | `src/app/register/page.tsx` |
| `/app` | gated | `src/app/app/page.tsx` |
| `/app/new` | gated | `src/app/app/new/page.tsx` |
| `/app/deal/[dealId]` | gated | `src/app/app/deal/[dealId]/page.tsx` |
| `/app/history` | gated | `src/app/app/history/page.tsx` |
| `/app/notifications` | gated | `src/app/app/notifications/page.tsx` |
| `/app/settings` | gated | `src/app/app/settings/page.tsx` |
| `/app/ops` | operator | `src/app/app/ops/page.tsx` |

Plus `src/app/layout.tsx`, `src/app/app/layout.tsx`, `src/app/loading.tsx`,
`src/app/not-found.tsx` (404) and `src/app/error.tsx` (runtime error).

Gating is **navigational only**. It is not the authorization boundary (UX-01 §2.2).

## 6. Commands run, and their exact results

### Blocked — the real toolchain could not be installed

The npm registry returns **403 Forbidden for every package**, scoped and
unscoped alike, and a direct `curl` to the registry returns HTTP `000`. There is
no `node_modules` directory and no root access to install PostgreSQL or any
system package (`apt-get` fails on the dpkg lock).

| Command | Exact result |
|---|---|
| `npm install --no-audit --no-fund` | `npm error code E403` / `npm error 403 403 Forbidden - GET https://registry.npmjs.org/@tailwindcss%2fpostcss` |
| `npx --no-install prettier --version` | `npm error code E403` / `403 Forbidden - GET https://registry.npmjs.org/prettier` |
| `npx --no-install tsc --version` | `npm error code E403` / `403 Forbidden - GET https://registry.npmjs.org/tsc` |
| `npx --no-install next --version` | `npm error code E403` / `403 Forbidden - GET https://registry.npmjs.org/next` |
| `npx --no-install vitest --version` | `npm error code E403` / `403 Forbidden - GET https://registry.npmjs.org/vitest` |
| `ls node_modules` | `No such file or directory` |

**Therefore: formatting, lint, typecheck, the Vitest suite and the production
build did not run.** They are not reported as passing, because they were not
executed. `npm run verify` remains the real gate and must be run in an
environment with registry access before this frontend is considered checked.

### Executed — what could run without a registry

Node 22 strips TypeScript types natively, so the pure modules run with no
dependencies at all.

| Command | Exact result |
|---|---|
| `node --version` | `v22.22.3` |
| `bash scripts/verify-offline.sh` | `# tests 24 / # pass 24 / # fail 0 / # duration_ms 427.80275` |
| `bash scripts/verify-offline.sh --screens` | `wrote docs/evidence/SCREEN-EVIDENCE.md` |
| `node scripts/coverage-manifest.mjs` | `OK  journals=57  boundaries=47  F=321  K-R=68  mutations=47` |
| `node scripts/check-schema.mjs` | `sql blocks: 46` / `tables: 50  types/domains: 34  functions: 20` / `SCHEMA CHECK PASSED — all 10 structural properties hold` |
| `node scripts/boundary-contracts.mjs` | `emitted 47 boundary contracts` |
| `sha256sum docs/specs/TS-01.4.md` | `a293e671997510ad2deb05138dbd1aae963fa601a7a85bd6dcdaae74a5290f20` |

The 24 passing tests are: 10 money-exactness, 8 deal-state presentation, and
**6 scenario-isolation** tests. The last group is the executable proof of
UX-01 §2.1 — each runs in a fresh child process, because the environment gate is
read at module load, and asserts that a production build returns the neutral
default for every crafted `publicId` and every `?scenario=` value **even when
`NEXT_PUBLIC_ALLOW_SCENARIOS=true` is forced**.

The schema checker was additionally run against five deliberately corrupted
copies of TS-02 and caught all five, including the two exact defects the review
found in v1.0 (FK to a non-key column; subquery inside a `CHECK`). A checker that
only ever passes proves nothing; see TS-02 §12.2.

## 7. Remaining failures and gaps

| # | Gap | Status |
|---|---|---|
| 1 | Prettier, ESLint, `tsc --noEmit`, Vitest and `next build` never ran | **Blocked** by the npm 403. Not a code failure — an unverified claim. Must be run before acceptance |
| 2 | No rendered screenshots | **Blocked.** Same cause. Item 10 substitutes executed content evidence and says exactly what that does not cover |
| 3 | TS-02's SQL has never been executed | **Blocked.** No PostgreSQL server, no root to install one. TS-02 §12.3 states this and makes approval conditional on a clean first migration |
| 4 | 321 F-rows, 68 K-R harnesses and 47 mutants are **specified, not written** | **By design.** No financial backend exists to test. Annex M is the specification of that suite |
| 5 | Mock link preview reported `OPEN` after consumption | **Found and fixed this pass.** The executed screen evidence surfaced it: a losing participant would have seen a joinable link. `getPreview` now reports `CONSUMED`, and the fix is visible in §5 of the screen evidence |

Nothing else is known to be failing. That is a statement about what was
observed, not a claim of correctness — items 1–3 mean large parts of the
frontend are genuinely unverified.

## 8. TS-01.4 is byte-for-byte unchanged

```
a293e671997510ad2deb05138dbd1aae963fa601a7a85bd6dcdaae74a5290f20  docs/specs/TS-01.4.md
```

Identical to the approved value. The file was read many times during this pass
and written **never**. Both generator scripts open it read-only.

## 9. No financial backend was implemented

Confirmed. There is:

- no database connection, driver, migration or ORM instance;
- no `src/server/`, no API route, no route handler — `find src/app -name 'route.ts'` returns nothing;
- no ledger, escrow, custody, blockchain, withdrawal, recovery or risk-mode code;
- no network call to any chain, price source or bank;
- no money movement of any kind.

Everything under `src/mocks/` is a **display fixture**. `src/types/services.ts`
marks every method corresponding to a TS-01.4 transaction boundary with
`@ts03-atomic` and documents that the mocks are **not race-safe** — which is a
statement of fact about fixtures, not a gap to close on the client. Race safety
belongs to the server boundary and cannot be added to a mock.

`USING_MOCK_SERVICES` drives a mandatory `MockNotice` chrome element stating
plainly that the build holds no money.

## 10. Preview evidence for the six required screens

**`docs/evidence/SCREEN-EVIDENCE.md`** — generated by
`bash scripts/verify-offline.sh --screens`, which executes the real service
adapter, the real money formatter and the real presentation module and records
what each screen displays.

Covered: `/` · `/d/[publicId]` · `/app/new` · one active deal room (plus all ten
states × both roles) · one lost-race state · `/app/ops`.

**These are not screenshots, and they are not offered as screenshots.** Pixels
require `next dev` or `next build`, which cannot run (item 6). The evidence
proves **content and state logic**: the exact strings, the exact money figures
with Indian grouping, which action each state offers, whether cancel and dispute
are withheld, and where the funds are said to be. It proves **nothing** about
layout, spacing, colour, typography or responsive behaviour — those remain
unverified.

What it does establish, by execution:

- `/d/[publicId]` carries **no bank instruction** in any preview payload (I7), across three link states;
- terminal states (`COMPLETED`, `REFUNDED`, `CANCELLED`) offer **no** action, **no** cancel and **no** dispute;
- cancellation disappears the moment a payment is claimed;
- funds are described as *held* while live, *frozen* under review, *released* only when complete — never as "secure" or "protected";
- the lost-race branch returns `LINK_CONSUMED` and the link then reads `CONSUMED`, so the loser sees a designed screen rather than a joinable link.
