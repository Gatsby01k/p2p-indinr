-- =====================================================================
-- 0012 — DEL-08: risk, compliance and operator operations.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  THIS IS A CONTROL PLANE, NOT A COMPLIANCE CLAIM.                │
-- │                                                                  │
-- │  It can stop a payment, hold a deal, queue a case and record why │
-- │  — enforceably, at the server, with evidence. It CANNOT and does │
-- │  not assert that anybody was screened against a real sanctions   │
-- │  list, that a regulator approved anything, or that a legal       │
-- │  obligation was discharged. No provider is connected. Every      │
-- │  screening row here carries the provider that produced it, and   │
-- │  the sandbox provider says so in its name.                       │
-- │                                                                  │
-- │  A system that says "compliant" without a provider behind it is  │
-- │  worse than one that says nothing: it stops people looking.      │
-- └──────────────────────────────────────────────────────────────────┘
--
-- THE ENFORCEMENT PRINCIPLE, in one line: a hold is a row this schema
-- holds, read live at the protected boundary, inside the same
-- transaction as the mutation it blocks. Hiding a button is not
-- enforcement, and nothing here relies on a screen behaving.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Vocabulary.
-- ---------------------------------------------------------------------

CREATE TYPE sandbox.risk_decision AS ENUM (
  'ALLOW',    -- proceed
  'STEP_UP',  -- proceed once a stronger check is satisfied
  'REVIEW',   -- proceed, but a case is opened behind it
  'HOLD',     -- BLOCK, reversibly, pending a person
  'REJECT'    -- BLOCK, terminally
);

/*
 * The enforcement points. A closed list, because "where is risk
 * evaluated?" must be answerable by reading one type rather than by
 * grepping for call sites.
 */
CREATE TYPE sandbox.enforcement_point AS ENUM (
  'ACCOUNT_VERIFY',
  'ACCOUNT_LINK',
  'QUOTE_ISSUE',
  'DEAL_JOIN',
  'VALUE_LOCK',
  'INSTRUCTION_DISCLOSE',
  'RAIL_OBSERVE',
  'DEAL_COMPLETE',
  'ESCROW_RELEASE',
  'ESCROW_REFUND',
  'DISPUTE_RESOLVE',
  'REFERRAL_QUALIFY',
  'REWARD_GRANT',
  'REWARD_REDEEM',
  'PREMIUM_CHANGE',
  'OPERATOR_ACTION'
);

CREATE TYPE sandbox.case_kind AS ENUM (
  'IDENTITY_REVIEW',
  'TRANSACTION_ALERT',
  'PAYMENT_ANOMALY',
  'ACCOUNT_TAKEOVER',
  'REWARD_ABUSE',
  'RAIL_INCIDENT',
  'POST_SETTLEMENT_COMPLAINT',
  'EVIDENCE_INCIDENT',
  'OPERATOR_SECURITY'
);

CREATE TYPE sandbox.ops_case_state AS ENUM (
  'OPEN', 'ASSIGNED', 'ESCALATED', 'RESOLVED', 'CLOSED'
);

CREATE TYPE sandbox.screening_kind AS ENUM (
  'SANCTIONS', 'PEP', 'ADVERSE_MEDIA', 'IDENTITY', 'PAYMENT_RISK'
);

CREATE TYPE sandbox.control_scope AS ENUM (
  'CORRIDOR', 'QUOTE_ISSUE', 'DEAL_JOIN', 'INSTRUCTION_DISCLOSE',
  'RAIL_CONFIRM', 'SETTLEMENT', 'REWARDS'
);

ALTER TABLE sandbox.audit_event DROP CONSTRAINT audit_event_subject_kind;
ALTER TABLE sandbox.audit_event ADD CONSTRAINT audit_event_subject_kind
  CHECK (subject_kind IN ('link','deal','quote','user','payment','case','evidence',
                          'policy','control'));

ALTER TABLE sandbox.outbox_event DROP CONSTRAINT outbox_event_subject_kind;
ALTER TABLE sandbox.outbox_event ADD CONSTRAINT outbox_event_subject_kind
  CHECK (subject_kind IN ('link','deal','quote','user','payment','case','evidence',
                          'policy','control'));

