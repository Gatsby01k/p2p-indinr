-- =====================================================================
-- 0010 — DEL-06: Deal Room, chat, evidence and disputes.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  ONE DEAL STATE MACHINE, NOT TWO.                                │
-- │                                                                  │
-- │  `sandbox.dispute` becomes a VIEW over `dispute_case`. Every      │
-- │  existing reader keeps working, unchanged, and there is exactly   │
-- │  one row behind it. A second dispute table would have been the    │
-- │  competing state machine this stage is forbidden to create — and  │
-- │  the failure mode is not theoretical: two tables that disagree    │
-- │  about whether a deal is disputed means one code path releases    │
-- │  value while another believes it is frozen.                       │
-- └──────────────────────────────────────────────────────────────────┘
--
-- WHAT MOVES MONEY HERE: nothing, directly. A ruling calls the DEL-04
-- release/refund boundary, which posts through `inrp2p.post_entry`.
-- These tables record WHO decided WHAT and WHY. The value follows the
-- ledger, and the ledger follows the lock.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Vocabulary.
-- ---------------------------------------------------------------------

CREATE TYPE sandbox.case_state AS ENUM (
  'OPEN',          -- raised, awaiting operator attention
  'UNDER_REVIEW',  -- an operator has picked it up
  'RESOLVED',      -- a maker-checker ruling committed
  'WITHDRAWN'      -- the raiser stood down before any ruling
);

CREATE TYPE sandbox.case_disposition AS ENUM ('RELEASE', 'REFUND');

CREATE TYPE sandbox.proposal_state AS ENUM (
  'PROPOSED',    -- awaiting a DIFFERENT operator's approval
  'APPROVED',    -- executed
  'REJECTED',    -- a checker declined it
  'SUPERSEDED'   -- another proposal was approved, or the case moved on
);

/*
 * Evidence lifecycle.
 *
 * `PENDING` means an upload was authorised and nothing has arrived.
 * `QUARANTINED` means bytes arrived and NOTHING has looked at them yet —
 * the default after upload, never skipped. Only a scanner adapter moves
 * a row to `READY`, and only `READY` evidence is downloadable.
 */
CREATE TYPE sandbox.evidence_state AS ENUM ('PENDING', 'QUARANTINED', 'READY', 'REJECTED');

CREATE TYPE sandbox.capability_kind AS ENUM ('UPLOAD', 'DOWNLOAD');

-- Audit and outbox learn two more subjects.
ALTER TABLE sandbox.audit_event DROP CONSTRAINT audit_event_subject_kind;
ALTER TABLE sandbox.audit_event ADD CONSTRAINT audit_event_subject_kind
  CHECK (subject_kind IN ('link','deal','quote','user','payment','case','evidence'));

ALTER TABLE sandbox.outbox_event DROP CONSTRAINT outbox_event_subject_kind;
ALTER TABLE sandbox.outbox_event ADD CONSTRAINT outbox_event_subject_kind
  CHECK (subject_kind IN ('link','deal','quote','user','payment','case','evidence'));

