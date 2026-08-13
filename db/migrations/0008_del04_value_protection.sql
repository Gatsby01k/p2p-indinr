-- =====================================================================
-- INRP2P — DEL-04 migration 0008: value protection over the ledger core.
--
-- 0007 built the spine: deterministic account identity, the closed
-- catalogue, entries, postings, balances and per-asset zero sum. This
-- file makes the spine USABLE — a posting boundary that maintains
-- balances atomically, an explicit available/locked separation, and deal
-- value locks that are idempotent, concurrent-safe and reversible.
--
-- ⚠ AN ENTRY HERE IS NOT PROOF THAT EXTERNAL FUNDS MOVED.
--
-- Everything below moves value BETWEEN INTERNAL ACCOUNTS. No deposit,
-- withdrawal, bank instruction or chain transaction exists in this
-- repository, and none is implied by a balance in this schema. What the
-- ledger proves is internal consistency: that every unit is in exactly
-- one account, that nothing was created or destroyed, and that a deal's
-- locked value is separated from its owner's spendable balance.
-- Connecting any of it to real movement is DEL-05.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Journal catalogue — the codes DEL-04 posts.
--
-- TS-02 §13.1 enumerates 57 journals for the whole system. This stage
-- posts five of them, and seeding only those is deliberate: an unseeded
-- code is refused by `journal_entry_code_fk`, so a boundary that has not
-- been written yet cannot post by accident. The catalogue grows as the
-- boundaries that use it are implemented and proved.
--
-- `inverse_of` pairs each journal with the one that undoes it, which is
-- what makes a correction a REVERSAL rather than an edit.
-- ---------------------------------------------------------------------

INSERT INTO inrp2p.journal_catalogue (journal_code, entry_class, description) VALUES
  ('JD-SBX-FUND',     'SNJ', 'Sandbox-only funding of a party balance. Holds no real value.'),
  ('JD-LOCK',         'SNJ', 'Lock a party balance into a deal escrow.'),
  ('JD-RELEASE',      'SNJ', 'Release deal escrow to the receiving party.'),
  ('JD-REFUND',       'SNJ', 'Return deal escrow to the party it came from.'),
  ('JD-REVERSAL',     'SIJ', 'Inverse of a prior entry. Corrections are reversals, never edits.')
ON CONFLICT (journal_code) DO NOTHING;

UPDATE inrp2p.journal_catalogue SET inverse_of = 'JD-REVERSAL'
 WHERE journal_code IN ('JD-SBX-FUND','JD-LOCK','JD-RELEASE','JD-REFUND');

-- ---------------------------------------------------------------------
-- 2. No credit-normal account may go into debit — TS-01.4 [M6].
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  THIS IS "NO NEGATIVE AVAILABLE BALANCE", AS A CONSTRAINT.       │
-- │                                                                  │
-- │  Postings are stored signed and sum to zero per asset: debits    │
-- │  positive, credits negative. A LIABILITY account — a party's     │
-- │  balance, a deal's escrow — is credit-normal, so what we OWE is  │
-- │  a negative signed balance. If such an account ever reached a    │
-- │  positive signed balance it would mean the party owes US, which  │
-- │  for a custodial balance means they spent value they never had.  │
-- │                                                                  │
-- │  The boundary refuses that case with a clean rejection. This     │
-- │  constraint is the second line: even a defective boundary, or a  │
-- │  hand-written statement by somebody with DML, cannot commit an   │
-- │  overspend.                                                      │
-- └──────────────────────────────────────────────────────────────────┘
-- ---------------------------------------------------------------------

ALTER TABLE inrp2p.account_balance
  ADD CONSTRAINT account_balance_credit_normal_not_debit CHECK (
    class NOT IN ('LIABILITY', 'REVENUE', 'EQUITY') OR balance_minor <= 0);

/*
 * The readable form of a balance.
 *
 * Sign conventions are a well-known source of six-figure mistakes, so the
 * translation lives in exactly one function and every caller uses it
 * rather than remembering which way round a liability goes.
 */
CREATE FUNCTION inrp2p.normal_balance(p_class inrp2p.account_class, p_signed inrp2p.amount_minor)
RETURNS inrp2p.amount_minor
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, inrp2p
AS $fn$
  SELECT CASE WHEN p_class IN ('ASSET', 'EXPENSE') THEN p_signed ELSE -p_signed END;
$fn$;

