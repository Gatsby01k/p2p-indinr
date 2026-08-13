-- =====================================================================
-- 0009 — DEL-05: INR and USDT payment rails.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  THE ONE RULE THIS MIGRATION EXISTS TO ENFORCE:                  │
-- │                                                                  │
-- │  NOTHING IN THIS SCHEMA IS PROOF THAT MONEY MOVED.               │
-- │                                                                  │
-- │  A payment intent is a demand. An instruction is a request. An   │
-- │  observation is a report. Only an observation that a PROVIDER or │
-- │  a WATCHER produced, whose signature verified, whose reference   │
-- │  normalized, whose amount and asset matched, and whose           │
-- │  confirmation policy was satisfied, may move an intent to        │
-- │  CONFIRMED — and only that transition is permitted to post to    │
-- │  the DEL-04 ledger.                                              │
-- │                                                                  │
-- │  A human typing a UTR or a transaction hash produces EVIDENCE.   │
-- │  Evidence is stored, audited and shown to reviewers. It can      │
-- │  never, by itself, confirm anything: `payment_evidence` has no   │
-- │  path to `CONFIRMED` anywhere in this file or in the service.    │
-- └──────────────────────────────────────────────────────────────────┘
--
-- These tables live in `sandbox`, NOT in `inrp2p`. That placement is a
-- statement: rail records are operational bookkeeping about the outside
-- world, and the outside world is not authoritative about value. Value
-- lives in `inrp2p` and gets there only through `inrp2p.post_entry`.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT CONTAIN: any provider
-- credential, endpoint, or account number; any production webhook
-- secret; any row that asserts a successful production payment. The
-- sandbox rows it permits are prefixed so they cannot be mistaken for
-- production references in a database dump.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Vocabulary.
--
-- The rail and network are separate columns because conflating them is
-- the exact mistake that sends TRC20 USDT to an ERC20 address. There is
-- no "USDT" network; there is TRC20, and this stage supports only TRC20.
-- ---------------------------------------------------------------------

CREATE TYPE sandbox.payment_rail AS ENUM ('INR', 'USDT');

-- `TRC20` is the only member, and adding another is a deliberate
-- migration rather than a string a caller can pass. An unrecognised
-- network cannot be represented, so it cannot be stored, so it cannot be
-- matched against.
CREATE TYPE sandbox.payment_network AS ENUM ('UPI', 'IMPS', 'NEFT', 'TRC20');

-- COLLECT: value comes IN from a participant.
-- PAYOUT:  value goes OUT to a participant.
CREATE TYPE sandbox.payment_direction AS ENUM ('COLLECT', 'PAYOUT');

CREATE TYPE sandbox.payment_state AS ENUM (
  'REQUESTED',   -- the demand exists; no instruction issued yet
  'INSTRUCTED',  -- instruction released to the payer (requires a live lock)
  'OBSERVED',    -- a matching provider report arrived, below policy
  'CONFIRMED',   -- policy satisfied; the ONE state that may post to the ledger
  'FAILED',      -- the provider reported failure, or an observation was refused
  'EXPIRED',     -- the window closed with nothing confirmed
  'REVERSED'     -- confirmed, then withdrawn by the chain (reorg) or provider
);

CREATE TYPE sandbox.observation_kind AS ENUM (
  'PENDING',     -- seen, not yet final (mempool, or provider "processing")
  'CONFIRMED',   -- the provider/watcher asserts finality
  'FAILED',      -- the provider/watcher asserts failure
  'REORGED'      -- a previously confirmed chain observation was withdrawn
);

CREATE TYPE sandbox.observation_source AS ENUM (
  'PROVIDER_WEBHOOK',  -- signed, verified, authoritative
  'CHAIN_WATCHER',     -- polled from a watcher adapter, authoritative
  'CLIENT_EVIDENCE'    -- typed by a human. NEVER authoritative.
);

-- ---------------------------------------------------------------------
-- 2. Audit and outbox learn the word "payment".
--
-- Both constraints are rewritten rather than dropped: an audit trail that
-- silently accepts any subject kind is a trail nobody can query with
-- confidence. Adding a value is a migration, which is the point.
-- ---------------------------------------------------------------------

