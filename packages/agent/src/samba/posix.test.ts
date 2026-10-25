// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillPosixIds, idBaseOf } from './posix.ts';
import type { LdifEntry } from './ldif.ts';
import type { SambaLocal } from './local.ts';

const DOMAIN = 'DC=example,DC=test';
const DSID = 'S-1-5-21-1-2-3';
const entry = (dn: string, attrs: Record<string, string[]>): LdifEntry => ({
  dn,
  attrs: new Map(Object.entries(attrs).map(([k, v]) => [k.toLowerCase(), v])),
});

function fake(objects: Record<string, LdifEntry>, settings: string | null = 'opendc:v1:{"data":{"idBase":200000}}') {
  const modified: string[] = [];
  const s = {
    domainDn: () => Promise.resolve(DOMAIN),
    get: (dn: string) => {
      if (dn === DOMAIN) return Promise.resolve(entry(DOMAIN, { objectSid: [DSID] }));
      if (dn.startsWith('CN=Settings'))
        return Promise.resolve(settings === null ? null : entry(dn, { 'msDS-Settings': [settings] }));
      return Promise.resolve(objects[dn] ?? null);
    },
    search: (_b: string, _s: string, f: { text: string }) => {
      const m = /\((\w+)=([^)]+)\)/.exec(f.text);
      return Promise.resolve(
        Object.values(objects).filter((o) => m && (o.attrs.get(m[1]!.toLowerCase()) ?? []).includes(m[2]!)),
      );
    },
    modify: (ldif: string) => {
      modified.push(ldif);
      return Promise.resolve();
    },
  } as unknown as SambaLocal;
  return { s, modified };
}

const G = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
const base = `<GUID=${G}>`;

test('fills uidNumber/gidNumber from idBase + RID and the primary group, never overwrites', async () => {
  const { s, modified } = fake({
    [base]: entry('CN=bob,CN=Users,DC=example,DC=test', {
      objectClass: ['top', 'person', 'user'],
      objectSid: [`${DSID}-1234`],
      primaryGroupID: ['513'],
    }),
    du: entry('CN=Domain Users,CN=Users,DC=example,DC=test', { objectSid: [`${DSID}-513`], gidNumber: ['200513'] }),
  });
  const r = await fillPosixIds(s, G);
  assert.deepEqual(r, {
    dn: 'CN=bob,CN=Users,DC=example,DC=test',
    set: { uidNumber: 201234, gidNumber: 200513 },
    skipped: null,
  });
  assert.match(modified[0] ?? '', /add: uidNumber\nuidNumber: 201234/);

  const has = fake({
    [base]: entry('CN=g', { objectClass: ['group'], objectSid: [`${DSID}-2000`], gidNumber: ['5'] }),
  });
  assert.equal((await fillPosixIds(has.s, G)).skipped, 'already has its IDs');
  assert.equal(has.modified.length, 0);
});

test('groups, computers, BUILTIN, conflicts, missing objects, default idBase', async () => {
  const grp = fake({ [base]: entry('CN=g', { objectClass: ['group'], objectSid: [`${DSID}-2000`] }) }, null);
  assert.deepEqual((await fillPosixIds(grp.s, G)).set, { gidNumber: 102000 });
  const pc = fake({ [base]: entry('CN=pc', { objectClass: ['user', 'computer'], objectSid: [`${DSID}-3000`] }) });
  assert.equal((await fillPosixIds(pc.s, G)).skipped, 'not a user or group');
  const bi = fake({ [base]: entry('CN=Users,CN=Builtin', { objectClass: ['group'], objectSid: ['S-1-5-32-545'] }) });
  assert.match((await fillPosixIds(bi.s, G)).skipped ?? '', /BUILTIN/);
  const clash = fake({
    [base]: entry('CN=g', { objectClass: ['group'], objectSid: [`${DSID}-2000`] }),
    other: entry('CN=other', { gidNumber: ['202000'] }),
  });
  await assert.rejects(fillPosixIds(clash.s, G), /already used by CN=other/);
  await assert.rejects(fillPosixIds(fake({}).s, G));
  assert.equal(await idBaseOf(fake({}, 'garbage').s, DOMAIN), 100000);
  assert.equal(await idBaseOf(fake({}, 'opendc:v1:{bad json').s, DOMAIN), 100000);
  assert.equal(await idBaseOf(fake({}, 'opendc:v1:{"data":{"idBase":-1}}').s, DOMAIN), 100000);
});
