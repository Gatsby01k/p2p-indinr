-- =====================================================================
-- INRP2P — DealSafe India, migration 0003
--
-- ⚠ STILL NO MONEY. Read the schema comment set in 0001 and left intact
-- below: no account, posting, journal, balance, wallet, custody or
-- withdrawal table exists here or may be added. Everything in this file
-- records ASSERTIONS people make to each other about transfers that
-- happen outside this system, plus the conversation and evidence around
-- them. Nothing debits, credits or moves anything.
--
-- SafePoints (`reward_event`) are explicitly NOT money: they are a
-- non-transferable, non-redeemable loyalty count with no cash value, no
-- payout path and no withdrawal path. The constraint at the bottom of
-- this file is what keeps that true.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Quotes and deals gain the product's commercial vocabulary.
--
-- INR_TO_INR carries no USDT leg at all, so `usdt_minor` becomes nullable
-- and a CHECK ties its presence to the scenario. That is stricter than
-- leaving it NOT NULL and writing a meaningless zero: a null cannot be
-- mistaken for an amount, and the constraint makes "an INR→INR deal with
-- a USDT figure" unrepresentable rather than merely unlikely.
-- ---------------------------------------------------------------------

ALTER TABLE sandbox.quote ALTER COLUMN usdt_minor DROP NOT NULL;
ALTER TABLE sandbox.quote DROP CONSTRAINT quote_usdt_pos;
ALTER TABLE sandbox.quote
  ADD CONSTRAINT quote_usdt_pos CHECK (usdt_minor IS NULL OR usdt_minor > 0);
ALTER TABLE sandbox.quote
  ADD CONSTRAINT quote_usdt_scenario
  CHECK ((direction = 'INR_TO_INR') = (usdt_minor IS NULL));

-- Fees are exact integer paise, fixed at quote issuance alongside the
-- amounts. No later step re-derives a fee from a percentage.
ALTER TABLE sandbox.quote ADD COLUMN IF NOT EXISTS protection_fee_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sandbox.quote ADD COLUMN IF NOT EXISTS network_fee_minor    BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sandbox.quote ADD COLUMN IF NOT EXISTS fee_bearer           TEXT   NOT NULL DEFAULT 'PAYER';
ALTER TABLE sandbox.quote ADD COLUMN IF NOT EXISTS title                TEXT   NULL;
ALTER TABLE sandbox.quote
  ADD CONSTRAINT quote_fees_nonneg CHECK (protection_fee_minor >= 0 AND network_fee_minor >= 0);
ALTER TABLE sandbox.quote
  ADD CONSTRAINT quote_fee_bearer_closed CHECK (fee_bearer IN ('PAYER', 'PAYEE'));

ALTER TABLE sandbox.deal ALTER COLUMN usdt_minor DROP NOT NULL;
ALTER TABLE sandbox.deal DROP CONSTRAINT deal_usdt_pos;
ALTER TABLE sandbox.deal
  ADD CONSTRAINT deal_usdt_pos CHECK (usdt_minor IS NULL OR usdt_minor > 0);
ALTER TABLE sandbox.deal
  ADD CONSTRAINT deal_usdt_scenario
  CHECK ((direction = 'INR_TO_INR') = (usdt_minor IS NULL));

ALTER TABLE sandbox.deal ADD COLUMN IF NOT EXISTS protection_fee_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sandbox.deal ADD COLUMN IF NOT EXISTS network_fee_minor    BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sandbox.deal ADD COLUMN IF NOT EXISTS fee_bearer           TEXT   NOT NULL DEFAULT 'PAYER';
ALTER TABLE sandbox.deal ADD COLUMN IF NOT EXISTS title                TEXT   NULL;
ALTER TABLE sandbox.deal ADD COLUMN IF NOT EXISTS closed_at            TIMESTAMPTZ NULL;

-- The short, speakable reference a person reads out or pastes into chat.
-- `public_id` stays the machine token; this is the human one.
ALTER TABLE sandbox.deal ADD COLUMN IF NOT EXISTS deal_code TEXT NULL;

