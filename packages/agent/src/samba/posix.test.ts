// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guidFromBytes } from '@opendc/shared/ldap';
import { fillPosixIds, idBaseOf } from './posix.ts';
import type { LdifEntry } from './ldif.ts';
import type { SambaLocal } from './local.ts';

const DOMAIN = 'DC=example,DC=test';
const DSID = 'S-1-5-21-1-2-3';
const entry = (dn: string, attrs: Record<string, string[]>): LdifEntry => ({
  dn,
  attrs: new Map(Object.entries(attrs).map(([k, v]) => [k.toLowerCase(), v])),
});

/** Decodes the escaped bytes of an objectGUID filter value. */
const guidsIn = (text: string): string[] =>
  [...text.matchAll(/\(objectGUID=((?:\\[0-9a-f]{2}){16})\)/gi)].map((m) =>
    guidFromBytes(
      Uint8Array.from(
        (m[1] ?? '')
          .slice(1)
          .split('\\')
          .map((h) => parseInt(h, 16)),
      ),
    ),
  );
const valuesIn = (text: string, attr: string): string[] =>
  [...text.matchAll(new RegExp(`\\(${attr}=([^)]+)\\)`, 'g'))].map((m) => m[1] ?? '');

function fake(
  objects: LdifEntry[],
  o: { settings?: string | null; failBatch?: boolean; failDn?: string; existsDn?: string } = {},
) {
  const settings = o.settings === undefined ? 'opendc:v1:{"data":{"idBase":200000}}' : o.settings;
  const modified: string[] = [];
  const has = (e: LdifEntry, attr: string, v: string) => (e.attrs.get(attr.toLowerCase()) ?? []).includes(v);
  const s = {
    domainDn: () => Promise.resolve(DOMAIN),
    get: (dn: string) => {
      if (dn === DOMAIN) return Promise.resolve(entry(DOMAIN, { objectSid: [DSID] }));
      if (dn.startsWith('CN=Settings'))
        return Promise.resolve(settings === null ? null : entry(dn, { 'msDS-Settings': [settings] }));
      return Promise.resolve(null);
    },
    search: (_b: string, _s: string, f: { text: string }) => {
      const t = f.text;
      if (t.includes('objectGUID')) {
        const g = guidsIn(t);
        return Promise.resolve(objects.filter((e) => g.includes(e.attrs.get('objectguid')?.[0] ?? '')));
      }
      for (const attr of ['objectSid', 'uidNumber', 'gidNumber']) {
        const vs = valuesIn(t, attr);
        if (vs.length) {
          const groupsOnly = t.includes('(objectClass=group)');
          return Promise.resolve(
            objects.filter((e) => vs.some((v) => has(e, attr, v)) && (!groupsOnly || has(e, 'objectClass', 'group'))),
          );
        }
      }
      return Promise.resolve([]);
    },
    modify: (ldif: string) => {
      const records = ldif.split('\n\n').filter(Boolean);
      if (records.length > 1 && o.failBatch) return Promise.reject(new Error('ldbmodify failed'));
      if (o.failDn && ldif.includes(`dn: ${o.failDn}`)) return Promise.reject(new Error('insufficient access'));
      if (o.existsDn && ldif.includes(`dn: ${o.existsDn}`))
        return Promise.reject(new Error('Attribute or value exists'));
      modified.push(ldif);
      return Promise.resolve();
    },
  } as unknown as SambaLocal;
  return { s, modified };
}

const g = (n: number) => `6f9619ff-8b86-4011-b42d-${String(n).padStart(12, '0')}`;
const user = (n: number, rid: number, extra: Record<string, string[]> = {}) =>
  entry(`CN=u${String(n)},CN=Users,${DOMAIN}`, {
    objectGUID: [g(n)],
    objectClass: ['top', 'person', 'user'],
    objectSid: [`${DSID}-${String(rid)}`],
    primaryGroupID: ['513'],
    ...extra,
  });
const group = (n: number, rid: number, extra: Record<string, string[]> = {}) =>
  entry(`CN=g${String(n)},CN=Users,${DOMAIN}`, {
    objectGUID: [g(n)],
    objectClass: ['top', 'group'],
    objectSid: [`${DSID}-${String(rid)}`],
    ...extra,
  });
