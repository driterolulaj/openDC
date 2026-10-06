# ADR-0013: Node-local SQLite platform DB; audit log replicated between DCs

Status: Proposed · Date: 2026-10-06

## Context
Sessions, jobs, checkpoints and caches are node-local by nature. The audit log has to be domain-wide, because
object history must show changes made from any DC. Writing audit entries into AD would bloat the directory and
add replication churn.

## Decision
1. `PlatformDb` is an interface in `packages/shared`. The default implementation uses `node:sqlite` (still
   experimental/RC on Node 24, which is why it sits behind an interface). `better-sqlite3` is the fallback, but
   only if `node:sqlite` turns out to be unusable, because it's a native addon. WAL mode; migrations are
   numbered SQL files.
2. **Audit log:**
   - Table `audit(origin_node_id, seq, ts, actor, actor_sid, source_ip, action, target_guid, target_dn,
     before_json, after_json, request_id, prev_hash, hash)`, with primary key `(origin_node_id, seq)`.
   - Append-only is enforced with triggers that reject UPDATE and DELETE. Retention purges use a special path
     that records a `retention_checkpoint` entry.
   - Hash chain per origin (`hash = SHA-256(prev_hash || canonical(entry))`) for tamper evidence. A diagnostic
     verifies the chain.
   - **Replication:** each writable DC pulls new entries from its peers over mTLS
     (`/node/v1/audit?origin=X&afterSeq=N`). Entries are immutable and keyed by origin and sequence, so the
     merge has no conflicts.
   - Diffs pass through schema-driven redaction (no password fields, no secrets). Personal data in diffs is
     covered by GDPR retention and erasure (Phase 7), which replaces values with a tombstone while keeping the
     hash chain verifiable through a stored per-field hash.
3. Sessions are node-local. A login on dc2 creates a dc2 session. There's no cross-DC session sharing; if a DC
   is lost, users simply log in again elsewhere.
4. **No secrets in the DB.** TOTP seeds are encrypted with a key from a systemd credential (they count as
   secrets). Reset tokens are stored only as SHA-256 hashes.

## Consequences
- Any writable DC can show complete history, delayed by the replication interval (default 30 s).
- An RODC holds only a read-only copy of the audit log (it pulls but never originates writes, because writes
  are proxied).
- The 50k-user load test has to cover audit query performance (indexes on target_guid, actor and ts).
