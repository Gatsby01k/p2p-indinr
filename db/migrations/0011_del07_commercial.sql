-- =====================================================================
-- 0011 — DEL-07: fees, premium, referrals, rewards and reputation.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  THE COMMERCIAL LAYER IS WHERE A FINTECH LIES TO PEOPLE.         │
-- │                                                                  │
-- │  Not usually by stealing. By recalculating after acceptance, by  │
-- │  crossing out a price that was never charged, by letting a       │
-- │  client pick its own discount, by stacking promotions until the  │
-- │  fee is negative, or by quietly applying a new schedule to a     │
-- │  deal somebody already agreed to.                                │
-- │                                                                  │
-- │  Every table here is shaped against exactly those. A fee policy  │
-- │  is IMMUTABLE and VERSIONED. The complete calculation is         │
-- │  SNAPSHOTTED into the quote, so activating a new policy tomorrow │
-- │  cannot touch a deal agreed today. A discount exists only        │
-- │  because an active policy version says so. And the arithmetic is │
-- │  exact integers throughout — there is no floating-point money    │
-- │  anywhere in this schema or the code that reads it.              │
-- └──────────────────────────────────────────────────────────────────┘
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT CREATE: a withdrawable
-- reward balance, a custodial INR account, a subscription provider, or
-- any path by which a reward mints ledger value. A reward here is a
-- bounded discount on a future fee, or a temporary entitlement. It is
-- never money.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Vocabulary.
-- ---------------------------------------------------------------------

CREATE TYPE sandbox.fee_asset AS ENUM ('INR', 'USDT');
CREATE TYPE sandbox.policy_state AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');
CREATE TYPE sandbox.entitlement_state AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');
CREATE TYPE sandbox.referral_state AS ENUM ('ATTRIBUTED', 'QUALIFIED', 'DISQUALIFIED');
CREATE TYPE sandbox.reward_state AS ENUM ('GRANTED', 'REDEEMED', 'EXPIRED', 'CANCELLED');

ALTER TABLE sandbox.audit_event DROP CONSTRAINT audit_event_subject_kind;
ALTER TABLE sandbox.audit_event ADD CONSTRAINT audit_event_subject_kind
  CHECK (subject_kind IN ('link','deal','quote','user','payment','case','evidence','policy'));

ALTER TABLE sandbox.outbox_event DROP CONSTRAINT outbox_event_subject_kind;
ALTER TABLE sandbox.outbox_event ADD CONSTRAINT outbox_event_subject_kind
  CHECK (subject_kind IN ('link','deal','quote','user','payment','case','evidence','policy'));

