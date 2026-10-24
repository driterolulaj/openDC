// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDb, SqlitePlatformDb } from './index.ts';
import { PlatformError } from '../errors.ts';

const migrations = [
  { id: 1, name: 'init', sql: 'CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER NOT NULL)' },
  { id: 2, name: 'index', sql: 'CREATE INDEX t_v ON t (v)' },
];

test('migrations apply once and in order', () => {
  const db = new SqlitePlatformDb(':memory:');
  assert.deepEqual(migrate(db, migrations), [1, 2]);
  assert.deepEqual(migrate(db, migrations), []);
  assert.deepEqual(migrate(db, [...migrations, { id: 3, name: 'col', sql: 'ALTER TABLE t ADD COLUMN w TEXT' }]), [3]);
  assert.throws(() => migrate(db, [migrations[1]!, migrations[0]!]), TypeError);
  db.close();
});

test('a failing migration rolls back and raises db.migration-failed', () => {
  const db = new SqlitePlatformDb(':memory:');
  migrate(db, migrations);
  const bad = { id: 9, name: 'broken', sql: 'CREATE TABLE ok (x); CREATE TABLE t (dup)' };
  assert.throws(
    () => migrate(db, [...migrations, bad]),
    (e: unknown) => e instanceof PlatformError && e.code === 'db.migration-failed',
  );
  assert.equal(db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'ok'")?.n, 0);
  db.close();
});

test('run/get/all with positional and named params; nested transactions', () => {
  const db = openDb(':memory:', migrations);
  db.run('INSERT INTO t (k, v) VALUES (?, ?)', ['a', 1]);
  db.run('INSERT INTO t (k, v) VALUES (:k, :v)', { k: 'b', v: 2 });
  assert.deepEqual({ ...db.get<{ v: number }>('SELECT v FROM t WHERE k = ?', ['b']) }, { v: 2 });
  assert.equal(db.all('SELECT * FROM t').length, 2);
  db.transaction(() => {
    db.run('INSERT INTO t (k, v) VALUES (?, ?)', ['c', 3]);
    assert.throws(() =>
      db.transaction(() => {
        db.run('INSERT INTO t (k, v) VALUES (?, ?)', ['d', 4]);
        throw new Error('inner');
      }),
    );
  });
  assert.deepEqual(
    db.all<{ k: string }>('SELECT k FROM t ORDER BY k').map((r) => r.k),
    ['a', 'b', 'c'],
  );
  assert.throws(() =>
    db.transaction(() => {
      db.run('INSERT INTO t (k, v) VALUES (?, ?)', ['e', 5]);
      throw new Error('outer');
    }),
  );
  assert.equal(db.get('SELECT k FROM t WHERE k = ?', ['e']), undefined);
  db.close();
});
