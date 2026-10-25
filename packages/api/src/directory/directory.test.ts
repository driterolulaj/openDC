// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Entry } from 'ldapts';
import { canonicalColumn, detectDelimiter, parseCsv, toCsv } from './csv.ts';
import { expand, planImport, type ImportContext } from './import.ts';
import { DirectoryService, generatePassword } from './service.ts';
import type { LdapLike, Mod } from './ldap.ts';
import { filetimeToIso, generalizedToIso, isoToFiletime, isProtectedEntry, protectedSids, str } from './model.ts';
import { eq, sidToBytes, guidToBytes } from '@opendc/shared/ldap';

test('CSV: quotes, embedded separators and newlines, BOM, semicolons, blank lines', () => {
  const text = '﻿sam,description\r\nalice,"Hello, ""World""\nsecond line"\r\n\r\nbob,plain\n';
  assert.deepEqual(parseCsv(text), [
    ['sam', 'description'],
    ['alice', 'Hello, "World"\nsecond line'],
    ['bob', 'plain'],
  ]);
  assert.equal(detectDelimiter('sam;givenName;sn\nx;y;z'), ';');
  assert.deepEqual(parseCsv('a;b\n1;"2;3"'), [
    ['a', 'b'],
    ['1', '2;3'],
  ]);
  assert.throws(() => parseCsv('a,b\n"open,1\n'), /unterminated/);
});

test('CSV export quotes what needs it and neutralises formulas', () => {
  const out = toCsv([
    ['sam', 'note'],
    ['x', '=HYPERLINK("http://evil")'],
    ['y', 'a,b'],
    ['z', null],
  ]);
  assert.equal(out, 'sam,note\r\nx,"\'=HYPERLINK(""http://evil"")"\r\ny,"a,b"\r\nz,\r\n');
});

test('CSV header aliases', () => {
  assert.equal(canonicalColumn('sAMAccountName'), 'sam');
  assert.equal(canonicalColumn('First Name'), 'givenName');
  assert.equal(canonicalColumn('Nachname'), 'sn');
  assert.equal(canonicalColumn('e-mail'), 'mail');
  assert.equal(canonicalColumn('shoe size'), null);
});

test('template placeholders; mail/UPN become lower-case ASCII', () => {
  const vars = { firstname: 'Jörg', lastname: 'Müller Lüdenscheidt', sam: 'jmueller', domain: 'ad.example.com' };
  assert.equal(expand('{firstname}.{lastname}@{domain}', vars, true), 'jorg.mullerludenscheidt@ad.example.com');
  assert.equal(expand('/home/{sam}', vars, false), '/home/jmueller');
});

test('AD time conversions', () => {
  assert.equal(filetimeToIso('0'), null);
  assert.equal(filetimeToIso('9223372036854775807'), null);
  const iso = '2027-01-31T00:00:00.000Z';
  assert.equal(filetimeToIso(isoToFiletime(iso)), iso);
  assert.equal(isoToFiletime(null), '0');
  assert.equal(generalizedToIso('20261024235555.0Z'), '2026-10-24T23:55:55.000Z');
  assert.equal(generalizedToIso(null), null);
});

test('generated passwords meet AD complexity and differ', () => {
  const a = generatePassword();
  assert.equal(a.length, 16);
  for (const re of [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z0-9]/]) assert.match(a, re);
  assert.notEqual(a, generatePassword());
});

const DOM = 'S-1-5-21-1-2-3';
const BASE = 'DC=x,DC=test';

function entry(dn: string, attrs: Record<string, string | string[]>, sid?: string): Entry {
  return {
    dn,
    ...attrs,
    objectGUID: Buffer.from(guidToBytes(crypto.randomUUID())),
    ...(sid ? { objectSid: Buffer.from(sidToBytes(sid)) } : {}),
  };
}

test('tier-0 detection: adminCount, protected SIDs, DC accounts, transitive membership', () => {
  const p = protectedSids(DOM);
  assert.ok(isProtectedEntry(entry('CN=a', { adminCount: '1' }), p));
  assert.ok(isProtectedEntry(entry('CN=da', { objectClass: ['group'] }, `${DOM}-512`), p));
  assert.ok(isProtectedEntry(entry('CN=dc', { objectClass: ['computer'], userAccountControl: String(0x2000) }), p));
  const member = {
    ...entry('CN=m', { objectClass: ['user'] }),
    tokenGroups: [Buffer.from(sidToBytes(`${DOM}-512`))],
  } as Entry;
  assert.ok(isProtectedEntry(member, p), 'member of Domain Admins before SDProp ran');
  assert.ok(!isProtectedEntry(entry('CN=u', { objectClass: ['user'] }, `${DOM}-1105`), p));
});

