# INRP2P — Threat Model

**Scope:** this repository at DEL-10, sandbox deployment.
**Method:** every entry names real routes, actions and services in this
codebase, and cites an **executable proof** that runs in CI.

Proofs live in:

- `tests/integration/threatModel.test.ts` — 23 tests, against the real database
- `tests/webSecurity.test.ts` — 32 tests, against the real source and verifier
- plus the pre-existing suites cited per row (604 integration tests total)

A category marked **N/A** carries a repository-specific reason, not a
generic one, and deliberately has no hollow test.

---

## 0. Assets and trust boundaries

| # | Asset | Where it lives |
|---|---|---|
| A1 | Value locks and ledger entries | `inrp2p.ledger_entry`, `inrp2p.post_entry` |
| A2 | Deal terms and frozen fee snapshots | `sandbox.deal`, `sandbox.quote_fee_snapshot` |
| A3 | Deal-room messages and evidence | `sandbox.deal_message`, `sandbox.evidence` |
| A4 | Identity and sessions | `sandbox.app_user`, `sandbox.session`, `sandbox.auth_challenge` |
| A5 | Operator authority | `sandbox.role_grant`, `sandbox.mfa_factor` |
| A6 | The audit trail | `sandbox.audit_event` |
| A7 | Secrets and connection strings | environment only; never in the repo |

**Trust boundaries.**

- **B1 Browser → server action.** 27 server actions. Everything past this
  point distrusts its input.
- **B2 Browser → route handler.** `GET /api/evidence/[evidenceId]`,
  `POST /api/telegram/auth`.
- **B3 Provider → ingest.** `ingestRailEventCommand`, authenticated by HMAC.
- **B4 Worker → database.** `runOnce`, `recoverStaleLeases`, worker role.
- **B5 Service → PostgreSQL.** Least-privilege roles; no DELETE anywhere.

**Attackers considered.** An authenticated customer (the most realistic);
a stranger holding a shared deal link; a malicious counterparty inside a
deal; a compromised or careless operator; a network attacker replaying
captured requests; and anyone who obtains a database read (backup, log,
support tool).

---

## 1. The matrix

### T1 · IDOR / BOLA

- **Asset** A2, A3 · **Attacker** authenticated customer · **Boundary** B1/B2
- **Entry points** `getDeal`, `cancelCommand`, `messageCommand`,
  `claimCommand`, `disputeCommand`, `GET /api/evidence/[evidenceId]`
- **Control** Authorisation is a `JOIN sandbox.participant` in the query
  itself, not a check before it, so a non-participant's read returns no
  row. `getDeal` then throws `NOT_A_PARTICIPANT` with one sentence that
  describes nothing. The evidence route answers **404, never 403** — a
  distinguishable "forbidden" would confirm the file exists.
- **Proof** `threatModel.test.ts` T1 (3 tests) · `webSecurity.test.ts` T14
- **Residual** A participant retains access to their own deal's history
  after completion. Intended: it is their receipt.

### T2 · Session fixation, theft, replay

- **Asset** A4 · **Attacker** network / database reader · **Boundary** B1
- **Entry points** `resolveSession`, `revokeSessionAction`, `signOutEverywhereAction`
- **Control** Sessions are server-side rows. The cookie holds a random
  token; only its SHA-256 is stored, so a database read yields nothing
  usable. Revocation and a per-user `session_version` both take effect on
  the next request.
- **Proof** `threatModel.test.ts` T2 (3 tests) · `identityAccess.test.ts`
- **Residual** A stolen live cookie works until it expires or is revoked;
  no device binding exists. DEL-08 already recorded that no device or IP
  telemetry may be claimed until it exists lawfully.

### T3 · OTP and Telegram replay

- **Asset** A4 · **Attacker** anyone who captures a code or `initData`
- **Entry points** `verifySignInCodeAction`, `POST /api/telegram/auth`
- **Control** A sign-in challenge is consumed by an `UPDATE … WHERE
  consumed_at IS NULL`, so the **database** decides a concurrent race, not
  a read-then-write. Telegram `initData` is HMAC-verified, bounded to 24
  hours, and each accepted launch is recorded by digest and refused twice.
- **Proof** `threatModel.test.ts` T3 (2 tests) · `webSecurity.test.ts` T15
  (9 tests) · `telegramVerify.test.ts`
