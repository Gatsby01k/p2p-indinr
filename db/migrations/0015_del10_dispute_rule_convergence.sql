-- =====================================================================
-- 0015 — DEL-10: converge the dispute-case ruling constraints.
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │  WHY A FORWARD MIGRATION AND NOT JUST THE EDIT TO 0010.          │
-- │                                                                  │
-- │  DEL-10 repaired `0010_del06_deal_room.sql` so that a populated  │
-- │  database could cross it at all. But 0010 was already published  │
-- │  at the DEL-09 baseline, and the runner records applied          │
-- │  migrations BY FILENAME — so any database that already ran the   │
-- │  original will never re-run the edited one.                      │
-- │                                                                  │
-- │  That leaves two populations with DIFFERENT SCHEMAS:             │
-- │                                                                  │
-- │    A. Databases built from the edited 0010 (fresh, or upgraded   │
-- │       from before DEL-06).                                       │
-- │    B. Databases that applied the ORIGINAL 0010 at DEL-09.        │
-- │                                                                  │
-- │  The difference is exactly two CHECK constraints on              │
-- │  `sandbox.dispute_case`:                                         │
-- │                                                                  │
-- │    · `dispute_case_resolved_rule` — the original folded          │
-- │      `resolved_by_proposal IS NOT NULL` into it;                 │
-- │    · `dispute_case_ruling_traceable` — the original had none.    │
-- │                                                                  │
-- │  This migration makes population B match population A. It is     │
-- │  written to be a NO-OP on A, so both paths run it and both end   │
-- │  with one fingerprint.                                           │
-- └──────────────────────────────────────────────────────────────────┘
--
-- WHAT THIS DOES NOT DO: it does not touch a single row. No dispute,
-- case, disposition, proposal, note or timestamp is read, rewritten or
-- deleted here. Constraints are redefined; the history stays as it is.
--
-- IDEMPOTENT. Re-running it changes nothing, and applying it to a
-- database that never had the original 0010 changes nothing either.
-- =====================================================================

DO $$
DECLARE
  resolved_def TEXT;
BEGIN
  /*
   * 1. `dispute_case_resolved_rule`.
   *
   * Recreated only when it still carries `resolved_by_proposal`. That
   * clause is what made a legacy ruling impossible to migrate: rulings
   * decided before DEL-06 have no maker-checker proposal to point at,
   * and minting one would fabricate an approval nobody gave.
   *
   * The definition is compared rather than assumed, so a database that
   * already has the corrected form is left untouched.
   */
  SELECT pg_get_constraintdef(oid) INTO resolved_def
    FROM pg_constraint
   WHERE conname = 'dispute_case_resolved_rule'
     AND conrelid = 'sandbox.dispute_case'::regclass;

  IF resolved_def IS NOT NULL AND resolved_def LIKE '%resolved_by_proposal%' THEN
    ALTER TABLE sandbox.dispute_case DROP CONSTRAINT dispute_case_resolved_rule;
    ALTER TABLE sandbox.dispute_case
      ADD CONSTRAINT dispute_case_resolved_rule
      CHECK ((state = 'RESOLVED') = (disposition IS NOT NULL
                                     AND resolved_at IS NOT NULL));
    RAISE NOTICE 'dispute_case_resolved_rule converged';
  END IF;

  /*
   * 2. `dispute_case_ruling_traceable`.
   *
   * The guarantee the clause above gave up, restated so it still holds
   * for every ruling THIS system makes: a resolved case names the
   * proposal that approved it, and may omit it ONLY if its note says it
   * was carried across from before DEL-06. The exception is narrow and
   * declares itself in the record an operator reads.
   *
   * NOT VALID is deliberately NOT used: this must be enforced for
   * existing rows too, and any database reaching here satisfies it —
   * population B could only have applied the original 0010 if every
   * resolved case already carried a proposal.
   */
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dispute_case_ruling_traceable'
       AND conrelid = 'sandbox.dispute_case'::regclass
  ) THEN
    ALTER TABLE sandbox.dispute_case
      ADD CONSTRAINT dispute_case_ruling_traceable
      CHECK (state <> 'RESOLVED'
             OR resolved_by_proposal IS NOT NULL
             OR resolution_note LIKE 'Resolved before DEL-06%');
    RAISE NOTICE 'dispute_case_ruling_traceable added';
  END IF;
END $$;

/*
 * A withdrawn case must name when it was withdrawn.
 *
 * The original 0010 set `withdrawn_at` in a follow-up UPDATE, which
 * could never run because the CHECK fires per row at INSERT — so no
 * database can hold a WITHDRAWN case with a NULL timestamp, and this is
 * a belt-and-braces assertion rather than a repair. It is stated here
 * because the convergence report compares it.
 */
DO $$
DECLARE
  offenders INTEGER;
BEGIN
  SELECT count(*) INTO offenders
    FROM sandbox.dispute_case
   WHERE state = 'WITHDRAWN' AND withdrawn_at IS NULL;

  IF offenders > 0 THEN
    RAISE EXCEPTION 'convergence refused: % withdrawn case(s) carry no withdrawal time', offenders;
  END IF;
END $$;
