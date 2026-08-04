-- =====================================================================
-- INRP2P — SANDBOX vertical slice, migration 0001
--
-- ⚠ THIS SCHEMA HOLDS NO MONEY AND IS NOT THE TS-02 LEDGER SCHEMA.
--
-- Everything lives in the `sandbox` schema and every table is prefixed
-- accordingly, so it can never be mistaken for the TS-02 `inrp2p` money
-- schema. There is deliberately NO account, NO posting, NO journal entry,
-- NO balance, NO wallet, NO withdrawal and NO custody table here. Amounts
-- are recorded as exact integer minor units purely so the UI can display a
-- consistent figure across reloads; nothing in this schema debits, credits
-- or transfers anything.
--
-- What this schema DOES model is the sandbox journey:
--   quote → link → join (single winner) → deal → claim → confirm → completed
-- with real server-side authorization and real transactional concurrency.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS sandbox;

-- ---------------------------------------------------------------------
-- Enumerations — closed catalogues, mirroring the vocabulary the UI uses.
-- ---------------------------------------------------------------------

CREATE TYPE sandbox.direction AS ENUM ('USDT_TO_INR', 'INR_TO_USDT');

-- The two seats in a deal. FIAT_SIDE sends INR; CRYPTO_SIDE supplies USDT
-- and receives the INR. Only FIAT_SIDE can ever produce a UTR.
CREATE TYPE sandbox.participant_role AS ENUM ('FIAT_SIDE', 'CRYPTO_SIDE');

CREATE TYPE sandbox.quote_state AS ENUM ('ISSUED', 'CONSUMED', 'EXPIRED');

-- A link is OPEN until exactly one of: consumed by a Join, or closed.
-- Expiry is NOT a state — it is `expires_at` compared against server time,
-- which is what stops a row ever reading "Open" and "Expired" at once.
CREATE TYPE sandbox.link_state AS ENUM ('OPEN', 'CONSUMED', 'CLOSED');

CREATE TYPE sandbox.deal_state AS ENUM (
  'FIAT_PENDING',   -- awaiting the INR transfer + claim
  'FIAT_CLAIMED',   -- claim submitted with a UTR, awaiting confirmation
  'COMPLETED',      -- counterparty confirmed receipt (terminal)
  'CANCELLED'       -- terminal, no settlement
);

-- ---------------------------------------------------------------------
-- Users. Sandbox identities only.
--
-- NOTE ON CREDENTIALS: there is no password column and none may be added.
-- The sandbox sign-in issues a signed session cookie against an email
-- alone; it authenticates nobody in the real world and stores no secret.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.app_user (
  user_id      UUID        NOT NULL DEFAULT gen_random_uuid(),
  email        TEXT        NOT NULL,
  display_name TEXT        NOT NULL,
  is_operator  BOOLEAN     NOT NULL DEFAULT FALSE,
  is_verified  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_user_pk PRIMARY KEY (user_id),
  CONSTRAINT app_user_email_uq UNIQUE (email),
  CONSTRAINT app_user_email_shape CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);

-- ---------------------------------------------------------------------
-- Quotes. Server-issued, server-priced, server-expired.
--
-- The rate is an exact rational (num/den) in INR paise per USDT micro, so
-- no floating point participates. Both amounts are frozen at issuance and
-- there is no update path to them — the UI may only copy them.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.quote (
  quote_id        UUID        NOT NULL DEFAULT gen_random_uuid(),
  issued_to       UUID        NOT NULL,
  direction       sandbox.direction NOT NULL,
  state           sandbox.quote_state NOT NULL DEFAULT 'ISSUED',

  -- Exact integer minor units. USDT/TRX = 6 dp, INR = 2 dp (paise).
  usdt_minor      BIGINT      NOT NULL,
  inr_minor       BIGINT      NOT NULL,

  -- Exact rational rate, lowest terms enforced in the service layer.
  rate_num        BIGINT      NOT NULL,
  rate_den        BIGINT      NOT NULL,

  -- Provenance of the price, so the UI never invents one.
  pricing_source  TEXT        NOT NULL,
  observed_at     TIMESTAMPTZ NOT NULL,

  -- Server-controlled. The client cannot set or extend this.
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT quote_pk PRIMARY KEY (quote_id),
  CONSTRAINT quote_user_fk FOREIGN KEY (issued_to) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT quote_usdt_pos CHECK (usdt_minor > 0),
  CONSTRAINT quote_inr_pos  CHECK (inr_minor  > 0),
  CONSTRAINT quote_rate_pos CHECK (rate_num > 0 AND rate_den > 0),
  CONSTRAINT quote_expiry_after_issue CHECK (expires_at > created_at)
);

