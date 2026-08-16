-- =====================================================================
-- 0013 — DEL-09: least-privilege database access.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  THE APPLICATION HAS BEEN CONNECTING AS THE DATABASE OWNER.      │
-- │                                                                  │
-- │  Every stage since DEL-04 has flagged this. The role split was   │
-- │  correct and proved under `SET LOCAL ROLE`, but the WEB RUNTIME  │
-- │  still logged in as `inrp2p_sandbox`, which owns everything —    │
-- │  so a SQL-injection bug anywhere in the application was a bug    │
-- │  with DDL, with `DELETE` on the audit trail, and with direct     │
-- │  write access to the ledger.                                     │
-- │                                                                  │
-- │  This migration creates the LOGIN roles the application and the  │
-- │  worker actually use, and grants each exactly what it needs.     │
-- │  After this, an application compromise cannot drop a table,      │
-- │  rewrite history, or post a ledger entry except through the      │
-- │  boundary functions that check the invariants.                   │
-- └──────────────────────────────────────────────────────────────────┘
--
-- PASSWORDS ARE NOT SET HERE. A password in a migration is a password
-- in version control. These roles are created NOLOGIN and a deployment
-- grants LOGIN with a credential from the secret manager — see
-- `scripts/provision-roles.mjs`, which reads it from the environment and
-- never writes it anywhere.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The login roles.
--
-- Created NOLOGIN so this migration cannot itself open a way in. The
-- provisioning script flips LOGIN and sets a password out of band.
-- ---------------------------------------------------------------------

DO $$
BEGIN
  -- The web runtime. Reads and writes application data; owns nothing.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inrp2p_web') THEN
    CREATE ROLE inrp2p_web NOLOGIN;
  END IF;

  -- The background worker. Same data, plus the outbox claim/lease.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inrp2p_worker') THEN
    CREATE ROLE inrp2p_worker NOLOGIN;
  END IF;

  -- Read-only operational access, for a human debugging an incident.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inrp2p_readonly') THEN
    CREATE ROLE inrp2p_readonly NOLOGIN;
  END IF;

  -- The migration executor. Holds DDL and is UNAVAILABLE to the runtime:
  -- its credential lives only in the deployment pipeline.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inrp2p_migrator') THEN
    CREATE ROLE inrp2p_migrator NOLOGIN;
  END IF;
END
$$;

/*
 * NOT SUPERUSER, NOT CREATEDB, NOT CREATEROLE, NOT BYPASSRLS,
 * NOT REPLICATION — stated explicitly rather than left to the default,
 * because "the default is fine" is how a role acquires an attribute
 * somebody set once for a debugging session.
 *
 * ⚠ THIS IS AN ASSERTION ABOUT STATE, NOT A CHANGE.
 *
 * A role created by the block above already has all five cleared, so the
 * ALTER normally changes nothing — it exists to catch the role that was
 * created by somebody else, earlier, with more.
 *
 * Issuing it BLINDLY made the assertion unrunnable on managed PostgreSQL.
 * SUPERUSER, BYPASSRLS and REPLICATION are superuser-only attributes, and
 * no managed provider grants superuser to anybody — so on Neon, RDS and
 * Cloud SQL this migration failed with `permission denied to alter role`
 * and the deployment stopped at v12, while on the local embedded cluster
 * (whose owner IS a superuser) it passed and hid the problem.
 *
 * So: attempt the change, and when the server refuses, verify the state
 * DIRECTLY and refuse to continue if it is actually wrong. That is
 * strictly stronger than before — the old form proved nothing about the
 * outcome, this one either holds or stops the migration.
 */
DO $attrs$
DECLARE
  role_name TEXT;
  held      TEXT;
