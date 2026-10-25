// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WatchContext, WatchEvent } from '@opendc/shared/manifest';
import users from './password-policy-users.ts';
import policies from './password-policies.ts';

const ev = (guid: string, dn: string, deleted = false): WatchEvent => ({ guid, dn, deleted, entry: { dn } });
const result = {
  policies: 1,
  domainDefault: null,
  psos: { created: 0, updated: 0, removed: 0 },
  members: { added: 1, removed: 0 },
  users: 1,
};

function ctx() {
  const calls: unknown[] = [];
  const c = {
    agent: (_op: string, args: unknown) => {
      calls.push(args);
      return Promise.resolve(result);
    },
    log: () => undefined,
  } as unknown as WatchContext;
  return { c, calls };
}

test('password policy users: moved users incrementally; OU changes and resyncs reconcile everything', async () => {
  const { c, calls } = ctx();
  await users.onChange(
    {
      handlerId: 'u',
      sync: false,
      events: [ev('a', 'CN=A,OU=X,DC=t'), ev('gone', 'CN=G\0ADEL:x,CN=Deleted Objects,DC=t', true)],
    },
    c,
  );
  assert.deepEqual(calls[0], { users: ['a'] });
  await users.onChange({ handlerId: 'u', sync: false, events: [ev('a', 'CN=A,OU=X,DC=t'), ev('o', 'ou=X,DC=t')] }, c);
  assert.deepEqual(calls[1], {});
  await users.onChange({ handlerId: 'u', sync: true, events: [] }, c);
  assert.deepEqual(calls[2], {});
  await users.onChange({ handlerId: 'u', sync: false, events: [ev('gone', 'CN=G,DC=t', true)] }, c);
  assert.equal(calls.length, 3, 'only deletions: nothing to do');
  const many = Array.from({ length: 5001 }, (_, i) => ev(`u${String(i)}`, 'CN=U,DC=t'));
  await users.onChange({ handlerId: 'u', sync: false, events: many }, c);
  assert.deepEqual(calls[3], {}, 'too many users: one full run');
  await policies.onChange({ handlerId: 'p', sync: false, events: [] }, c);
  assert.deepEqual(calls[4], {});
});