-- ---------------------------------------------------------------------
-- 2. Deal chat.
--
-- Private to the two seats and any operator reviewing a dispute. There is
-- no group, no third party and no public thread — the authorization is a
-- join against `participant`, enforced in the service, never a filter the
-- client asks for.
--
-- `kind` separates what a person SAID from what the system RECORDED, so
-- a system line can never be forged by typing it.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox.deal_message (
  message_id UUID        NOT NULL DEFAULT gen_random_uuid(),
  deal_id    UUID        NOT NULL,
  author_id  UUID        NULL,                    -- NULL for system lines
  kind       TEXT        NOT NULL DEFAULT 'CHAT', -- 'CHAT' | 'SYSTEM'
  body       TEXT        NOT NULL,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT deal_message_pk PRIMARY KEY (message_id),
  CONSTRAINT deal_message_deal_fk FOREIGN KEY (deal_id) REFERENCES sandbox.deal (deal_id),
  CONSTRAINT deal_message_author_fk FOREIGN KEY (author_id) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT deal_message_kind_closed CHECK (kind IN ('CHAT', 'SYSTEM')),
  -- A system line has no author; a chat line must have one.
  CONSTRAINT deal_message_author_rule CHECK ((kind = 'SYSTEM') = (author_id IS NULL)),
  CONSTRAINT deal_message_body_len CHECK (char_length(body) BETWEEN 1 AND 2000)
);

CREATE INDEX IF NOT EXISTS deal_message_deal_ix
  ON sandbox.deal_message (deal_id, sent_at, message_id);

-- ---------------------------------------------------------------------
-- 3. Evidence.
--
-- A payment receipt, a screenshot, a signed document. Held as bytes so
-- the evidence trail is genuinely downloadable by the two participants
-- rather than a filename with nothing behind it.
--
-- `sha256` is stored so a file can be shown to be the same file later —
-- that is what makes an evidence trail worth having in a dispute.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox.deal_evidence (
  evidence_id  UUID        NOT NULL DEFAULT gen_random_uuid(),
  deal_id      UUID        NOT NULL,
  uploaded_by  UUID        NOT NULL,
  filename     TEXT        NOT NULL,
  content_type TEXT        NOT NULL,
  byte_size    INTEGER     NOT NULL,
  sha256       TEXT        NOT NULL,
  content      BYTEA       NOT NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT deal_evidence_pk PRIMARY KEY (evidence_id),
  CONSTRAINT deal_evidence_deal_fk FOREIGN KEY (deal_id) REFERENCES sandbox.deal (deal_id),
  CONSTRAINT deal_evidence_user_fk FOREIGN KEY (uploaded_by) REFERENCES sandbox.app_user (user_id),
  -- 5 MB ceiling, enforced by the database and not only by the form.
  CONSTRAINT deal_evidence_size CHECK (byte_size > 0 AND byte_size <= 5 * 1024 * 1024),
  CONSTRAINT deal_evidence_sha_shape CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- A closed catalogue: the app never has to sniff or trust a browser's
  -- content type, and an executable can never be stored as "evidence".
  CONSTRAINT deal_evidence_type_closed
    CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp'))
);

CREATE INDEX IF NOT EXISTS deal_evidence_deal_ix
  ON sandbox.deal_evidence (deal_id, uploaded_at);

