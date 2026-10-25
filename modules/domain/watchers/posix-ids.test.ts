// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlatformError } from '@opendc/shared';
import { childDn } from '@opendc/shared/ldap';
import type { WatchBatch, WatchContext, WatchEvent } from '@opendc/shared/manifest';
import handler, { generalizedTime } from './posix-ids.ts';

const ev = (guid: string, whenCreated: string, deleted = false): WatchEvent => ({
  guid,
  dn: childDn('CN=Users,DC=x', 'CN', guid),
  deleted,
  entry: { dn: childDn('DC=x', 'CN', guid), whenCreated },
});

type R = { guid: string; dn: string | null; set: object; skipped: string | null; error: string | null };

function ctx(fill: (guid: string) => R) {
  const audits: { result: string; targetGuid?: string }[] = [];
  const calls: string[][] = [];
  const c = {
    since: '2026-10-25T12:00:00.000Z',
    agent: (_op: string, args: { guids: string[] }) => {
      calls.push(args.guids);
      try {
        return Promise.resolve({ results: args.guids.map(fill) });
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
    audit: (e: { result: string }) => audits.push(e),
    log: () => undefined,
  } as unknown as WatchContext;
  return { c, audits, calls };
}

const ok = (guid: string): R => ({
  guid,
  dn: childDn('DC=x', 'CN', guid),
  set: { uidNumber: 1 },
  skipped: null,
  error: null,
});

test('POSIX IDs: one batched call; a resync only fills objects created since; skips are not audited', async () => {
  const { c, audits, calls } = ctx((guid) =>
    guid === 'old-skip' ? { guid, dn: 'CN=s', set: {}, skipped: 'already has its IDs', error: null } : ok(guid),
  );
  const sync: WatchBatch = {
    handlerId: 'posix-ids',
    sync: true,
    events: [ev('before', '20261025115959.0Z'), ev('after', '20261025120001.0Z'), ev('nodate', '')],
  };
  await handler.onChange(sync, c);
  assert.deepEqual(calls, [['after']]);
  await handler.onChange(
    { handlerId: 'posix-ids', sync: false, events: [ev('before', '2020'), ev('gone', '', true), ev('old-skip', '')] },
    c,
  );
  assert.deepEqual(calls[1], ['before', 'old-skip']);
  assert.equal(audits.length, 2);
  await handler.onChange({ handlerId: 'p', sync: true, events: [ev('x', '')] }, c);
  assert.equal(calls.length, 2, 'nothing to do: no agent call');
  const many = Array.from({ length: 1100 }, (_, i) => ev(`g${String(i)}`, ''));
  await handler.onChange({ handlerId: 'p', sync: false, events: many }, c);
  assert.deepEqual(
    calls.slice(2).map((x) => x.length),
    [500, 500, 100],
  );
});

test('POSIX IDs: per-object errors are audited, vanished objects ignored, agent errors fail the batch', async () => {
  const { c, audits } = ctx((guid) => {
    if (guid === 'down') throw new PlatformError('agent.unreachable', { socket: 's', reason: 'r' });
    if (guid === 'conflict')
      return { guid, dn: 'CN=c', set: {}, skipped: null, error: 'the computed ID is already used' };
    if (guid === 'vanished') return { guid, dn: null, set: {}, skipped: null, error: 'not found' };
    return ok(guid);
  });
  await handler.onChange(
    { handlerId: 'p', sync: false, events: [ev('conflict', ''), ev('vanished', ''), ev('fine', '')] },
    c,
  );
  assert.deepEqual(
    audits.map((a) => [a.targetGuid, a.result]),
    [
      ['conflict', 'failure'],
      ['fine', 'success'],
    ],
  );
  await assert.rejects(handler.onChange({ handlerId: 'p', sync: false, events: [ev('down', '')] }, c));
  assert.equal(generalizedTime(['20261025120000.0Z']), Date.UTC(2026, 9, 25, 12, 0, 0));
  assert.equal(generalizedTime(42), null);
});