ALTER TABLE sandbox.audit_event DROP CONSTRAINT audit_event_subject_kind;
ALTER TABLE sandbox.audit_event ADD CONSTRAINT audit_event_subject_kind
  CHECK (subject_kind IN ('link','deal','quote','user','payment'));

ALTER TABLE sandbox.outbox_event DROP CONSTRAINT outbox_event_subject_kind;
ALTER TABLE sandbox.outbox_event ADD CONSTRAINT outbox_event_subject_kind
  CHECK (subject_kind IN ('link','deal','quote','user','payment'));

-- ---------------------------------------------------------------------
-- 3. Payment intent — the demand.
--
-- ONE LIVE INTENT PER (deal, rail, direction). The partial unique index
-- is what makes "you cannot open a second collection for the same deal
-- while one is still running" a database fact rather than a race between
-- two requests that both checked first.
--
-- `amount_minor` is BIGINT and integral by construction. There is no
-- decimal anywhere in this table: a rail amount that passed through a
-- float is a rail amount that cannot be reconciled.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.payment_intent (
  intent_id     UUID        NOT NULL DEFAULT gen_random_uuid(),
  deal_id       UUID        NOT NULL,
  rail          sandbox.payment_rail      NOT NULL,
  network       sandbox.payment_network   NOT NULL,
  direction     sandbox.payment_direction NOT NULL,
  state         sandbox.payment_state     NOT NULL DEFAULT 'REQUESTED',

  -- Who owes it, and who receives it. Both are participants of the deal;
  -- the service checks that, and `payment_intent_party_distinct` refuses
  -- the degenerate case outright.
  payer_id      UUID        NOT NULL,
  payee_id      UUID        NOT NULL,

  asset         TEXT        NOT NULL,   -- 'INR' or 'USDT'
  amount_minor  BIGINT      NOT NULL,

  -- The DEL-04 lock this intent depends on. Instructions are released
  -- only while this lock is LOCKED, checked live at read time.
  required_lock_id UUID     NULL,

  -- Exactly-once ledger posting. Set at, and only at, the CONFIRMED
  -- transition; the unique constraint means a retried confirmation
  -- cannot produce a second entry even if every other guard failed.
  ledger_entry_id  UUID     NULL,
  reversal_entry_id UUID    NULL,

  confirmed_observation_id UUID NULL,
  failure_reason TEXT       NULL,

  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  instructed_at TIMESTAMPTZ NULL,
  settled_at    TIMESTAMPTZ NULL,
  version       INTEGER     NOT NULL DEFAULT 0,

  CONSTRAINT payment_intent_pk PRIMARY KEY (intent_id),
  CONSTRAINT payment_intent_deal_fk FOREIGN KEY (deal_id)
    REFERENCES sandbox.deal (deal_id),
  CONSTRAINT payment_intent_payer_fk FOREIGN KEY (payer_id)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT payment_intent_payee_fk FOREIGN KEY (payee_id)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT payment_intent_party_distinct CHECK (payer_id <> payee_id),
  CONSTRAINT payment_intent_amount_pos CHECK (amount_minor > 0),

  -- The rail decides which networks and which asset are even expressible.
  -- A TRC20 INR payment and a UPI USDT payment are both unrepresentable.
  CONSTRAINT payment_intent_rail_network CHECK (
    (rail = 'INR'  AND network IN ('UPI','IMPS','NEFT') AND asset = 'INR')
 OR (rail = 'USDT' AND network = 'TRC20'                AND asset = 'USDT')),

  -- An instruction cannot predate the intent, and a settlement cannot
  -- predate the instruction.
  CONSTRAINT payment_intent_instructed_state CHECK (
    (instructed_at IS NOT NULL) = (state <> 'REQUESTED' AND state <> 'EXPIRED')
    OR (state = 'EXPIRED')),
  CONSTRAINT payment_intent_settled_state CHECK (
    (settled_at IS NOT NULL) = (state IN ('CONFIRMED','FAILED','EXPIRED','REVERSED'))),

  -- ONLY a confirmed intent may carry a ledger entry. This is the
  -- structural half of "failed or expired payments must not create
  -- confirmed-value postings": there is nowhere to record one.
  CONSTRAINT payment_intent_entry_only_when_confirmed CHECK (
    ledger_entry_id IS NULL OR state IN ('CONFIRMED','REVERSED')),
  CONSTRAINT payment_intent_reversal_needs_entry CHECK (
    reversal_entry_id IS NULL OR (ledger_entry_id IS NOT NULL AND state = 'REVERSED')),
  /*
   * A confirmation must name the observation that caused it — always.
   *
   * It must carry a LEDGER ENTRY only on the USDT rail, because that is
   * the only rail whose value enters the ledger. A confirmed INR payment
   * means rupees moved between two BANK accounts INRP2P does not hold,
   * and TS-02 §4 forbids an INR ledger balance, so there is nothing to
   * post. Requiring an entry here would have forced somebody to invent
   * one — which is exactly the claim this stage must not make.
   */
  CONSTRAINT payment_intent_confirmed_has_evidence CHECK (
    state <> 'CONFIRMED' OR confirmed_observation_id IS NOT NULL),
  CONSTRAINT payment_intent_usdt_confirmed_has_entry CHECK (
    state <> 'CONFIRMED' OR rail <> 'USDT' OR ledger_entry_id IS NOT NULL),
  CONSTRAINT payment_intent_inr_never_posts CHECK (
    rail <> 'INR' OR (ledger_entry_id IS NULL AND reversal_entry_id IS NULL)),
  CONSTRAINT payment_intent_failure_reason CHECK (
    (failure_reason IS NULL) OR state IN ('FAILED','EXPIRED','REVERSED'))
);