/** A fake directory: users by sAMAccountName, groups, and a log of writes. */
function fakeDir(existing: Entry[]): { dir: DirectoryService; writes: string[] } {
  const writes: string[] = [];
  const ldap: LdapLike = {
    search: async (_base, o) => {
      const text = o.filter?.text ?? '';
      return existing.filter((e) => {
        const sam = str(e, 'sAMAccountName');
        return sam !== null && text.toLowerCase().includes(eq('sAMAccountName', sam).text.toLowerCase());
      });
    },
    add: async (dn) => {
      writes.push(`add ${dn}`);
    },
    modify: async (dn: string, mods: Mod[]) => {
      writes.push(`modify ${dn} ${mods.map((m) => m.attr).join(',')}`);
    },
    del: async (dn) => {
      writes.push(`del ${dn}`);
    },
    rename: async () => undefined,
  };
  return { dir: new DirectoryService(ldap, { domainDn: BASE, domainSid: DOM }), writes };
}

test('import dry run: create, update diff, unchanged, errors, RBAC and tier 0', async () => {
  const bob = entry(`CN=Bob,OU=Staff,${BASE}`, {
    objectClass: ['top', 'person', 'organizationalPerson', 'user'],
    sAMAccountName: 'bob',
    givenName: 'Bob',
    department: 'Sales',
    userAccountControl: '512',
  });
  const carol = entry(`CN=Carol,OU=Staff,${BASE}`, {
    objectClass: ['user'],
    sAMAccountName: 'carol',
    givenName: 'Carol',
    userAccountControl: '512',
  });
  const admin = entry(`CN=Admin,OU=Staff,${BASE}`, {
    objectClass: ['user'],
    sAMAccountName: 'admin2',
    adminCount: '1',
  });
  const eng = entry(`CN=Engineering,OU=Staff,${BASE}`, { objectClass: ['group'], sAMAccountName: 'Engineering' });
  const { dir } = fakeDir([bob, carol, admin, eng]);
  const ctx: ImportContext = {
    dir,
    can: (perm, t) => !(perm === 'domain.users.write' && t.dn.startsWith('CN=Carol')),
    parentDn: `OU=Staff,${BASE}`,
    template: {
      defaults: { mail: '{firstname}.{lastname}@x.test' },
      groups: [],
      mustChangePassword: true,
      enabled: true,
    },
    mode: 'upsert',
  };
  const csv = [
    'sam;givenName;sn;department;groups;enabled',
    'alice;Alice;Smith;R&D;Engineering;yes',
    'bob;Bob;;Marketing;;',
    'bob;Bob;;;;',
    'carol;Carol;;HR;;',
    'admin2;;;IT;;',
    ';x;;;;',
    'dave;Dave;;;Nope;',
    'erin;Erin;;;;maybe',
  ].join('\n');
  const { preview } = await planImport(csv, ctx);
  const byLine = new Map(preview.rows.map((r) => [r.line, r]));
  assert.equal(byLine.get(2)?.action, 'create');
  assert.equal(byLine.get(2)?.changes.mail?.to, 'alice.smith@x.test', 'template placeholder expanded');
  assert.equal(byLine.get(2)?.changes.groups?.to, 'Engineering');
  assert.equal(byLine.get(3)?.action, 'update');
  assert.deepEqual(byLine.get(3)?.changes.department, { from: 'Sales', to: 'Marketing' });
  assert.match(byLine.get(4)?.error ?? '', /duplicate/);
  assert.match(byLine.get(5)?.error ?? '', /no permission/);
  assert.match(byLine.get(6)?.error ?? '', /protected/);
  assert.match(byLine.get(7)?.error ?? '', /sam is empty/);
  assert.match(byLine.get(8)?.error ?? '', /group Nope not found/);
  assert.match(byLine.get(9)?.error ?? '', /enabled/);
  assert.deepEqual(preview.counts, { create: 1, update: 1, unchanged: 0, error: 6 });

  const unchanged = await planImport('sam,givenName\nbob,Bob\n', ctx);
  assert.equal(unchanged.preview.rows[0]?.action, 'unchanged');
  const createOnly = await planImport('sam\nbob\n', { ...ctx, mode: 'create' });
  assert.match(createOnly.preview.rows[0]?.error ?? '', /exists/);
  await assert.rejects(planImport('givenName\nx\n', ctx), /sam/);
});