-- ---------------------------------------------------------------------
-- 3. The posting boundary — TS-02 §7.
--
-- The ONLY way an entry is written. It is `SECURITY DEFINER` and owned by
-- the boundary role, so the application role can execute it without
-- holding DML on any money table.
--
-- Three properties, in the order they are established:
--
--   IDEMPOTENT — `(journal_code, entry_key_digest)` is unique, so a
--     replay returns the ORIGINAL entry id and posts nothing. Exactly-once
--     is structural, not a convention the caller must respect.
--
--   ORDERED — balances are locked by `account_id` ASCENDING. Two entries
--     touching the same pair of accounts therefore always take them in
--     the same order, and cannot deadlock. This is the canonical lock
--     order for rank-9 objects.
--
--   BALANCED — the deferred constraint trigger from 0007 refuses an
--     unbalanced or empty entry at commit, whatever this function does.
-- ---------------------------------------------------------------------

CREATE FUNCTION inrp2p.post_entry(
  p_journal_code   TEXT,
  p_entry_key      JSONB,
  p_account_ids    UUID[],
  p_amounts        NUMERIC[]
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, inrp2p, public
AS $fn$
DECLARE
  v_digest    TEXT;
  v_entry_id  UUID;
  v_class     inrp2p.journal_class;
  v_mode_ver  BIGINT;
  v_id        UUID;
  v_i         INT;
BEGIN
  IF array_length(p_account_ids, 1) IS DISTINCT FROM array_length(p_amounts, 1) THEN
    RAISE EXCEPTION 'post_entry: % accounts but % amounts',
      array_length(p_account_ids, 1), array_length(p_amounts, 1)
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF coalesce(array_length(p_account_ids, 1), 0) < 2 THEN
    RAISE EXCEPTION 'post_entry: an entry needs at least two postings'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_digest := encode(digest(p_entry_key::text, 'sha256'), 'hex');

  -- Replay: the same journal with the same natural key is ONE entry,
  -- forever. Return the original rather than posting a second time.
  SELECT entry_id INTO v_entry_id
    FROM inrp2p.journal_entry
   WHERE journal_code = p_journal_code AND entry_key_digest = v_digest;
  IF FOUND THEN
    RETURN v_entry_id;
  END IF;

  SELECT entry_class INTO v_class
    FROM inrp2p.journal_catalogue WHERE journal_code = p_journal_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post_entry: journal % is not in the catalogue', p_journal_code
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Rank 0a: the admission singleton, taken SHARE. Reading `mode_version`
  -- here binds the entry to the risk mode that admitted it.
  SELECT mode_version INTO v_mode_ver
    FROM inrp2p.system_money_state WHERE id IS TRUE FOR SHARE;

  -- Rank 9, canonical order: ascending account_id, deduplicated.
  FOR v_id IN
    SELECT DISTINCT a FROM unnest(p_account_ids) AS a ORDER BY a
  LOOP
    PERFORM 1 FROM inrp2p.account_balance WHERE account_id = v_id FOR UPDATE;
  END LOOP;

  INSERT INTO inrp2p.journal_entry
    (journal_code, entry_class, entry_key_digest, entry_key_json, mode_version, txid)
  VALUES (p_journal_code, v_class, v_digest, p_entry_key, v_mode_ver, txid_current())
  RETURNING entry_id INTO v_entry_id;

  FOR v_i IN 1 .. array_length(p_account_ids, 1) LOOP
    INSERT INTO inrp2p.posting (entry_id, seq, account_id, asset, amount_minor)
    SELECT v_entry_id, v_i, p_account_ids[v_i], la.asset, p_amounts[v_i]
      FROM inrp2p.ledger_account la WHERE la.account_id = p_account_ids[v_i];

    UPDATE inrp2p.account_balance
       SET balance_minor = balance_minor + p_amounts[v_i],
           version       = version + 1,
           updated_at    = now()
     WHERE account_id = p_account_ids[v_i];
  END LOOP;

  RETURN v_entry_id;
END;
$fn$;

/*
 * Reverse an entry — the only way a mistake is corrected.
 *
 * A new entry with negated postings, linked to the original by its entry
 * key. Nothing is updated and nothing is deleted, so the trail shows both
 * what was believed and what was corrected. An accountant can reconstruct
 * every intermediate state; an UPDATE would have destroyed it.
 */
CREATE FUNCTION inrp2p.reverse_entry(p_entry_id UUID, p_reason TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, inrp2p, public
AS $fn$
DECLARE
  v_accounts UUID[];
  v_amounts  NUMERIC[];
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) < 8 THEN
    RAISE EXCEPTION 'reverse_entry: a reversal must carry a written reason'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM inrp2p.journal_entry WHERE entry_id = p_entry_id) THEN
    RAISE EXCEPTION 'reverse_entry: entry % does not exist', p_entry_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT array_agg(account_id ORDER BY seq), array_agg(-amount_minor ORDER BY seq)
    INTO v_accounts, v_amounts
    FROM inrp2p.posting WHERE entry_id = p_entry_id;

  RETURN inrp2p.post_entry(
    'JD-REVERSAL',
    jsonb_build_object('reverses', p_entry_id, 'reason', trim(p_reason)),
    v_accounts,
    v_amounts);
