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

function ctx(fill: (guid: string) => unknown) {
  const audits: { result: string }[] = [];
  const calls: string[] = [];
  const c = {
    since: '2026-10-25T12:00:00.000Z',
    agent: (_op: string, args: { guid: string }) => {
      calls.push(args.guid);
      try {
        return Promise.resolve(fill(args.guid));
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
    audit: (e: { result: string }) => audits.push(e),
    log: () => undefined,
  } as unknown as WatchContext;
  return { c, audits, calls };
}

test('POSIX IDs: incremental changes are filled and audited; a resync only fills objects created since', async () => {
  const { c, audits, calls } = ctx((guid) =>
    guid === 'old-skip'
      ? { dn: 'CN=s', set: {}, skipped: 'already has its IDs' }
      : { dn: childDn('DC=x', 'CN', guid), set: { uidNumber: 101234 }, skipped: null },
  );
  const sync: WatchBatch = {
    handlerId: 'posix-ids',
    sync: true,
    events: [ev('before', '20261025115959.0Z'), ev('after', '20261025120001.0Z'), ev('nodate', '')],
  };
  await handler.onChange(sync, c);
  assert.deepEqual(calls, ['after']);
  await handler.onChange(
    { handlerId: 'posix-ids', sync: false, events: [ev('before', '2020'), ev('gone', '', true), ev('old-skip', '')] },
    c,
  );
  assert.deepEqual(calls, ['after', 'before', 'old-skip']);
  assert.equal(audits.length, 2, 'skipped objects are not audited');
});

test('POSIX IDs: a conflicting ID is audited and skipped; other errors fail the batch', async () => {
  const { c, audits } = ctx((guid) => {
    if (guid === 'conflict') throw new PlatformError('directory.invalid', { reason: 'uidNumber 101 is already used' });
    if (guid === 'vanished') throw new PlatformError('request.not-found', { what: 'x' });
    if (guid === 'down') throw new PlatformError('agent.unreachable', { socket: 's', reason: 'r' });
    return { dn: 'CN=ok', set: { gidNumber: 100513 }, skipped: null };
  });
  await handler.onChange(
    { handlerId: 'p', sync: false, events: [ev('conflict', ''), ev('vanished', ''), ev('ok', '')] },
    c,
  );
  assert.equal(audits[0]?.result, 'failure');
  assert.equal(audits[1]?.result, 'success');
  await assert.rejects(handler.onChange({ handlerId: 'p', sync: false, events: [ev('down', '')] }, c));
  assert.equal(generalizedTime(['20261025120000.0Z']), Date.UTC(2026, 9, 25, 12, 0, 0));
  assert.equal(generalizedTime(42), null);
});
