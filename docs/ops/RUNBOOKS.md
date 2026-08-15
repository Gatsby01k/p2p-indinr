# Operational runbooks

**No alert destination is configured.** No PagerDuty, Slack, email or SMS
provider has credentials in this repository, so nothing here is delivered
anywhere. `db/alerts.json` defines the rules and the queries that
evaluate them; wiring them to a destination is a deployment task with
real credentials, and until that happens an operator finds these by
looking.

That is stated first because a runbook that assumes it was paged is a
runbook nobody reads in time.

---

## 1. Deployment failure

**Symptom** — the deploy step fails, or readiness stays `false` after it.

1. `GET /api/health/ready` as an authenticated operator. The detailed
   view names the failing check; the public one deliberately does not.
2. If `schema-version` fails, the application and the database disagree.
   **Do not** run migrations from the application. Run the pipeline's
   migration step, then redeploy.
3. If `config` fails, the named variable is missing. It is named, never
   valued — read it from the secret manager, not from a log.
4. If an `adapter:*` check fails, that provider is not configured. In
   this repository none of them is, so a production readiness failure
   here is expected and correct.
5. Roll back the **application** to the previous image. Do **not** roll
   back migrations: financial history is immutable and a reverse
   migration would delete committed records. Fix forward.

## 2. Database outage

1. Liveness stays green — it does not touch the database, deliberately,
   so the platform is not restart-looped by a slow query.
2. Readiness goes red and traffic is routed away.
3. Nothing is lost: every money-moving path is one transaction, so an
   interrupted request either committed or did not.
4. On recovery, run `npm run drill:recovery` against a restored copy
   before promoting it, and confirm `ledger-zero-sum` passes.

## 3. Compromised credential

1. **Pause first.** `CONTROL_PAUSE` on `SETTLEMENT` needs one authorised
   operator and takes effect on the next request. Resuming needs two.
2. Rotate the database role: `npm run roles:provision` with a new
   password from the secret manager. The roles are `NOLOGIN` by default,
   so revoking is `ALTER ROLE … NOLOGIN`.
3. Rotate signing keys. Verification accepts the previous key for a
   bounded window so sessions and capabilities issued before the
   rotation are not all invalidated at once.
4. Read `sandbox.audit_event` for the actor. It is append-only and the
   runtime roles hold no `UPDATE` on it, so an attacker with application
   access could not have edited it.

## 4. Rail or provider outage

1. `CONTROL_PAUSE` on `RAIL_CONFIRM` stops confirmations platform-wide.
   Observations are still **recorded** — a pause must not lose the report
   that a transfer arrived.
2. Instructions already issued remain valid. Customers who have sent
   money are not stranded; their confirmation is deferred.
3. On recovery, propose `CORRIDOR_RESUME`, have a **different** reviewer
   approve, then resume. The database refuses a one-person resume.
4. Backlogged provider events replay through the normal ingest path,
   which is keyed — a duplicate confirms nothing twice.

## 5. Stuck outbox

1. `outboxHealth()` reports pending, lagging, dead-letter and the age of
   the oldest pending event.
2. A **lagging** backlog usually means the scheduler is not calling the
   worker. The worker is one-shot by design; the scheduler is an
   external readiness dependency.
3. **Dead letters** are events that failed `max_attempts` times. Read
   `last_error`, fix the cause, then `replayDeadLetter` — which requires
   `risk.case.work` and a satisfied second factor.
4. Replay is safe: handlers are idempotent and every boundary they call
   is keyed.

## 6. Webhook replay attack

1. Repeated `WEBHOOK_UNVERIFIED` in the audit trail is the signal. Every
   refused delivery is recorded — a forgery that left no trace would be
   one nobody could investigate.
2. No action is required to stop it: `rail_event` uniqueness rejects a
   replay, and the signature covers `timestamp.body` so a captured
   request cannot be re-timestamped.
3. If the volume is disruptive, `CONTROL_PAUSE` on `RAIL_CONFIRM`.
4. If a signature ever **verifies** from an unexpected source, treat the
   webhook secret as compromised and follow runbook 3.

## 7. Ledger invariant incident

1. `SELECT asset, sum(amount_minor) FROM inrp2p.posting GROUP BY asset`
   must return zero for every asset. It is enforced at commit by a
   constraint trigger, so a non-zero result means something bypassed
   `post_entry` — which the runtime roles cannot do.
2. **Pause `SETTLEMENT` immediately.**
3. Do **not** "correct" the ledger. Entries are immutable; a correction
   is a reversal entry, and an unexplained imbalance is an incident
   before it is a correction.
4. Preserve the evidence: `sandbox.ops_case` with
   `preservation_hold = true`.

## 8. USDT reorg

1. A reorg **before** disposal reverses the deposit entry automatically
   through `JD-REVERSAL`. Both entries remain.
2. A reorg **after** the value was released raises a
   `REORG_AFTER_DISPOSAL` incident and changes nothing. That is
   deliberate: the alternatives are inventing value or silently debiting
   a customer who did nothing wrong.
3. A person decides. Options are commercial, not technical — absorb the
   loss, contact the recipient, or pursue recovery.
4. Never resolve it by editing the ledger.

## 9. Evidence or storage breach

1. Evidence bytes live behind a storage adapter and are reachable only
   through a short-lived, single-use, non-transferable capability.
2. Revoke outstanding capabilities:
   `UPDATE sandbox.evidence_capability SET consumed_at = now() WHERE consumed_at IS NULL`.
   They are stored only as a SHA-256, so a database dump alone does not
   hand anybody a download.
3. Rotate the storage credential and follow runbook 3.
4. `sandbox.audit_event` records every `EVIDENCE_DOWNLOAD_REQUEST`, which
   is the list of what was accessed.

## 10. Emergency pause and resume

- **Pause**: one operator with `control.pause`. Immediate — an incident
  at 03:00 must not wait for a colleague.
- **Resume**: propose `CORRIDOR_RESUME`, a **different** person with
  `control.resume.approve` approves, then resume. Enforced by the
  service and independently by a `CHECK` constraint.
- A pause stops **new** work. It never rewrites a ledger entry, a
  payment record or a deal.

## 11. Backup restoration

1. `npm run drill:recovery` performs backup, restore into an isolated
   database, and verification.
2. It reports which mode ran. `pg_dump` is the production path;
   `logical` is a row-level fallback for environments without the
   binaries, and it is **not** equivalent.
3. The checks that matter: schema version, ledger zero-sum, entry
   integrity, immutable history, and whether the source had
   representative data at all.
4. **RPO and RTO are not claimed.** The drill reports a measured
   duration on drill data. A real target needs a production-sized
   dataset and a real incident.
