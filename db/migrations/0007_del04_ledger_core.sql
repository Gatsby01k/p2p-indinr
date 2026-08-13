-- =====================================================================
-- INRP2P — DEL-04 migration 0007: the money core.
--
-- ⚠ THIS IS THE FIRST EXECUTABLE MONEY SCHEMA IN THIS REPOSITORY.
--
-- Everything before it lived in the `sandbox` schema, which states in its
-- own comment that it holds no funds and is not the TS-02 ledger. This
-- file materializes the beginning of the real one: `inrp2p`.
--
-- AUTHORITY. Every definition below is transcribed from
-- `docs/specs/TS-02.md` v2.1 §3.3, §4.3, §5.2, §5.3, §5.4, §6.2 and §9,
-- which is itself subordinate to the approved and immutable TS-01.4. This
-- migration invents nothing: where the specification gives DDL, the DDL is
-- reproduced; where it gives a rule, the rule becomes a constraint.
--
-- SCOPE OF THIS MIGRATION. The ledger SPINE only:
--   · deterministic account identity (CE encoding → UUIDv5);
--   · the closed account catalogue;
--   · journal entries, postings and balances, with per-asset zero-sum
--     enforced before an entry becomes visible;
--   · the singleton money-state row that admission gates read;
--   · the five database roles and their grants.
--
-- What it deliberately does NOT contain, because each needs its own
-- migration and its own proof: the 57 journals, the 47 boundary
-- functions, receivables, withdrawals, sweeps, gas, capital, reorg and
-- reinstatement. Those attach to this spine; none of them can be written
-- correctly until the spine exists and is proved.
--
-- NO DEAL ORCHESTRATION IS REWIRED HERE. The sandbox lifecycle keeps
-- working exactly as accepted in DEL-02; it will move onto boundary
-- functions only once those functions exist.
-- =====================================================================

/*
 * `digest()` comes from pgcrypto, and pgcrypto installs into whichever
 * schema it was first created in — `public` on this database. The
 * boundary functions below pin `search_path` for safety, so `public`
 * must be on it or `digest(bytea, text)` is simply not visible. Pinning
 * the path and then omitting the schema the function lives in is a
 * classic way to make a SECURITY DEFINER function fail only in
 * production, so it is stated explicitly here.
 */
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS inrp2p;

COMMENT ON SCHEMA inrp2p IS
  'The TS-02 money schema. Every unit of a ledger asset sits in some account '
  'here at all times. Unlike the sandbox schema, rows in this schema represent '
  'value: nothing may be inserted, updated or deleted except through a boundary '
  'function owned by inrp2p_boundary.';

-- ---------------------------------------------------------------------
-- 1. Ledger vocabulary — TS-02 §4.1, §5.1.
--
-- LEDGER ASSETS ARE `USDT` AND `TRX`, AND THAT IS THE WHOLE LIST.
--
-- INR is a settlement and display currency, never a ledger balance
-- (TS-02 §4). There is no INR account family and none may be added: an
-- INR balance would be a claim that INRP2P holds rupees, which it does
-- not and is not licensed to. This is the constraint behind roadmap
-- decision B2 — `INR_TO_INR` is backed by locked USDT collateral, not by
-- custodial rupees.
-- ---------------------------------------------------------------------

CREATE TYPE inrp2p.ledger_asset  AS ENUM ('USDT', 'TRX');
CREATE TYPE inrp2p.account_class AS ENUM ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE', 'EQUITY');
CREATE TYPE inrp2p.journal_class AS ENUM ('SDJ', 'SNJ', 'SIJ');

-- ---------------------------------------------------------------------
-- 2. Amounts — TS-02 §4.3.
--
-- The base type is UNCONSTRAINED `NUMERIC`, and that is the entire point.
--
-- v2.0 used `NUMERIC(38,0)` with `CHECK (scale(VALUE) = 0)`, which is dead
-- code: a domain constraint runs AFTER coercion to the base type, and a
-- constrained numeric rounds during that coercion. `1.5` became `2` and
-- then passed the scale test — fractional input was silently rounded into
-- money. An unconstrained base preserves the input's scale, so the check
-- has something to see and `1.5` is rejected.
-- ---------------------------------------------------------------------

CREATE DOMAIN inrp2p.amount_minor AS NUMERIC
  CONSTRAINT amount_minor_finite CHECK (VALUE IS NOT NULL AND NOT (VALUE = 'NaN'::numeric))
  CONSTRAINT amount_minor_integral CHECK (scale(VALUE) <= 0)
  CONSTRAINT amount_minor_range CHECK (
        VALUE > -100000000000000000000000000000000000000
    AND VALUE <  100000000000000000000000000000000000000);

