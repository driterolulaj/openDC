// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PlatformDb (ADR-0013): a small synchronous SQL interface with a node:sqlite implementation. node:sqlite
 * is still marked experimental on Node 24, which is why callers only see this interface.
 *
 * Each service owns its own database file under its own state directory (the api and watcher run as
 * different users), with its own numbered migration list.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { PlatformError } from '../errors.ts';

export type SqlParam = SQLInputValue;
export type SqlParams = readonly SqlParam[] | Record<string, SqlParam>;

export interface PlatformDb {
  exec(sql: string): void;
  run(sql: string, params?: SqlParams): { changes: number; lastInsertRowid: number };
  get<T>(sql: string, params?: SqlParams): T | undefined;
  all<T>(sql: string, params?: SqlParams): T[];
  /** Runs `fn` in a transaction (nested calls use savepoints). */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface Migration {
  /** Monotonic, e.g. 1, 2, 3. */
  id: number;
  name: string;
  sql: string;
}

function bind(params: SqlParams | undefined): SqlParam[] | [Record<string, SqlParam>] {
  if (!params) return [];
  return Array.isArray(params) ? [...(params as SqlParam[])] : [params as Record<string, SqlParam>];
}

export class SqlitePlatformDb implements PlatformDb {
  readonly path: string;
  #db: DatabaseSync;
  #depth = 0;

  constructor(path: string) {
    this.path = path;
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA foreign_keys = ON');
    if (path !== ':memory:') {
      this.#db.exec('PRAGMA journal_mode = WAL');
      this.#db.exec('PRAGMA synchronous = NORMAL');
    }
    this.#db.exec('PRAGMA busy_timeout = 5000');
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  run(sql: string, params?: SqlParams): { changes: number; lastInsertRowid: number } {
    const stmt = this.#db.prepare(sql);
    const r = stmt.run(...(bind(params) as SqlParam[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T>(sql: string, params?: SqlParams): T | undefined {
    const stmt = this.#db.prepare(sql);
    return stmt.get(...(bind(params) as SqlParam[])) as T | undefined;
  }

  all<T>(sql: string, params?: SqlParams): T[] {
    const stmt = this.#db.prepare(sql);
    return stmt.all(...(bind(params) as SqlParam[])) as T[];
  }

  transaction<T>(fn: () => T): T {
    const sp = `sp${String(this.#depth)}`;
    this.#db.exec(this.#depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.#depth++;
    try {
      const out = fn();
      this.#depth--;
      this.#db.exec(this.#depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (e) {
      this.#depth--;
      this.#db.exec(this.#depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }

  close(): void {
    this.#db.close();
  }
}

/** Applies pending migrations in order, each in its own transaction. Returns the ids applied. */
export function migrate(db: PlatformDb, migrations: readonly Migration[]): number[] {
  const ids = migrations.map((m) => m.id);
  if (ids.some((id, i) => i > 0 && id <= (ids[i - 1] ?? 0))) throw new TypeError('Migration ids must increase');
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const done = new Set(db.all<{ id: number }>('SELECT id FROM schema_migrations').map((r) => r.id));
  const applied: number[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    try {
      db.transaction(() => {
        db.exec(m.sql);
        db.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [
          m.id,
          m.name,
          new Date().toISOString(),
        ]);
      });
    } catch (e) {
      throw new PlatformError(
        'db.migration-failed',
        {
          migration: `${String(m.id)}-${m.name}`,
          reason: e instanceof Error ? e.message : String(e),
          path: db instanceof SqlitePlatformDb ? db.path : '(db)',
        },
        { cause: e },
      );
    }
    applied.push(m.id);
  }
  return applied;
}

export function openDb(path: string, migrations: readonly Migration[]): PlatformDb {
  const db = new SqlitePlatformDb(path);
  migrate(db, migrations);
  return db;
}