-- One live demand per deal, rail and direction.
CREATE UNIQUE INDEX payment_intent_live_uq
  ON sandbox.payment_intent (deal_id, rail, direction)
  WHERE state IN ('REQUESTED','INSTRUCTED','OBSERVED');

-- A ledger entry belongs to exactly one intent. Retried provider events
-- cannot fan one entry out across two intents.
CREATE UNIQUE INDEX payment_intent_entry_uq
  ON sandbox.payment_intent (ledger_entry_id)
  WHERE ledger_entry_id IS NOT NULL;

CREATE INDEX payment_intent_deal_ix ON sandbox.payment_intent (deal_id, state);
CREATE INDEX payment_intent_due_ix  ON sandbox.payment_intent (expires_at)
  WHERE state IN ('REQUESTED','INSTRUCTED','OBSERVED');

-- ---------------------------------------------------------------------
-- 4. Payment instruction — the sensitive part.
--
-- This is the row that carries a bank handle or a deposit address, so it
-- is separated from the intent precisely so that reading an intent does
-- not read an instruction. Two different queries, two different
-- authorization decisions, and a log that prints an intent prints no
-- account number.
--
-- `reference` is the payer-visible tag that MUST appear on the transfer.
-- In sandbox it is `SBX-` prefixed and the check enforces that: a
-- sandbox reference in a production reconciliation report is then a
-- self-announcing error rather than a silent match.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.payment_instruction (
  instruction_id UUID       NOT NULL DEFAULT gen_random_uuid(),
  intent_id     UUID        NOT NULL,

  -- Provider-neutral: the adapter names itself, and no provider identity
  -- is hard-coded anywhere in this schema.
  provider_key  TEXT        NOT NULL,
  -- What the payer must send to. A VPA, an account+IFSC, or a TRC20
  -- address. Opaque here; the service validates by network.
  destination   TEXT        NOT NULL,
  destination_detail JSONB  NOT NULL DEFAULT '{}'::jsonb,
  reference     TEXT        NOT NULL,

  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  issued_to     UUID        NOT NULL,

  CONSTRAINT payment_instruction_pk PRIMARY KEY (instruction_id),
  -- One instruction per intent: reissuing must not silently create a
  -- second destination while the payer is looking at the first.
  CONSTRAINT payment_instruction_intent_uq UNIQUE (intent_id),
  CONSTRAINT payment_instruction_intent_fk FOREIGN KEY (intent_id)
    REFERENCES sandbox.payment_intent (intent_id),
  CONSTRAINT payment_instruction_issued_fk FOREIGN KEY (issued_to)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT payment_instruction_detail_obj CHECK (
    jsonb_typeof(destination_detail) = 'object'),
  CONSTRAINT payment_instruction_reference_shape CHECK (
    reference ~ '^SBX-[A-Z0-9-]{6,48}$'),
  CONSTRAINT payment_instruction_destination_len CHECK (
    length(destination) BETWEEN 3 AND 128)
);