-- ---------------------------------------------------------------------
-- 2. Fee policy — immutable and versioned.
--
-- A row here is never edited. Changing a fee means inserting a NEW
-- version and activating it, which leaves the old one readable forever —
-- because every quote issued under it points at it, and a quote whose
-- schedule cannot be re-read is a quote nobody can audit.
--
-- `discount_cap_bps` is the ceiling on ALL discounts combined. Premium,
-- referral and reward compose inside it, so no combination of promotions
-- can drive a fee to zero unless this policy says it may.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.fee_policy (
  policy_id     UUID        NOT NULL DEFAULT gen_random_uuid(),
  policy_key    TEXT        NOT NULL,   -- stable name across versions
  version       INTEGER     NOT NULL,

  scenario      sandbox.direction NOT NULL,
  fee_asset     sandbox.fee_asset NOT NULL,
  -- SERVER-CONTROLLED. No request field reaches this column.
  fee_bearer    TEXT        NOT NULL,

  bps           BIGINT      NOT NULL,
  fixed_minor   BIGINT      NOT NULL DEFAULT 0,
  min_fee_minor BIGINT      NOT NULL DEFAULT 0,
  max_fee_minor BIGINT      NOT NULL,

  discount_cap_bps BIGINT   NOT NULL DEFAULT 0,

  eligibility   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  state         sandbox.policy_state NOT NULL DEFAULT 'DRAFT',
  /*
   * A policy is usable in production ONLY if it says so AND it was
   * activated through maker-checker. Two separate facts: a schedule can
   * be perfectly valid and still not be one anybody approved for real
   * customers.
   */
  production_enabled BOOLEAN NOT NULL DEFAULT FALSE,

  effective_from TIMESTAMPTZ NOT NULL,
  expires_at    TIMESTAMPTZ NULL,

  created_by    UUID        NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at  TIMESTAMPTZ NULL,
  retired_at    TIMESTAMPTZ NULL,

  CONSTRAINT fee_policy_pk PRIMARY KEY (policy_id),
  CONSTRAINT fee_policy_version_uq UNIQUE (policy_key, version),
  CONSTRAINT fee_policy_creator_fk FOREIGN KEY (created_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT fee_policy_bearer CHECK (fee_bearer IN ('PAYER','PAYEE')),
  CONSTRAINT fee_policy_version_pos CHECK (version >= 1),
  -- Exact integers, all non-negative, and a coherent band.
  CONSTRAINT fee_policy_bps CHECK (bps >= 0 AND bps <= 10000),
  CONSTRAINT fee_policy_fixed CHECK (fixed_minor >= 0),
  CONSTRAINT fee_policy_band CHECK (min_fee_minor >= 0 AND max_fee_minor >= min_fee_minor),
  CONSTRAINT fee_policy_cap CHECK (discount_cap_bps >= 0 AND discount_cap_bps <= 10000),
  CONSTRAINT fee_policy_window CHECK (expires_at IS NULL OR expires_at > effective_from),
  CONSTRAINT fee_policy_eligibility_obj CHECK (jsonb_typeof(eligibility) = 'object'),
  CONSTRAINT fee_policy_activated CHECK ((state = 'DRAFT') = (activated_at IS NULL)),
  CONSTRAINT fee_policy_retired CHECK ((state = 'RETIRED') = (retired_at IS NOT NULL)),
  /*
   * A NON-CUSTODIAL INR FEE IS NOT COLLECTIBLE, AND THE SCHEMA SAYS SO.
   *
   * INRP2P holds no rupees (TS-02 §4), so an INR-denominated fee cannot
   * be taken from a ledger balance. Such a policy may exist for DISPLAY
   * — the quote still shows the customer what the fee is — but it can
   * never be marked production-collectible, because collecting it would
   * require either a custodial INR balance or an invented receivable.
   */
  CONSTRAINT fee_policy_inr_not_collectible CHECK (
    fee_asset <> 'INR' OR production_enabled = FALSE)
);

/*
 * AT MOST ONE ACTIVE SCHEDULE PER CORRIDOR.
 *
 * Keyed on SCENARIO rather than `policy_key`, and that distinction
 * matters: two active schedules for the same corridor — even under
 * different names — means the price a customer is quoted depends on
 * which row a query happened to order first. That is not a
 * configuration, it is a coin toss with somebody's money.
 *
 * So activating a schedule retires whatever was pricing that corridor,
 * and the index makes a moment with two live ones unrepresentable.
 */
CREATE UNIQUE INDEX fee_policy_active_uq
  ON sandbox.fee_policy (scenario)
  WHERE state = 'ACTIVE';

CREATE INDEX fee_policy_lookup_ix
  ON sandbox.fee_policy (scenario, state, effective_from);

/*
 * A policy is IMMUTABLE in its terms. Only the lifecycle columns move.
 *
 * Every quote ever issued under a version points at it. Editing the rate
 * afterwards would silently rewrite what those customers were charged,
 * and no amount of good intent makes that acceptable.
 */
CREATE FUNCTION sandbox.trg_fee_policy_immutable() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, sandbox, public
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fee policies are permanent; retire them instead'
      USING ERRCODE = '42501';
  END IF;
  IF (NEW.policy_key, NEW.version, NEW.scenario, NEW.fee_asset, NEW.fee_bearer,
      NEW.bps, NEW.fixed_minor, NEW.min_fee_minor, NEW.max_fee_minor,
      NEW.discount_cap_bps, NEW.eligibility, NEW.effective_from, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.policy_key, OLD.version, OLD.scenario, OLD.fee_asset, OLD.fee_bearer,
      OLD.bps, OLD.fixed_minor, OLD.min_fee_minor, OLD.max_fee_minor,
      OLD.discount_cap_bps, OLD.eligibility, OLD.effective_from, OLD.expires_at) THEN
    RAISE EXCEPTION
      'fee policy %/% is immutable; publish a new version instead',
      OLD.policy_key, OLD.version USING ERRCODE = '42501';
  END IF;
  IF OLD.state = 'RETIRED' AND NEW.state <> 'RETIRED' THEN
    RAISE EXCEPTION 'fee policy %/% is retired', OLD.policy_key, OLD.version
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER fee_policy_immutable
  BEFORE UPDATE OR DELETE ON sandbox.fee_policy
  FOR EACH ROW EXECUTE FUNCTION sandbox.trg_fee_policy_immutable();

-- ---------------------------------------------------------------------
-- 3. Policy activation — maker-checker, reusing the DEL-06 shape.
--
-- Activating a fee schedule changes what every future customer pays. It
-- is at least as consequential as a dispute ruling, so it gets the same
-- protection: one authorised person proposes, a DIFFERENT one approves,
-- and self-approval is refused by a CHECK rather than by a convention.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.fee_policy_activation (
  activation_id UUID       NOT NULL DEFAULT gen_random_uuid(),
  policy_id     UUID       NOT NULL,
  proposed_by   UUID       NOT NULL,
  rationale     TEXT       NOT NULL,
  state         sandbox.proposal_state NOT NULL DEFAULT 'PROPOSED',
  approved_by   UUID       NULL,
  decided_at    TIMESTAMPTZ NULL,
  decision_note TEXT       NULL,
  proposed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fee_policy_activation_pk PRIMARY KEY (activation_id),
  CONSTRAINT fee_policy_activation_policy_fk FOREIGN KEY (policy_id)
    REFERENCES sandbox.fee_policy (policy_id),
  CONSTRAINT fee_policy_activation_maker_fk FOREIGN KEY (proposed_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT fee_policy_activation_checker_fk FOREIGN KEY (approved_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT fee_policy_activation_rationale CHECK (char_length(rationale) BETWEEN 20 AND 4000),
  -- THE RULE, in the database.
  CONSTRAINT activation_no_self_approval CHECK (
    approved_by IS NULL OR approved_by <> proposed_by),
  CONSTRAINT fee_policy_activation_decided CHECK ((state = 'PROPOSED') = (decided_at IS NULL)),
  CONSTRAINT fee_policy_activation_approved CHECK (
    state <> 'APPROVED' OR approved_by IS NOT NULL)
);

CREATE UNIQUE INDEX fee_policy_activation_live_uq
  ON sandbox.fee_policy_activation (policy_id) WHERE state = 'PROPOSED';
CREATE UNIQUE INDEX fee_policy_activation_approved_uq
  ON sandbox.fee_policy_activation (policy_id) WHERE state = 'APPROVED';

-- ---------------------------------------------------------------------
-- 4. The quote snapshot — the complete economic result, frozen.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  THIS TABLE IS THE PROMISE.                                      │
-- │                                                                  │
-- │  Everything the customer was shown before they accepted lives    │
-- │  here: which policy version priced it, the base fee, every       │
-- │  discount component with its source, the bounds that were        │
-- │  applied, the final fee, and what each side ends up with.        │
-- │                                                                  │
-- │  It is written ONCE and never updated. Activating a new policy   │
-- │  tomorrow cannot reach a row here, so "an accepted quote never   │
-- │  changes" is a property of the schema and not of anybody's       │
-- │  discipline.                                                     │
-- └──────────────────────────────────────────────────────────────────┘
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.quote_fee_snapshot (
  snapshot_id   UUID        NOT NULL DEFAULT gen_random_uuid(),
  quote_id      UUID        NOT NULL,
  policy_id     UUID        NOT NULL,
  policy_key    TEXT        NOT NULL,
  policy_version INTEGER    NOT NULL,

  fee_asset     sandbox.fee_asset NOT NULL,
  fee_bearer    TEXT        NOT NULL,

  -- Every step of the canonical order, kept separately so a customer
  -- support conversation can answer "why is the fee this number?".
  base_fee_minor      BIGINT NOT NULL,
  premium_discount_minor  BIGINT NOT NULL DEFAULT 0,
  referral_discount_minor BIGINT NOT NULL DEFAULT 0,
  reward_discount_minor   BIGINT NOT NULL DEFAULT 0,
  discount_capped_minor   BIGINT NOT NULL DEFAULT 0,
  bounded_fee_minor   BIGINT NOT NULL,
  final_fee_minor     BIGINT NOT NULL,

  payer_sends_minor    BIGINT NOT NULL,
  payee_receives_minor BIGINT NOT NULL,

  -- Which entitlements were applied, by id, so the claim is checkable.
  premium_grant_id UUID     NULL,
  referral_id      UUID     NULL,
  reward_grant_id  UUID     NULL,

  components    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT quote_fee_snapshot_pk PRIMARY KEY (snapshot_id),
  -- One snapshot per quote: a second would be a second promise.
  CONSTRAINT quote_fee_snapshot_quote_uq UNIQUE (quote_id),
  CONSTRAINT quote_fee_snapshot_quote_fk FOREIGN KEY (quote_id)
    REFERENCES sandbox.quote (quote_id),
  CONSTRAINT quote_fee_snapshot_policy_fk FOREIGN KEY (policy_id)
    REFERENCES sandbox.fee_policy (policy_id),
  CONSTRAINT quote_fee_snapshot_bearer CHECK (fee_bearer IN ('PAYER','PAYEE')),
  CONSTRAINT quote_fee_snapshot_components_obj CHECK (jsonb_typeof(components) = 'object'),
  -- NO NEGATIVE FEE, ever, whatever the discounts said.
  CONSTRAINT quote_fee_snapshot_nonneg CHECK (
    base_fee_minor >= 0 AND final_fee_minor >= 0 AND bounded_fee_minor >= 0
    AND premium_discount_minor >= 0 AND referral_discount_minor >= 0
    AND reward_discount_minor >= 0 AND discount_capped_minor >= 0),
  -- A discount cannot exceed the base it discounts.
  CONSTRAINT quote_fee_snapshot_discount_bounded CHECK (
    premium_discount_minor + referral_discount_minor + reward_discount_minor
      <= base_fee_minor + discount_capped_minor),
  -- NO NEGATIVE NET. A deal that leaves the payee owing money is not a deal.
  CONSTRAINT quote_fee_snapshot_net CHECK (
    payer_sends_minor > 0 AND payee_receives_minor > 0)
);

CREATE INDEX quote_fee_snapshot_policy_ix ON sandbox.quote_fee_snapshot (policy_id);

CREATE FUNCTION sandbox.trg_snapshot_immutable() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, sandbox, public
AS $fn$
BEGIN
  RAISE EXCEPTION
    'a quote fee snapshot is the promise made to a customer and cannot change'
    USING ERRCODE = '42501';
END;
$fn$;

CREATE TRIGGER quote_fee_snapshot_immutable
  BEFORE UPDATE OR DELETE ON sandbox.quote_fee_snapshot
  FOR EACH ROW EXECUTE FUNCTION sandbox.trg_snapshot_immutable();

-- ---------------------------------------------------------------------
-- 5. Fee collection.
--
-- ONE COLLECTION PER DEAL, carrying the ledger entry that took it. The
-- unique constraints are what make "a replay cannot collect twice" and
-- "concurrent settlement cannot collect twice" structural rather than
-- careful.
--
-- `uncollectible_reason` is the honest branch: when a fee cannot be
-- taken through the supported locked asset, the row records WHY and no
-- entry is posted. Not a receivable, not a claim that somebody paid.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.fee_collection (
  collection_id UUID       NOT NULL DEFAULT gen_random_uuid(),
  deal_id       UUID       NOT NULL,
  snapshot_id   UUID       NOT NULL,
  command_id    UUID       NOT NULL,

  fee_asset     sandbox.fee_asset NOT NULL,
  amount_minor  BIGINT     NOT NULL,
  collected     BOOLEAN    NOT NULL,
  uncollectible_reason TEXT NULL,

  ledger_entry_id  UUID    NULL,
  reversal_entry_id UUID   NULL,
  collected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fee_collection_pk PRIMARY KEY (collection_id),
  CONSTRAINT fee_collection_deal_uq UNIQUE (deal_id),
  CONSTRAINT fee_collection_command_uq UNIQUE (command_id),
  CONSTRAINT fee_collection_deal_fk FOREIGN KEY (deal_id) REFERENCES sandbox.deal (deal_id),
  CONSTRAINT fee_collection_snapshot_fk FOREIGN KEY (snapshot_id)
    REFERENCES sandbox.quote_fee_snapshot (snapshot_id),
  CONSTRAINT fee_collection_amount CHECK (amount_minor >= 0),
  -- Collected means an entry; uncollectible means a stated reason. There
  -- is no third state where money was taken and nobody knows how.
  CONSTRAINT fee_collection_entry CHECK (
    (collected = TRUE  AND ledger_entry_id IS NOT NULL AND uncollectible_reason IS NULL)
 OR (collected = FALSE AND ledger_entry_id IS NULL     AND uncollectible_reason IS NOT NULL))
);

CREATE UNIQUE INDEX fee_collection_entry_uq
  ON sandbox.fee_collection (ledger_entry_id) WHERE ledger_entry_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 6. Premium entitlements.
--
-- Server-authoritative and session-independent: there is no premium flag
-- on a session, a cookie or a user row. Whether somebody is premium is a
-- question answered by reading live grants at the moment it matters.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.premium_grant (
  grant_id      UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL,
  -- Where this entitlement came from. `SANDBOX_MANUAL` is unavailable in
  -- production, enforced in the service and stated here so a dump shows
  -- immediately which grants were conjured for a demonstration.
  source        TEXT        NOT NULL,
  source_ref    TEXT        NULL,
  discount_bps  BIGINT      NOT NULL,

  starts_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  state         sandbox.entitlement_state NOT NULL DEFAULT 'ACTIVE',
  revoked_at    TIMESTAMPTZ NULL,
  revoked_by    UUID        NULL,
  revoke_reason TEXT        NULL,

  granted_by    UUID        NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT premium_grant_pk PRIMARY KEY (grant_id),
  CONSTRAINT premium_grant_user_fk FOREIGN KEY (user_id) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT premium_grant_granter_fk FOREIGN KEY (granted_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT premium_grant_revoker_fk FOREIGN KEY (revoked_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT premium_grant_source CHECK (
    source IN ('SUBSCRIPTION','REWARD_CAMPAIGN','SANDBOX_MANUAL')),
  CONSTRAINT premium_grant_discount CHECK (discount_bps > 0 AND discount_bps <= 10000),
  CONSTRAINT premium_grant_window CHECK (expires_at > starts_at),
  CONSTRAINT premium_grant_revoked CHECK (
    (state = 'REVOKED') = (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL))
);

CREATE INDEX premium_grant_live_ix
  ON sandbox.premium_grant (user_id, expires_at)
  WHERE state = 'ACTIVE';

-- ---------------------------------------------------------------------
-- 7. Referrals.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  ONE DURABLE REFERRER PER ACCOUNT, DECIDED ONCE.                 │
-- │                                                                  │
-- │  `referral_attribution_referee_uq` is a plain UNIQUE on the      │
-- │  referee, not a partial index: attribution is not something that │
-- │  gets reconsidered. Two referrers racing to claim the same new   │
-- │  account is exactly the abuse this prevents, and the database    │
-- │  decides it rather than whichever request checked first.         │
-- │                                                                  │
-- │  Self-referral is a CHECK. Cycles are refused in the service,    │
-- │  because a cycle is a graph property a row constraint cannot     │
-- │  see — and the test for it drives the real function.             │
-- └──────────────────────────────────────────────────────────────────┘
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.referral_code (
  code_id     UUID        NOT NULL DEFAULT gen_random_uuid(),
  owner_id    UUID        NOT NULL,
  -- The canonical form: upper-case, no ambiguous characters. Stored
  -- normalized so uniqueness means what it looks like it means.
  code        TEXT        NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT referral_code_pk PRIMARY KEY (code_id),
  CONSTRAINT referral_code_uq UNIQUE (code),
  CONSTRAINT referral_code_owner_uq UNIQUE (owner_id),
  CONSTRAINT referral_code_owner_fk FOREIGN KEY (owner_id) REFERENCES sandbox.app_user (user_id),
  /*
   * 10 characters from an unambiguous alphabet, generated from a CSPRNG.
   * Long enough that enumeration is pointless; restricted enough that a
   * person reading one aloud does not create a different code.
   */
  CONSTRAINT referral_code_shape CHECK (code ~ '^[2-9A-HJ-NP-Z]{10}$')
);

CREATE TABLE sandbox.referral_attribution (
  referral_id UUID        NOT NULL DEFAULT gen_random_uuid(),
  referrer_id UUID        NOT NULL,
  referee_id  UUID        NOT NULL,
  code_id     UUID        NOT NULL,
  state       sandbox.referral_state NOT NULL DEFAULT 'ATTRIBUTED',

  qualifying_deal_id UUID NULL,
  qualified_at TIMESTAMPTZ NULL,
  disqualified_reason TEXT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT referral_attribution_pk PRIMARY KEY (referral_id),
  -- ONE referrer per account, forever.
  CONSTRAINT referral_attribution_referee_uq UNIQUE (referee_id),
  CONSTRAINT referral_attribution_referrer_fk FOREIGN KEY (referrer_id)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT referral_attribution_referee_fk FOREIGN KEY (referee_id)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT referral_attribution_code_fk FOREIGN KEY (code_id)
    REFERENCES sandbox.referral_code (code_id),
  CONSTRAINT referral_attribution_deal_fk FOREIGN KEY (qualifying_deal_id)
    REFERENCES sandbox.deal (deal_id),
  -- NO SELF-REFERRAL. Not a rule the service remembers; a rule the row
  -- cannot violate.
  CONSTRAINT referral_no_self CHECK (referrer_id <> referee_id),
  CONSTRAINT referral_qualified CHECK (
    (state = 'QUALIFIED') = (qualifying_deal_id IS NOT NULL AND qualified_at IS NOT NULL)),
  CONSTRAINT referral_disqualified CHECK (
    (state = 'DISQUALIFIED') = (disqualified_reason IS NOT NULL))
);

CREATE INDEX referral_attribution_referrer_ix
  ON sandbox.referral_attribution (referrer_id, state);
-- A deal qualifies at most one referral: one economic event, one benefit.
CREATE UNIQUE INDEX referral_attribution_deal_uq
  ON sandbox.referral_attribution (qualifying_deal_id)
  WHERE qualifying_deal_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 8. Rewards — bounded discounts, never money.
--
-- A campaign is versioned and immutable. `commitment` is a hash published
-- BEFORE eligibility opens; when a campaign selects winners it reveals
-- the seed, and anybody can verify the selection was not chosen after
-- seeing who entered. That is the difference between a lottery and a
-- decision made afterwards by whoever ran it.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.reward_campaign (
  campaign_id   UUID        NOT NULL DEFAULT gen_random_uuid(),
  campaign_key  TEXT        NOT NULL,
  version       INTEGER     NOT NULL,

  -- What a grant from this campaign is worth. Exactly one form, chosen
  -- here: a fee discount, or a temporary premium entitlement.
  benefit_kind  TEXT        NOT NULL,
  discount_bps  BIGINT      NOT NULL DEFAULT 0,
  max_benefit_minor BIGINT  NOT NULL,
  premium_days  INTEGER     NOT NULL DEFAULT 0,

  eligible_from TIMESTAMPTZ NOT NULL,
  eligible_to   TIMESTAMPTZ NOT NULL,
  grant_ttl_days INTEGER    NOT NULL DEFAULT 30,

  /*
   * The commitment: SHA-256 of the selection seed, published before
   * eligibility opens. The seed itself is revealed at selection time and
   * must hash to this. A campaign that cannot show its commitment cannot
   * run a random selection at all.
   */
  commitment    TEXT        NULL,
  revealed_seed TEXT        NULL,
  revealed_at   TIMESTAMPTZ NULL,

  -- Sandbox campaigns are marked, so a demonstration reward can never be
  -- mistaken for one a real customer earned.
  sandbox_only  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT reward_campaign_pk PRIMARY KEY (campaign_id),
  CONSTRAINT reward_campaign_version_uq UNIQUE (campaign_key, version),
  CONSTRAINT reward_campaign_kind CHECK (benefit_kind IN ('FEE_DISCOUNT','PREMIUM_DAYS')),
  CONSTRAINT reward_campaign_discount CHECK (discount_bps >= 0 AND discount_bps <= 10000),
  CONSTRAINT reward_campaign_max CHECK (max_benefit_minor >= 0),
  CONSTRAINT reward_campaign_premium_days CHECK (premium_days >= 0),
  CONSTRAINT reward_campaign_window CHECK (eligible_to > eligible_from),
  CONSTRAINT reward_campaign_ttl CHECK (grant_ttl_days > 0),
  CONSTRAINT reward_campaign_commitment_shape CHECK (
    commitment IS NULL OR commitment ~ '^[0-9a-f]{64}$'),
  -- A revealed seed must actually match the commitment. Checked in the
  -- service (it needs a hash); the column pairing is checked here.
  CONSTRAINT reward_campaign_reveal CHECK (
    (revealed_seed IS NULL) = (revealed_at IS NULL)),
  CONSTRAINT reward_campaign_reveal_needs_commitment CHECK (
    revealed_seed IS NULL OR commitment IS NOT NULL),
  -- The form determines which fields carry meaning.
  CONSTRAINT reward_campaign_form CHECK (
    (benefit_kind = 'FEE_DISCOUNT' AND discount_bps > 0 AND premium_days = 0)
 OR (benefit_kind = 'PREMIUM_DAYS' AND premium_days > 0))
);

CREATE TABLE sandbox.reward_grant (
  grant_id      UUID        NOT NULL DEFAULT gen_random_uuid(),
  campaign_id   UUID        NOT NULL,
  user_id       UUID        NOT NULL,
  -- What earned it, so a grant is always traceable to an economic event.
  source_deal_id UUID       NULL,
  state         sandbox.reward_state NOT NULL DEFAULT 'GRANTED',

  expires_at    TIMESTAMPTZ NOT NULL,
  redeemed_at   TIMESTAMPTZ NULL,
  redeemed_quote_id UUID    NULL,
  cancelled_reason TEXT     NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT reward_grant_pk PRIMARY KEY (grant_id),
  CONSTRAINT reward_grant_campaign_fk FOREIGN KEY (campaign_id)
    REFERENCES sandbox.reward_campaign (campaign_id),
  CONSTRAINT reward_grant_user_fk FOREIGN KEY (user_id) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT reward_grant_deal_fk FOREIGN KEY (source_deal_id)
    REFERENCES sandbox.deal (deal_id),
  CONSTRAINT reward_grant_quote_fk FOREIGN KEY (redeemed_quote_id)
    REFERENCES sandbox.quote (quote_id),
  -- SINGLE USE: redeemed means a quote, and nothing else does.
  CONSTRAINT reward_grant_redeemed CHECK (
    (state = 'REDEEMED') = (redeemed_at IS NOT NULL AND redeemed_quote_id IS NOT NULL)),
  CONSTRAINT reward_grant_cancelled CHECK (
    (state = 'CANCELLED') = (cancelled_reason IS NOT NULL))
);

-- One grant per campaign per user per source deal: a redelivered event
-- cannot mint a second reward for the same thing.
CREATE UNIQUE INDEX reward_grant_source_uq
  ON sandbox.reward_grant (campaign_id, user_id, source_deal_id)
  WHERE source_deal_id IS NOT NULL;

CREATE INDEX reward_grant_inventory_ix
  ON sandbox.reward_grant (user_id, expires_at) WHERE state = 'GRANTED';

-- A quote consumes at most one reward.
CREATE UNIQUE INDEX reward_grant_quote_uq
  ON sandbox.reward_grant (redeemed_quote_id) WHERE redeemed_quote_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 9. Reputation — computed from immutable events.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  A SCORE IS NOT A COLUMN SOMEBODY SETS.                          │
-- │                                                                  │
-- │  There is no `app_user.reputation`. There are EVENTS, each one   │
-- │  immutable and each one carrying a dedup key so a redelivered    │
-- │  signal cannot count twice, and a VERSIONED model that turns     │
-- │  them into a number. Any score can be recomputed from the events │
-- │  that produced it, which is the only way to answer "why is my    │
-- │  rating this?" honestly.                                         │
-- │                                                                  │
-- │  Corrections are ADDITIVE: a reversed deal adds a negative       │
-- │  event, it does not delete the positive one. The history of what │
-- │  was believed, and when it stopped being true, both survive.     │
-- └──────────────────────────────────────────────────────────────────┘
--
-- NO PROTECTED ATTRIBUTE APPEARS HERE. The signal list is deliberately
-- limited to conduct on this platform.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.reputation_event (
  event_id      UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL,
  signal        TEXT        NOT NULL,
  -- Signed points, in the model's units. Negative for adverse signals.
  points        INTEGER     NOT NULL,
  deal_id       UUID        NULL,
  /*
   * The idempotency key for a SIGNAL. Derived from what caused it — the
   * deal, the case, the incident — so the same underlying fact reported
   * twice produces one event.
   */
  dedup_key     TEXT        NOT NULL,
  -- Additive corrections point at what they correct.
  corrects      UUID        NULL,
  detail        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT reputation_event_pk PRIMARY KEY (event_id),
  CONSTRAINT reputation_event_dedup_uq UNIQUE (dedup_key),
  CONSTRAINT reputation_event_user_fk FOREIGN KEY (user_id) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT reputation_event_deal_fk FOREIGN KEY (deal_id) REFERENCES sandbox.deal (deal_id),
  CONSTRAINT reputation_event_corrects_fk FOREIGN KEY (corrects)
    REFERENCES sandbox.reputation_event (event_id),
  CONSTRAINT reputation_event_detail_obj CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT reputation_event_signal CHECK (
    signal IN ('DEAL_COMPLETED','VOLUME_SETTLED','PAID_ON_TIME','PAID_LATE',
               'DEAL_CANCELLED','DISPUTE_RAISED','DISPUTE_LOST','REVERSAL_INCIDENT',
               'EVIDENCE_PROVIDED','ACCOUNT_VERIFIED','CORRECTION'))
);

CREATE INDEX reputation_event_user_ix ON sandbox.reputation_event (user_id, occurred_at);

CREATE FUNCTION sandbox.trg_reputation_immutable() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, sandbox, public
AS $fn$
BEGIN
  RAISE EXCEPTION
    'reputation history is append-only; correct it with an additive event'
    USING ERRCODE = '42501';
END;
$fn$;

CREATE TRIGGER reputation_event_immutable
  BEFORE UPDATE OR DELETE ON sandbox.reputation_event
  FOR EACH ROW EXECUTE FUNCTION sandbox.trg_reputation_immutable();

-- ---------------------------------------------------------------------
-- 10. Benefit adjustments — the honest record when a benefit goes wrong.
--
-- A reward granted for a deal that is later reversed must be cancelled.
-- If it was ALREADY USED, it is not silently debited from the person's
-- money: a loss row is written instead, because the alternative is
-- taking value from a customer for something the platform got wrong.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.benefit_adjustment (
  adjustment_id UUID       NOT NULL DEFAULT gen_random_uuid(),
  user_id       UUID       NOT NULL,
  kind          TEXT       NOT NULL,
  deal_id       UUID       NULL,
  reward_grant_id UUID     NULL,
  premium_grant_id UUID    NULL,
  amount_minor  BIGINT     NOT NULL DEFAULT 0,
  reason        TEXT       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT benefit_adjustment_pk PRIMARY KEY (adjustment_id),
  CONSTRAINT benefit_adjustment_user_fk FOREIGN KEY (user_id)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT benefit_adjustment_deal_fk FOREIGN KEY (deal_id)
    REFERENCES sandbox.deal (deal_id),
  CONSTRAINT benefit_adjustment_reward_fk FOREIGN KEY (reward_grant_id)
    REFERENCES sandbox.reward_grant (grant_id),
  CONSTRAINT benefit_adjustment_premium_fk FOREIGN KEY (premium_grant_id)
    REFERENCES sandbox.premium_grant (grant_id),
  CONSTRAINT benefit_adjustment_kind CHECK (
    kind IN ('REWARD_CANCELLED','PREMIUM_REVOKED','REFERRAL_DISQUALIFIED',
             'BENEFIT_ALREADY_CONSUMED_LOSS')),
  CONSTRAINT benefit_adjustment_reason_len CHECK (char_length(reason) BETWEEN 10 AND 2000),
  CONSTRAINT benefit_adjustment_amount CHECK (amount_minor >= 0)
);

CREATE INDEX benefit_adjustment_user_ix ON sandbox.benefit_adjustment (user_id, created_at);

-- ---------------------------------------------------------------------
-- 11. The sandbox's opening fee schedules.
--
-- These reproduce the ACCEPTED figures from `src/lib/fees.ts` exactly —
-- 1.50% / ₹25 / ₹2,000 for protected payments, 1.25% / ₹25 / ₹2,500 plus
-- a ₹180 network fee for exchanges — so introducing versioned policy
-- changes nobody's price on the day it ships.
--
-- THE NON-RETROACTIVE MIGRATION STRATEGY, stated explicitly: quotes
-- issued before this migration have NO snapshot row, and the collection
-- path treats a missing snapshot as "priced under the pre-policy rules"
-- and refuses to invent one. A legacy deal is never re-priced.
--
-- All three are `production_enabled = FALSE`. Production requires a
-- maker-checker activation that nobody has performed.
-- ---------------------------------------------------------------------

INSERT INTO sandbox.fee_policy
  (policy_key, version, scenario, fee_asset, fee_bearer, bps, fixed_minor,
   min_fee_minor, max_fee_minor, discount_cap_bps, state, effective_from, activated_at)
VALUES
  ('protected-inr', 1, 'INR_TO_INR', 'INR', 'PAYER',
   150, 0, 2500, 200000, 5000, 'ACTIVE', now(), now()),
  ('exchange-usdt-to-inr', 1, 'USDT_TO_INR', 'INR', 'PAYER',
   125, 18000, 2500, 250000, 5000, 'ACTIVE', now(), now()),
  ('exchange-inr-to-usdt', 1, 'INR_TO_USDT', 'INR', 'PAYER',
   125, 18000, 2500, 250000, 5000, 'ACTIVE', now(), now());

-- ---------------------------------------------------------------------
-- 12. The one journal DEL-07 may post.
--
-- A platform fee is REVENUE: the beneficiary's balance is debited by the
-- snapshotted amount and `fee_revenue` is credited. It is posted only at
-- a successful release, only once per deal, and only for a USDT-
-- denominated fee — because that is the only asset there is a balance to
-- take it from.
-- ---------------------------------------------------------------------

INSERT INTO inrp2p.journal_catalogue (journal_code, entry_class, description) VALUES
  ('JD-FEE', 'SNJ',
   'Platform fee collected at a successful release, for the exact amount frozen '
   'into the quote''s fee snapshot. Debits the beneficiary balance and credits '
   'fee revenue. Never posted on a refund, cancellation or reversal.')
ON CONFLICT (journal_code) DO NOTHING;

-- ---------------------------------------------------------------------
-- 13. Read models.
-- ---------------------------------------------------------------------

CREATE VIEW sandbox.reputation_standing AS
  SELECT e.user_id,
         sum(e.points)::BIGINT                                        AS points,
         count(*) FILTER (WHERE e.signal = 'DEAL_COMPLETED')::INTEGER AS completed_deals,
         count(*) FILTER (WHERE e.signal = 'DISPUTE_LOST')::INTEGER   AS disputes_lost,
         min(e.occurred_at)                                           AS first_event_at,
         max(e.occurred_at)                                           AS last_event_at
    FROM sandbox.reputation_event e
   GROUP BY e.user_id;

COMMENT ON VIEW sandbox.reputation_standing IS
  'Reputation recomputed from source events on every read. There is no '
  'stored score to drift, and no column an operator could set by hand. '
  'Bands and public exposure are decided in the service; this view is '
  'internal and carries the raw signal counts.';

CREATE VIEW sandbox.fee_schedule_public AS
  SELECT p.policy_key, p.version, p.scenario, p.fee_asset, p.fee_bearer,
         p.bps, p.fixed_minor, p.min_fee_minor, p.max_fee_minor,
         p.discount_cap_bps, p.effective_from, p.expires_at
    FROM sandbox.fee_policy p
   WHERE p.state = 'ACTIVE';

COMMENT ON VIEW sandbox.fee_schedule_public IS
  'The active schedules, publishable. Carries no eligibility rules and no '
  'draft or retired version: what a customer is charged should be legible, '
  'and what is being considered internally is not their business.';