CREATE DOMAIN inrp2p.amount_minor_nonneg AS inrp2p.amount_minor
  CONSTRAINT amount_minor_nonneg_chk CHECK (VALUE >= 0);

-- ---------------------------------------------------------------------
-- 3. Deterministic account identity — TS-02 §3.3.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  WHY THE ENCODING IS LENGTH-PREFIXED AND NOT DELIMITED.          │
-- │                                                                  │
-- │  v2.0 derived `account_id` from a pipe-joined string. That is    │
-- │  ambiguous: `('divergence', 'desk_9|x')` and                     │
-- │  `('divergence|desk_9', 'x')` produce the same string, so two    │
-- │  distinct ledger accounts collapse into one id — breaking M4 and │
-- │  M5, which is to say breaking the separation between one party's │
-- │  receivable and another's.                                       │
-- │                                                                  │
-- │  CE frames every field as                                        │
-- │      u32be(len(tag)) ‖ tag ‖ u8(type) ‖ u32be(len(body)) ‖ body  │
-- │  so no body can be mistaken for a boundary. Lengths are BYTE     │
-- │  counts, not character counts, which matters the moment a        │
-- │  scope_id contains anything outside ASCII.                       │
-- └──────────────────────────────────────────────────────────────────┘

CREATE TYPE inrp2p.account_key AS (
  asset      inrp2p.ledger_asset,
  family     TEXT,
  scope_kind TEXT,
  scope_id   TEXT,   -- '' when the family is unscoped; never NULL
  shard      INTEGER -- 0 when the family is not sharded
);

CREATE FUNCTION inrp2p.ce_field(p_tag TEXT, p_type INTEGER, p_body BYTEA)
RETURNS BYTEA
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, inrp2p, public
AS $fn$
  SELECT int4send(octet_length(convert_to(p_tag, 'UTF8')))
      || convert_to(p_tag, 'UTF8')
      || set_byte('\x00'::bytea, 0, p_type)
      || int4send(octet_length(p_body))
      || p_body;
$fn$;

CREATE FUNCTION inrp2p.ce_account_key(p_key inrp2p.account_key)
RETURNS BYTEA
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, inrp2p, public
AS $fn$
BEGIN
  -- A NULL component would silently shorten the encoding and collide two
  -- different keys, so it raises rather than encoding.
  IF (p_key).asset IS NULL OR (p_key).family IS NULL
     OR (p_key).scope_kind IS NULL OR (p_key).scope_id IS NULL
     OR (p_key).shard IS NULL THEN
    RAISE EXCEPTION 'account_key has a NULL component: %', p_key
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  RETURN inrp2p.ce_field('asset',      2, convert_to((p_key).asset::text,  'UTF8'))
      || inrp2p.ce_field('family',     2, convert_to((p_key).family,       'UTF8'))
      || inrp2p.ce_field('scope_kind', 2, convert_to((p_key).scope_kind,   'UTF8'))
      || inrp2p.ce_field('scope_id',   2, convert_to((p_key).scope_id,     'UTF8'))
      -- integer body: ASCII base-10, no sign, no leading zeros
      || inrp2p.ce_field('shard',      1, convert_to((p_key).shard::text,  'UTF8'));
END;
$fn$;

-- RFC 4122 §4.3 name-based UUID with SHA-1, over BYTEA so it consumes CE
-- output directly rather than round-tripping through text.
CREATE FUNCTION inrp2p.uuid_v5(p_namespace UUID, p_name BYTEA)
RETURNS UUID
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, inrp2p, public
AS $fn$
DECLARE
  v_hash BYTEA;
  v_b    BYTEA;
BEGIN
  v_hash := digest(decode(replace(p_namespace::text, '-', ''), 'hex') || p_name, 'sha1');
  v_b    := substring(v_hash FROM 1 FOR 16);
  v_b    := set_byte(v_b, 6, (get_byte(v_b, 6) & 15) | 80);   -- version 5
  v_b    := set_byte(v_b, 8, (get_byte(v_b, 8) & 63) | 128);  -- variant 10x
  RETURN encode(v_b, 'hex')::UUID;
END;
$fn$;

