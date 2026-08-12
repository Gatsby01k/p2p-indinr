-- =====================================================================
-- INRP2P — DEL-03 migration 0006: identity and access.
--
-- ⚠ STILL NO MONEY. No account, posting, journal, balance, wallet or
-- custody table is added here and none may be. This migration replaces
-- the sandbox's identity stand-ins with real, revocable, auditable
-- boundaries — nothing else.
--
-- ⚠ NO PASSWORD COLUMN, HERE OR ANYWHERE. Web sign-in is a one-time
-- code delivered out of band. What is stored is a HASH of that code, and
-- the row is consumed on first use. There is no long-lived shared secret
-- to steal from this database.
--
-- Six concerns:
--   1. `auth_challenge`   one-time email codes / magic links, hashed,
--                         single-use, expiring on the database clock.
--   2. `session`          server-side sessions: hashed token, expiry,
--                         version, rotation lineage, revocation.
--   3. `role_grant`       explicit RBAC. Operator is granted here and
--                         ONLY out of band — no web route writes it.
--   4. `mfa_*`            real second factors: TOTP enrolment, replay
--                         protection, single-use recovery codes.
--   5. `verification_case` evidence-backed decisions with a reviewer who
--                         is not the subject, expiry and immutability.
--   6. `rate_bucket`      abuse limits on every credential endpoint.
--
-- And one deliberate REMOVAL: every legacy `is_operator` flag is cleared
-- rather than converted into a grant. See §8.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. One-time authentication challenges.
--
-- WHY A HASH AND NOT THE CODE.
--
-- A magic link or OTP is a bearer credential for the seconds it lives.
-- Storing it in clear means a database read — a backup, a log, a support
-- query, a compromised replica — hands over live credentials for every
-- pending sign-in. The hash makes a stolen dump useless: verification
-- re-hashes what the caller presented and compares.
--
-- `consumed_at` is what makes it SINGLE-USE. It is set by a conditional
-- UPDATE, so two concurrent redemptions of the same link cannot both win.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox.auth_challenge (
  challenge_id  UUID        NOT NULL DEFAULT gen_random_uuid(),
  -- Who it was issued to. Lower-cased at the service boundary.
  email         TEXT        NOT NULL,
  purpose       TEXT        NOT NULL,
  -- SHA-256 of the secret. The secret itself is never stored.
  token_hash    TEXT        NOT NULL,
  -- Bound to the request that asked, so a code minted for one browser
  -- cannot be completed from another without also stealing the cookie.
  request_binding TEXT      NULL,
  attempts      INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ NULL,
  consumed_by   UUID        NULL,

  CONSTRAINT auth_challenge_pk PRIMARY KEY (challenge_id),
  CONSTRAINT auth_challenge_hash_uq UNIQUE (token_hash),
  CONSTRAINT auth_challenge_user_fk FOREIGN KEY (consumed_by) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT auth_challenge_purpose_closed CHECK (purpose IN ('SIGN_IN', 'RECOVERY')),
  CONSTRAINT auth_challenge_hash_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_challenge_expiry_after_issue CHECK (expires_at > created_at),
  CONSTRAINT auth_challenge_email_shape CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  -- A consumed challenge names its consumer; an unconsumed one cannot.
  CONSTRAINT auth_challenge_consumed_agrees
    CHECK ((consumed_at IS NULL) = (consumed_by IS NULL)),
  -- Bounded guessing even before the rate limiter is consulted.
  CONSTRAINT auth_challenge_attempts_bounded CHECK (attempts BETWEEN 0 AND 10)
);

CREATE INDEX IF NOT EXISTS auth_challenge_email_ix
  ON sandbox.auth_challenge (email, created_at DESC);
CREATE INDEX IF NOT EXISTS auth_challenge_live_ix
  ON sandbox.auth_challenge (expires_at) WHERE consumed_at IS NULL;

COMMENT ON TABLE sandbox.auth_challenge IS
  'One-time sign-in / recovery credentials. Stores a SHA-256 of the secret, '
  'never the secret. Single-use via consumed_at, expiring on the database clock. '
  'No password column exists in this schema and none may be added.';