BEGIN
  FOREACH role_name IN ARRAY
    ARRAY['inrp2p_web', 'inrp2p_worker', 'inrp2p_readonly', 'inrp2p_migrator']
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION',
        role_name);
    EXCEPTION WHEN insufficient_privilege THEN
      SELECT string_agg(v.attribute, ', ')
        INTO held
        FROM pg_roles p,
             LATERAL (VALUES ('SUPERUSER', p.rolsuper),
                             ('CREATEDB', p.rolcreatedb),
                             ('CREATEROLE', p.rolcreaterole),
                             ('BYPASSRLS', p.rolbypassrls),
                             ('REPLICATION', p.rolreplication)) AS v(attribute, granted)
       WHERE p.rolname = role_name AND v.granted;

      IF held IS NOT NULL THEN
        RAISE EXCEPTION
          'role % holds %, and this connection cannot clear it', role_name, held
          USING HINT = 'These are superuser-only attributes. Clear them with a '
                       'superuser connection, then re-run the migration.';
      END IF;
    END;
  END LOOP;
END
$attrs$;

/*
 * A LOCKED `search_path` on every login role.
 *
 * Without it, a caller can prepend a schema they control and shadow
 * `sandbox.deal` with their own table. Pinning it per role means the
 * resolution is fixed before any application code runs.
 */
ALTER ROLE inrp2p_web      SET search_path = pg_catalog, sandbox, inrp2p_read, public;
ALTER ROLE inrp2p_worker   SET search_path = pg_catalog, sandbox, inrp2p_read, public;
ALTER ROLE inrp2p_readonly SET search_path = pg_catalog, sandbox, inrp2p_read, public;
ALTER ROLE inrp2p_migrator SET search_path = pg_catalog, sandbox, inrp2p, public;

/*
 * TIMEOUTS, per role rather than per connection.
 *
 * A statement that runs for ten minutes holds locks for ten minutes, and
 * an idle transaction holds them indefinitely. Set here so they apply
 * however the application connects — including a psql session somebody
 * opens during an incident.
 */
ALTER ROLE inrp2p_web      SET statement_timeout = '15s';
ALTER ROLE inrp2p_web      SET lock_timeout = '3s';
ALTER ROLE inrp2p_web      SET idle_in_transaction_session_timeout = '10s';

-- The worker may legitimately run longer than a web request, and still
-- not forever.
ALTER ROLE inrp2p_worker   SET statement_timeout = '60s';
ALTER ROLE inrp2p_worker   SET lock_timeout = '5s';
ALTER ROLE inrp2p_worker   SET idle_in_transaction_session_timeout = '30s';

ALTER ROLE inrp2p_readonly SET statement_timeout = '120s';
ALTER ROLE inrp2p_readonly SET lock_timeout = '1s';
ALTER ROLE inrp2p_readonly SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE inrp2p_readonly SET default_transaction_read_only = on;

-- Migrations take a while and must not be killed halfway.
ALTER ROLE inrp2p_migrator SET statement_timeout = '0';
ALTER ROLE inrp2p_migrator SET lock_timeout = '30s';

-- ---------------------------------------------------------------------
-- 2. Schema access.
--
-- `USAGE` only. No `CREATE` on any schema for any runtime role, so a
-- compromised application cannot add a table to hide data in.
-- ---------------------------------------------------------------------

REVOKE ALL ON SCHEMA sandbox FROM PUBLIC;
GRANT USAGE ON SCHEMA sandbox TO inrp2p_web, inrp2p_worker, inrp2p_readonly;
GRANT USAGE, CREATE ON SCHEMA sandbox TO inrp2p_migrator;

GRANT USAGE ON SCHEMA inrp2p_read TO inrp2p_web, inrp2p_worker, inrp2p_readonly;
GRANT USAGE ON SCHEMA inrp2p TO inrp2p_web, inrp2p_worker;
GRANT USAGE, CREATE ON SCHEMA inrp2p TO inrp2p_migrator;

-- ---------------------------------------------------------------------
-- 3. Outbox delivery columns (DEL-09 worker).
--
-- These come BEFORE the grants below, because a column-level privilege
-- on a column that does not exist yet fails outright. Ordering inside a
-- migration is load-bearing and stated rather than assumed.
-- ---------------------------------------------------------------------