const domainUsers = entry(`CN=Domain Users,CN=Users,${DOMAIN}`, {
  objectGUID: [g(999)],
  objectClass: ['group'],
  objectSid: [`${DSID}-513`],
  gidNumber: ['200513'],
});

test('fills users and groups in one write; primary group GID; never overwrites', async () => {
  const { s, modified } = fake([
    user(1, 1234),
    group(2, 2000),
    group(3, 2001, { gidNumber: ['5'] }),
    user(4, 1235, { primaryGroupID: ['2000'] }),
    domainUsers,
  ]);
  const { results } = await fillPosixIds(s, [g(1), g(2), g(3), g(4), g(1).toUpperCase()]);
  assert.equal(results.length, 4, 'duplicates collapse');
  assert.deepEqual(results[0], {
    guid: g(1),
    dn: `CN=u1,CN=Users,${DOMAIN}`,
    set: { uidNumber: 201234, gidNumber: 200513 },
    skipped: null,
    error: null,
  });
  assert.deepEqual(results[1]?.set, { gidNumber: 202000 });
  assert.equal(results[2]?.skipped, 'already has its IDs');
  assert.deepEqual(results[3]?.set, { uidNumber: 201235, gidNumber: 202000 }, 'primary group without GID: the rule');
  assert.equal(modified.length, 1, 'one LDIF');
  assert.equal(modified[0]?.match(/^dn: /gm)?.length, 3);
});

test('computers, BUILTIN, missing objects, ID clashes, default idBase', async () => {
  const pc = entry('CN=pc', { objectGUID: [g(5)], objectClass: ['user', 'computer'], objectSid: [`${DSID}-3000`] });
  const bi = entry('CN=Users,CN=Builtin', { objectGUID: [g(6)], objectClass: ['group'], objectSid: ['S-1-5-32-545'] });
  // a user already holds the UID u7 would get; a *user* with gid 102001 doesn't block group g8
  const holder = entry('CN=holder', { objectGUID: [g(70)], objectClass: ['user'], uidNumber: ['101300'] });
  const member = entry('CN=member', { objectGUID: [g(71)], objectClass: ['user'], gidNumber: ['102001'] });
  const { s, modified } = fake([pc, bi, user(7, 1300), group(8, 2001), holder, member], { settings: null });
  const { results } = await fillPosixIds(s, [g(5), g(6), g(7), g(8), g(9)]);
  assert.equal(results[0]?.skipped, 'not a user or group');
  assert.match(results[1]?.skipped ?? '', /BUILTIN/);
  assert.match(results[2]?.error ?? '', /already used by CN=holder/);
  assert.deepEqual(results[2]?.set, {});
  assert.deepEqual(results[3]?.set, { gidNumber: 102001 });
  assert.equal(results[4]?.error, 'not found');
  assert.equal(modified.length, 1);

  assert.equal(await idBaseOf(fake([], { settings: 'garbage' }).s, DOMAIN), 100000);
  assert.equal(await idBaseOf(fake([], { settings: 'opendc:v1:{bad json' }).s, DOMAIN), 100000);
  assert.equal(await idBaseOf(fake([], { settings: 'opendc:v1:{"data":{"idBase":-1}}' }).s, DOMAIN), 100000);
});

test('a failing batch write is retried per object; "exists" means it was written before', async () => {
  const { s, modified } = fake([user(1, 1234), user(2, 1235), user(3, 1236), domainUsers], {
    failBatch: true,
    failDn: `CN=u2,CN=Users,${DOMAIN}`,
    existsDn: `CN=u1,CN=Users,${DOMAIN}`,
  });
  const { results } = await fillPosixIds(s, [g(1), g(2), g(3)]);
  assert.equal(results[0]?.error, null, 'written by the failed batch before the failing record');
  assert.match(results[1]?.error ?? '', /insufficient access/);
  assert.deepEqual(results[1]?.set, {});
  assert.deepEqual(results[2]?.set, { uidNumber: 201236, gidNumber: 200513 });
  assert.equal(modified.length, 1);
});