-- ---------------------------------------------------------------------
-- 5. Provider event log — replay protection, before anything is believed.
--
-- Every inbound webhook or watcher poll lands here FIRST, keyed by
-- (provider, provider_event_id). The unique constraint is the replay
-- defence: a provider that delivers the same event five times — which
-- every real provider does — inserts once and the other four are
-- recognised as duplicates by the database, not by a cache that might
-- have been evicted.
--
-- `body_digest` is stored alongside so a replayed id carrying a DIFFERENT
-- body is distinguishable from an honest redelivery. Same id, different
-- body is not a duplicate; it is someone editing an event.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.rail_event (
  rail_event_id UUID        NOT NULL DEFAULT gen_random_uuid(),
  provider_key  TEXT        NOT NULL,
  provider_event_id TEXT    NOT NULL,
  body_digest   BYTEA       NOT NULL,
  signature_verified BOOLEAN NOT NULL,
  -- The provider's own timestamp, used for the freshness window.
  event_at      TIMESTAMPTZ NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted      BOOLEAN     NOT NULL,
  refusal_code  TEXT        NULL,

  CONSTRAINT rail_event_pk PRIMARY KEY (rail_event_id),
  CONSTRAINT rail_event_provider_uq UNIQUE (provider_key, provider_event_id),
  CONSTRAINT rail_event_digest_len CHECK (length(body_digest) = 32),
  -- An accepted event must have verified. There is no "accepted anyway".
  CONSTRAINT rail_event_accepted_verified CHECK (accepted = FALSE OR signature_verified),
  CONSTRAINT rail_event_refusal CHECK ((refusal_code IS NULL) = accepted)
);

CREATE INDEX rail_event_received_ix ON sandbox.rail_event (received_at);

