// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gpoGuid, gpoName, parseGpLink, restoredVersion, splitVersion, withGptVersion } from './index.ts';

test('GPO ids and names', () => {
  assert.equal(gpoGuid.parse('{31b2f340-016d-11d2-945f-00c04fb984f9}'), '{31B2F340-016D-11D2-945F-00C04FB984F9}');
  assert.equal(gpoGuid.safeParse('31b2f340-016d-11d2-945f-00c04fb984f9').success, false);
  assert.equal(gpoGuid.safeParse('{31b2f340-016d-11d2-945f-00c04fb984f9},CN=x').success, false);
  assert.equal(gpoName.parse('  Workstations – Firewall  '), 'Workstations – Firewall');
  assert.equal(gpoName.safeParse('a\nb').success, false);
  assert.equal(gpoName.safeParse('').success, false);
});

test('versions: halves, and a restore lands above both', () => {
  assert.deepEqual(splitVersion(0x00030005), { user: 3, computer: 5 });
  // AD stores the number signed: a user half from 0x8000 on makes it negative
  assert.deepEqual(splitVersion(0x80010002 | 0), { user: 0x8001, computer: 2 });
  assert.equal(restoredVersion(0x00030005, 0x00010009), 0x0004000a);
  assert.equal(restoredVersion(0, 0), 0x00010001);
  assert.equal(restoredVersion(0x7fff0000, 0), 0x80000001 | 0);
  assert.ok(restoredVersion(0x7fff0000, 0) < 0, 'signed like AD');
  // wraps instead of overflowing the half
  assert.equal(splitVersion(restoredVersion(0xffff, 0)).computer, 0);
});

test('GPT.INI: Version replaced or added, other lines kept, CRLF', () => {
  assert.equal(withGptVersion('[General]\r\nVersion=0\r\n', 65537), '[General]\r\nVersion=65537\r\n');
  assert.equal(
    withGptVersion('[General]\ndisplayName=New Group Policy Object\nversion=7\n', 3),
    '[General]\r\ndisplayName=New Group Policy Object\r\nVersion=3\r\n',
  );
  assert.equal(withGptVersion('[General]\r\ndisplayName=x\r\n', 2), '[General]\r\nVersion=2\r\ndisplayName=x\r\n');
  assert.equal(withGptVersion(null, 0), '[General]\r\nVersion=0\r\n');
  assert.equal(withGptVersion('', 1), '[General]\r\nVersion=1\r\n');
  assert.equal(withGptVersion(null, 0x80000001 | 0), '[General]\r\nVersion=2147483649\r\n');
});

test('gPLink: options and link order (the last entry wins)', () => {
  const v =
    '[LDAP://cn={31B2F340-016D-11D2-945F-00C04FB984F9},cn=policies,cn=system,DC=x;0]' +
    '[LDAP://CN={6ac1786c-016f-11d2-945f-00c04fb984f9},CN=Policies,CN=System,DC=x;3]' +
    '[LDAP://cn=not-a-gpo,DC=x;0]' +
    '[LDAP://cn={11111111-2222-3333-4444-555555555555},cn=policies,cn=system,DC=x;1]';
  const links = parseGpLink(v);
  assert.deepEqual(
    links.map((l) => [l.gpo, l.order, l.disabled, l.enforced]),
    [
      ['{11111111-2222-3333-4444-555555555555}', 1, true, false],
      ['{6AC1786C-016F-11D2-945F-00C04FB984F9}', 3, true, true],
      ['{31B2F340-016D-11D2-945F-00C04FB984F9}', 4, false, false],
    ],
  );
  assert.deepEqual(parseGpLink(null), []);
  assert.deepEqual(parseGpLink(' '), []);
});