ALTER TABLE sandbox.outbox_event
  ADD COLUMN IF NOT EXISTS state           TEXT        NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS attempts        INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts    INTEGER     NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS lease_owner     TEXT        NULL,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_error      TEXT        NULL,
  ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS correlation_id  TEXT        NULL;

ALTER TABLE sandbox.outbox_event
  ADD CONSTRAINT outbox_event_state
    CHECK (state IN ('PENDING','DELIVERED','DEAD_LETTER')),
  ADD CONSTRAINT outbox_event_attempts CHECK (attempts >= 0 AND attempts <= max_attempts),
  -- A dead letter has stopped being retried and says when it stopped.
  ADD CONSTRAINT outbox_event_dead CHECK (
    (state = 'DEAD_LETTER') = (dead_lettered_at IS NOT NULL)),
  ADD CONSTRAINT outbox_event_delivered CHECK (
    (state = 'DELIVERED') = (published_at IS NOT NULL));

CREATE INDEX IF NOT EXISTS outbox_event_claimable_ix
  ON sandbox.outbox_event (next_attempt_at)
  WHERE state = 'PENDING';

CREATE INDEX IF NOT EXISTS outbox_event_dead_ix
  ON sandbox.outbox_event (dead_lettered_at)
  WHERE state = 'DEAD_LETTER';

-- Existing rows predate delivery tracking. `published_at IS NULL` on all
-- of them, so they are PENDING — which is exactly right: they were never
-- delivered, and a dispatcher now exists to deliver them.
UPDATE sandbox.outbox_event SET state = 'PENDING' WHERE published_at IS NULL;
UPDATE sandbox.outbox_event SET state = 'DELIVERED' WHERE published_at IS NOT NULL;

-- ---------------------------------------------------------------------
-- 4. Application data.
--
-- Broad DML on the sandbox schema, because that is what an application
-- does — and then narrowed, below, everywhere history must not move.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA sandbox TO inrp2p_web, inrp2p_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA sandbox TO inrp2p_web, inrp2p_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA sandbox TO inrp2p_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA inrp2p_read TO inrp2p_web, inrp2p_worker, inrp2p_readonly;

/*
 * NO DELETE. ANYWHERE. FOR ANY RUNTIME ROLE.
 *
 * Nothing in this product legitimately deletes a row: deals complete,
 * disputes resolve, evidence is rejected, holds are released. Every one
 * of those is an UPDATE or an INSERT. So `DELETE` is not narrowed to the
 * sensitive tables — it is withheld entirely, and a bug that tries to
 * delete anything fails loudly instead of quietly succeeding on the one
 * table nobody thought to protect.
 */
REVOKE DELETE ON ALL TABLES IN SCHEMA sandbox FROM inrp2p_web, inrp2p_worker;
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA sandbox FROM inrp2p_web, inrp2p_worker;

/*
 * IMMUTABLE HISTORY IS INSERT-ONLY.
 *
 * These tables have triggers that raise on UPDATE, and a trigger is a
 * good belt. This is the braces: the privilege is not there either, so
 * a future migration that drops a trigger does not silently open a
 * table to rewriting.
 */
REVOKE UPDATE ON
  sandbox.audit_event,
  sandbox.deal_message,
  sandbox.payment_observation,
  sandbox.rail_event,
  sandbox.risk_decision_log,
  sandbox.reputation_event,
  sandbox.ops_case_action,
  sandbox.screening_result,
  sandbox.quote_fee_snapshot,
  sandbox.dispute_proposal,
  sandbox.evidence_capability
  FROM inrp2p_web, inrp2p_worker;

-- The outbox is append-only except for `published_at`, which is the one
-- field a dispatcher must set. Granted narrowly, by column.
REVOKE UPDATE ON sandbox.outbox_event FROM inrp2p_web, inrp2p_worker;
GRANT UPDATE (published_at, attempts, next_attempt_at, last_error, state, dead_lettered_at)
  ON sandbox.outbox_event TO inrp2p_worker;