CREATE FUNCTION inrp2p.account_id_of(p_key inrp2p.account_key)
RETURNS UUID
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, inrp2p, public
AS $fn$
  SELECT inrp2p.uuid_v5('6f2a1c4e-0b7d-5f8a-9c31-2e4d6a8b0f13'::uuid,
                        inrp2p.ce_account_key(p_key));
$fn$;

/*
 * `class` is a TOTAL FUNCTION of `family`, derived rather than carried.
 *
 * If class were part of the key, two rows with the same key and different
 * classes would be representable and merely constrained. Deriving it makes
 * that impossible: there is one class for a family, and the account id
 * does not depend on it. A family outside the closed catalogue returns
 * NULL, and `ledger_account.class` is NOT NULL — so an unclassified
 * account fails at INSERT rather than existing.
 */
CREATE FUNCTION inrp2p.account_class_of(p_family TEXT)
RETURNS inrp2p.account_class
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, inrp2p, public
AS $fn$
  SELECT CASE
    WHEN p_family LIKE 'wallet.%'     THEN 'ASSET'
    WHEN p_family LIKE 'receivable.%' THEN 'ASSET'
    WHEN p_family = 'staked'          THEN 'ASSET'
    WHEN p_family IN ('party.balance','desk.reserve','quote_reserved',
                      'escrow','fee_reserved','hold','withdrawal_payable')
                                      THEN 'LIABILITY'
    WHEN p_family IN ('fee_revenue','withdrawal_fee_revenue')
                                      THEN 'REVENUE'
    WHEN p_family IN ('platform_compensation_expense','reorg_loss_expense',
                      'divergence_loss_expense','gas_expense')
                                      THEN 'EXPENSE'
    WHEN p_family = 'platform_capital' THEN 'EQUITY'
  END::inrp2p.account_class;
$fn$;

-- ---------------------------------------------------------------------
-- 4. `system_money_state` — TS-02 §5.2.
--
-- The rank-0a singleton every admission gate takes a lock on. The
-- `id BOOLEAN PRIMARY KEY CHECK (id IS TRUE)` pattern makes a second row
-- unrepresentable, so "the row" is unambiguous and the lock is a literal
-- row lock rather than an advisory convention.
--
-- `free_buffer_minor` MAY be negative: a solvency breach is a DETECTED
-- condition, not an impossible one, and refusing to store it would mean
-- the system could not report the thing it most needs to report.
-- ---------------------------------------------------------------------

CREATE TABLE inrp2p.system_money_state (
  id                BOOLEAN     NOT NULL DEFAULT TRUE,
  mode              TEXT        NOT NULL DEFAULT 'NORMAL',
  mode_version      BIGINT      NOT NULL DEFAULT 1,
  free_buffer_minor inrp2p.amount_minor NOT NULL DEFAULT 0,
  version           BIGINT      NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT system_money_state_pk PRIMARY KEY (id),
  CONSTRAINT system_money_state_singleton CHECK (id IS TRUE),
  CONSTRAINT system_money_state_mode_closed
    CHECK (mode IN ('NORMAL', 'CONSTRAINED', 'HALTED'))
);

INSERT INTO inrp2p.system_money_state (id) VALUES (TRUE)
  ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 5. `ledger_account` — the closed catalogue, TS-02 §5.3.
--
-- Two CHECKs close it: the (asset, family) pair and the (class, family)
-- pair are both enumerated, so no account outside TS-01.4 §2.1/§2.2 can
-- exist at all. `ledger_account_id_derived` makes derived identity a
-- DATABASE guarantee — a row whose id was not derived from its own key
-- cannot be inserted, which is what lets a boundary compute its lock
-- order before it has read the table.
-- ---------------------------------------------------------------------