-- ---------------------------------------------------------------------
-- 4. Disputes.
--
-- Raising one PAUSES release. It reverses nothing and refunds nothing:
-- only an operator ruling moves the deal onward, which is why there is a
-- resolution column and no automatic path out of this table.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox.dispute (
  dispute_id  UUID        NOT NULL DEFAULT gen_random_uuid(),
  deal_id     UUID        NOT NULL,
  raised_by   UUID        NOT NULL,
  reason      TEXT        NOT NULL,
  detail      TEXT        NULL,
  state       TEXT        NOT NULL DEFAULT 'OPEN',
  resolution  TEXT        NULL,
  resolved_by UUID        NULL,
  raised_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ NULL,

  CONSTRAINT dispute_pk PRIMARY KEY (dispute_id),
  -- One live dispute per deal. A second complaint joins the first.
  CONSTRAINT dispute_deal_uq UNIQUE (deal_id),
  CONSTRAINT dispute_deal_fk FOREIGN KEY (deal_id) REFERENCES sandbox.deal (deal_id),
  CONSTRAINT dispute_raiser_fk FOREIGN KEY (raised_by) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT dispute_resolver_fk FOREIGN KEY (resolved_by) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT dispute_reason_closed CHECK (
    reason IN ('PAYMENT_NOT_RECEIVED', 'WRONG_AMOUNT', 'PROOF_MISMATCH', 'NOT_AS_AGREED', 'OTHER')
  ),
  CONSTRAINT dispute_state_closed CHECK (state IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED')),
  CONSTRAINT dispute_resolution_closed CHECK (
    resolution IS NULL OR resolution IN ('RELEASED', 'REFUNDED', 'CANCELLED')
  ),
  -- Resolved means all three resolution facts are present, or none are.
  CONSTRAINT dispute_resolved_rule CHECK (
    (state = 'RESOLVED')
      = (resolution IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

-- ---------------------------------------------------------------------
-- 5. Notifications. Per-user, generated server-side from real events.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox.notification (
  notification_id UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL,
  deal_id         UUID        NULL,
  severity        TEXT        NOT NULL DEFAULT 'INFO',
  title           TEXT        NOT NULL,
  body            TEXT        NOT NULL,
  read_at         TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT notification_pk PRIMARY KEY (notification_id),
  CONSTRAINT notification_user_fk FOREIGN KEY (user_id) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT notification_deal_fk FOREIGN KEY (deal_id) REFERENCES sandbox.deal (deal_id),
  CONSTRAINT notification_severity_closed CHECK (severity IN ('INFO', 'ACTION', 'WARNING'))
);

CREATE INDEX IF NOT EXISTS notification_user_ix
  ON sandbox.notification (user_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 6. SafePoints — a loyalty COUNT, and deliberately not a balance.
--
-- ⚠ SafePoints have NO monetary value. They cannot be bought, sold,
-- transferred, withdrawn or converted to cash, and no code path exists to
-- do any of those. They unlock a fee discount on this platform and
-- nothing else. The `kind` catalogue below is closed and contains no
-- payout, redemption-for-cash or transfer member — which is what makes
-- the "not money" claim structural rather than a promise in a comment.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox.reward_event (
  reward_id  UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL,
  deal_id    UUID        NULL,
  kind       TEXT        NOT NULL,
  points     INTEGER     NOT NULL,
  note       TEXT        NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT reward_event_pk PRIMARY KEY (reward_id),
  CONSTRAINT reward_event_user_fk FOREIGN KEY (user_id) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT reward_event_deal_fk FOREIGN KEY (deal_id) REFERENCES sandbox.deal (deal_id),
  CONSTRAINT reward_event_kind_closed
    CHECK (kind IN ('DEAL_COMPLETED', 'REFERRAL_COMPLETED', 'VERIFICATION', 'FEE_CREDIT_APPLIED')),
  CONSTRAINT reward_event_points_bounded CHECK (points BETWEEN -100000 AND 100000),
  -- At most one award per deal per user: completing a deal twice is not a
  -- thing, so the database refuses to record it as one.
  CONSTRAINT reward_event_deal_kind_uq UNIQUE (user_id, deal_id, kind)
);

CREATE INDEX IF NOT EXISTS reward_event_user_ix
  ON sandbox.reward_event (user_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 7. Referrals. A referral is only "qualified" once the invited person
-- completes a protected deal — never on sign-up, which is what stops the
-- programme paying for empty accounts.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox.referral (
  referral_id  UUID        NOT NULL DEFAULT gen_random_uuid(),
  referrer_id  UUID        NOT NULL,
  invitee_id   UUID        NOT NULL,
  qualified_at TIMESTAMPTZ NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT referral_pk PRIMARY KEY (referral_id),
  CONSTRAINT referral_invitee_uq UNIQUE (invitee_id),   -- one referrer, ever
  CONSTRAINT referral_referrer_fk FOREIGN KEY (referrer_id) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT referral_invitee_fk FOREIGN KEY (invitee_id) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT referral_not_self CHECK (referrer_id <> invitee_id)
);

CREATE INDEX IF NOT EXISTS referral_referrer_ix ON sandbox.referral (referrer_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 8. Payment methods.
--
-- ⚠ NO SECRET IS STORED. There is no PIN, no password, no CVV, no full
-- card number and no bank credential column, and none may be added: this
-- table records how to ADDRESS a transfer that a person performs in their
-- own banking app. The account number is held masked only.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox.payment_method (
  method_id    UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL,
  kind         TEXT        NOT NULL,
  label        TEXT        NOT NULL,
  -- UPI: the VPA. BANK: masked account number. WALLET: the address.
  handle       TEXT        NOT NULL,
  bank_name    TEXT        NULL,
  ifsc         TEXT        NULL,
  is_default   BOOLEAN     NOT NULL DEFAULT FALSE,
  verified     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payment_method_pk PRIMARY KEY (method_id),
  CONSTRAINT payment_method_user_fk FOREIGN KEY (user_id) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT payment_method_kind_closed CHECK (kind IN ('UPI', 'BANK', 'WALLET')),
  CONSTRAINT payment_method_handle_len CHECK (char_length(handle) BETWEEN 3 AND 120)
);

CREATE INDEX IF NOT EXISTS payment_method_user_ix ON sandbox.payment_method (user_id, created_at);

-- Exactly one default per user, enforced by the database rather than by
-- remembering to clear the old one in application code.
CREATE UNIQUE INDEX IF NOT EXISTS payment_method_one_default_ix
  ON sandbox.payment_method (user_id) WHERE is_default;

-- ---------------------------------------------------------------------
-- 9. Profile and preferences. One row per user, created on demand.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox.user_profile (
  user_id            UUID        NOT NULL,
  identity_verified  BOOLEAN     NOT NULL DEFAULT FALSE,
  upi_verified       BOOLEAN     NOT NULL DEFAULT FALSE,
  wallet_verified    BOOLEAN     NOT NULL DEFAULT FALSE,
  two_factor_enabled BOOLEAN     NOT NULL DEFAULT FALSE,
  notify_email       BOOLEAN     NOT NULL DEFAULT TRUE,
  notify_push        BOOLEAN     NOT NULL DEFAULT TRUE,
  about              TEXT        NULL,
  city               TEXT        NULL,
  referral_code      TEXT        NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT user_profile_pk PRIMARY KEY (user_id),
  CONSTRAINT user_profile_user_fk FOREIGN KEY (user_id) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT user_profile_referral_uq UNIQUE (referral_code),
  CONSTRAINT user_profile_referral_shape CHECK (referral_code ~ '^[a-z0-9]{6,16}$')
);

-- ---------------------------------------------------------------------
-- 10. Backfill and tighten.
--
-- Every existing deal predates `deal_code`, so one is derived from the
-- token it already has. Only then does the column become NOT NULL — a
-- constraint added before the backfill would fail on the first old row.
-- ---------------------------------------------------------------------

UPDATE sandbox.deal
   SET deal_code = 'INR-' || substr(replace(public_id, 'INRP-', ''), 1, 4)
 WHERE deal_code IS NULL;

ALTER TABLE sandbox.deal ALTER COLUMN deal_code SET NOT NULL;
ALTER TABLE sandbox.deal ADD CONSTRAINT deal_code_uq UNIQUE (deal_code);
ALTER TABLE sandbox.deal
  ADD CONSTRAINT deal_code_shape CHECK (deal_code ~ '^[A-Z]{3}-[0-9A-HJ-NP-Z]{4}$');

COMMENT ON TABLE sandbox.reward_event IS
  'SafePoints. NOT money: non-transferable, non-redeemable for cash, no payout '
  'or withdrawal path exists. Unlocks a platform fee discount only.';

COMMENT ON TABLE sandbox.payment_method IS
  'Addressing information for transfers made OUTSIDE this system. Holds no '
  'credential: no PIN, password, CVV, full card number or bank login may ever '
  'be stored here.';

COMMENT ON TABLE sandbox.deal_evidence IS
  'Participant-supplied evidence bytes for a single deal. Readable only by the '
  'two participants and a reviewing operator; never public, never in an unfurl.';