-- ---------------------------------------------------------------------
-- 2. Risk policy — immutable, versioned, and explicitly NOT a model.
--
-- `rules` is a JSONB array of DECLARATIVE rules, each with a code, a
-- signal, a comparison and a decision. That shape is deliberate: every
-- decision this engine makes can be explained by naming the rule codes
-- that matched, and a person can read the policy and predict the
-- outcome. An opaque score would satisfy the same interface and answer
-- none of the questions that matter when somebody's money is held.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.risk_policy (
  policy_id     UUID        NOT NULL DEFAULT gen_random_uuid(),
  policy_key    TEXT        NOT NULL,
  version       INTEGER     NOT NULL,
  point         sandbox.enforcement_point NOT NULL,

  rules         JSONB       NOT NULL,
  -- The decision when NO rule matches. `ALLOW` for ordinary points;
  -- a stricter default is a deliberate choice a policy author makes.
  default_decision sandbox.risk_decision NOT NULL DEFAULT 'ALLOW',

  state         sandbox.policy_state NOT NULL DEFAULT 'DRAFT',
  production_enabled BOOLEAN NOT NULL DEFAULT FALSE,

  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID        NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at  TIMESTAMPTZ NULL,
  retired_at    TIMESTAMPTZ NULL,

  CONSTRAINT risk_policy_pk PRIMARY KEY (policy_id),
  CONSTRAINT risk_policy_version_uq UNIQUE (policy_key, version),
  CONSTRAINT risk_policy_creator_fk FOREIGN KEY (created_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT risk_policy_rules_array CHECK (jsonb_typeof(rules) = 'array'),
  CONSTRAINT risk_policy_version_pos CHECK (version >= 1),
  CONSTRAINT risk_policy_activated CHECK ((state = 'DRAFT') = (activated_at IS NULL)),
  CONSTRAINT risk_policy_retired CHECK ((state = 'RETIRED') = (retired_at IS NOT NULL))
);

-- One live policy per enforcement point, for the same reason DEL-07 has
-- one live schedule per corridor: two would make the decision depend on
-- which row a query ordered first.
CREATE UNIQUE INDEX risk_policy_active_uq
  ON sandbox.risk_policy (point) WHERE state = 'ACTIVE';

CREATE FUNCTION sandbox.trg_risk_policy_immutable() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, sandbox, public
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'risk policies are permanent; retire them instead'
      USING ERRCODE = '42501';
  END IF;
  IF (NEW.policy_key, NEW.version, NEW.point, NEW.rules, NEW.default_decision)
     IS DISTINCT FROM
     (OLD.policy_key, OLD.version, OLD.point, OLD.rules, OLD.default_decision) THEN
    RAISE EXCEPTION
      'risk policy %/% is immutable; publish a new version instead',
      OLD.policy_key, OLD.version USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER risk_policy_immutable
  BEFORE UPDATE OR DELETE ON sandbox.risk_policy
  FOR EACH ROW EXECUTE FUNCTION sandbox.trg_risk_policy_immutable();

-- ---------------------------------------------------------------------
-- 3. Risk decisions — the evidence.
--
-- Every evaluation is written down, ALLOW included. A control plane that
-- only records refusals cannot answer "why was this allowed?", which is
-- the question asked after something goes wrong.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.risk_decision_log (
  decision_id   UUID        NOT NULL DEFAULT gen_random_uuid(),
  policy_id     UUID        NOT NULL,
  policy_key    TEXT        NOT NULL,
  policy_version INTEGER    NOT NULL,
  point         sandbox.enforcement_point NOT NULL,

  subject_kind  TEXT        NOT NULL,
  subject_id    TEXT        NOT NULL,
  actor_id      UUID        NULL,

  -- The NORMALIZED signals the decision saw, so it can be replayed.
  signals       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  matched_rules TEXT[]      NOT NULL DEFAULT '{}',
  decision      sandbox.risk_decision NOT NULL,
  reason_codes  TEXT[]      NOT NULL DEFAULT '{}',

  command_id    UUID        NULL,
  correlation_id TEXT       NOT NULL,
  -- When a HOLD stops applying by itself, if ever.
  expires_at    TIMESTAMPTZ NULL,
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT risk_decision_pk PRIMARY KEY (decision_id),
  CONSTRAINT risk_decision_policy_fk FOREIGN KEY (policy_id)
    REFERENCES sandbox.risk_policy (policy_id),
  CONSTRAINT risk_decision_actor_fk FOREIGN KEY (actor_id)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT risk_decision_signals_obj CHECK (jsonb_typeof(signals) = 'object'),
  CONSTRAINT risk_decision_subject_kind CHECK (
    subject_kind IN ('user','deal','quote','payment','case','reward','link'))
);

CREATE INDEX risk_decision_subject_ix
  ON sandbox.risk_decision_log (subject_kind, subject_id, decided_at DESC);