CREATE TABLE inrp2p.ledger_account (
  account_id  UUID    NOT NULL,
  asset       inrp2p.ledger_asset  NOT NULL,
  class       inrp2p.account_class NOT NULL,
  family      TEXT    NOT NULL,
  scope_kind  TEXT    NOT NULL,
  scope_id    TEXT    NOT NULL,
  shard       INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ledger_account_pk PRIMARY KEY (account_id),
  CONSTRAINT ledger_account_uk UNIQUE (asset, family, scope_kind, scope_id, shard),
  CONSTRAINT ledger_account_shard CHECK (shard >= 0),
  CONSTRAINT ledger_account_asset_family CHECK (
    (asset = 'USDT' AND family IN (
        'wallet.deposit','wallet.hot','wallet.warm','wallet.cold','wallet.buffer',
        'receivable.deposit_reversal','receivable.desk_shortfall','receivable.divergence',
        'party.balance','desk.reserve','quote_reserved','escrow','fee_reserved','hold',
        'withdrawal_payable','fee_revenue','withdrawal_fee_revenue',
        'platform_compensation_expense','reorg_loss_expense','divergence_loss_expense',
        'platform_capital'))
 OR (asset = 'TRX'  AND family IN (
        'wallet.gas','staked','gas_expense','platform_capital'))),
  CONSTRAINT ledger_account_class_family CHECK (
    (class = 'ASSET'     AND family LIKE 'wallet.%')
 OR (class = 'ASSET'     AND family LIKE 'receivable.%')
 OR (class = 'ASSET'     AND family = 'staked')
 OR (class = 'LIABILITY' AND family IN ('party.balance','desk.reserve','quote_reserved',
                                        'escrow','fee_reserved','hold','withdrawal_payable'))
 OR (class = 'REVENUE'   AND family IN ('fee_revenue','withdrawal_fee_revenue'))
 OR (class = 'EXPENSE'   AND family IN ('platform_compensation_expense','reorg_loss_expense',
                                        'divergence_loss_expense','gas_expense'))
 OR (class = 'EQUITY'    AND family = 'platform_capital')),
  CONSTRAINT ledger_account_shardable CHECK (
    shard = 0 OR family IN ('fee_revenue','withdrawal_fee_revenue',
                            'platform_compensation_expense','reorg_loss_expense',
                            'divergence_loss_expense','gas_expense')),
  CONSTRAINT ledger_account_id_derived CHECK (
    account_id = inrp2p.account_id_of(
      ROW(asset, family, scope_kind, scope_id, shard)::inrp2p.account_key))
);

CREATE INDEX ledger_account_family_ix ON inrp2p.ledger_account (family, asset);

-- Composite uniques so the posting and balance foreign keys below can make
-- "asset matches the account definition" a FOREIGN-KEY guarantee rather
-- than a trigger somebody could forget to write.
ALTER TABLE inrp2p.ledger_account
  ADD CONSTRAINT ledger_account_id_asset_uk UNIQUE (account_id, asset);
ALTER TABLE inrp2p.ledger_account
  ADD CONSTRAINT ledger_account_id_asset_class_uk UNIQUE (account_id, asset, class);

/*
 * Money history is IMMUTABLE, and an attempt to change it RAISES.
 *
 * The sandbox audit trail uses `DO INSTEAD NOTHING`, which silently
 * discards the write. That is right for an append-only log nobody is
 * supposed to touch. It is wrong here for two reasons: a rule makes
 * `INSERT ... ON CONFLICT` illegal on the table, which `ensure_accounts`
 * needs; and a silent no-op is the worst possible response to code that
 * believes it just corrected a ledger. A trigger that raises tells the
 * caller their edit did not happen.
 */
CREATE FUNCTION inrp2p.trg_immutable() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, inrp2p
AS $fn$
BEGIN
  RAISE EXCEPTION 'inrp2p.% is immutable: % is not permitted',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$fn$;

CREATE TRIGGER ledger_account_immutable
  BEFORE UPDATE OR DELETE ON inrp2p.ledger_account
  FOR EACH ROW EXECUTE FUNCTION inrp2p.trg_immutable();

-- ---------------------------------------------------------------------
-- 6. Journals, postings, balances — TS-02 §5.4.
-- ---------------------------------------------------------------------

CREATE TABLE inrp2p.journal_catalogue (
  journal_code TEXT NOT NULL,
  entry_class  inrp2p.journal_class NOT NULL,
  description  TEXT NOT NULL,
  inverse_of   TEXT NULL,

  CONSTRAINT journal_catalogue_pk PRIMARY KEY (journal_code),
  CONSTRAINT journal_catalogue_inv_fk FOREIGN KEY (inverse_of)
    REFERENCES inrp2p.journal_catalogue (journal_code)
);

COMMENT ON TABLE inrp2p.journal_catalogue IS
  'The closed catalogue of journal codes. TS-02 §13.1 enumerates 57; this '
  'migration creates the table, and the seeding of all 57 belongs with the '
  'boundary functions that post them — an unseeded catalogue refuses every '
  'entry via journal_entry_code_fk, which is the correct fail-closed state.';

