-- =====================================================================
-- DEL-10 · The typed sign-in code must actually work.
--
-- THE DEFECT THIS REPAIRS.
--
-- DEL-03 minted `secret = "<8-digit code>.<link token>"` and stored ONE
-- hash, of the whole string. Its own comment said "the code is the
-- typable fallback … both hash into the same row" — but nothing ever
-- hashed the code on its own, so the only credential that could ever
-- match was the entire concatenation.
--
-- The consequence reached the person: the sign-in screen offers a field
-- whose placeholder is `12345678`, under copy promising a one-time code
-- by email, and typing that code was guaranteed to be refused with
-- "That sign-in code is not valid." The DEL-10 browser run hit exactly
-- this and could only proceed by pasting the full internal secret.
--
-- WHY A SECOND COLUMN RATHER THAN A SHORTER SECRET.
--
-- The two credentials have very different strengths and must not be
-- conflated. The link token is high-entropy and stands alone. Eight
-- digits do not: `code_hash` is therefore a hash of the code SALTED
-- WITH THE ADDRESS it was issued to, so a guess is only ever tested
-- against the one challenge belonging to that mailbox. Guessing is
-- bounded by the existing per-address verify rate limit, single use and
-- a fifteen-minute expiry — not by the size of the table.
--
-- NULLABLE ON PURPOSE. Challenges already in flight when this migration
-- runs have no code hash and keep working through their link until they
-- expire. Nothing is back-filled, because the codes are not recoverable
-- and must not be.
-- =====================================================================

ALTER TABLE sandbox.auth_challenge
  ADD COLUMN IF NOT EXISTS code_hash TEXT NULL;

DO $$
BEGIN
  -- Same shape rule as `token_hash`: a bare SHA-256 hex digest.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'auth_challenge_code_hash_shape'
  ) THEN
    ALTER TABLE sandbox.auth_challenge
      ADD CONSTRAINT auth_challenge_code_hash_shape
      CHECK (code_hash IS NULL OR code_hash ~ '^[0-9a-f]{64}$');
  END IF;
END $$;

-- Unique like `token_hash`, so a redemption resolves to at most one
-- challenge and two live challenges can never answer to one credential.
-- `NULLS NOT DISTINCT` is deliberately NOT used: pre-migration rows all
-- carry NULL and must not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS auth_challenge_code_hash_uq
  ON sandbox.auth_challenge (code_hash)
  WHERE code_hash IS NOT NULL;

-- `schema_state` is written by the migration runner from the file count,
-- never by a migration. A hand-written version here would disagree with
-- the checksum the runner computes over the whole directory.
