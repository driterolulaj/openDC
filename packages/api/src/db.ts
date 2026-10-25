// SPDX-License-Identifier: AGPL-3.0-only
/** The API's platform DB schema (ADR-0013). No secrets: session ids are stored as SHA-256 only. */
import type { Migration } from '@opendc/shared/db';

export const apiMigrations: Migration[] = [
  {
    id: 1,
    name: 'sessions-audit-jobs',
    sql: `
      CREATE TABLE sessions (
        id_hash      TEXT PRIMARY KEY,
        user_sid     TEXT NOT NULL,
        user_guid    TEXT NOT NULL,
        username     TEXT NOT NULL,
        display_name TEXT,
        user_dn      TEXT NOT NULL,
        domain_sid   TEXT NOT NULL,
        group_sids   TEXT NOT NULL,
        groups_at    INTEGER NOT NULL,
        created_at   INTEGER NOT NULL,
        last_seen    INTEGER NOT NULL,
        ip           TEXT
      );
      CREATE INDEX sessions_last_seen ON sessions (last_seen);

      CREATE TABLE audit (
        origin_node_id TEXT NOT NULL,
        seq            INTEGER NOT NULL,
        ts             TEXT NOT NULL,
        actor          TEXT NOT NULL,
        actor_sid      TEXT,
        source_ip      TEXT,
        action         TEXT NOT NULL,
        result         TEXT NOT NULL,
        target_guid    TEXT,
        target_dn      TEXT,
        before_json    TEXT,
        after_json     TEXT,
        request_id     TEXT,
        prev_hash      TEXT NOT NULL,
        hash           TEXT NOT NULL,
        PRIMARY KEY (origin_node_id, seq)
      );
      CREATE INDEX audit_target ON audit (target_guid);
      CREATE INDEX audit_actor ON audit (actor_sid);
      CREATE INDEX audit_ts ON audit (ts);
      CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
      CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

      CREATE TABLE jobs (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        actor       TEXT NOT NULL,
        actor_sid   TEXT,
        status      TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        result_json TEXT,
        error_json  TEXT
      );
      CREATE TABLE job_events (
        job_id    TEXT NOT NULL REFERENCES jobs (id),
        n         INTEGER NOT NULL,
        ts        TEXT NOT NULL,
        kind      TEXT NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (job_id, n)
      );
    `,
  },
  {
    id: 2,
    name: 'import-batches',
    sql: `
      -- CSV imports (Phase 2): which objects an import created, so it can be undone. No passwords.
      CREATE TABLE import_batches (
        id            TEXT PRIMARY KEY,
        actor         TEXT NOT NULL,
        actor_sid     TEXT,
        created_at    TEXT NOT NULL,
        created_json  TEXT NOT NULL,
        updated_count INTEGER NOT NULL,
        failed_count  INTEGER NOT NULL,
        undone_at     TEXT
      );
    `,
  },
];