- **Residual** Within its validity window a code is a bearer credential.
  Mitigated by single use, 15-minute expiry and per-address rate limits.

### T4 · Privilege escalation

- **Asset** A5, A1 · **Attacker** authenticated customer, careless operator
- **Entry points** `ruleAction`, `proposeRulingCommand`, `approveRulingCommand`,
  operator queue reads
- **Control** The principal is built server-side from `role_grant`; a role
  asserted by the caller is ignored. Operator actions need a live grant
  **and** a satisfied MFA factor. Maker-checker is enforced twice — in the
  service and by a `no_self_approval` CHECK — so one person cannot both
  propose and approve.
- **Proof** `threatModel.test.ts` T4 (2 tests) · `operatorAccess.test.ts` ·
  `dealRoom.test.ts`
- **Residual** A grant is written out of band by an administrator; that
  process is operational, not enforced by this codebase.

### T5 · SQL injection

- **Asset** all · **Attacker** any caller · **Boundary** B1/B2/B3
- **Control** Every statement is parameterised; no string concatenation
  builds SQL anywhere. Identifiers are constrained by shape before use
  (`^[0-9a-f-]{36}$` for evidence ids, `UTR_PATTERN` for references).
- **Proof** `threatModel.test.ts` T5 — a `'; DROP TABLE sandbox.deal; --`
  payload is stored **verbatim as text** and the table survives; a payload
  in a UTR is refused by shape.
- **Residual** None identified. `search_path` is locked per role, closing
  the function-shadowing variant.

### T6 · Mass assignment

- **Asset** A2 · **Attacker** authenticated customer · **Boundary** B1
- **Entry points** `createDealAction`, `issueProtectedQuote`
- **Control** Commands accept a named payload and derive everything
  financial server-side. `feeBearer` is decided by the active policy; a
  client-supplied value is accepted by the type and then ignored.
- **Proof** `threatModel.test.ts` T6 (2 tests) · `commercial.test.ts`
- **Residual** None identified.

### T7 · Oversized / deep payload denial of service

- **Asset** availability · **Attacker** any authenticated caller
- **Control** Message bodies and dispute statements are length-bounded in
  the service and again by CHECK constraints; evidence is size- and
  type-bounded; `initData` is rejected above 8 KB before parsing; per-role
  statement timeouts bound any single query.
- **Proof** `threatModel.test.ts` T7 (2 tests) — a 1 MB message is refused
  and **nothing reaches the table**
- **Residual** No global request-rate limit or body-size cap at the edge;
  that belongs to the deployment (see §3).

### T8 · Command and financial races

- **Asset** A1, A2 · **Attacker** a customer racing themselves or a counterparty
- **Control** Idempotency is caller UUID + canonical payload hash + stored
  result, so a retry replays the original outcome rather than acting
  again. Joining is decided by a conditional `UPDATE` on the link, and one
  active dispute per deal by a partial unique index. Per-asset zero-sum is
  enforced by the ledger itself.
- **Proof** `threatModel.test.ts` T8 (2 tests) · `atomicJoin.test.ts`
  (16-way race) · `valueProtection.test.ts` · `ledgerCore.test.ts`
- **Residual** None identified at the database level.

### T9 · Sensitive data and secret exposure

- **Asset** A4, A6, A7 · **Attacker** anyone with log, backup or queue access
- **Control** `redactObject` strips tokens, connection strings, UTRs and
  signatures from anything logged. The public readiness endpoint returns
  `{ready}` and nothing else. Operator queues are disclosure-tiered.
  `secret-scan` gates the repository.
- **Proof** `threatModel.test.ts` T9 — a **real minted session token** and
  its sign-in secret appear nowhere in `audit_event` · `operations.test.ts`
- **Note** An earlier form of this test flagged 1,496 "secrets" that were
  all legitimate content hashes (evidence SHA-256s, command payload
  hashes). It was replaced with a by-value hunt, because a check that
  cannot tell a digest from a credential gets waived.
- **Residual** Application logs are written to stdout; retention and access
  are a deployment concern.

### T10 · Worker replay and poisoning

