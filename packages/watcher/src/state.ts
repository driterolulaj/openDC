// SPDX-License-Identifier: AGPL-3.0-only
/** The watcher's own state DB (ADR-0013: one DB per service): per-handler checkpoints. No secrets. */
import type { Migration, PlatformDb } from '@opendc/shared/db';
import type { Checkpoint, CheckpointStore } from './engine.ts';

export const watcherMigrations: Migration[] = [
  {
    id: 1,
    name: 'checkpoints',
    sql: `
      CREATE TABLE checkpoints (
        handler         TEXT PRIMARY KEY,
        dc              TEXT NOT NULL,
        invocation_id   TEXT NOT NULL,
        cookie          TEXT NOT NULL,
        failures        INTEGER NOT NULL,
        quarantined     INTEGER NOT NULL,
        last_error      TEXT,
        next_attempt_at INTEGER NOT NULL,
        last_success_at INTEGER,
        since           INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
    `,
  },
];

interface Row {
  dc: string;
  invocation_id: string;
  cookie: string;
  failures: number;
  quarantined: number;
  last_error: string | null;
  next_attempt_at: number;
  last_success_at: number | null;
  since: number;
}

export class SqliteCheckpoints implements CheckpointStore {
  readonly #db: PlatformDb;

  constructor(db: PlatformDb) {
    this.#db = db;
  }

  get(handler: string): Checkpoint | null {
    const r = this.#db.get<Row>('SELECT * FROM checkpoints WHERE handler = ?', [handler]);
    return r
      ? {
          dc: r.dc,
          invocationId: r.invocation_id,
          cookie: r.cookie,
          failures: r.failures,
          quarantined: r.quarantined === 1,
          lastError: r.last_error,
          nextAttemptAt: r.next_attempt_at,
          lastSuccessAt: r.last_success_at,
          since: r.since,
        }
      : null;
  }

  save(handler: string, cp: Checkpoint): void {
    this.#db.run(
      `INSERT INTO checkpoints (handler, dc, invocation_id, cookie, failures, quarantined, last_error,
                                next_attempt_at, last_success_at, since, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (handler) DO UPDATE SET dc = excluded.dc, invocation_id = excluded.invocation_id,
         cookie = excluded.cookie, failures = excluded.failures, quarantined = excluded.quarantined,
         last_error = excluded.last_error, next_attempt_at = excluded.next_attempt_at,
         last_success_at = excluded.last_success_at, since = excluded.since, updated_at = excluded.updated_at`,
      [
        handler,
        cp.dc,
        cp.invocationId,
        cp.cookie,
        cp.failures,
        cp.quarantined ? 1 : 0,
        cp.lastError,
        cp.nextAttemptAt,
        cp.lastSuccessAt,
        cp.since,
        Date.now(),
      ],
    );
  }

  /** Lifts a quarantine (the next pass retries from the frozen checkpoint). */
  release(handler: string): boolean {
    return (
      this.#db.run('UPDATE checkpoints SET quarantined = 0, failures = 0, next_attempt_at = 0 WHERE handler = ?', [
        handler,
      ]).changes > 0
    );
  }

  /** Lifts every quarantine; returns the handlers it released. */
  releaseAll(): string[] {
    const rows = this.#db.all<{ handler: string }>('SELECT handler FROM checkpoints WHERE quarantined = 1');
    for (const r of rows) this.release(r.handler);
    return rows.map((r) => r.handler);
  }

  /** Forgets the cookie (keeps `since`): the next pass does a full resync. */
  resync(handler: string): boolean {
    return this.#db.run("UPDATE checkpoints SET cookie = '' WHERE handler = ?", [handler]).changes > 0;
  }
}