-- ---------------------------------------------------------------------
-- 2. The dispute case.
--
-- ONE ACTIVE CASE PER DEAL, and — unlike the table it replaces — more
-- than one case over a deal's life. The old `UNIQUE (deal_id)` meant a
-- deal that had ever been disputed could never be disputed again, which
-- is wrong: a resolved complaint about a payment does not forfeit the
-- right to complain about what happened afterwards.
--
-- `snapshot` freezes what was true when the case opened: the deal state,
-- the value lock, the payment intents. A ruling weeks later must be
-- judged against the facts at the time, and a live re-read would show
-- the facts the ruling itself changed.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.dispute_case (
  case_id      UUID        NOT NULL DEFAULT gen_random_uuid(),
  deal_id      UUID        NOT NULL,
  opened_by    UUID        NOT NULL,
  category     TEXT        NOT NULL,
  statement    TEXT        NOT NULL,
  state        sandbox.case_state NOT NULL DEFAULT 'OPEN',

  snapshot     JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- Optimistic concurrency. A proposal carries the version it was built
  -- against; if the case moved on, the approval is stale and refused.
  version      INTEGER     NOT NULL DEFAULT 0,

  disposition  sandbox.case_disposition NULL,
  resolved_by_proposal UUID NULL,
  resolution_note TEXT     NULL,

  opened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ NULL,
  withdrawn_at TIMESTAMPTZ NULL,

  CONSTRAINT dispute_case_pk PRIMARY KEY (case_id),
  CONSTRAINT dispute_case_deal_fk FOREIGN KEY (deal_id) REFERENCES sandbox.deal (deal_id),
  CONSTRAINT dispute_case_opener_fk FOREIGN KEY (opened_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT dispute_case_category CHECK (
    category IN ('PAYMENT_NOT_RECEIVED','WRONG_AMOUNT','PROOF_MISMATCH','NOT_AS_AGREED','OTHER')),
  -- A statement long enough to act on. A one-word dispute wastes an
  -- operator's time and gives the counterparty nothing to answer.
  CONSTRAINT dispute_case_statement_len CHECK (char_length(statement) BETWEEN 20 AND 4000),
  CONSTRAINT dispute_case_snapshot_obj CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT dispute_case_resolved_rule CHECK (
    (state = 'RESOLVED') = (disposition IS NOT NULL
                            AND resolved_at IS NOT NULL)),
  /*
   * A ruling THIS SYSTEM made names the proposal that approved it, so a
   * resolution can always be traced back to two people.
   *
   * ⚠ DEL-10: this was folded into the rule above, which made the
   * backfill impossible to complete. Historical rulings were decided
   * before DEL-06 existed and have no proposal to point at, so every
   * legacy RESOLVED dispute aborted the migration.
   *
   * The exception is deliberately narrow and self-declaring: a resolved
   * case may omit its proposal ONLY if its note says it was carried
   * across. Minting a proposal id for a ruling nobody approved would
   * fabricate a maker-checker record — the one thing this table exists
   * to make impossible.
   */
  CONSTRAINT dispute_case_ruling_traceable CHECK (
    state <> 'RESOLVED'
    OR resolved_by_proposal IS NOT NULL
    OR resolution_note LIKE 'Resolved before DEL-06%'),
  CONSTRAINT dispute_case_withdrawn_rule CHECK (
    (state = 'WITHDRAWN') = (withdrawn_at IS NOT NULL))
);

/*
 * ONE ACTIVE CASE PER DEAL, enforced by the database.
 *
 * Two participants complaining at the same moment is a genuine race, and
 * the partial index decides it rather than a check-then-insert that both
 * requests pass.
 */
CREATE UNIQUE INDEX dispute_case_active_uq
  ON sandbox.dispute_case (deal_id)
  WHERE state IN ('OPEN','UNDER_REVIEW');

CREATE INDEX dispute_case_state_ix ON sandbox.dispute_case (state, opened_at);
CREATE INDEX dispute_case_deal_ix  ON sandbox.dispute_case (deal_id, opened_at);

-- ---------------------------------------------------------------------
-- 3. Backfill, then replace the old table with a view.
--
-- The old rows are real decisions and are carried across verbatim. The
-- old `detail` column was nullable and the new `statement` is not, so a
-- historical row with no detail gets an explicit, honest placeholder
-- rather than an invented complaint.
--
-- ⚠ DEL-10 REPAIR — THIS BACKFILL COULD NOT RUN ON REAL DATA.
--
-- `dispute.detail` was free text with no length rule. `statement` is
-- constrained to BETWEEN 20 AND 4000. The original expression only
-- substituted the placeholder when detail was NULL or blank, and carried
-- everything else across unchanged — so a legacy row reading "Nothing
-- arrived." (16 characters) violated the CHECK and aborted the whole
-- migration. Both of those exact strings exist in the sandbox data.
--
-- It went unnoticed for four stages because every gate applied the
-- migrations to a FRESHLY CREATED database, where `sandbox.dispute` was
-- empty and the backfill was a no-op. It failed the moment DEL-10 ran an
-- upgrade over a populated one.
--
-- The expression below now maps legacy text INTO the new domain instead
-- of assuming it already fits. A person's own words are never discarded
-- and never rewritten: a short statement keeps its text and gains a
-- clause saying why it was extended, and an over-long one is cut at the
-- limit and openly marked as truncated.
-- ---------------------------------------------------------------------

/*
 * Defined once and used by both inserts below, so the two paths cannot
 * drift apart, then dropped at the end of this migration — it exists to
 * carry history across, not to become part of the schema.
 */
CREATE FUNCTION sandbox.del06_legacy_statement(detail TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    -- Nothing was ever written. Say exactly that; invent no complaint.
    WHEN nullif(trim(detail), '') IS NULL
      THEN 'Raised before DEL-06; no statement was recorded at the time.'
    -- Their words, kept whole, with the reason they were padded.
    WHEN char_length(trim(detail)) < 20
      THEN trim(detail) || ' (Statement carried over from before DEL-06, '
           'when no minimum length applied.)'
    -- Cut to the limit, and said so rather than silently shortened.
    WHEN char_length(trim(detail)) > 4000
      THEN left(trim(detail), 3950) || ' […truncated in the DEL-06 migration]'
    ELSE trim(detail)
  END;
$$;

INSERT INTO sandbox.dispute_case
  (case_id, deal_id, opened_by, category, statement, state, disposition,
   resolution_note, opened_at, resolved_at)
SELECT d.dispute_id,
       d.deal_id,
       d.raised_by,
       d.reason,
       sandbox.del06_legacy_statement(d.detail),
       CASE d.state WHEN 'RESOLVED' THEN 'RESOLVED'::sandbox.case_state
                    WHEN 'UNDER_REVIEW' THEN 'UNDER_REVIEW'::sandbox.case_state
                    ELSE 'OPEN'::sandbox.case_state END,
       CASE d.resolution WHEN 'RELEASED' THEN 'RELEASE'::sandbox.case_disposition
                         WHEN 'REFUNDED' THEN 'REFUND'::sandbox.case_disposition
                         ELSE NULL END,
       /*
        * A resolved legacy row states, in the record itself, that no
        * DEL-06 proposal stands behind it. `dispute_case_ruling_traceable`
        * reads this note, so the exception cannot be taken silently — and
        * an operator reading the case sees the same sentence.
        */
       CASE WHEN d.state = 'RESOLVED'
            THEN 'Resolved before DEL-06, when rulings were not recorded as '
                 'maker-checker proposals. No approving proposal exists for '
                 'this decision.'
            ELSE NULL END,
       d.raised_at,
       d.resolved_at
  FROM sandbox.dispute d
 WHERE NOT (d.state = 'RESOLVED' AND d.resolution = 'CANCELLED');

/*
 * A historical `CANCELLED` resolution has no DEL-06 equivalent, and
 * inventing one would misreport what an operator decided. Those rows are
 * carried as RESOLVED cases whose disposition is recorded in the note,
 * because `case_disposition` deliberately admits only the two dispositions
 * a live value lock can actually justify.
 */
INSERT INTO sandbox.dispute_case
  (case_id, deal_id, opened_by, category, statement, state, disposition,
   resolved_by_proposal, resolution_note, opened_at, resolved_at, withdrawn_at)
SELECT d.dispute_id, d.deal_id, d.raised_by, d.reason,
       sandbox.del06_legacy_statement(d.detail),
       'WITHDRAWN'::sandbox.case_state, NULL, NULL,
       'Resolved as CANCELLED before DEL-06. Recorded as withdrawn because '
       'DEL-06 admits only RELEASE and REFUND as dispositions.',
       d.raised_at, NULL,
       /*
        * ⚠ DEL-10: set HERE, in the insert.
        *
        * `dispute_case_withdrawn_rule` requires a withdrawn case to name
        * when it was withdrawn, and CHECK constraints are evaluated per
        * row as it is inserted — not at the end of the statement. The
        * original migration set this in a follow-up UPDATE, so the very
        * first legacy CANCELLED dispute aborted the whole upgrade before
        * that UPDATE could ever run.
        *
        * It survived review because it is invisible on an empty database
        * and on any dataset that happens to contain no CANCELLED
        * resolutions — including the one the earlier DEL-10 repair was
        * tested against. The populated fixture carries them deliberately.
        *
        * The withdrawal is dated to when the dispute was raised, which is
        * the only honest timestamp available: the legacy row recorded no
        * separate withdrawal moment, and inventing one would be worse.
        */
       d.raised_at
  FROM sandbox.dispute d
 WHERE d.state = 'RESOLVED' AND d.resolution = 'CANCELLED';

-- The carry-across is done; the helper does not belong to the schema.
DROP FUNCTION sandbox.del06_legacy_statement(TEXT);

DROP TABLE sandbox.dispute;

-- ---------------------------------------------------------------------
-- 4. Maker-checker proposals.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  SELF-APPROVAL IS UNREPRESENTABLE, NOT MERELY FORBIDDEN.         │
-- │                                                                  │
-- │  `proposal_no_self_approval` is a CHECK, so an operator cannot   │
-- │  approve their own proposal through the service, through psql,   │
-- │  through a future feature, or through a bug. The service also    │
-- │  checks it and returns a clear refusal; the constraint is what   │
-- │  makes the guarantee absolute.                                   │
-- └──────────────────────────────────────────────────────────────────┘
--
-- `case_version` is the optimistic-concurrency anchor. An approval is
-- valid only while the case is still the case the maker examined.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.dispute_proposal (
  proposal_id  UUID        NOT NULL DEFAULT gen_random_uuid(),
  case_id      UUID        NOT NULL,
  proposed_by  UUID        NOT NULL,
  disposition  sandbox.case_disposition NOT NULL,
  rationale    TEXT        NOT NULL,
  case_version INTEGER     NOT NULL,
  state        sandbox.proposal_state NOT NULL DEFAULT 'PROPOSED',

  approved_by  UUID        NULL,
  decided_at   TIMESTAMPTZ NULL,
  decision_note TEXT       NULL,

  proposed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT dispute_proposal_pk PRIMARY KEY (proposal_id),
  CONSTRAINT dispute_proposal_case_fk FOREIGN KEY (case_id)
    REFERENCES sandbox.dispute_case (case_id),
  CONSTRAINT dispute_proposal_maker_fk FOREIGN KEY (proposed_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT dispute_proposal_checker_fk FOREIGN KEY (approved_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT dispute_proposal_rationale_len CHECK (char_length(rationale) BETWEEN 20 AND 4000),

  -- THE MAKER-CHECKER RULE, in the database.
  CONSTRAINT proposal_no_self_approval CHECK (approved_by IS NULL OR approved_by <> proposed_by),

  CONSTRAINT dispute_proposal_decided_rule CHECK (
    (state = 'PROPOSED') = (decided_at IS NULL)),
  CONSTRAINT dispute_proposal_approved_rule CHECK (
    state <> 'APPROVED' OR approved_by IS NOT NULL)
);

/*
 * ONE LIVE PROPOSAL PER CASE.
 *
 * Two operators proposing opposite dispositions at once, both waiting for
 * a checker, is how a case gets resolved twice. The second maker is
 * refused and told a proposal is already outstanding.
 */
CREATE UNIQUE INDEX dispute_proposal_live_uq
  ON sandbox.dispute_proposal (case_id)
  WHERE state = 'PROPOSED';

-- At most ONE approved proposal per case, ever. This is the structural
-- half of "release or refund happens exactly once".
CREATE UNIQUE INDEX dispute_proposal_approved_uq
  ON sandbox.dispute_proposal (case_id)
  WHERE state = 'APPROVED';

CREATE INDEX dispute_proposal_case_ix ON sandbox.dispute_proposal (case_id, proposed_at);

ALTER TABLE sandbox.dispute_case
  ADD CONSTRAINT dispute_case_proposal_fk FOREIGN KEY (resolved_by_proposal)
    REFERENCES sandbox.dispute_proposal (proposal_id);

/*
 * A decided proposal is history and stays history.
 *
 * Rejected and superseded proposals are the record of what was
 * CONSIDERED, which is exactly what an audit of a disputed ruling needs.
 * Editing one after the fact would let the reasoning be rewritten to fit
 * the outcome.
 */
CREATE FUNCTION sandbox.trg_proposal_immutable() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, sandbox, public
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dispute proposals are permanent' USING ERRCODE = '42501';
  END IF;
  IF OLD.state <> 'PROPOSED' THEN
    RAISE EXCEPTION 'proposal % is already %, and a decision is final',
      OLD.proposal_id, OLD.state USING ERRCODE = '42501';
  END IF;
  IF (NEW.case_id, NEW.proposed_by, NEW.disposition, NEW.rationale, NEW.case_version)
     IS DISTINCT FROM
     (OLD.case_id, OLD.proposed_by, OLD.disposition, OLD.rationale, OLD.case_version) THEN
    RAISE EXCEPTION 'proposal % is immutable in its terms', OLD.proposal_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER dispute_proposal_immutable
  BEFORE UPDATE OR DELETE ON sandbox.dispute_proposal
  FOR EACH ROW EXECUTE FUNCTION sandbox.trg_proposal_immutable();

/*
 * The compatibility view.
 *
 * Same columns, same names, same meanings as the table it replaces, so
 * every existing reader keeps working and none of them can disagree with
 * the new one. It is READ-ONLY on purpose: a write through this view
 * would bypass the version counter and the maker-checker chain, so there
 * are no rules making it updatable and any INSERT will fail loudly.
 */
CREATE VIEW sandbox.dispute AS
  SELECT c.case_id                    AS dispute_id,
         c.deal_id,
         c.opened_by                  AS raised_by,
         c.category                   AS reason,
         c.statement                  AS detail,
         CASE c.state WHEN 'RESOLVED' THEN 'RESOLVED'
                      WHEN 'UNDER_REVIEW' THEN 'UNDER_REVIEW'
                      WHEN 'WITHDRAWN' THEN 'RESOLVED'
                      ELSE 'OPEN' END AS state,
         CASE c.disposition WHEN 'RELEASE' THEN 'RELEASED'
                            WHEN 'REFUND'  THEN 'REFUNDED'
                            ELSE NULL END AS resolution,
         p.proposed_by                AS resolved_by,
         c.opened_at                  AS raised_at,
         c.resolved_at
    FROM sandbox.dispute_case c
    LEFT JOIN sandbox.dispute_proposal p ON p.proposal_id = c.resolved_by_proposal;

-- ---------------------------------------------------------------------
-- 5. Private operator notes.
--
-- A SEPARATE TABLE, not a column on the case, and that separation is the
-- protection. A participant-facing query reads `dispute_case`; there is
-- no column it could forget to exclude, and no `SELECT *` that leaks an
-- investigator's working hypothesis to the person being investigated.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.case_note (
  note_id    UUID        NOT NULL DEFAULT gen_random_uuid(),
  case_id    UUID        NOT NULL,
  author_id  UUID        NOT NULL,
  body       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT case_note_pk PRIMARY KEY (note_id),
  CONSTRAINT case_note_case_fk FOREIGN KEY (case_id)
    REFERENCES sandbox.dispute_case (case_id),
  CONSTRAINT case_note_author_fk FOREIGN KEY (author_id)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT case_note_body_len CHECK (char_length(body) BETWEEN 1 AND 4000)
);

CREATE INDEX case_note_case_ix ON sandbox.case_note (case_id, created_at);

COMMENT ON TABLE sandbox.case_note IS
  'PRIVATE operator notes. Never returned by any participant-facing read. '
  'Kept in its own table so that exclusion is structural rather than a '
  'column somebody must remember to omit.';

-- ---------------------------------------------------------------------
-- 6. Chat becomes ordered, idempotent and append-only.
--
-- `seq` is a per-database identity, so ordering is deterministic and
-- total. `sent_at` was the old ordering key and two messages sent in the
-- same millisecond ordered arbitrarily — which, in a dispute about who
-- said what first, is the whole question.
--
-- `command_id` makes a resend idempotent: the same command replays the
-- same message instead of posting it twice.
-- ---------------------------------------------------------------------

ALTER TABLE sandbox.deal_message
  ADD COLUMN seq        BIGINT GENERATED ALWAYS AS IDENTITY,
  ADD COLUMN command_id UUID NULL;

CREATE UNIQUE INDEX deal_message_seq_uq ON sandbox.deal_message (seq);
CREATE UNIQUE INDEX deal_message_command_uq ON sandbox.deal_message (command_id)
  WHERE command_id IS NOT NULL;
CREATE INDEX deal_message_cursor_ix ON sandbox.deal_message (deal_id, seq);

/*
 * Redaction is ADDITIVE.
 *
 * Moderating a message must not rewrite what was said — a chat log that
 * can be edited proves nothing in a dispute. The original row stays
 * exactly as it was; this row records that a moderator hid it, who did
 * so and why. A reader joins and decides what to display.
 */
CREATE TABLE sandbox.message_redaction (
  redaction_id UUID        NOT NULL DEFAULT gen_random_uuid(),
  message_id   UUID        NOT NULL,
  redacted_by  UUID        NOT NULL,
  reason       TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT message_redaction_pk PRIMARY KEY (redaction_id),
  CONSTRAINT message_redaction_uq UNIQUE (message_id),
  CONSTRAINT message_redaction_message_fk FOREIGN KEY (message_id)
    REFERENCES sandbox.deal_message (message_id),
  CONSTRAINT message_redaction_actor_fk FOREIGN KEY (redacted_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT message_redaction_reason_len CHECK (char_length(reason) BETWEEN 10 AND 500)
);

CREATE FUNCTION sandbox.trg_message_immutable() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, sandbox, public
AS $fn$
BEGIN
  RAISE EXCEPTION
    'deal_message is append-only: moderate with sandbox.message_redaction instead'
    USING ERRCODE = '42501';
END;
$fn$;

CREATE TRIGGER deal_message_immutable
  BEFORE UPDATE OR DELETE ON sandbox.deal_message
  FOR EACH ROW EXECUTE FUNCTION sandbox.trg_message_immutable();

-- ---------------------------------------------------------------------
-- 7. Evidence, as metadata plus a storage capability.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  THE BYTES ARE NOT IN THIS DATABASE, AND THE URL IS NOT PUBLIC.  │
-- │                                                                  │
-- │  The old `deal_evidence` held content as BYTEA. That is fine for │
-- │  a demonstration and wrong for a product: it puts unscanned,     │
-- │  user-supplied bytes in the same store as the ledger, and it     │
-- │  makes "access rechecked on every download" impossible to        │
-- │  express, because a row that has been read is already read.      │
-- │                                                                  │
-- │  Here the row is METADATA. Bytes live behind a storage adapter,  │
-- │  reachable only through a short-lived, signed, single-purpose    │
-- │  capability that is issued per request and re-authorised every   │
-- │  time. There is no permanent URL to leak.                        │
-- └──────────────────────────────────────────────────────────────────┘
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.evidence_object (
  evidence_id  UUID        NOT NULL DEFAULT gen_random_uuid(),
  deal_id      UUID        NOT NULL,
  case_id      UUID        NULL,
  uploaded_by  UUID        NOT NULL,

  -- Provider-neutral. The adapter names its own bucket/key scheme.
  storage_key  TEXT        NOT NULL,
  provider_key TEXT        NOT NULL,

  filename     TEXT        NOT NULL,
  media_type   TEXT        NOT NULL,
  byte_size    INTEGER     NOT NULL,
  content_hash TEXT        NULL,     -- known only once bytes arrive

  state        sandbox.evidence_state NOT NULL DEFAULT 'PENDING',
  scan_verdict TEXT        NULL,
  rejected_reason TEXT     NULL,

  -- Immutable versioning: a replacement is a NEW row that points back.
  supersedes   UUID        NULL,
  version      INTEGER     NOT NULL DEFAULT 1,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_at  TIMESTAMPTZ NULL,
  scanned_at   TIMESTAMPTZ NULL,

  CONSTRAINT evidence_object_pk PRIMARY KEY (evidence_id),
  CONSTRAINT evidence_object_deal_fk FOREIGN KEY (deal_id) REFERENCES sandbox.deal (deal_id),
  CONSTRAINT evidence_object_case_fk FOREIGN KEY (case_id)
    REFERENCES sandbox.dispute_case (case_id),
  CONSTRAINT evidence_object_user_fk FOREIGN KEY (uploaded_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT evidence_object_supersedes_fk FOREIGN KEY (supersedes)
    REFERENCES sandbox.evidence_object (evidence_id),
  CONSTRAINT evidence_object_storage_uq UNIQUE (storage_key),
  CONSTRAINT evidence_object_size CHECK (byte_size > 0 AND byte_size <= 5 * 1024 * 1024),
  -- A closed catalogue. An executable can never be stored as evidence,
  -- whatever a browser claims its content type is.
  CONSTRAINT evidence_object_type_closed CHECK (
    media_type IN ('application/pdf','image/png','image/jpeg','image/webp')),
  CONSTRAINT evidence_object_hash_shape CHECK (
    content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  -- Bytes present means a hash; READY means it was scanned.
  CONSTRAINT evidence_object_arrived CHECK (
    (state = 'PENDING') = (uploaded_at IS NULL)),
  CONSTRAINT evidence_object_ready_scanned CHECK (
    state <> 'READY' OR (scanned_at IS NOT NULL AND content_hash IS NOT NULL
                         AND scan_verdict = 'CLEAN')),
  CONSTRAINT evidence_object_rejected_reason CHECK (
    (state = 'REJECTED') = (rejected_reason IS NOT NULL)),
  CONSTRAINT evidence_object_version CHECK (version >= 1),
  CONSTRAINT evidence_object_supersedes_self CHECK (supersedes IS DISTINCT FROM evidence_id)
);

CREATE INDEX evidence_object_deal_ix ON sandbox.evidence_object (deal_id, created_at);
CREATE INDEX evidence_object_case_ix ON sandbox.evidence_object (case_id, created_at)
  WHERE case_id IS NOT NULL;
-- A superseded row is replaced by exactly one successor.
CREATE UNIQUE INDEX evidence_object_supersedes_uq ON sandbox.evidence_object (supersedes)
  WHERE supersedes IS NOT NULL;

/*
 * Evidence metadata is append-mostly.
 *
 * The lifecycle columns move forward — PENDING → QUARANTINED → READY or
 * REJECTED — and nothing else ever changes. Rewriting a filename, a hash
 * or an uploader after the fact would break the one thing evidence is
 * for: showing that this is the same file somebody submitted then.
 */
CREATE FUNCTION sandbox.trg_evidence_transition() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, sandbox, public
AS $fn$
DECLARE
  ok BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence is permanent; reject it instead of deleting it'
      USING ERRCODE = '42501';
  END IF;

  IF (NEW.deal_id, NEW.uploaded_by, NEW.storage_key, NEW.filename,
      NEW.media_type, NEW.supersedes, NEW.version)
     IS DISTINCT FROM
     (OLD.deal_id, OLD.uploaded_by, OLD.storage_key, OLD.filename,
      OLD.media_type, OLD.supersedes, OLD.version) THEN
    RAISE EXCEPTION 'evidence % is immutable in its identity', OLD.evidence_id
      USING ERRCODE = '42501';
  END IF;

  -- A recorded hash is the hash. Re-pointing it would let a different
  -- file inherit an approved row.
  IF OLD.content_hash IS NOT NULL AND NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN
    RAISE EXCEPTION 'evidence % already carries a content hash', OLD.evidence_id
      USING ERRCODE = '42501';
  END IF;

  IF OLD.state = NEW.state THEN RETURN NEW; END IF;

  ok := CASE OLD.state
    WHEN 'PENDING'     THEN NEW.state IN ('QUARANTINED','REJECTED')
    WHEN 'QUARANTINED' THEN NEW.state IN ('READY','REJECTED')
    ELSE FALSE     -- READY and REJECTED are terminal
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'evidence % cannot move from % to %',
      OLD.evidence_id, OLD.state, NEW.state USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER evidence_object_transition
  BEFORE UPDATE OR DELETE ON sandbox.evidence_object
  FOR EACH ROW EXECUTE FUNCTION sandbox.trg_evidence_transition();

/*
 * Storage capabilities: short-lived, single-use, single-purpose.
 *
 * The token itself is never stored — only its SHA-256 — for the same
 * reason a session token is not stored: a database dump must not hand
 * somebody the ability to download every participant's bank receipts.
 *
 * `consumed_at` makes a capability single-use, so a captured token that
 * is still inside its window is still worthless once it has been spent.
 */
CREATE TABLE sandbox.evidence_capability (
  capability_id UUID       NOT NULL DEFAULT gen_random_uuid(),
  evidence_id  UUID        NOT NULL,
  kind         sandbox.capability_kind NOT NULL,
  token_hash   TEXT        NOT NULL,
  issued_to    UUID        NOT NULL,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ NULL,

  CONSTRAINT evidence_capability_pk PRIMARY KEY (capability_id),
  CONSTRAINT evidence_capability_token_uq UNIQUE (token_hash),
  CONSTRAINT evidence_capability_evidence_fk FOREIGN KEY (evidence_id)
    REFERENCES sandbox.evidence_object (evidence_id),
  CONSTRAINT evidence_capability_user_fk FOREIGN KEY (issued_to)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT evidence_capability_hash_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- Deliberately short. A capability that outlives the page that used it
  -- is a capability somebody can find in a proxy log tomorrow.
  CONSTRAINT evidence_capability_window CHECK (expires_at > issued_at)
);

CREATE INDEX evidence_capability_evidence_ix
  ON sandbox.evidence_capability (evidence_id, issued_at);

-- ---------------------------------------------------------------------
-- 8. Incidents — where the system fails CLOSED.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  SOME SITUATIONS HAVE NO SAFE AUTOMATIC ANSWER.                  │
-- │                                                                  │
-- │  A chain reorg that withdraws a deposit AFTER its value was      │
-- │  released to the counterparty is the clearest one. The value is  │
-- │  gone; the platform can either invent a compensating balance     │
-- │  (a lie), silently debit a user who did nothing wrong (theft),   │
-- │  or STOP and tell a human.                                       │
-- │                                                                  │
-- │  This table is that stop. It is the honest answer, and the       │
-- │  reason it exists as a first-class record rather than a log line │
-- │  is that a log line is not something anybody is accountable for. │
-- └──────────────────────────────────────────────────────────────────┘
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.deal_incident (
  incident_id  UUID        NOT NULL DEFAULT gen_random_uuid(),
  deal_id      UUID        NOT NULL,
  kind         TEXT        NOT NULL,
  detail       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  state        TEXT        NOT NULL DEFAULT 'OPEN',
  opened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at    TIMESTAMPTZ NULL,
  closed_by    UUID        NULL,
  closing_note TEXT        NULL,

  CONSTRAINT deal_incident_pk PRIMARY KEY (incident_id),
  CONSTRAINT deal_incident_deal_fk FOREIGN KEY (deal_id) REFERENCES sandbox.deal (deal_id),
  CONSTRAINT deal_incident_closer_fk FOREIGN KEY (closed_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT deal_incident_kind CHECK (
    kind IN ('REORG_AFTER_DISPOSAL','LATE_EVENT_AFTER_RESOLUTION','LOCK_STATE_DIVERGENCE')),
  CONSTRAINT deal_incident_state CHECK (state IN ('OPEN','ACKNOWLEDGED','CLOSED')),
  CONSTRAINT deal_incident_detail_obj CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT deal_incident_closed_rule CHECK (
    (state = 'CLOSED') = (closed_at IS NOT NULL AND closed_by IS NOT NULL))
);

-- One open incident per deal and kind: a provider redelivering the same
-- bad news must not open fifty tickets.
CREATE UNIQUE INDEX deal_incident_open_uq
  ON sandbox.deal_incident (deal_id, kind)
  WHERE state <> 'CLOSED';

CREATE INDEX deal_incident_open_ix ON sandbox.deal_incident (opened_at)
  WHERE state <> 'CLOSED';

-- ---------------------------------------------------------------------
-- 9. Read models.
--
-- Both views EXCLUDE operator notes, capability tokens and storage keys.
-- The exclusion is in the view definition rather than in each caller,
-- because the caller that forgets is the one that ships.
-- ---------------------------------------------------------------------

CREATE VIEW sandbox.case_timeline AS
  SELECT c.case_id,
         c.deal_id,
         c.state,
         c.category,
         c.statement,
         c.opened_by,
         c.opened_at,
         c.disposition,
         c.resolution_note,
         c.resolved_at,
         c.version
    FROM sandbox.dispute_case c;

COMMENT ON VIEW sandbox.case_timeline IS
  'Participant-visible dispute case. Carries no operator note, no proposal '
  'rationale and no storage key: what an investigator was thinking is not '
  'part of what the parties are told.';

CREATE VIEW sandbox.evidence_manifest AS
  SELECT e.evidence_id,
         e.deal_id,
         e.case_id,
         e.uploaded_by,
         e.filename,
         e.media_type,
         e.byte_size,
         e.content_hash,
         e.state,
         e.version,
         e.supersedes,
         e.created_at,
         e.uploaded_at
    FROM sandbox.evidence_object e;

COMMENT ON VIEW sandbox.evidence_manifest IS
  'Evidence METADATA. No storage key and no capability token: knowing that '
  'a receipt exists is not permission to fetch it, and fetching is a '
  'separately authorised act.';