- **Asset** A1, A6 · **Attacker** infrastructure fault, duplicate delivery
- **Control** `event_key` is unique, so an event cannot be enqueued twice.
  Delivery is leased with exponential backoff and jitter; a duplicate
  delivery has no second effect. **An unhandled event is quarantined as
  `DEAD_LETTER` with `published_at` left NULL** — never recorded as
  delivered (the DEL-10 correction).
- **Proof** `threatModel.test.ts` T10 (2 tests) · `outboxIntegrity.test.ts`
  (10 tests) · `outbox-manifest.mjs`
- **Residual** The scheduler that invokes the worker is external.

### T11 · Audit and record integrity

- **Asset** A6, A3 · **Attacker** operator, or anyone with a database session
- **Control** Deal messages and evidence rows are trigger-protected against
  UPDATE and DELETE. `audit_event` is protected by privilege: DELETE is
  revoked from every application role. Fee snapshots refuse edits with
  "the promise made to a customer".
- **Proof** `threatModel.test.ts` T11 · `leastPrivilege.test.ts` ·
  `commercial.test.ts`
- **Residual** The database **owner** can still alter history. Mitigated by
  never running the application as owner — a production readiness
  **failure** if it happens.

### T12 · Open redirect

- **Asset** A4 · **Attacker** phisher with a crafted link · **Boundary** B1
- **Entry point** `/login?next=…`
- **Control** `next` is honoured only when it starts with `/` and not `//`,
  so absolute and protocol-relative URLs fall back to `/app`.
- **Proof** `webSecurity.test.ts` T12 (9 cases, including `//evil.example`,
  `javascript:` and backslash forms), plus a scan proving no other
  redirect is fed from a search parameter.
- **Residual** None identified.

### T13 · Stored and reflected XSS

- **Asset** A4 · **Attacker** malicious counterparty via chat or filename
- **Control** React escapes all interpolated text. There is exactly **one**
  `dangerouslySetInnerHTML` in the codebase — `QrCode.tsx`, rendering SVG
  from the `qrcode` encoder, where the value becomes path geometry rather
  than markup — and it is allowlisted with that reason. No `innerHTML`
  assignment, no `document.write`, no value-built `javascript:`/`data:` href.
- **Proof** `webSecurity.test.ts` T13 (4 tests). A new opt-out fails CI.
- **Residual** No Content-Security-Policy header is set. **Open finding**,
  see §2.

### T14 · File-type smuggling, path traversal, cache leakage

- **Asset** A3, A4 · **Attacker** malicious counterparty uploading evidence
- **Entry point** `GET /api/evidence/[evidenceId]`
- **Control** `Content-Disposition: attachment` plus
  `X-Content-Type-Options: nosniff` stop an uploaded file rendering as
  active content in the app's origin. The filename is stripped of quotes,
  backslashes and CRLF before entering the header, so it cannot inject
  one. The id must match a UUID shape before the database is touched, so
  `../../../etc/passwd` never becomes a lookup.
  `Cache-Control: private, no-store` keeps a private file out of shared
  caches. Uploads are quarantined until a scanner promotes them to READY.
- **Proof** `webSecurity.test.ts` T14 (6 tests) · `dealRoom.test.ts`
- **Residual** The scanner adapter is a sandbox stub; no real malware
  engine is configured, and none is claimed.

### T15 · Webhook forgery, tampering, replay, timing

- **Asset** A1 · **Attacker** anyone who can reach the ingest endpoint
- **Entry points** `ingestRailEventCommand`, `POST /api/telegram/auth`
- **Control** HMAC over the payload, a freshness window, event-id
  uniqueness, and `timingSafeEqual` with a length check first — because
  `timingSafeEqual` throws on a length mismatch and a throw is itself an
  oracle.
- **Proof** `webSecurity.test.ts` T15 (9 tests): valid accepted; tampered,
  forged, wrong-token, stale, future-dated and malformed all refused ·
  `railRequests.test.ts` · `paymentRails.test.ts`
- **Residual** No real provider is configured; the sandbox key is
  non-secret by design and must never serve production.

### T16 · SSRF

- **Asset** internal network · **Attacker** any caller
- **Control** No request target is built from caller input. Every `fetch`
  in the codebase is either a same-origin path (the Telegram provider
  posting to `/api/telegram/auth`) or an adapter reading its base URL from
  configuration.