CREATE INDEX quote_issued_to_ix ON sandbox.quote (issued_to, created_at DESC);

-- ---------------------------------------------------------------------
-- Deal links.
--
-- `public_id` is the shareable token. It is random and carries no scenario
-- suffix semantics: the server resolves state from this table alone, so a
-- crafted id cannot manufacture a status.
--
-- One link consumes at most one quote: UNIQUE(quote_id).
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.deal_link (
  link_id     UUID        NOT NULL DEFAULT gen_random_uuid(),
  public_id   TEXT        NOT NULL,
  quote_id    UUID        NOT NULL,
  created_by  UUID        NOT NULL,

  -- The creator's seat. The joiner takes the opposite seat.
  creator_role sandbox.participant_role NOT NULL,

  state       sandbox.link_state NOT NULL DEFAULT 'OPEN',
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ NULL,
  closed_at   TIMESTAMPTZ NULL,
  version     INTEGER     NOT NULL DEFAULT 0,

  CONSTRAINT deal_link_pk PRIMARY KEY (link_id),
  CONSTRAINT deal_link_public_id_uq UNIQUE (public_id),
  -- A quote backs at most one link.
  CONSTRAINT deal_link_quote_uq UNIQUE (quote_id),
  CONSTRAINT deal_link_quote_fk FOREIGN KEY (quote_id) REFERENCES sandbox.quote (quote_id),
  CONSTRAINT deal_link_creator_fk FOREIGN KEY (created_by) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT deal_link_public_id_shape CHECK (public_id ~ '^INRP-[0-9A-HJ-NP-Z]{10}$'),
  -- State/timestamp agreement, so a row can never claim to be two things.
  CONSTRAINT deal_link_consumed_at CHECK ((state = 'CONSUMED') = (consumed_at IS NOT NULL)),
  CONSTRAINT deal_link_closed_at   CHECK ((state = 'CLOSED')   = (closed_at   IS NOT NULL))
);

CREATE INDEX deal_link_creator_ix ON sandbox.deal_link (created_by, created_at DESC);

-- ---------------------------------------------------------------------
-- Deals.
--
-- ***THE SINGLE-WINNER JOIN GUARANTEE LIVES HERE.***
--
-- `UNIQUE(link_id)` means the database itself permits at most one deal per
-- link. Combined with the conditional
--     UPDATE sandbox.deal_link SET state='CONSUMED' WHERE link_id=$1 AND state='OPEN'
-- executed under `SELECT ... FOR UPDATE` inside one transaction, two
-- concurrent sessions cannot both create a deal: the second either sees zero
-- affected rows on the CAS, or is rejected by this constraint. There is no
-- code path that can bypass it, and no button state participates.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.deal (
  deal_id     UUID        NOT NULL DEFAULT gen_random_uuid(),
  public_id   TEXT        NOT NULL,
  link_id     UUID        NOT NULL,
  quote_id    UUID        NOT NULL,
  state       sandbox.deal_state NOT NULL DEFAULT 'FIAT_PENDING',

  -- Terms copied from the quote at Join and never recomputed afterwards.
  direction   sandbox.direction NOT NULL,
  usdt_minor  BIGINT      NOT NULL,
  inr_minor   BIGINT      NOT NULL,
  rate_num    BIGINT      NOT NULL,
  rate_den    BIGINT      NOT NULL,
  pricing_source TEXT     NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,

  -- Server-controlled deadline for the currently pending action.
  action_deadline TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL,
  version     INTEGER     NOT NULL DEFAULT 0,

  CONSTRAINT deal_pk PRIMARY KEY (deal_id),
  CONSTRAINT deal_public_id_uq UNIQUE (public_id),
  CONSTRAINT deal_link_uq UNIQUE (link_id),           -- ← single-winner Join
  CONSTRAINT deal_quote_uq UNIQUE (quote_id),
  CONSTRAINT deal_link_fk FOREIGN KEY (link_id) REFERENCES sandbox.deal_link (link_id),
  CONSTRAINT deal_quote_fk FOREIGN KEY (quote_id) REFERENCES sandbox.quote (quote_id),
  CONSTRAINT deal_usdt_pos CHECK (usdt_minor > 0),
  CONSTRAINT deal_inr_pos  CHECK (inr_minor  > 0),
  CONSTRAINT deal_completed_at CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL))
);

-- ---------------------------------------------------------------------
-- Participants. Exactly one user per seat, exactly one seat per user.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.participant (
  deal_id  UUID NOT NULL,
  user_id  UUID NOT NULL,
  role     sandbox.participant_role NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT participant_pk PRIMARY KEY (deal_id, role),
  CONSTRAINT participant_user_uq UNIQUE (deal_id, user_id),
  CONSTRAINT participant_deal_fk FOREIGN KEY (deal_id) REFERENCES sandbox.deal (deal_id),
  CONSTRAINT participant_user_fk FOREIGN KEY (user_id) REFERENCES sandbox.app_user (user_id)
);