CREATE TABLE inrp2p.journal_entry (
  entry_id         UUID NOT NULL DEFAULT gen_random_uuid(),
  journal_code     TEXT NOT NULL,
  entry_class      inrp2p.journal_class NOT NULL,
  entry_key_digest TEXT NOT NULL,
  entry_key_json   JSONB NOT NULL,
  applied_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  mode_version     BIGINT NOT NULL,
  -- `txid_current()`, so a journal, its audit event and its outbox rows
  -- can be PROVEN to have committed in one transaction [O1].
  txid             BIGINT NOT NULL,

  CONSTRAINT journal_entry_pk PRIMARY KEY (entry_id),
  -- Replay identity: the same journal with the same natural key is one
  -- entry, forever. This is what makes exactly-once posting structural.
  CONSTRAINT journal_entry_key_uk UNIQUE (journal_code, entry_key_digest),
  CONSTRAINT journal_entry_code_fk FOREIGN KEY (journal_code)
    REFERENCES inrp2p.journal_catalogue (journal_code),
  CONSTRAINT journal_entry_digest_fmt CHECK (entry_key_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT journal_entry_key_obj CHECK (jsonb_typeof(entry_key_json) = 'object')
);

CREATE INDEX journal_entry_applied_ix ON inrp2p.journal_entry (applied_at DESC);

CREATE TABLE inrp2p.posting (
  entry_id     UUID NOT NULL,
  seq          SMALLINT NOT NULL,
  account_id   UUID NOT NULL,
  asset        inrp2p.ledger_asset NOT NULL,
  amount_minor inrp2p.amount_minor NOT NULL,

  CONSTRAINT posting_pk PRIMARY KEY (entry_id, seq),
  CONSTRAINT posting_entry_fk FOREIGN KEY (entry_id)
    REFERENCES inrp2p.journal_entry (entry_id),
  -- Targets (account_id, asset): "posting asset equals ledger-account
  -- asset" is therefore a foreign-key guarantee, unviolatable even by a
  -- defective boundary.
  CONSTRAINT posting_account_fk FOREIGN KEY (account_id, asset)
    REFERENCES inrp2p.ledger_account (account_id, asset),
  CONSTRAINT posting_seq_pos CHECK (seq >= 1),
  -- A zero posting is not a movement; it is noise in a ledger people read.
  CONSTRAINT posting_nonzero CHECK (amount_minor <> 0)
);

CREATE INDEX posting_account_ix ON inrp2p.posting (account_id, entry_id);

CREATE TRIGGER journal_entry_immutable
  BEFORE UPDATE OR DELETE ON inrp2p.journal_entry
  FOR EACH ROW EXECUTE FUNCTION inrp2p.trg_immutable();

CREATE TRIGGER posting_immutable
  BEFORE UPDATE OR DELETE ON inrp2p.posting
  FOR EACH ROW EXECUTE FUNCTION inrp2p.trg_immutable();

CREATE TABLE inrp2p.account_balance (
  account_id    UUID NOT NULL,
  asset         inrp2p.ledger_asset  NOT NULL,
  class         inrp2p.account_class NOT NULL,
  balance_minor inrp2p.amount_minor NOT NULL DEFAULT 0,
  version       BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT account_balance_pk PRIMARY KEY (account_id),
  -- Targets (account_id, asset, class): the balance cannot disagree with
  -- the immutable account definition it belongs to.
  CONSTRAINT account_balance_def_fk FOREIGN KEY (account_id, asset, class)
    REFERENCES inrp2p.ledger_account (account_id, asset, class)
);

-- ---------------------------------------------------------------------
-- 7. Per-asset zero sum, before the entry is visible — TS-02 §6.2, [M1]/[M2].
--
-- DEFERRABLE INITIALLY DEFERRED, so postings may be inserted after the
-- entry header and the check still happens before anybody can see the
-- result. It is not deferrable by the caller: `SET CONSTRAINTS ALL
-- IMMEDIATE` can only tighten a constraint declared this way, never relax
-- it. An unbalanced entry therefore cannot commit, whatever a boundary
-- does.
-- ---------------------------------------------------------------------

CREATE FUNCTION inrp2p.trg_entry_balanced() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, inrp2p, public
AS $fn$
DECLARE
  v_bad TEXT;
BEGIN
  SELECT string_agg(asset::text || '=' || total::text, ',')
    INTO v_bad
    FROM (SELECT asset, sum(amount_minor) AS total
            FROM inrp2p.posting WHERE entry_id = NEW.entry_id
           GROUP BY asset HAVING sum(amount_minor) <> 0) s;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'journal entry % not balanced per asset: %', NEW.entry_id, v_bad
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM inrp2p.posting WHERE entry_id = NEW.entry_id) THEN
    RAISE EXCEPTION 'journal entry % has no postings', NEW.entry_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER journal_entry_balanced_ct
  AFTER INSERT ON inrp2p.journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inrp2p.trg_entry_balanced();

