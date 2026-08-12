-- =====================================================================
-- INRP2P — DEL-02 migration 0005: command idempotency, transactional
-- outbox, and the authoritative locked-value fact.
--
-- ⚠ STILL NO MONEY. This migration adds no account, posting, journal,
-- balance, wallet, custody or withdrawal table, and none may be added
-- here. It adds the *boundary machinery* TS-02 §5.19 and §10 require —
-- command identity, event identity and rejection evidence — so that the
-- DEL-04 ledger has a correct seam to attach to rather than being
-- retrofitted onto un-idempotent mutations.
--
-- Three concerns, in order:
--
--   1. `command`      one row per externally retryable mutation, keyed by
--                     a CALLER-supplied id, carrying the canonical payload
--                     hash and the recorded outcome. This is what makes a
--                     replay return the original answer instead of acting
--                     twice.
--   2. `outbox_event` domain events written in the SAME transaction as the
--                     state change they describe. No worker is created
--                     here; delivery is DEL-09's concern. What matters now
--                     is that an event can never exist without its
--                     transition, or a transition without its event.
--   3. `value_locked_at`
--                     the authoritative fact that gates bank/UPI
--                     instruction release (UX-01 §3 / I7, roadmap B5). A
--                     null here means no instruction may be shown — which
--                     is exactly the production behaviour until DEL-04
--                     exists to set it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Command idempotency.
--
-- WHY THE PAYLOAD HASH IS A COLUMN AND NOT A COMMENT.
--
-- An idempotency key that only proves "I have seen this id" is worse than
-- none: a client that reuses an id with different content would silently
-- receive the previous answer for a request it never made. Storing the
-- canonical hash lets the boundary tell the two cases apart —
--
--   same id + same hash  → return the recorded outcome, act once;
--   same id + other hash → refuse, because the caller contradicted itself.
--
-- `outcome_code` is NULL on success and carries the rejection code
-- otherwise, so a replayed REJECTION replays as the same rejection rather
-- than being retried into a different answer.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox.command (
  command_id    UUID        NOT NULL,
  command_type  TEXT        NOT NULL,
  actor_id      UUID        NULL,
  -- SHA-256 over the canonical JSON encoding of the caller's arguments.
  payload_hash  TEXT        NOT NULL,
  status        TEXT        NOT NULL,
  -- The rejection code for a refused command; NULL when it succeeded.
  outcome_code  TEXT        NULL,
  -- The exact value the first execution returned, replayed verbatim.
  result        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ NULL,

  CONSTRAINT command_pk PRIMARY KEY (command_id),
  CONSTRAINT command_actor_fk FOREIGN KEY (actor_id) REFERENCES sandbox.app_user (user_id),
  CONSTRAINT command_status_closed CHECK (status IN ('SUCCEEDED', 'REJECTED')),
  CONSTRAINT command_hash_shape CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT command_result_obj CHECK (jsonb_typeof(result) = 'object'),
  -- Status and outcome cannot disagree: a succeeded command has no
  -- rejection code, and a rejected one must carry exactly one.
  CONSTRAINT command_outcome_agrees
    CHECK ((status = 'REJECTED') = (outcome_code IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS command_actor_ix
  ON sandbox.command (actor_id, created_at DESC);

COMMENT ON TABLE sandbox.command IS
  'Command idempotency for DEL-02 mutations. One row per caller-supplied '
  'command id, carrying the canonical payload hash and the recorded outcome. '
  'Written in the SAME transaction as the domain mutation, audit event and '
  'outbox event it accompanies.';

-- ---------------------------------------------------------------------
-- 2. Transactional outbox.
--
-- `event_key` is the deduplication identity TS-02 §5.19 requires. It is
-- derived from the command that produced the event, so a replayed command
-- cannot emit a second copy of the same event even if the surrounding
-- code were to run again.
--
-- `published_at` exists but nothing in this stage sets it: dispatch,
-- retry, lag monitoring and dead-lettering all belong to DEL-09. The
-- column is here so DEL-09 adds a reader, not a schema change to a table
-- that already holds events.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox.outbox_event (
  outbox_id    BIGINT      GENERATED ALWAYS AS IDENTITY,
  event_key    TEXT        NOT NULL,
  event_type   TEXT        NOT NULL,
  subject_kind TEXT        NOT NULL,
  subject_id   UUID        NOT NULL,
  payload      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set by a DEL-09 dispatcher. Always NULL in this stage.
  published_at TIMESTAMPTZ NULL,

  CONSTRAINT outbox_event_pk PRIMARY KEY (outbox_id),
  -- Exactly-once emission, enforced by the database rather than by
  -- remembering not to emit twice.
  CONSTRAINT outbox_event_key_uq UNIQUE (event_key),
  CONSTRAINT outbox_event_payload_obj CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_event_subject_kind
    CHECK (subject_kind IN ('link', 'deal', 'quote', 'user'))
);

-- The dispatcher DEL-09 will add reads unpublished events oldest first.
CREATE INDEX IF NOT EXISTS outbox_event_unpublished_ix
  ON sandbox.outbox_event (occurred_at)
  WHERE published_at IS NULL;

CREATE INDEX IF NOT EXISTS outbox_event_subject_ix
  ON sandbox.outbox_event (subject_kind, subject_id, outbox_id);

-- An outbox row is a record that something HAPPENED. Like the audit
-- trail, it may be appended to and read, never rewritten — otherwise a
-- delivered event could be edited after the fact and the two records of
-- the same transition would disagree. `published_at` is the one field a
-- dispatcher must set, so UPDATE is narrowed rather than forbidden.
CREATE RULE outbox_event_no_delete AS ON DELETE TO sandbox.outbox_event DO INSTEAD NOTHING;

-- ---------------------------------------------------------------------
-- 3. The authoritative locked-value fact.
--
-- UX-01 §3 and TS-01.4 I7 forbid releasing bank instructions before the
-- value leg is locked. Until now nothing recorded whether it was, so the
-- pay screen relied on the deal merely existing.
--
-- `value_locked_at` is that missing fact, and `value_lock_ref` names what
-- performed the lock. In the sandbox the reference is a simulated hold
-- and is prefixed `SBX-` so it can never be mistaken for custody. In
-- production nothing can set either column until DEL-04 exists, so
-- instructions stay unavailable — which is the required behaviour, not a
-- gap.
-- ---------------------------------------------------------------------

ALTER TABLE sandbox.deal ADD COLUMN IF NOT EXISTS value_locked_at TIMESTAMPTZ NULL;
ALTER TABLE sandbox.deal ADD COLUMN IF NOT EXISTS value_lock_ref  TEXT        NULL;

ALTER TABLE sandbox.deal
  ADD CONSTRAINT deal_value_lock_agrees
  CHECK ((value_locked_at IS NULL) = (value_lock_ref IS NULL));

COMMENT ON COLUMN sandbox.deal.value_locked_at IS
  'Authoritative locked-value fact gating bank/UPI instruction release (UX-01 '
  'I7). NULL means no instruction may be disclosed. Only a value-protection '
  'adapter may set it; the sandbox adapter writes a simulated SBX- reference '
  'that holds nothing.';

-- ---------------------------------------------------------------------
-- 4. Expiry support.
--
-- The lifecycle sweep selects deals whose payment window has passed and
-- quotes past their expiry. Both are exact comparisons against the
-- database clock, so both want an index that matches the predicate rather
-- than a sequential scan that grows with history.
-- ---------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS deal_pending_deadline_ix
  ON sandbox.deal (action_deadline)
  WHERE state = 'FIAT_PENDING' AND action_deadline IS NOT NULL;

CREATE INDEX IF NOT EXISTS quote_issued_expiry_ix
  ON sandbox.quote (expires_at)
  WHERE state = 'ISSUED';