CREATE INDEX participant_user_ix ON sandbox.participant (user_id);

-- ---------------------------------------------------------------------
-- Payment claim.
--
-- At most one claim per deal. The UTR is unique platform-wide: reusing a
-- bank reference is a fraud signal, so the database refuses it outright
-- rather than leaving it to application logic.
--
-- This records an ASSERTION by the fiat payer that a bank transfer happened
-- outside this system. It moves nothing.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.payment_claim (
  claim_id     UUID        NOT NULL DEFAULT gen_random_uuid(),
  deal_id      UUID        NOT NULL,
  claimed_by   UUID        NOT NULL,
  utr          TEXT        NOT NULL,
  note         TEXT        NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payment_claim_pk PRIMARY KEY (claim_id),
  CONSTRAINT payment_claim_deal_uq UNIQUE (deal_id),
  CONSTRAINT payment_claim_utr_uq  UNIQUE (utr),
  CONSTRAINT payment_claim_deal_fk FOREIGN KEY (deal_id) REFERENCES sandbox.deal (deal_id),
  CONSTRAINT payment_claim_user_fk FOREIGN KEY (claimed_by) REFERENCES sandbox.app_user (user_id),
  -- Sandbox UTR shape: 12 alphanumerics, matching the real UTR length so the
  -- UI validation is representative, while the value itself is test data.
  CONSTRAINT payment_claim_utr_shape CHECK (utr ~ '^[0-9A-Z]{12}$')
);

-- ---------------------------------------------------------------------
-- Confirmation. At most one per deal, and never by the claimant.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.settlement_confirmation (
  confirmation_id UUID       NOT NULL DEFAULT gen_random_uuid(),
  deal_id         UUID       NOT NULL,
  confirmed_by    UUID       NOT NULL,
  confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT settlement_confirmation_pk PRIMARY KEY (confirmation_id),
  CONSTRAINT settlement_confirmation_deal_uq UNIQUE (deal_id),
  CONSTRAINT settlement_confirmation_deal_fk FOREIGN KEY (deal_id) REFERENCES sandbox.deal (deal_id),
  CONSTRAINT settlement_confirmation_user_fk FOREIGN KEY (confirmed_by) REFERENCES sandbox.app_user (user_id)
);

-- ---------------------------------------------------------------------
-- Audit. Append-only record of every sandbox transition.
--
-- Written in the SAME transaction as the transition it describes, so a
-- state change without its audit row is impossible.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.audit_event (
  audit_id    BIGINT      GENERATED ALWAYS AS IDENTITY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id    UUID        NULL,          -- NULL for system/anonymous reads
  action      TEXT        NOT NULL,
  subject_kind TEXT       NOT NULL,      -- 'link' | 'deal' | 'quote'
  subject_id  UUID        NOT NULL,
  from_state  TEXT        NULL,
  to_state    TEXT        NULL,
  outcome     TEXT        NOT NULL,      -- 'OK' or the rejection code
  detail      JSONB       NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT audit_event_pk PRIMARY KEY (audit_id),
  CONSTRAINT audit_event_actor_fk FOREIGN KEY (actor_id) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT audit_event_detail_obj CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT audit_event_subject_kind CHECK (subject_kind IN ('link','deal','quote','user'))
);

CREATE INDEX audit_event_subject_ix ON sandbox.audit_event (subject_kind, subject_id, audit_id);

-- Append-only enforcement: the audit trail may be inserted into and read,
-- never rewritten. A rule is used rather than a trigger so the prohibition
-- is total and carries no exception path.
CREATE RULE audit_event_no_update AS ON UPDATE TO sandbox.audit_event DO INSTEAD NOTHING;
CREATE RULE audit_event_no_delete AS ON DELETE TO sandbox.audit_event DO INSTEAD NOTHING;

-- ---------------------------------------------------------------------
-- Structural proof that this schema cannot become a ledger.
--
-- If a later migration adds a money-movement table to this schema, this
-- check fails loudly in CI (scripts/db-verify.mjs) rather than silently
-- turning the sandbox into custody.
-- ---------------------------------------------------------------------

COMMENT ON SCHEMA sandbox IS
  'SANDBOX ONLY. Holds no funds. No account, posting, journal, balance, wallet, '
  'custody or withdrawal table may ever be created here. The TS-02 money schema '
  'is a separate, unimplemented concern.';