-- ---------------------------------------------------------------------
-- 8. `ensure_accounts` — TS-02 §7.2.
--
-- The only way an account comes into existence. It derives the id from
-- the key, so a caller cannot choose one, and it constrains `scope_id` to
-- a safe alphabet before anything is stored.
-- ---------------------------------------------------------------------

CREATE FUNCTION inrp2p.ensure_accounts(p_keys inrp2p.account_key[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, inrp2p, public
AS $fn$
DECLARE
  k inrp2p.account_key;
BEGIN
  FOREACH k IN ARRAY p_keys LOOP
    IF (k).scope_id <> '' AND (k).scope_id !~ '^[0-9a-zA-Z:._-]+$' THEN
      RAISE EXCEPTION 'scope_id % is outside the permitted alphabet', (k).scope_id
        USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO inrp2p.ledger_account (account_id, asset, class, family, scope_kind, scope_id, shard)
    VALUES (inrp2p.account_id_of(k),
            (k).asset,
            inrp2p.account_class_of((k).family),
            (k).family, (k).scope_kind, (k).scope_id, (k).shard)
    ON CONFLICT (account_id) DO NOTHING;

    INSERT INTO inrp2p.account_balance (account_id, asset, class)
    VALUES (inrp2p.account_id_of(k), (k).asset, inrp2p.account_class_of((k).family))
    ON CONFLICT (account_id) DO NOTHING;
  END LOOP;
END;
$fn$;

-- ---------------------------------------------------------------------
-- 9. Roles and grants — TS-02 §9.1, §9.2.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  THE APPLICATION ROLE HAS NO DML ON ANY MONEY TABLE.             │
-- │                                                                  │
-- │  That is the point of the separation. `inrp2p_app` may EXECUTE   │
-- │  boundary functions and read views; it cannot INSERT a posting   │
-- │  or UPDATE a balance even if the application is compromised.     │
-- │  Money moves only through code owned by `inrp2p_boundary`.       │
-- │                                                                  │
-- │  Roles are created NOLOGIN except the three that a service       │
-- │  actually connects as, and no password is set here: credentials  │
-- │  belong in a secrets manager (DEL-09), not in a migration that   │
-- │  lives in a public repository.                                   │
-- └──────────────────────────────────────────────────────────────────┘
-- ---------------------------------------------------------------------

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inrp2p_owner') THEN
    CREATE ROLE inrp2p_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inrp2p_boundary') THEN
    CREATE ROLE inrp2p_boundary NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inrp2p_app') THEN
    CREATE ROLE inrp2p_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inrp2p_relay') THEN
    CREATE ROLE inrp2p_relay NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inrp2p_recon') THEN
    CREATE ROLE inrp2p_recon NOLOGIN;
  END IF;
END;
$roles$;

REVOKE ALL ON SCHEMA inrp2p FROM PUBLIC;
REVOKE ALL ON ALL TABLES    IN SCHEMA inrp2p FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inrp2p FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA inrp2p FROM PUBLIC;

GRANT USAGE ON SCHEMA inrp2p TO inrp2p_boundary, inrp2p_app, inrp2p_relay, inrp2p_recon;

-- The boundary role is the ONLY role with DML on money tables…
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA inrp2p TO inrp2p_boundary;
-- …and even it may not DELETE anything, ever.
REVOKE DELETE ON ALL TABLES IN SCHEMA inrp2p FROM inrp2p_boundary;
-- The immutable tables are insert-only even for the boundary.
REVOKE UPDATE ON inrp2p.journal_entry, inrp2p.posting, inrp2p.ledger_account
  FROM inrp2p_boundary;

-- The application may execute the boundary and read nothing directly.
GRANT EXECUTE ON FUNCTION inrp2p.ensure_accounts(inrp2p.account_key[]) TO inrp2p_boundary;
REVOKE ALL ON FUNCTION inrp2p.ensure_accounts(inrp2p.account_key[]) FROM PUBLIC;

-- Reconciliation reads everything and writes nothing.
GRANT SELECT ON ALL TABLES IN SCHEMA inrp2p TO inrp2p_recon;

ALTER DEFAULT PRIVILEGES IN SCHEMA inrp2p REVOKE ALL ON TABLES FROM PUBLIC;