-- A fee policy and a risk policy move only through their lifecycle
-- columns, and only from the web boundary that checks maker-checker.
REVOKE UPDATE ON sandbox.fee_policy, sandbox.risk_policy FROM inrp2p_worker;

-- ---------------------------------------------------------------------
-- 5. The money schema.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  THE APPLICATION HOLDS NO DML ON `inrp2p`. NOT ONE TABLE.        │
-- │                                                                  │
-- │  It may EXECUTE the three SECURITY DEFINER boundary functions,   │
-- │  which are owned by `inrp2p_boundary` and enforce the zero-sum,  │
-- │  non-negative and immutability invariants. Everything else it    │
-- │  reads through `inrp2p_read`.                                    │
-- │                                                                  │
-- │  `value_lock` is the single exception, and deliberately so: a    │
-- │  lock row that disagreed with the ledger is VISIBLE as a lock    │
-- │  with no matching entry, whereas a forged ledger entry would be  │
-- │  actual value.                                                   │
-- └──────────────────────────────────────────────────────────────────┘
-- ---------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA inrp2p FROM inrp2p_web, inrp2p_worker;
GRANT SELECT, INSERT, UPDATE ON inrp2p.value_lock TO inrp2p_web, inrp2p_worker;

GRANT EXECUTE ON FUNCTION
  inrp2p.post_entry(TEXT, JSONB, UUID[], NUMERIC[]),
  inrp2p.reverse_entry(UUID, TEXT),
  inrp2p.ensure_accounts(inrp2p.account_key[])
  TO inrp2p_web, inrp2p_worker;

GRANT EXECUTE ON FUNCTION
  inrp2p.ce_field(TEXT, INTEGER, BYTEA),
  inrp2p.ce_account_key(inrp2p.account_key),
  inrp2p.uuid_v5(UUID, BYTEA),
  inrp2p.account_id_of(inrp2p.account_key),
  inrp2p.account_class_of(TEXT),
  inrp2p.normal_balance(inrp2p.account_class, inrp2p.amount_minor)
  TO inrp2p_web, inrp2p_worker, inrp2p_readonly;

-- Reconciliation reads the money tables and writes nothing.
GRANT SELECT ON ALL TABLES IN SCHEMA inrp2p TO inrp2p_readonly;

-- ---------------------------------------------------------------------
-- 6. Default privileges, so a FUTURE table is safe by default.
--
-- The failure this prevents: a later migration adds a table, nobody
-- remembers to revoke DELETE, and the runtime quietly gains it.
-- ---------------------------------------------------------------------

ALTER DEFAULT PRIVILEGES IN SCHEMA sandbox
  GRANT SELECT, INSERT, UPDATE ON TABLES TO inrp2p_web, inrp2p_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA sandbox
  GRANT SELECT ON TABLES TO inrp2p_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA sandbox
  GRANT USAGE, SELECT ON SEQUENCES TO inrp2p_web, inrp2p_worker;

-- A future `inrp2p` table is readable by nobody until somebody decides.
ALTER DEFAULT PRIVILEGES IN SCHEMA inrp2p REVOKE ALL ON TABLES FROM PUBLIC;

-- ---------------------------------------------------------------------
-- 7. The schema-version fact, for the readiness check.
--
-- The application reads this at startup and refuses to serve if it does
-- not match what the code expects. A web process running against a
-- database it was not built for is how a "successful" deploy silently
-- writes the wrong shape.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox.schema_state (
  singleton   BOOLEAN     NOT NULL DEFAULT TRUE,
  version     INTEGER     NOT NULL,
  checksum    TEXT        NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT schema_state_pk PRIMARY KEY (singleton),
  CONSTRAINT schema_state_singleton CHECK (singleton),
  CONSTRAINT schema_state_checksum CHECK (checksum ~ '^[0-9a-f]{64}$')
);

GRANT SELECT ON sandbox.schema_state
  TO inrp2p_web, inrp2p_worker, inrp2p_readonly;
REVOKE INSERT, UPDATE, DELETE ON sandbox.schema_state
  FROM inrp2p_web, inrp2p_worker;