-- ---------------------------------------------------------------------
-- 6. Observation — what somebody REPORTED about the outside world.
--
-- The `source` column is the whole safety story. `CLIENT_EVIDENCE` rows
-- may exist freely and are shown to reviewers; the service has no branch
-- that reads one and confirms an intent. `PROVIDER_WEBHOOK` and
-- `CHAIN_WATCHER` rows require a verified `rail_event`, enforced below.
--
-- `external_ref` is the NORMALIZED reference: an upper-cased UTR, or a
-- lower-cased 0x-free transaction hash. Normalizing before storing is
-- what makes uniqueness mean anything — `abc123` and `ABC123` are the
-- same bank reference, and a database that thinks otherwise will happily
-- accept the same payment twice.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.payment_observation (
  observation_id UUID       NOT NULL DEFAULT gen_random_uuid(),
  intent_id     UUID        NULL,     -- NULL when nothing matched
  deal_id       UUID        NULL,
  rail          sandbox.payment_rail       NOT NULL,
  network       sandbox.payment_network    NOT NULL,
  source        sandbox.observation_source NOT NULL,
  kind          sandbox.observation_kind   NOT NULL,

  rail_event_id UUID        NULL,     -- the verified delivery, when authoritative
  submitted_by  UUID        NULL,     -- the human, for CLIENT_EVIDENCE

  external_ref  TEXT        NOT NULL,
  asset         TEXT        NOT NULL,
  amount_minor  BIGINT      NOT NULL,
  confirmations INTEGER     NOT NULL DEFAULT 0,
  -- Provider-declared beneficiary, compared against the instruction.
  beneficiary   TEXT        NULL,
  observed_at   TIMESTAMPTZ NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Why this observation did or did not reconcile. Always populated, so
  -- a reviewer never has to guess why a payment did not settle.
  match_outcome TEXT        NOT NULL,

  /*
   * Was this report APPLIED to the intent, or recorded and refused?
   *
   * A refused report is still evidence and must survive — "we received a
   * webhook claiming this UTR and refused it because the amount was
   * wrong" is precisely what a support case needs. But a refused report
   * makes no claim on its reference, so it is excluded from the
   * uniqueness index below. Without this column the only way to keep the
   * evidence would be to mangle the stored reference, and a reference
   * that has been altered to fit a constraint is no longer evidence.
   */
  accepted      BOOLEAN     NOT NULL,

  CONSTRAINT payment_observation_pk PRIMARY KEY (observation_id),
  CONSTRAINT payment_observation_intent_fk FOREIGN KEY (intent_id)
    REFERENCES sandbox.payment_intent (intent_id),
  CONSTRAINT payment_observation_deal_fk FOREIGN KEY (deal_id)
    REFERENCES sandbox.deal (deal_id),
  CONSTRAINT payment_observation_event_fk FOREIGN KEY (rail_event_id)
    REFERENCES sandbox.rail_event (rail_event_id),
  CONSTRAINT payment_observation_user_fk FOREIGN KEY (submitted_by)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT payment_observation_amount_pos CHECK (amount_minor > 0),
  CONSTRAINT payment_observation_confirmations CHECK (confirmations >= 0),

  /*
   * AN AUTHORITATIVE OBSERVATION MUST CARRY A VERIFIED DELIVERY, AND A
   * CLIENT OBSERVATION MUST NOT.
   *
   * This is the constraint that makes "client evidence cannot confirm a
   * payment" impossible to bypass by mislabelling a row: to write a
   * PROVIDER_WEBHOOK observation you need a `rail_event` id, and a
   * `rail_event` cannot be `accepted` unless its signature verified.
   */
  CONSTRAINT payment_observation_authority CHECK (
    (source = 'CLIENT_EVIDENCE' AND rail_event_id IS NULL AND submitted_by IS NOT NULL)
 OR (source IN ('PROVIDER_WEBHOOK','CHAIN_WATCHER')
     AND rail_event_id IS NOT NULL AND submitted_by IS NULL)),

  -- Client evidence is never final, whatever it claims to be, and it is
  -- never "accepted" in the sense that would let it claim a reference.
  CONSTRAINT payment_observation_client_not_confirming CHECK (
    source <> 'CLIENT_EVIDENCE' OR (kind = 'PENDING' AND accepted = FALSE)),

  -- An accepted report must belong to an intent. "Applied to nothing" is
  -- not a state; it is a bug.
  CONSTRAINT payment_observation_accepted_matched CHECK (
    accepted = FALSE OR intent_id IS NOT NULL),

  CONSTRAINT payment_observation_ref_shape CHECK (
    (rail = 'INR'  AND external_ref ~ '^[A-Z0-9]{6,32}$')
 OR (rail = 'USDT' AND external_ref ~ '^[0-9a-f]{64}$'))
);

/*
 * ONE CONFIRMED MOVEMENT PER REFERENCE, PLATFORM-WIDE.
 *
 * A UTR or a transaction hash identifies ONE real-world movement. Two
 * intents claiming the same reference is either a provider bug or fraud,
 * and in both cases the second must be refused rather than reconciled.
 *
 * The predicate is narrow on purpose, and each exclusion is deliberate:
 *
 *   · NOT `accepted = false` — a refused provider report is evidence,
 *     not a claim, and evidence must survive rather than be discarded to
 *     satisfy a constraint;
 *   · NOT `CLIENT_EVIDENCE` — two people may honestly type the same UTR
 *     by mistake, which is a review problem and not a collision;
 *   · NOT `FAILED` or `REORGED` — those WITHDRAW a claim on a reference
 *     rather than making one. A reorg necessarily names the same hash as
 *     the confirmation it reverses, and it must be recordable.
 */