CREATE INDEX risk_decision_point_ix
  ON sandbox.risk_decision_log (point, decided_at DESC);

CREATE FUNCTION sandbox.trg_risk_decision_immutable() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, sandbox, public
AS $fn$
BEGIN
  RAISE EXCEPTION
    'a risk decision is evidence of what was decided and cannot be rewritten'
    USING ERRCODE = '42501';
END;
$fn$;

CREATE TRIGGER risk_decision_immutable
  BEFORE UPDATE OR DELETE ON sandbox.risk_decision_log
  FOR EACH ROW EXECUTE FUNCTION sandbox.trg_risk_decision_immutable();

-- ---------------------------------------------------------------------
-- 4. Holds — the thing that actually blocks.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  A HOLD IS A ROW, READ LIVE, INSIDE THE PROTECTED TRANSACTION.   │
-- │                                                                  │
-- │  Not a flag on a session, not a cached decision, not a hidden    │
-- │  button. `assertNotHeld` reads this table on the caller's `tx`   │
-- │  before the mutation writes, so a hold placed a millisecond ago  │
-- │  stops the very next command.                                    │
-- │                                                                  │
-- │  Releasing one requires maker-checker, because releasing a hold  │
-- │  is the moment somebody's money becomes movable again.           │
-- └──────────────────────────────────────────────────────────────────┘
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.risk_hold (
  hold_id       UUID        NOT NULL DEFAULT gen_random_uuid(),
  subject_kind  TEXT        NOT NULL,
  subject_id    TEXT        NOT NULL,
  point         sandbox.enforcement_point NULL,   -- NULL = every point
  decision_id   UUID        NULL,
  case_id       UUID        NULL,

  reason_code   TEXT        NOT NULL,
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  expires_at    TIMESTAMPTZ NULL,

  placed_by     UUID        NULL,
  placed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_by   UUID        NULL,
  released_at   TIMESTAMPTZ NULL,
  release_reason TEXT       NULL,

  CONSTRAINT risk_hold_pk PRIMARY KEY (hold_id),
  CONSTRAINT risk_hold_decision_fk FOREIGN KEY (decision_id)
    REFERENCES sandbox.risk_decision_log (decision_id),
  CONSTRAINT risk_hold_placer_fk FOREIGN KEY (placed_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT risk_hold_releaser_fk FOREIGN KEY (released_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT risk_hold_subject_kind CHECK (
    subject_kind IN ('user','deal','quote','payment','case','reward','link')),
  CONSTRAINT risk_hold_released CHECK (
    (active = FALSE) = (released_at IS NOT NULL AND release_reason IS NOT NULL))
);

/*
 * One live hold per (subject, point): a repeated signal joins the
 * existing hold rather than stacking fifty identical ones.
 *
 * `NULLS NOT DISTINCT` is the point of this index. A NULL `point` means
 * "every enforcement point", and under the default NULL semantics two
 * such holds would both be permitted — the broadest hold is exactly the
 * one that must not be duplicated.
 */
CREATE UNIQUE INDEX risk_hold_live_uq
  ON sandbox.risk_hold (subject_kind, subject_id, point) NULLS NOT DISTINCT
  WHERE active;

CREATE INDEX risk_hold_subject_ix ON sandbox.risk_hold (subject_kind, subject_id)
  WHERE active;

-- ---------------------------------------------------------------------
-- 5. Limits and counters.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  A LIMIT IS ONLY A LIMIT IF CONCURRENCY CANNOT OVERSHOOT IT.     │
-- │                                                                  │
-- │  `INSERT ... ON CONFLICT DO UPDATE` on the counter row takes a   │
-- │  row lock, so two simultaneous consumptions serialise and the    │
-- │  second sees the first's total. A read-then-write would let both │
-- │  pass at the boundary, which is exactly when a limit matters.    │
-- │                                                                  │
-- │  `consumption_key` makes a retry idempotent: the same command    │
-- │  consuming twice is recorded once.                               │
-- └──────────────────────────────────────────────────────────────────┘
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.risk_limit (
  limit_id      UUID        NOT NULL DEFAULT gen_random_uuid(),
  limit_key     TEXT        NOT NULL,
  scope_kind    TEXT        NOT NULL,   -- 'user' | 'corridor' | 'global'
  -- NUMERIC, not BIGINT: a volume limit sums money and must never be
  -- capped by an integer width somebody chose years ago.
  max_amount    NUMERIC     NULL,
  max_count     INTEGER     NULL,
  window_seconds INTEGER    NOT NULL,
  -- A HARD limit refuses; a soft one opens a review case instead.
  hard          BOOLEAN     NOT NULL DEFAULT TRUE,
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT risk_limit_pk PRIMARY KEY (limit_id),
  CONSTRAINT risk_limit_key_uq UNIQUE (limit_key, scope_kind),
  CONSTRAINT risk_limit_scope CHECK (scope_kind IN ('user','corridor','global')),
  CONSTRAINT risk_limit_window CHECK (window_seconds > 0),
  CONSTRAINT risk_limit_bound CHECK (max_amount IS NOT NULL OR max_count IS NOT NULL),
  CONSTRAINT risk_limit_amount_pos CHECK (max_amount IS NULL OR max_amount > 0),
  CONSTRAINT risk_limit_count_pos CHECK (max_count IS NULL OR max_count > 0)
);

CREATE TABLE sandbox.risk_counter (
  counter_id    UUID        NOT NULL DEFAULT gen_random_uuid(),
  limit_key     TEXT        NOT NULL,
  scope_id      TEXT        NOT NULL,
  -- The window this counter belongs to, computed from the DATABASE
  -- clock so a skewed application server cannot open a fresh window.
  window_start  TIMESTAMPTZ NOT NULL,
  total_amount  NUMERIC     NOT NULL DEFAULT 0,
  total_count   INTEGER     NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT risk_counter_pk PRIMARY KEY (counter_id),
  CONSTRAINT risk_counter_uq UNIQUE (limit_key, scope_id, window_start),
  CONSTRAINT risk_counter_nonneg CHECK (total_amount >= 0 AND total_count >= 0)
);

/*
 * Every consumption, recorded once.
 *
 * The unique key is what makes a retry safe: the same command
 * consuming the same limit twice inserts once, and the counter is
 * updated only when the insert actually happened.
 */
CREATE TABLE sandbox.risk_consumption (
  consumption_id UUID       NOT NULL DEFAULT gen_random_uuid(),
  consumption_key TEXT      NOT NULL,
  limit_key     TEXT        NOT NULL,
  scope_id      TEXT        NOT NULL,
  amount        NUMERIC     NOT NULL DEFAULT 0,
  count_delta   INTEGER     NOT NULL DEFAULT 1,
  -- Corrections are ADDITIVE and point at what they correct.
  corrects      UUID        NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT risk_consumption_pk PRIMARY KEY (consumption_id),
  CONSTRAINT risk_consumption_key_uq UNIQUE (consumption_key),
  CONSTRAINT risk_consumption_corrects_fk FOREIGN KEY (corrects)
    REFERENCES sandbox.risk_consumption (consumption_id),
  CONSTRAINT risk_consumption_amount CHECK (amount >= 0 OR corrects IS NOT NULL)
);

CREATE INDEX risk_consumption_scope_ix
  ON sandbox.risk_consumption (limit_key, scope_id, created_at);

-- ---------------------------------------------------------------------
-- 6. Screening — provider-neutral, and honest about what it is.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  `provider_key` IS MANDATORY AND IS NEVER IMPLIED.               │
-- │                                                                  │
-- │  A screening row says who produced it. The sandbox provider is   │
-- │  named `sandbox-screening`, so no row in this table can be read  │
-- │  as "cleared against the real list" unless a real provider's key │
-- │  is in that column — and none is connected.                      │
-- │                                                                  │
-- │  `raw_hash` proves what came back without STORING it: a raw      │
-- │  sanctions payload is sensitive data about a named person, and   │
-- │  keeping it in a general-purpose table is how it ends up in a    │
-- │  log, an export or a support screenshot.                          │
-- └──────────────────────────────────────────────────────────────────┘
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.screening_result (
  screening_id  UUID        NOT NULL DEFAULT gen_random_uuid(),
  provider_key  TEXT        NOT NULL,
  provider_ref  TEXT        NOT NULL,
  kind          sandbox.screening_kind NOT NULL,

  subject_kind  TEXT        NOT NULL,
  subject_id    TEXT        NOT NULL,

  -- SHA-256 of the exact response bytes. The bytes themselves are not
  -- stored: this proves what was received without duplicating it.
  raw_hash      BYTEA       NOT NULL,
  signature_verified BOOLEAN NOT NULL,
  -- Normalized, REDACTED findings: match strength and category, never
  -- the free-text narrative a provider returns.
  findings      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  hit           BOOLEAN     NOT NULL,

  provider_at   TIMESTAMPTZ NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- After this, the result is stale and must be re-obtained.
  fresh_until   TIMESTAMPTZ NOT NULL,

  CONSTRAINT screening_result_pk PRIMARY KEY (screening_id),
  CONSTRAINT screening_result_provider_uq UNIQUE (provider_key, provider_ref),
  CONSTRAINT screening_result_hash_len CHECK (length(raw_hash) = 32),
  CONSTRAINT screening_result_findings_obj CHECK (jsonb_typeof(findings) = 'object'),
  CONSTRAINT screening_result_subject_kind CHECK (subject_kind IN ('user','deal','payment')),
  CONSTRAINT screening_result_freshness CHECK (fresh_until > provider_at),
  -- An unverified response is recorded and can never count as a result.
  CONSTRAINT screening_result_unverified_not_clear CHECK (
    signature_verified OR hit = FALSE)
);

CREATE INDEX screening_result_subject_ix
  ON sandbox.screening_result (subject_kind, subject_id, received_at DESC);

CREATE FUNCTION sandbox.trg_screening_immutable() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, sandbox, public
AS $fn$
BEGIN
  RAISE EXCEPTION 'a screening result is a record of what a provider said'
    USING ERRCODE = '42501';
END;
$fn$;

CREATE TRIGGER screening_result_immutable
  BEFORE UPDATE OR DELETE ON sandbox.screening_result
  FOR EACH ROW EXECUTE FUNCTION sandbox.trg_screening_immutable();

-- ---------------------------------------------------------------------
-- 7. Operational cases — one canonical record.
--
-- Deliberately SEPARATE from `dispute_case`: a dispute is between two
-- customers about a deal, and an operational case is the platform
-- investigating something. Conflating them would put an account-takeover
-- investigation in the deal room where the suspect can read it.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.ops_case (
  ops_case_id   UUID        NOT NULL DEFAULT gen_random_uuid(),
  kind          sandbox.case_kind NOT NULL,
  state         sandbox.ops_case_state NOT NULL DEFAULT 'OPEN',
  priority      INTEGER     NOT NULL DEFAULT 50,

  subject_kind  TEXT        NOT NULL,
  subject_id    TEXT        NOT NULL,
  /*
   * The correlation key. Alerts about the same underlying thing collapse
   * onto one case instead of producing a queue nobody can work: fifty
   * rows for one incident is how a real signal gets missed.
   */
  correlation_key TEXT      NOT NULL,

  summary       TEXT        NOT NULL,
  reason_codes  TEXT[]      NOT NULL DEFAULT '{}',
  version       INTEGER     NOT NULL DEFAULT 0,

  assigned_to   UUID        NULL,
  -- A bounded lease: an operator who takes a case and goes home does
  -- not hold it forever.
  lease_expires_at TIMESTAMPTZ NULL,

  sla_due_at    TIMESTAMPTZ NULL,
  /*
   * Legal-hold metadata, and nothing more.
   *
   * It records that THIS PLATFORM decided to preserve a record. It does
   * not, and must not, claim a regulator or court requested anything —
   * that is a legal fact nobody in this system is in a position to
   * assert.
   */
  preservation_hold BOOLEAN NOT NULL DEFAULT FALSE,
  preservation_note TEXT    NULL,

  disposition   TEXT        NULL,
  disposition_note TEXT     NULL,
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ NULL,
  closed_at     TIMESTAMPTZ NULL,

  CONSTRAINT ops_case_pk PRIMARY KEY (ops_case_id),
  CONSTRAINT ops_case_assignee_fk FOREIGN KEY (assigned_to)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT ops_case_priority CHECK (priority BETWEEN 1 AND 100),
  CONSTRAINT ops_case_subject_kind CHECK (
    subject_kind IN ('user','deal','quote','payment','case','reward','link')),
  CONSTRAINT ops_case_summary_len CHECK (char_length(summary) BETWEEN 10 AND 2000),
  CONSTRAINT ops_case_disposition CHECK (
    disposition IS NULL OR disposition IN (
      'NO_ACTION','CONFIRMED_ABUSE','FALSE_POSITIVE','ESCALATED_EXTERNAL',
      'CUSTOMER_CONTACTED','CONTROL_APPLIED')),
  CONSTRAINT ops_case_resolved CHECK (
    (state IN ('RESOLVED','CLOSED')) = (disposition IS NOT NULL AND resolved_at IS NOT NULL)),
  CONSTRAINT ops_case_closed CHECK ((state = 'CLOSED') = (closed_at IS NOT NULL)),
  CONSTRAINT ops_case_assigned CHECK (
    (state = 'ASSIGNED') <= (assigned_to IS NOT NULL))
);

-- One live case per correlated thing.
CREATE UNIQUE INDEX ops_case_correlation_uq
  ON sandbox.ops_case (correlation_key)
  WHERE state IN ('OPEN','ASSIGNED','ESCALATED');

CREATE INDEX ops_case_queue_ix
  ON sandbox.ops_case (kind, priority DESC, opened_at)
  WHERE state IN ('OPEN','ASSIGNED','ESCALATED');
CREATE INDEX ops_case_subject_ix ON sandbox.ops_case (subject_kind, subject_id);

/*
 * The case timeline. Append-only: what an investigator did, and when.
 * A case whose history can be edited is a case whose conclusion cannot
 * be trusted.
 */
CREATE TABLE sandbox.ops_case_action (
  action_id     UUID        NOT NULL DEFAULT gen_random_uuid(),
  ops_case_id   UUID        NOT NULL,
  actor_id      UUID        NULL,
  action        TEXT        NOT NULL,
  detail        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- PRIVATE notes live here and are never returned to a participant.
  internal      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ops_case_action_pk PRIMARY KEY (action_id),
  CONSTRAINT ops_case_action_case_fk FOREIGN KEY (ops_case_id)
    REFERENCES sandbox.ops_case (ops_case_id),
  CONSTRAINT ops_case_action_actor_fk FOREIGN KEY (actor_id)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT ops_case_action_detail_obj CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX ops_case_action_case_ix ON sandbox.ops_case_action (ops_case_id, created_at);

CREATE FUNCTION sandbox.trg_ops_action_immutable() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, sandbox, public
AS $fn$
BEGIN
  RAISE EXCEPTION 'case history is append-only' USING ERRCODE = '42501';
END;
$fn$;

CREATE TRIGGER ops_case_action_immutable
  BEFORE UPDATE OR DELETE ON sandbox.ops_case_action
  FOR EACH ROW EXECUTE FUNCTION sandbox.trg_ops_action_immutable();

-- ---------------------------------------------------------------------
-- 8. Emergency controls.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  ASYMMETRIC ON PURPOSE: ONE PERSON STOPS, TWO PEOPLE START.      │
-- │                                                                  │
-- │  Pausing is the safe direction, so it happens immediately on one │
-- │  authorised person's word — an incident at 03:00 must not wait   │
-- │  for a colleague to wake up. RESUMING puts customer money back   │
-- │  in motion, so it takes a second authorised person, and the      │
-- │  same person cannot do both.                                     │
-- └──────────────────────────────────────────────────────────────────┘
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.control_switch (
  switch_id     UUID        NOT NULL DEFAULT gen_random_uuid(),
  scope         sandbox.control_scope NOT NULL,
  -- NULL target means the whole scope; otherwise a corridor or rail.
  target        TEXT        NULL,
  paused        BOOLEAN     NOT NULL DEFAULT TRUE,
  reason        TEXT        NOT NULL,

  paused_by     UUID        NOT NULL,
  paused_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resumed_by    UUID        NULL,
  resume_approved_by UUID   NULL,
  resumed_at    TIMESTAMPTZ NULL,
  resume_reason TEXT        NULL,

  CONSTRAINT control_switch_pk PRIMARY KEY (switch_id),
  CONSTRAINT control_switch_pauser_fk FOREIGN KEY (paused_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT control_switch_resumer_fk FOREIGN KEY (resumed_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT control_switch_approver_fk FOREIGN KEY (resume_approved_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT control_switch_reason_len CHECK (char_length(reason) BETWEEN 10 AND 1000),
  CONSTRAINT control_switch_resumed CHECK (
    (paused = FALSE) = (resumed_at IS NOT NULL AND resumed_by IS NOT NULL
                        AND resume_approved_by IS NOT NULL)),
  -- TWO PEOPLE TO RESUME, in the database.
  CONSTRAINT control_switch_two_person_resume CHECK (
    resume_approved_by IS NULL OR resume_approved_by <> resumed_by)
);

-- One live pause per (scope, target). `NULLS NOT DISTINCT` for the same
-- reason as the hold index: a NULL target is the WHOLE scope, and two
-- of those must not coexist.
CREATE UNIQUE INDEX control_switch_live_uq
  ON sandbox.control_switch (scope, target) NULLS NOT DISTINCT
  WHERE paused;

-- ---------------------------------------------------------------------
-- 9. Maker-checker for high-impact operator actions.
--
-- A single table rather than one per action, because the RULE is the
-- same everywhere — propose, a different person approves, both checked
-- live at execution — and duplicating it per feature is how one copy
-- ends up missing the self-approval check.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.ops_approval (
  approval_id   UUID        NOT NULL DEFAULT gen_random_uuid(),
  action_kind   TEXT        NOT NULL,
  target_ref    TEXT        NOT NULL,
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  rationale     TEXT        NOT NULL,

  state         sandbox.proposal_state NOT NULL DEFAULT 'PROPOSED',
  proposed_by   UUID        NOT NULL,
  proposed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by   UUID        NULL,
  decided_at    TIMESTAMPTZ NULL,
  decision_note TEXT        NULL,

  CONSTRAINT ops_approval_pk PRIMARY KEY (approval_id),
  CONSTRAINT ops_approval_maker_fk FOREIGN KEY (proposed_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT ops_approval_checker_fk FOREIGN KEY (approved_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT ops_approval_kind CHECK (
    action_kind IN ('RISK_POLICY_ACTIVATE','CORRIDOR_RESUME','LIMIT_INCREASE',
                    'HOLD_RELEASE','CASE_CLOSE_VALUE','REWARD_CAMPAIGN_ACTIVATE')),
  CONSTRAINT ops_approval_rationale CHECK (char_length(rationale) BETWEEN 20 AND 4000),
  CONSTRAINT ops_approval_payload_obj CHECK (jsonb_typeof(payload) = 'object'),
  -- THE RULE.
  CONSTRAINT ops_approval_no_self CHECK (approved_by IS NULL OR approved_by <> proposed_by),
  CONSTRAINT ops_approval_decided CHECK ((state = 'PROPOSED') = (decided_at IS NULL)),
  CONSTRAINT ops_approval_approved CHECK (state <> 'APPROVED' OR approved_by IS NOT NULL)
);

CREATE UNIQUE INDEX ops_approval_live_uq
  ON sandbox.ops_approval (action_kind, target_ref) WHERE state = 'PROPOSED';

CREATE INDEX ops_approval_queue_ix ON sandbox.ops_approval (state, proposed_at);

-- ---------------------------------------------------------------------
-- 10. Compliance export — prepared, never sent.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  THIS BOUNDARY PREPARES A PACKAGE. IT TRANSMITS NOTHING.         │
-- │                                                                  │
-- │  No regulator, bank, exchange or third party is contacted by     │
-- │  anything in this repository. An export is a checksummed,        │
-- │  scoped, expiring, audited record that an AUTHORISED person      │
-- │  assembled — and retrieving it is a separate authorised act with │
-- │  no public URL.                                                  │
-- └──────────────────────────────────────────────────────────────────┘
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.compliance_export (
  export_id     UUID        NOT NULL DEFAULT gen_random_uuid(),
  requested_by  UUID        NOT NULL,
  scope_kind    TEXT        NOT NULL,
  scope_id      TEXT        NOT NULL,
  sections      TEXT[]      NOT NULL,
  redacted      BOOLEAN     NOT NULL DEFAULT TRUE,

  -- SHA-256 of the generated package, so a copy can be shown to be the
  -- copy that was produced.
  checksum      TEXT        NULL,
  row_count     INTEGER     NULL,
  token_hash    TEXT        NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  retrieved_at  TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT compliance_export_pk PRIMARY KEY (export_id),
  CONSTRAINT compliance_export_requester_fk FOREIGN KEY (requested_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT compliance_export_token_uq UNIQUE (token_hash),
  CONSTRAINT compliance_export_scope CHECK (scope_kind IN ('user','deal','case')),
  CONSTRAINT compliance_export_sections CHECK (cardinality(sections) > 0),
  CONSTRAINT compliance_export_token_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT compliance_export_checksum_shape CHECK (
    checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT compliance_export_window CHECK (expires_at > created_at)
);

CREATE INDEX compliance_export_requester_ix
  ON sandbox.compliance_export (requested_by, created_at DESC);

-- ---------------------------------------------------------------------
-- 11. Seeded controls.
--
-- Conservative starting limits and an ALLOW-by-default policy per
-- enforcement point, so introducing the control plane changes nobody's
-- experience on the day it ships — the machinery is live and the rules
-- are the ones already in force.
--
-- Every risk policy is `production_enabled = FALSE`: production requires
-- a maker-checker activation nobody has performed.
-- ---------------------------------------------------------------------

INSERT INTO sandbox.risk_limit (limit_key, scope_kind, max_amount, max_count, window_seconds, hard)
VALUES
  ('deal.value.per_txn',    'user', 500000000, NULL,  86400, TRUE),
  ('deal.value.daily',      'user', 2000000000, NULL, 86400, TRUE),
  ('deal.count.daily',      'user', NULL,       50,   86400, TRUE),
  ('deal.active',           'user', NULL,       20,   86400, TRUE),
  ('payment.velocity',      'user', NULL,       100,  3600,  TRUE),
  ('payment.failed',        'user', NULL,       20,   3600,  FALSE),
  ('reference.anomaly',     'user', NULL,       10,   86400, FALSE),
  ('deal.cancelled',        'user', NULL,       15,   86400, FALSE),
  ('dispute.raised',        'user', NULL,       10,   604800, FALSE),
  ('reversal.exposure',     'user', NULL,       5,    604800, FALSE),
  ('referral.velocity',     'user', NULL,       25,   86400, TRUE),
  ('reward.velocity',       'user', NULL,       10,   86400, TRUE),
  ('counterparty.repeat',   'user', NULL,       30,   86400, FALSE),
  ('corridor.volume.daily', 'corridor', 100000000000, NULL, 86400, TRUE);

INSERT INTO sandbox.risk_policy (policy_key, version, point, rules, default_decision, state, activated_at)
SELECT 'baseline-' || lower(p::text), 1, p, '[]'::jsonb, 'ALLOW', 'ACTIVE', now()
  FROM unnest(enum_range(NULL::sandbox.enforcement_point)) AS p
 -- REWARD_GRANT gets real rules below rather than an ALLOW placeholder,
 -- and only one policy may be ACTIVE per point.
 WHERE p <> 'REWARD_GRANT';

/*
 * The reward-granting policy is the one exception: it starts with real
 * rules, because DEL-07 deferred reward orchestration precisely so that
 * it could be connected through these controls rather than shipped
 * without them.
 */
INSERT INTO sandbox.risk_policy (policy_key, version, point, rules, default_decision, state, activated_at)
VALUES ('reward-abuse', 2, 'REWARD_GRANT',
  '[
    {"code":"RWD-SELF","signal":"selfDealing","op":"eq","value":true,"decision":"REJECT",
     "reason":"REWARD_SELF_DEALING"},
    {"code":"RWD-LINK","signal":"linkedAccount","op":"eq","value":true,"decision":"REVIEW",
     "reason":"REWARD_LINKED_ACCOUNT"},
    {"code":"RWD-VEL","signal":"rewardVelocityExceeded","op":"eq","value":true,
     "decision":"REVIEW","reason":"REWARD_VELOCITY"},
    {"code":"RWD-REPEAT","signal":"repeatedCounterparty","op":"gte","value":5,
     "decision":"REVIEW","reason":"REWARD_REPEATED_COUNTERPARTY"},
    {"code":"RWD-HELD","signal":"subjectHeld","op":"eq","value":true,"decision":"HOLD",
     "reason":"SUBJECT_UNDER_HOLD"}
   ]'::jsonb,
  'ALLOW', 'ACTIVE', now());

-- ---------------------------------------------------------------------
-- 12. Operator read models.
-- ---------------------------------------------------------------------

CREATE VIEW sandbox.ops_queue AS
  SELECT c.ops_case_id, c.kind, c.state, c.priority, c.subject_kind, c.subject_id,
         c.summary, c.reason_codes, c.version, c.assigned_to, c.lease_expires_at,
         c.sla_due_at, c.opened_at,
         (c.sla_due_at IS NOT NULL AND c.sla_due_at < now()) AS overdue,
         (c.assigned_to IS NOT NULL AND c.lease_expires_at < now()) AS lease_expired
    FROM sandbox.ops_case c
   WHERE c.state IN ('OPEN','ASSIGNED','ESCALATED');

COMMENT ON VIEW sandbox.ops_queue IS
  'The operator work queue. Carries no screening payload, no raw provider '
  'response and no internal note: knowing a case exists is not the same as '
  'being entitled to everything inside it.';

CREATE VIEW sandbox.control_status AS
  SELECT scope, target, paused, reason, paused_at, paused_by
    FROM sandbox.control_switch
   WHERE paused;

COMMENT ON VIEW sandbox.control_status IS
  'Live pause state. Read at every protected boundary on each request — a '
  'cached copy in a screen is not authority and never blocks anything.';

CREATE VIEW sandbox.limit_consumption AS
  SELECT c.limit_key, c.scope_id, c.window_start, c.total_amount, c.total_count,
         l.max_amount, l.max_count, l.window_seconds, l.hard
    FROM sandbox.risk_counter c
    JOIN sandbox.risk_limit l ON l.limit_key = c.limit_key
   WHERE c.window_start > now() - make_interval(secs => l.window_seconds);