END;
$fn$;

-- ---------------------------------------------------------------------
-- 4. Deal value locks — the available/locked separation, made explicit.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  A LOCK IS A LEDGER MOVEMENT, NOT A FLAG.                        │
-- │                                                                  │
-- │  Locked value leaves the owner's `party.balance` and arrives in  │
-- │  an `escrow` account scoped to the deal. That means "available"  │
-- │  and "locked" are not two columns that can disagree — they are   │
-- │  two accounts, and the ledger's zero-sum invariant guarantees    │
-- │  the total is unchanged. Someone cannot spend locked value       │
-- │  because it is not in the account a spend reads.                 │
-- │                                                                  │
-- │  This row is the INDEX into that movement: which deal, which     │
-- │  actor, which command, and which entries locked and settled it.  │
-- └──────────────────────────────────────────────────────────────────┘
-- ---------------------------------------------------------------------

CREATE TABLE inrp2p.value_lock (
  lock_id       UUID NOT NULL DEFAULT gen_random_uuid(),
  -- The sandbox deal this protects. Deliberately not a foreign key: the
  -- money schema does not depend on the sandbox schema, so the ledger can
  -- outlive it when deal orchestration moves.
  deal_id       UUID NOT NULL,
  -- Who asked, and under which DEL-02 command. This is what ties a
  -- financial movement back to an authenticated actor and a replayable
  -- request rather than to "the system".
  owner_id      UUID NOT NULL,
  command_id    UUID NOT NULL,
  asset         inrp2p.ledger_asset NOT NULL,
  amount_minor  inrp2p.amount_minor_nonneg NOT NULL,
  state         TEXT NOT NULL DEFAULT 'LOCKED',
  locked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at    TIMESTAMPTZ NULL,
  -- The entries that created and ended the lock. Immutable once written.
  lock_entry_id   UUID NOT NULL,
  settle_entry_id UUID NULL,
  settle_command_id UUID NULL,

  CONSTRAINT value_lock_pk PRIMARY KEY (lock_id),
  -- ONE live lock per deal. A second lock attempt is a replay or a bug,
  -- and either way the database decides rather than the caller.
  CONSTRAINT value_lock_deal_uq UNIQUE (deal_id),
  CONSTRAINT value_lock_command_uq UNIQUE (command_id),
  CONSTRAINT value_lock_entry_fk FOREIGN KEY (lock_entry_id)
    REFERENCES inrp2p.journal_entry (entry_id),
  CONSTRAINT value_lock_settle_fk FOREIGN KEY (settle_entry_id)
    REFERENCES inrp2p.journal_entry (entry_id),
  CONSTRAINT value_lock_state_closed
    CHECK (state IN ('LOCKED', 'RELEASED', 'REFUNDED', 'REVERSED')),
  CONSTRAINT value_lock_amount_pos CHECK (amount_minor > 0),
  -- A settled lock names its entry and its moment; a live one cannot.
  CONSTRAINT value_lock_settled_agrees
    CHECK ((state = 'LOCKED') = (settled_at IS NULL)),
  CONSTRAINT value_lock_settle_entry_agrees
    CHECK ((settled_at IS NULL) = (settle_entry_id IS NULL))
);

CREATE INDEX value_lock_owner_ix ON inrp2p.value_lock (owner_id, locked_at DESC);
CREATE INDEX value_lock_live_ix  ON inrp2p.value_lock (deal_id) WHERE state = 'LOCKED';

-- A lock record is history once settled. The state transition is the only
-- permitted change, and it happens through the boundary functions below.
CREATE TRIGGER value_lock_no_delete
  BEFORE DELETE ON inrp2p.value_lock
  FOR EACH ROW EXECUTE FUNCTION inrp2p.trg_immutable();

-- ---------------------------------------------------------------------
-- 5. Read surface — TS-02 §9.2, the `inrp2p_read` schema.
--
-- The application reads balances and history through VIEWS and never
-- touches the money tables. That is what lets `inrp2p_app` hold `SELECT`
-- on the read schema and nothing at all on `inrp2p`: a compromised
-- application can show a balance and cannot write one.
-- ---------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS inrp2p_read;