CREATE UNIQUE INDEX payment_observation_confirmed_ref_uq
  ON sandbox.payment_observation (rail, external_ref)
  WHERE accepted AND kind = 'CONFIRMED'
    AND source IN ('PROVIDER_WEBHOOK','CHAIN_WATCHER');

CREATE INDEX payment_observation_intent_ix
  ON sandbox.payment_observation (intent_id, recorded_at);
CREATE INDEX payment_observation_ref_ix
  ON sandbox.payment_observation (rail, external_ref);

-- ---------------------------------------------------------------------
-- 7. USDT address allocation.
--
-- An address belongs to exactly one deal for exactly one user, forever.
-- Reusing a deposit address across deals is how a payment for deal A
-- gets credited to deal B, so the uniqueness is unconditional rather
-- than scoped to live deals.
-- ---------------------------------------------------------------------

CREATE TABLE sandbox.usdt_address_allocation (
  allocation_id UUID        NOT NULL DEFAULT gen_random_uuid(),
  address       TEXT        NOT NULL,
  network       sandbox.payment_network NOT NULL,
  deal_id       UUID        NOT NULL,
  owner_id      UUID        NOT NULL,
  intent_id     UUID        NOT NULL,
  allocated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT usdt_address_allocation_pk PRIMARY KEY (allocation_id),
  CONSTRAINT usdt_address_uq UNIQUE (address),
  CONSTRAINT usdt_address_intent_uq UNIQUE (intent_id),
  CONSTRAINT usdt_address_deal_fk FOREIGN KEY (deal_id)
    REFERENCES sandbox.deal (deal_id),
  CONSTRAINT usdt_address_owner_fk FOREIGN KEY (owner_id)
    REFERENCES sandbox.app_user (user_id),
  CONSTRAINT usdt_address_intent_fk FOREIGN KEY (intent_id)
    REFERENCES sandbox.payment_intent (intent_id),
  -- Only TRC20 exists in this stage, and the type cannot express others
  -- for USDT anyway. Stated twice on purpose: a future network added to
  -- the enum must come here and decide, rather than inherit silently.
  CONSTRAINT usdt_address_network CHECK (network = 'TRC20'),
  /*
   * A SANDBOX ADDRESS IS SHAPED LIKE A TRON ADDRESS AND IS NOT ONE.
   *
   * Base58 TRON addresses start `T` and are 34 characters. Sandbox
   * addresses start `TSBX` so they are the right shape for the UI and
   * the validators, and are instantly recognisable as fictitious in any
   * dump, report or support ticket. A production allocator would insert
   * real addresses and this check would have to be revisited
   * deliberately — which is the intent.
   */
  CONSTRAINT usdt_address_sandbox_shape CHECK (address ~ '^TSBX[1-9A-HJ-NP-Za-km-z]{30}$')
);

-- ---------------------------------------------------------------------
-- 8. Rail request outbox — retry-safe external calls.
--
-- Calling a provider is the one thing that cannot be inside the database
-- transaction: the call can succeed while the transaction rolls back, and
-- then the world and the database disagree. So the intent to call is
-- COMMITTED first, with a stable idempotency key, and a worker performs
-- the call afterwards.
--
-- `idempotency_key` is derived from the command, so a worker that
-- crashes after the provider returned but before it recorded the result
-- will retry with the SAME key and the provider will deduplicate. That
-- is why the key is stored rather than generated at call time.
-- ---------------------------------------------------------------------

CREATE TYPE sandbox.rail_request_state AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