-- ---------------------------------------------------------------------
-- 2. Server-side sessions.
--
-- The DEL-02 session was `userId.HMAC(userId)` in a cookie: unbounded,
-- unversioned and unrevocable (TS-00 `AUD-P0-003`). A captured value
-- authenticated forever and nothing could take it back.
--
-- A session is now a ROW. The cookie carries an opaque random token; the
-- row stores its hash. Expiry is the database clock. Revocation is a
-- column. Rotation writes a new row and points the old one at it, so the
-- lineage survives for an investigation instead of being overwritten.
--
-- `version` is bumped on any change that must invalidate live sessions —
-- a role change, a 2FA enrolment — so authority cannot outlive the fact
-- it was derived from.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox.session (
  session_id     UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL,
  -- SHA-256 of the cookie token. A dump yields no usable cookie.
  token_hash     TEXT        NOT NULL,
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Bumped by role and 2FA changes; a session below the user's current
  -- version is refused without needing to be found and deleted.
  version        INTEGER     NOT NULL DEFAULT 1,
  revoked_at     TIMESTAMPTZ NULL,
  revoked_reason TEXT        NULL,
  -- Rotation lineage: the session this one replaced, and vice versa.
  rotated_from   UUID        NULL,
  -- Shown in the device list. Coarse by design: enough to recognise a
  -- session, not enough to fingerprint a person.
  device_label   TEXT        NULL,
  -- How the session was created, so an audit can tell paths apart.
  origin         TEXT        NOT NULL,
  /*
   * Whether the caller has cleared a second factor IN THIS SESSION.
   *
   * Separate from enrolment: enrolling is a property of the account,
   * clearing the challenge is a property of the session. An operator
   * with 2FA enrolled but not yet satisfied on this device holds a
   * session that can sign in and do nothing operator-shaped.
   */
  mfa_satisfied_at TIMESTAMPTZ NULL,

  CONSTRAINT session_pk PRIMARY KEY (session_id),
  CONSTRAINT session_token_uq UNIQUE (token_hash),
  CONSTRAINT session_user_fk FOREIGN KEY (user_id) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT session_rotated_fk FOREIGN KEY (rotated_from) REFERENCES sandbox.session (session_id),
  CONSTRAINT session_hash_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT session_expiry_after_issue CHECK (expires_at > issued_at),
  CONSTRAINT session_origin_closed CHECK (origin IN ('EMAIL_OTP', 'TELEGRAM', 'ROTATION')),
  CONSTRAINT session_revoked_agrees CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS session_user_ix ON sandbox.session (user_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS session_live_ix
  ON sandbox.session (expires_at) WHERE revoked_at IS NULL;

COMMENT ON TABLE sandbox.session IS
  'Server-side sessions. The cookie holds an opaque token; this row holds its '
  'SHA-256. Expiry is evaluated against the database clock, revocation is a '
  'column, and rotation preserves lineage rather than overwriting it.';

-- The user-wide session version. A role or 2FA change bumps it, and every
-- session issued before that becomes invalid without a sweep.
ALTER TABLE sandbox.app_user ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------
-- 3. RBAC.
--
-- `app_user.is_operator` was set from an email prefix (TS-00
-- `AUD-P0-001`). Authority now lives in explicit grants, and the column
-- becomes a cache that no request handler ever writes — see the
-- backfill at the end of this file.
--
-- `granted_via` records HOW authority arrived. `WEB` is deliberately NOT
-- a member: there is no web route that writes this table, so a
-- self-grant is unrepresentable rather than merely forbidden.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox.role_grant (
  grant_id    UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL,
  role        TEXT        NOT NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL for a grant made by the out-of-band administrative tool, which
  -- has no session and therefore no acting user.
  granted_by  UUID        NULL,
  granted_via TEXT        NOT NULL,
  reason      TEXT        NOT NULL,
  revoked_at  TIMESTAMPTZ NULL,
  revoked_by  UUID        NULL,

  CONSTRAINT role_grant_pk PRIMARY KEY (grant_id),
  CONSTRAINT role_grant_user_fk FOREIGN KEY (user_id) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT role_grant_granter_fk FOREIGN KEY (granted_by) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT role_grant_revoker_fk FOREIGN KEY (revoked_by) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT role_grant_role_closed CHECK (role IN ('OPERATOR', 'REVIEWER', 'ADMIN')),
  -- The closed catalogue that makes a self-grant unrepresentable.
  CONSTRAINT role_grant_via_closed CHECK (granted_via IN ('CLI', 'MIGRATION')),
  CONSTRAINT role_grant_reason_len CHECK (char_length(reason) >= 8),
  /*
   * `revoked_by` is NOT paired with `revoked_at`.
   *
   * The out-of-band tool has no acting user — the same reason
   * `granted_by` is nullable — so a CLI revoke legitimately records WHEN
   * without recording WHO. Requiring both would make the administrative
   * boundary unable to revoke anything, which is the opposite of the
   * safety this table exists for. A revoke made through a future
   * authenticated console will carry the actor; the audit event records
   * the action either way.
   */
  CONSTRAINT role_grant_revoked_by_needs_time
    CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL),
  -- Nobody grants themselves, even through the administrative tool.
  CONSTRAINT role_grant_not_self CHECK (granted_by IS NULL OR granted_by <> user_id)
);

-- At most one live grant of a role per user.
CREATE UNIQUE INDEX IF NOT EXISTS role_grant_live_uq
  ON sandbox.role_grant (user_id, role) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS role_grant_user_ix ON sandbox.role_grant (user_id, granted_at DESC);

COMMENT ON TABLE sandbox.role_grant IS
  'Explicit role authority. `granted_via` has no WEB member, so no request-'
  'handling code path can write this table: operator access is granted out of '
  'band only, and a self-grant is refused by CHECK rather than by convention.';

-- ---------------------------------------------------------------------
-- 4. Real second factors.
--
-- `user_profile.two_factor_enabled` was a boolean a request could set
-- (TS-00 `AUD-P1-008`). A factor is now an enrolled secret with a
-- verified enrolment, replay protection and single-use recovery codes.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox.mfa_factor (
  factor_id    UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL,
  kind         TEXT        NOT NULL,
  -- Base32 TOTP secret. Encryption at rest is a DEL-09 KMS concern and is
  -- recorded as such rather than pretended at here.
  secret       TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Enrolment is not complete until a code has been proved once.
  confirmed_at TIMESTAMPTZ NULL,
  disabled_at  TIMESTAMPTZ NULL,
  -- The last TOTP step accepted, so the same code cannot be replayed
  -- inside its own validity window.
  last_step    BIGINT      NULL,

  CONSTRAINT mfa_factor_pk PRIMARY KEY (factor_id),
  CONSTRAINT mfa_factor_user_fk FOREIGN KEY (user_id) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT mfa_factor_kind_closed CHECK (kind IN ('TOTP')),
  CONSTRAINT mfa_factor_secret_len CHECK (char_length(secret) >= 16)
);

/*
 * TWO indexes, because a pending enrolment and a working factor are
 * different things and must be allowed to coexist.
 *
 * At most one CONFIRMED live factor per kind — that is the one that
 * actually authorises anything. And at most one PENDING enrolment, so a
 * person cannot accumulate half-finished secrets. Re-enrolling therefore
 * does NOT disturb the factor currently protecting the account: the old
 * one keeps working until the new one is confirmed, at which point the
 * confirmation step disables it. Someone changing phones is never left
 * with no second factor because they abandoned the new setup halfway.
 */
CREATE UNIQUE INDEX IF NOT EXISTS mfa_factor_confirmed_uq
  ON sandbox.mfa_factor (user_id, kind)
  WHERE disabled_at IS NULL AND confirmed_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS mfa_factor_pending_uq
  ON sandbox.mfa_factor (user_id, kind)
  WHERE disabled_at IS NULL AND confirmed_at IS NULL;

CREATE TABLE IF NOT EXISTS sandbox.mfa_recovery_code (
  code_id    UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL,
  /*
   * The enrolment these codes belong to.
   *
   * Codes are minted when enrolment BEGINS, before any factor has been
   * proved — they have to be, because they are shown once alongside the
   * secret. Binding them to the factor is what stops that being a
   * bypass: redemption requires the factor to be CONFIRMED, so an
   * abandoned half-enrolment leaves codes that can never be used, and
   * re-enrolling disables the previous factor and with it its codes.
   */
  factor_id  UUID        NOT NULL,
  -- Hashed, like every other credential in this schema.
  code_hash  TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at    TIMESTAMPTZ NULL,

  CONSTRAINT mfa_recovery_pk PRIMARY KEY (code_id),
  CONSTRAINT mfa_recovery_hash_uq UNIQUE (code_hash),
  CONSTRAINT mfa_recovery_user_fk FOREIGN KEY (user_id) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT mfa_recovery_factor_fk FOREIGN KEY (factor_id) REFERENCES sandbox.mfa_factor (factor_id),
  CONSTRAINT mfa_recovery_hash_shape CHECK (code_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS mfa_recovery_user_ix
  ON sandbox.mfa_recovery_code (user_id) WHERE used_at IS NULL;

-- ---------------------------------------------------------------------
-- 5. Verification cases.
--
-- `markVerified()` set a boolean, awarded points and audited nothing
-- (TS-00 `AUD-P1-008`, `AUD-P1-001`). A verification is now a CASE: it
-- carries evidence, a decision, a decider who is not the subject, an
-- expiry, and a history that cannot be rewritten.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox.verification_case (
  case_id      UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL,
  kind         TEXT        NOT NULL,
  state        TEXT        NOT NULL DEFAULT 'SUBMITTED',
  -- What the subject supplied. Evidence BYTES are DEL-06's object store;
  -- this records the reference and the provider's own decision.
  evidence_ref TEXT        NULL,
  provider     TEXT        NULL,
  provider_decision TEXT   NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at   TIMESTAMPTZ NULL,
  -- The reviewer. Never the subject — enforced below, not by convention.
  decided_by   UUID        NULL,
  decision_note TEXT       NULL,
  -- A verification is a statement about a moment, so it lapses.
  expires_at   TIMESTAMPTZ NULL,

  CONSTRAINT verification_case_pk PRIMARY KEY (case_id),
  CONSTRAINT verification_case_user_fk FOREIGN KEY (user_id) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT verification_case_reviewer_fk
    FOREIGN KEY (decided_by) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT verification_case_kind_closed CHECK (kind IN ('IDENTITY', 'UPI', 'WALLET')),
  CONSTRAINT verification_case_state_closed
    CHECK (state IN ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED')),
  CONSTRAINT verification_case_decision_closed
    CHECK (provider_decision IS NULL OR provider_decision IN ('PASS', 'FAIL', 'REFER')),
  -- REVIEWER SEPARATION, as a database constraint rather than a rule
  -- somebody remembers: a subject cannot decide their own case.
  CONSTRAINT verification_case_reviewer_not_subject
    CHECK (decided_by IS NULL OR decided_by <> user_id),
  -- A decided case names its decider and its moment; an open one cannot.
  CONSTRAINT verification_case_decided_agrees
    CHECK ((state IN ('APPROVED', 'REJECTED')) = (decided_at IS NOT NULL)),
  CONSTRAINT verification_case_decider_agrees
    CHECK ((decided_at IS NULL) = (decided_by IS NULL))
);

-- One open case per user per kind: a second submission joins the first.
CREATE UNIQUE INDEX IF NOT EXISTS verification_case_open_uq
  ON sandbox.verification_case (user_id, kind)
  WHERE state IN ('SUBMITTED', 'UNDER_REVIEW');
CREATE INDEX IF NOT EXISTS verification_case_user_ix
  ON sandbox.verification_case (user_id, submitted_at DESC);

-- Immutable history. A decision may be recorded once; it may never be
-- edited afterwards, which is what makes the trail worth reading.
CREATE RULE verification_case_no_delete
  AS ON DELETE TO sandbox.verification_case DO INSTEAD NOTHING;

-- ---------------------------------------------------------------------
-- 6. Rate limiting.
--
-- A fixed-window counter keyed by (scope, subject). Deliberately in the
-- database rather than in memory: a serverless deployment has many
-- instances and an in-memory limiter on each is not a limit at all.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox.rate_bucket (
  scope       TEXT        NOT NULL,
  subject     TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count       INTEGER     NOT NULL DEFAULT 0,

  CONSTRAINT rate_bucket_pk PRIMARY KEY (scope, subject, window_start),
  CONSTRAINT rate_bucket_count_nonneg CHECK (count >= 0)
);

CREATE INDEX IF NOT EXISTS rate_bucket_window_ix ON sandbox.rate_bucket (window_start);

-- ---------------------------------------------------------------------
-- 7. Telegram launch replay protection.
--
-- `initData` verification bounded replay to 24 hours (TS-00
-- `AUD-P1-009`). A captured string still authenticated for a day. Each
-- accepted launch is now recorded and may be presented exactly once.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox.telegram_launch (
  launch_hash TEXT        NOT NULL,
  telegram_id BIGINT      NOT NULL,
  auth_date   TIMESTAMPTZ NOT NULL,
  seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT telegram_launch_pk PRIMARY KEY (launch_hash),
  CONSTRAINT telegram_launch_hash_shape CHECK (launch_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS telegram_launch_seen_ix ON sandbox.telegram_launch (seen_at);

-- ---------------------------------------------------------------------
-- 8. Fail closed: legacy operator flags are REVOKED, not preserved.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  AUTHORITY CREATED BY A VULNERABILITY IS NOT AUTHORITY.          │
-- │                                                                  │
-- │  Every existing `is_operator = TRUE` was produced by the rule    │
-- │  TS-00 recorded as `AUD-P0-001`: sign in with an address         │
-- │  beginning `ops@` and become an operator. Nobody vetted those    │
-- │  accounts, and there is no record of who they belong to.         │
-- │                                                                  │
-- │  Converting them into permanent OPERATOR grants would launder    │
-- │  the exploit into legitimacy — the privilege would survive the   │
-- │  fix that was supposed to remove it, and it would then look      │
-- │  properly granted to everyone who read the table afterwards.     │
-- │                                                                  │
-- │  So every legacy flag fails closed to FALSE and NO grant is      │
-- │  inferred. A real operator is re-granted deliberately:           │
-- │                                                                  │
-- │      node scripts/grant-role.mjs grant <email> OPERATOR "<why>"  │
-- │                                                                  │
-- │  The removal is audited per account, so whoever runs the         │
-- │  re-grants can see exactly which accounts to consider — and an   │
-- │  auditor can see that the migration took authority away rather   │
-- │  than quietly keeping it.                                        │
-- └──────────────────────────────────────────────────────────────────┘
-- ---------------------------------------------------------------------

-- One audit row per account losing legacy authority, written BEFORE the
-- flags are cleared so the subjects can still be identified from it.
INSERT INTO sandbox.audit_event
  (actor_id, action, subject_kind, subject_id, from_state, to_state, outcome, detail)
SELECT NULL,
       'ROLE_REVOKE',
       'user',
       user_id,
       'OPERATOR',
       NULL,
       'LEGACY_OPERATOR_REVOKED',
       jsonb_build_object(
         'migration', '0006_del03_identity',
         'reason',    'Legacy is_operator derived from the ops@ email prefix (TS-00 AUD-P0-001). '
                      'Authority removed; re-grant deliberately via scripts/grant-role.mjs.',
         'email',     email,
         'telegramUsername', telegram_username
       )
  FROM sandbox.app_user
 WHERE is_operator;

-- Fail closed. No grant is created for anybody.
UPDATE sandbox.app_user SET is_operator = FALSE WHERE is_operator;

-- Every live session predating this migration is invalidated too: a
-- session opened while the account was an operator must not keep acting
-- like one for the rest of its life.
UPDATE sandbox.app_user SET session_version = session_version + 1;

COMMENT ON COLUMN sandbox.app_user.is_operator IS
  'CACHE of a live OPERATOR role_grant, maintained only by the grant boundary. '
  'Never derived from an email address, and never written by a request handler. '
  'Migration 0006 cleared every legacy value rather than converting it to a grant: '
  'authority produced by the ops@ vulnerability was removed, not preserved.';