CREATE VIEW inrp2p_read.account_balance AS
  SELECT b.account_id,
         a.asset,
         a.class,
         a.family,
         a.scope_kind,
         a.scope_id,
         b.balance_minor                                   AS signed_minor,
         inrp2p.normal_balance(a.class, b.balance_minor)    AS balance_minor,
         b.version,
         b.updated_at
    FROM inrp2p.account_balance b
    JOIN inrp2p.ledger_account a ON a.account_id = b.account_id;

CREATE VIEW inrp2p_read.value_lock AS
  SELECT lock_id, deal_id, owner_id, command_id, asset, amount_minor,
         state, locked_at, settled_at, lock_entry_id, settle_entry_id
    FROM inrp2p.value_lock;

CREATE VIEW inrp2p_read.journal AS
  SELECT e.entry_id, e.journal_code, e.entry_class, e.applied_at, e.entry_key_json,
         p.seq, p.account_id, p.asset, p.amount_minor,
         a.family, a.scope_kind, a.scope_id
    FROM inrp2p.journal_entry e
    JOIN inrp2p.posting p ON p.entry_id = e.entry_id
    JOIN inrp2p.ledger_account a ON a.account_id = p.account_id;

GRANT USAGE ON SCHEMA inrp2p_read TO inrp2p_app, inrp2p_recon;
GRANT SELECT ON ALL TABLES IN SCHEMA inrp2p_read TO inrp2p_app, inrp2p_recon;
ALTER DEFAULT PRIVILEGES IN SCHEMA inrp2p_read GRANT SELECT ON TABLES TO inrp2p_app;

/*
 * OWNERSHIP IS WHAT MAKES `SECURITY DEFINER` MEAN ANYTHING.
 *
 * A definer function runs as its OWNER, not as whoever declared it
 * interesting. Left owned by the migration user these functions would run
 * with the migration user's authority, and `inrp2p_app` calling them would
 * effectively be the migration user for the duration of the call — the
 * exact privilege escalation the role split exists to prevent.
 *
 * Transferring them to `inrp2p_boundary` binds them to the only role that
 * holds DML on the money tables, and that role is NOLOGIN, so its
 * authority is reachable ONLY by calling one of these three functions.
 */
ALTER FUNCTION inrp2p.post_entry(TEXT, JSONB, UUID[], NUMERIC[]) OWNER TO inrp2p_boundary;
ALTER FUNCTION inrp2p.reverse_entry(UUID, TEXT)                  OWNER TO inrp2p_boundary;
ALTER FUNCTION inrp2p.ensure_accounts(inrp2p.account_key[])      OWNER TO inrp2p_boundary;

/*
 * The CE and identity helpers are PURE: given a key they compute the same
 * id and the same class, touch no table and move nothing. They are the
 * arithmetic of the schema, not its authority, and both the definer
 * functions and the callers that name an account need them. Withholding
 * EXECUTE here would not protect a single unit of value — it would only
 * make `ensure_accounts` fail from inside its own definer context.
 */
GRANT EXECUTE ON FUNCTION
  inrp2p.ce_field(TEXT, INTEGER, BYTEA),
  inrp2p.ce_account_key(inrp2p.account_key),
  inrp2p.uuid_v5(UUID, BYTEA),
  inrp2p.account_id_of(inrp2p.account_key),
  inrp2p.account_class_of(TEXT),
  inrp2p.normal_balance(inrp2p.account_class, inrp2p.amount_minor)
  TO inrp2p_boundary, inrp2p_app, inrp2p_recon, inrp2p_relay;

REVOKE ALL ON FUNCTION
  inrp2p.post_entry(TEXT, JSONB, UUID[], NUMERIC[]),
  inrp2p.reverse_entry(UUID, TEXT),
  inrp2p.ensure_accounts(inrp2p.account_key[])
  FROM PUBLIC;

-- The application may EXECUTE the boundary and holds no DML of its own.
GRANT EXECUTE ON FUNCTION
  inrp2p.post_entry(TEXT, JSONB, UUID[], NUMERIC[]),
  inrp2p.reverse_entry(UUID, TEXT),
  inrp2p.ensure_accounts(inrp2p.account_key[])
  TO inrp2p_app;

GRANT SELECT, INSERT, UPDATE ON inrp2p.value_lock TO inrp2p_boundary;
GRANT SELECT ON inrp2p.value_lock TO inrp2p_recon;

/*
 * The value-lock row is written by the application, not by a definer
 * function, so `inrp2p_app` needs its own DML here — and ONLY here. It
 * still cannot touch a single money table: a lock row that disagreed with
 * the ledger would be visible as a lock with no matching entry, whereas a
 * forged ledger entry would be actual value.
 */
GRANT SELECT, INSERT, UPDATE ON inrp2p.value_lock TO inrp2p_app;