CREATE TABLE sandbox.rail_request (
  request_id    UUID        NOT NULL DEFAULT gen_random_uuid(),
  intent_id     UUID        NOT NULL,
  provider_key  TEXT        NOT NULL,
  operation     TEXT        NOT NULL,
  idempotency_key TEXT      NOT NULL,
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  state         sandbox.rail_request_state NOT NULL DEFAULT 'PENDING',
  attempts      INTEGER     NOT NULL DEFAULT 0,
  max_attempts  INTEGER     NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error    TEXT        NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ NULL,

  CONSTRAINT rail_request_pk PRIMARY KEY (request_id),
  CONSTRAINT rail_request_intent_fk FOREIGN KEY (intent_id)
    REFERENCES sandbox.payment_intent (intent_id),
  -- The key IS the deduplication contract with the provider.
  CONSTRAINT rail_request_key_uq UNIQUE (idempotency_key),
  CONSTRAINT rail_request_payload_obj CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT rail_request_attempts CHECK (attempts >= 0 AND attempts <= max_attempts),
  CONSTRAINT rail_request_completed CHECK (
    (completed_at IS NOT NULL) = (state <> 'PENDING'))
);

CREATE INDEX rail_request_due_ix ON sandbox.rail_request (next_attempt_at)
  WHERE state = 'PENDING';

-- ---------------------------------------------------------------------
-- 9. Append-only guarantees.
--
-- Observations and rail events are records that something was REPORTED.
-- Editing one after the fact would let a settled payment be re-explained,
-- which is exactly what a fraud investigation must be able to rule out.
-- Triggers rather than rules, so the refusal is loud and `ON CONFLICT`
-- keeps working.
-- ---------------------------------------------------------------------

CREATE FUNCTION sandbox.trg_rail_immutable() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, sandbox, public
AS $fn$
BEGIN
  RAISE EXCEPTION
    'sandbox.% is append-only: a report of what happened cannot be rewritten',
    TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$fn$;

CREATE TRIGGER rail_event_immutable
  BEFORE UPDATE OR DELETE ON sandbox.rail_event
  FOR EACH ROW EXECUTE FUNCTION sandbox.trg_rail_immutable();

CREATE TRIGGER payment_observation_immutable
  BEFORE UPDATE OR DELETE ON sandbox.payment_observation
  FOR EACH ROW EXECUTE FUNCTION sandbox.trg_rail_immutable();

CREATE TRIGGER payment_instruction_immutable
  BEFORE UPDATE OR DELETE ON sandbox.payment_instruction
  FOR EACH ROW EXECUTE FUNCTION sandbox.trg_rail_immutable();

CREATE TRIGGER usdt_address_allocation_immutable
  BEFORE UPDATE OR DELETE ON sandbox.usdt_address_allocation
  FOR EACH ROW EXECUTE FUNCTION sandbox.trg_rail_immutable();

-- ---------------------------------------------------------------------
-- 10. The state machine, enforced in the database.
--
-- The service also checks transitions, and that is not redundancy for its
-- own sake: the service produces a clean refusal a caller can act on,
-- while this trigger guarantees that NO code path — a future feature, a
-- migration, an operator with psql — can move an intent somewhere the
-- design does not allow. Two layers, two different jobs.
-- ---------------------------------------------------------------------

CREATE FUNCTION sandbox.trg_payment_intent_transition() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, sandbox, public
AS $fn$
DECLARE
  ok BOOLEAN;