- **Proof** `webSecurity.test.ts` T16 (2 tests), asserted per call site
- **Residual** When real adapters arrive, their URLs must stay
  configuration-only. Recorded as a DEL-11 constraint.

### T17 · CSRF

- **Asset** A1, A2, A3 · **Attacker** any site the customer visits · **Boundary** B1
- **Control** All 27 mutations are Next.js server actions: POST-only to
  unguessable, build-scoped action ids, with the request `Origin`
  verified against the `Host` before the action runs. The single mutating
  route handler (`POST /api/telegram/auth`) is authenticated by HMAC over
  the `initData`, not by the session cookie. The cookie itself is
  `httpOnly`, and `Secure` in production.
- **⚠ The embedded case, stated plainly.** `sameSite` is `lax` normally
  but **`none` when the app is embedded** — a Telegram Mini App runs in a
  cross-site iframe, where a `Lax` cookie is never sent and nobody can
  sign in at all. So **in embedded mode SameSite contributes nothing to
  CSRF defence**, and the whole weight falls on server-action Origin
  verification. `None` is paired with `Secure`, which browsers require.
  This is a deliberate trade-off, not an oversight — recorded here rather
  than described as protection it does not provide.
- **Proof** `webSecurity.test.ts` T17 (3 tests): the cookie flags are
  pinned, and every mutating route handler is proven to carry signature
  authentication · `mutation-surface.mjs` (all 27 actions gated)
- **Residual** An embedded session depends entirely on Origin
  verification. See F3.

### T18 · User enumeration

- **Asset** A4 · **Attacker** anyone
- **Control** Sign-in returns the same response whether or not the address
  exists, consumes the same rate budget, and the UI says "**If** … is
  registered". Every redemption failure — wrong, expired, spent, wrong
  address — returns one identical refusal; the real reason goes to the
  audit row only.
- **Proof** `signInCode.test.ts` (indistinguishable refusals) ·
  `identityAuth.test.ts` · confirmed in the browser (§8 of the report)
- **Residual** Timing differences were not measured; the paths are
  structurally identical but this is not proven to a timing-attack
  standard.

### T19 · Authenticated cache leakage

- **Asset** A2, A3 · **Attacker** shared cache or CDN
- **Control** Every authenticated page is `force-dynamic`; the evidence
  route sets `private, no-store`. No authenticated response is statically
  generated.
- **Proof** `webSecurity.test.ts` T14 · route configuration
- **Residual** No CDN is configured; when one is, `no-store` on
  authenticated routes must be verified at the edge.

---

## 2. Open findings

| # | Finding | Severity | Disposition |
|---|---|---|---|
| F1 | **No Content-Security-Policy header.** React escaping is the only XSS control; a CSP would be defence in depth. | Medium | **Not release-blocking.** No injection sink exists today (T13 proves it), so CSP adds depth rather than closing a hole. Recommended for DEL-11 with `frame-ancestors` compatible with the Telegram Mini App host. |
| F2 | **No edge rate limit or body-size cap.** Credential endpoints are rate-limited in-application; general request flooding is not bounded. | Medium | **Deployment concern.** Belongs to the reverse proxy, which does not exist in this repository. |
| F3 | **In embedded (Telegram) mode the session cookie is `SameSite=None`**, so CSRF defence rests solely on server-action Origin verification. | Low | Unavoidable: a `Lax` cookie is not sent in a cross-site iframe, so the Mini App could not authenticate at all. Paired with `Secure`; all mutations are Origin-verified server actions. Revisit if a mutating route handler is ever added. |
| F4 | **Database owner can alter history.** | Low | Structural to PostgreSQL. Mitigated by least-privilege roles; running as owner is a production readiness *failure*. |
| F5 | **Enumeration timing not measured.** | Low | Paths are structurally identical; a timing study needs load tooling not present here. |

**No release-blocking security finding remains open.** The three defects
this stage found and fixed — the amount handoff, the dead sign-in code and
the unhandled-outbox record — are in the final report, with the migration
repairs.

---

## 3. Explicitly out of scope

- Physical and cloud-infrastructure security (no infrastructure exists here).
- Real provider security (no production adapter is implemented).
- External penetration testing — **none has been performed, and none is claimed.**
- Sanctions/KYC screening — **not live**, and no screening claim is made anywhere.