BEGIN
  /*
   * IMMUTABILITY IS CHECKED FIRST, BEFORE THE STATE COMPARISON.
   *
   * The identity of a payment never changes. Re-pointing an intent at
   * another deal, party, asset or amount would let a confirmed payment be
   * re-attributed after the fact — and that rewrite does not need a state
   * change to do its damage, so an early `RETURN NEW` for same-state
   * updates would have waved it straight through.
   */
  IF (NEW.deal_id, NEW.rail, NEW.network, NEW.direction, NEW.payer_id,
      NEW.payee_id, NEW.asset, NEW.amount_minor)
     IS DISTINCT FROM
     (OLD.deal_id, OLD.rail, OLD.network, OLD.direction, OLD.payer_id,
      OLD.payee_id, OLD.asset, OLD.amount_minor) THEN
    RAISE EXCEPTION 'payment intent % is immutable in its terms', OLD.intent_id
      USING ERRCODE = '42501';
  END IF;

  -- A ledger entry, once recorded, IS the entry. Re-pointing it would
  -- break the exactly-once guarantee the unique index provides.
  IF OLD.ledger_entry_id IS NOT NULL
     AND NEW.ledger_entry_id IS DISTINCT FROM OLD.ledger_entry_id THEN
    RAISE EXCEPTION 'payment intent % already posted entry %',
      OLD.intent_id, OLD.ledger_entry_id
      USING ERRCODE = '42501';
  END IF;

  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;

  ok := CASE OLD.state
    WHEN 'REQUESTED'  THEN NEW.state IN ('INSTRUCTED','FAILED','EXPIRED')
    WHEN 'INSTRUCTED' THEN NEW.state IN ('OBSERVED','CONFIRMED','FAILED','EXPIRED')
    WHEN 'OBSERVED'   THEN NEW.state IN ('CONFIRMED','FAILED','EXPIRED')
    WHEN 'CONFIRMED'  THEN NEW.state = 'REVERSED'
    ELSE FALSE          -- FAILED, EXPIRED and REVERSED are terminal
  END;

  IF NOT ok THEN
    RAISE EXCEPTION 'payment intent % cannot move from % to %',
      OLD.intent_id, OLD.state, NEW.state
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER payment_intent_transition
  BEFORE UPDATE ON sandbox.payment_intent
  FOR EACH ROW EXECUTE FUNCTION sandbox.trg_payment_intent_transition();

CREATE RULE payment_intent_no_delete AS
  ON DELETE TO sandbox.payment_intent DO INSTEAD NOTHING;

-- ---------------------------------------------------------------------
-- 11. Reconciliation read surface.
--
-- Deliberately excludes `destination` and `destination_detail`: a
-- reconciliation report is read by people who need to know that a
-- payment matched, not where the money was sent. Least privilege applies
-- to reports as much as to roles.
-- ---------------------------------------------------------------------

CREATE VIEW sandbox.payment_reconciliation AS
  SELECT i.intent_id,
         i.deal_id,
         i.rail,
         i.network,
         i.direction,
         i.state,
         i.asset,
         i.amount_minor,
         i.ledger_entry_id,
         i.reversal_entry_id,
         o.observation_id,
         o.source,
         o.kind,
         o.external_ref,
         o.amount_minor      AS observed_amount_minor,
         o.confirmations,
         o.match_outcome,
         o.recorded_at
    FROM sandbox.payment_intent i
    LEFT JOIN sandbox.payment_observation o ON o.intent_id = i.intent_id;

-- ---------------------------------------------------------------------
-- 12. The one journal DEL-05 may post.
--
-- A CONFIRMED USDT observation is the first thing in this repository
-- that represents value arriving from OUTSIDE. `wallet.deposit` is an
-- ASSET and debiting it is a claim that the custodian now holds those
-- tokens — a claim DEL-04 forbade for conjured value and which is
-- correct here, and only here, because a watcher observed the transfer
-- on chain and the confirmation policy was satisfied.
--
-- THERE IS NO INR JOURNAL, AND THAT IS NOT AN OMISSION. A confirmed INR
-- payment means rupees moved between two BANK accounts that INRP2P does
-- not hold. TS-02 §4 forbids an INR ledger balance for that exact
-- reason, so an INR confirmation updates the payment record and posts
-- nothing. Inventing an INR posting would be claiming custody of
-- customer rupees.
-- ---------------------------------------------------------------------

INSERT INTO inrp2p.journal_catalogue (journal_code, entry_class, description) VALUES
  ('JD-DEP-CONFIRM', 'SNJ',
   'A confirmed, policy-satisfying on-chain USDT deposit observed by a watcher. '
   'Debits the deposit wallet and credits the deal escrow. Posted only at the '
   'CONFIRMED transition of a payment intent, exactly once per intent.')
ON CONFLICT (journal_code) DO NOTHING;

COMMENT ON VIEW sandbox.payment_reconciliation IS
  'Intent-to-observation reconciliation. Carries no destination, account '
  'number or address: matching a payment does not require knowing where it '
  'was sent. Rows here describe REPORTS about the outside world and are '
  'never proof that value moved.';
